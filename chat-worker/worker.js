/*
 * Chat server for alexmyers.info (a Cloudflare Worker).
 *
 * GitHub Pages can't keep secrets, so the site's chat widget talks to this
 * Worker, which holds the Anthropic API key and calls Claude.
 *
 * What Claude reads on every conversation, all fetched from the live site:
 *   content/site.json            every project's title, year, description, text blocks, image alt text
 *   content/chat/instructions.md how the chatbot should talk (voice, rules)
 *   content/chat/texts.json      the list of extra texts to feed it (statements, interviews, notes)
 *   content/chat/<file>          those texts
 * Plus the page the visitor is looking at right now.
 *
 * Edit those files and publish; the Worker picks up changes within ~5 minutes.
 */

const DEFAULTS = {
  SITE_URL: 'https://www.alexmyers.info',
  ALLOWED_ORIGINS: 'https://www.alexmyers.info,https://alexmyers.info,https://aandnota.github.io,http://127.0.0.1:5500,http://localhost:5500',
  MODEL: 'claude-sonnet-5-5',
  MAX_TOKENS: '700',
};
const KNOWLEDGE_TTL_MS = 5 * 60 * 1000;
const MAX_TURNS = 24;          // messages kept from the conversation (user + assistant)
const MAX_MESSAGE_CHARS = 2000;

const cfg = (env, k) => (env[k] ?? DEFAULTS[k]);

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = cfg(env, 'ALLOWED_ORIGINS').split(',').map((s) => s.trim());
    // The live site, plus any local preview (Live Server picks 5500, 5501, … as ports are free)
    const ok = allowed.includes(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return text('Not found', 404, cors);
    if (!ok) return text('This chat only works on the website.', 403, cors);
    if (!env.ANTHROPIC_API_KEY) return text('The chat is not set up yet (missing API key).', 500, cors);

    // Optional per-visitor rate limit (see wrangler.toml)
    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return text('Too many messages at once. Give it a minute and try again.', 429, cors);
    }

    let body;
    try { body = await request.json(); } catch { return text('Bad request', 400, cors); }
    const messages = cleanMessages(body.messages);
    if (!messages) return text('Bad request', 400, cors);

    let knowledge;
    try { knowledge = await loadKnowledge(env); }
    catch (err) { console.error(err); return text('The chat could not load the site content.', 502, cors); }

    const page = describePage(body.page, knowledge);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg(env, 'MODEL'),
        max_tokens: Number(cfg(env, 'MAX_TOKENS')),
        stream: true,
        system: [
          // Everything that's the same for every visitor: cached, so it's cheap after the first message.
          { type: 'text', text: knowledge.prompt, cache_control: { type: 'ephemeral' } },
          // Where this visitor is right now.
          { type: 'text', text: page },
        ],
        messages,
      }),
    });
    if (!res.ok || !res.body) {
      console.error('Anthropic API error', res.status, await res.text());
      return text('The chat is unavailable right now.', 502, cors);
    }

    // Pass only the reply text on to the browser, as a plain text stream.
    return new Response(res.body.pipeThrough(sseToText()), {
      headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};

/* Conversation ------------------------------------------------------- */

/**
 * Accepts [{role, content, page?}] from the widget. Keeps the latest turns,
 * trims long messages, and notes in a visitor's message when they had moved
 * to a different page since their previous one.
 */
function cleanMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let msgs = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS), page: m.page }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();      // must start with the visitor
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;

  // Merge any back-to-back messages from the same side (the API wants them alternating).
  const out = [];
  let lastPage = null;
  for (const m of msgs) {
    let content = m.content;
    if (m.role === 'user' && m.page && pageKey(m.page) !== lastPage) {
      if (lastPage !== null) content = `[The visitor has moved to: ${pageLabel(m.page)}]\n${content}`;
      lastPage = pageKey(m.page);
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n\n' + content;
    else out.push({ role: m.role, content });
  }
  return out;
}

const pageKey = (p) => `${p.view || ''}:${p.slug || ''}`;
const pageLabel = (p) => (p.view === 'project' || p.view === 'page') && p.title ? `"${String(p.title).slice(0, 120)}"` : 'the home page';

function describePage(p, knowledge) {
  p = p || {};
  if (p.view === 'project') {
    const proj = knowledge.projects.find((x) => x.slug === p.slug);
    if (proj) {
      const related = knowledge.texts.filter((t) => t.projects.includes(proj.slug)).map((t) => t.title);
      return [
        `# Where the visitor is now`,
        `The visitor is on the page for the project "${proj.title}" (address: project.html?p=${proj.slug}).`,
        `They can see its banner image, title, description, and the images, videos and text below it. Assume this is the work they mean by "this", "it" or "this piece" unless they say otherwise.`,
        related.length ? `Texts about this project in your notes: ${related.join('; ')}.` : '',
      ].filter(Boolean).join('\n');
    }
  }
  if (p.view === 'page') {
    const pg = knowledge.pages.find((x) => x.slug === p.slug);
    if (pg) return `# Where the visitor is now\nThe visitor is on the text page "${pg.title}" (page.html?p=${pg.slug}).`;
  }
  return `# Where the visitor is now\nThe visitor is on the home page, which shows the intro and a grid of thumbnails for every project.`;
}

/* Knowledge ---------------------------------------------------------- */

let cache = null;   // lives as long as this Worker instance does

async function loadKnowledge(env) {
  if (cache && Date.now() - cache.at < KNOWLEDGE_TTL_MS) return cache.value;
  const base = cfg(env, 'SITE_URL').replace(/\/$/, '') + '/content/';
  const get = (path, as) => fetch(base + path, { cf: { cacheTtl: 300 } })
    .then((r) => (r.ok ? r[as]() : null)).catch(() => null);

  const [site, manifest, instructions] = await Promise.all([
    get('site.json', 'json'), get('chat/texts.json', 'json'), get('chat/instructions.md', 'text'),
  ]);
  if (!site) throw new Error('site.json unavailable');

  const list = Array.isArray(manifest) ? manifest : (manifest && manifest.texts) || [];
  const texts = (await Promise.all(list.filter((t) => t && t.file).map(async (t) => {
    const body = await get('chat/' + t.file.replace(/^\/+/, ''), 'text');
    return body && {
      title: t.title || t.file,
      projects: Array.isArray(t.projects) ? t.projects : t.projects ? [t.projects] : [],
      body: body.replace(/<!--[\s\S]*?-->/g, '').trim(),   // notes-to-self in <!-- --> are skipped
    };
  }))).filter(Boolean);

  const projects = withSlugs(site.projects || []);
  const pages = (site.pages || []).map((pg) => ({ title: pg.title || pg.slug, slug: pg.slug, body: pg.body || '' }));
  const value = { projects, pages, texts, prompt: buildPrompt(site, projects, pages, texts, instructions) };
  cache = { at: Date.now(), value };
  return value;
}

// Same slug rule as assets/site.js, so addresses match the site.
const slugify = (s) =>
  (s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_-]+/g, '-').slice(0, 60).replace(/-+$/, '') || 'project';
function withSlugs(list) {
  const used = new Set();
  return list.map((p) => {
    let slug = p.slug || slugify(p.title), base = slug, n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return { ...p, slug, media: p.media || p.images || [] };
  });
}

function buildPrompt(site, projects, pages, texts, instructions) {
  const projectText = projects.map((p) => {
    const media = p.media || [];
    const blocks = media.filter((m) => m.type === 'text' && m.body).map((m) => m.body.trim());
    const alts = media.filter((m) => m.alt).map((m) => m.alt);
    const counts = ['image', 'video', 'youtube', 'vimeo']
      .map((t) => [t, media.filter((m) => (m.type || 'image') === t).length]).filter(([, n]) => n);
    const related = texts.filter((t) => t.projects.includes(p.slug)).map((t) => t.title);
    return [
      `## ${p.title || 'Untitled'}${p.year ? ` (${p.year})` : ''}`,
      `Address: project.html?p=${p.slug}`,
      p.subtitle && `Subtitle: ${p.subtitle}`,
      p.description && `Description:\n${p.description.trim()}`,
      blocks.length && `More text on the page:\n${blocks.join('\n\n')}`,
      alts.length && `Image/video descriptions: ${alts.join(' | ')}`,
      counts.length && `On the page: ${counts.map(([t, n]) => `${n} ${t === 'image' ? 'image' : t + ' video'}${n > 1 ? 's' : ''}`).join(', ')}`,
      related.length && `Related texts in your notes: ${related.join('; ')}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const textText = texts.map((t) =>
    `<text title="${t.title.replace(/"/g, "'")}"${t.projects.length ? ` projects="${t.projects.join(', ')}"` : ''}>\n${t.body}\n</text>`).join('\n\n');

  return [
    `You are "(Un)Realistic Beauty Expectations", the conversation companion on ${site.title || 'the artist'}'s portfolio website, alexmyers.info. Visitors open you from a small chat panel while they look at the artwork.`,
    `# How to talk\n${(instructions || '').trim() || DEFAULT_INSTRUCTIONS}`,
    `# Linking\nWhen you mention another project, link it in this form so the visitor can go look: [Project Title](project.html?p=address). Only use addresses listed below. Never write other links unless they appear in the material below.`,
    `# The site\nName: ${site.title || ''}\nTagline: ${site.tagline || ''}\nIntro: ${site.intro || ''}`,
    `# Projects on the site (newest first, as on the home page)\n\n${projectText}`,
    pages.length && `# Text pages\n\n${pages.map((pg) => `## ${pg.title} (page.html?p=${pg.slug})\n${pg.body.trim()}`).join('\n\n')}`,
    texts.length && `# Texts the artist has given you\nThese are the artist's own writing and notes. Treat them as your main source for what the work means and how it was made.\n\n${textText}`,
  ].filter(Boolean).join('\n\n');
}

const DEFAULT_INSTRUCTIONS = `Talk with visitors about the artwork on this site. Keep replies short, a few sentences. Only state facts that appear in the material below; if you don't know, say so.`;

/* Helpers ------------------------------------------------------------ */

function text(msg, status, headers) {
  return new Response(msg, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Turns Anthropic's event stream into just the reply text. */
function sseToText() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5));
            if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
              controller.enqueue(encoder.encode(data.delta.text));
            } else if (data.type === 'error') {
              console.error('stream error', data.error);
              controller.enqueue(encoder.encode('\n\n(Sorry, the reply was cut off.)'));
            }
          } catch { /* ignore keep-alives and partial lines */ }
        }
      }
    },
  });
}
