/*
 * Public site. Reads content/site.json (edited in /admin) and builds one of:
 *   index.html                 home: name, intro, links, grid of projects
 *   project.html?p=<slug>      a project: banner image, text, images and videos
 *   page.html?p=<slug>         a text page, e.g. Teaching
 */
(() => {
  const app = document.getElementById('app');
  const view = document.body.dataset.view;

  /* Helpers -------------------------------------------------------- */
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.filter(Boolean));
    return node;
  };

  const slugify = (s) =>
    (s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
      .trim().replace(/[\s_-]+/g, '-').slice(0, 60).replace(/-+$/, '') || 'project';   // same rule as the admin

  const safeUrl = (u) => {
    u = (u || '').trim();
    if (!u) return '';
    if (/^[^@\s/]+@[^@\s]+\.[^@\s]+$/.test(u)) return 'mailto:' + u;
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[./#]/.test(u) || /^[\w-]+\.html([?#]|$)/i.test(u)) return u;   // a page on this site
    return 'https://' + u;
  };

  const isExternal = (href) => /^https?:/i.test(href) && !href.startsWith(location.origin);
  const link = (href, attrs, ...children) => el('a', {
    href, target: isExternal(href) ? '_blank' : null, rel: isExternal(href) ? 'noopener' : null, ...attrs,
  }, ...children);

  /*
   * Simple text formatting, used for descriptions, the intro and pages.
   * Built from DOM nodes (never innerHTML), so text can't inject markup.
   *   blank line = new paragraph   # Heading   ## Small heading   > quote   - list
   *   [label](https://…) = link    *italic*    **bold**           bare https://… links
   */
  const INLINE = /(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;
  function inline(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const [tok] = m;
      if (m[1]) {
        const [, label, url] = tok.match(/^\[(.+)\]\((.+)\)$/);
        out.push(link(safeUrl(url), {}, ...inline(label)));
      } else if (m[2]) {
        out.push(link(tok, { text: tok }));
      } else if (m[3]) {
        out.push(el('strong', {}, ...inline(tok.slice(2, -2))));
      } else {
        out.push(el('em', {}, ...inline(tok.slice(1, -1))));
      }
      last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  const lines = (text) => text.split('\n').flatMap((line, i) => (i ? [el('br'), ...inline(line)] : inline(line)));

  function richText(text, cls = 'rich') {
    const wrap = el('div', { class: cls });
    for (let block of (text || '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/)) {
      block = block.trim();
      if (!block) continue;
      const head = block.match(/^(#{1,2}) (.+)(?:\n([\s\S]*))?$/);   // heading, maybe with text right under it
      if (head) {
        wrap.append(el(head[1].length === 1 ? 'h2' : 'h3', {}, ...inline(head[2].trim())));
        if (head[3] && head[3].trim()) wrap.append(el('p', {}, ...lines(head[3].trim())));
        continue;
      }
      const rows = block.split('\n');
      if (rows.every((r) => /^[-*] /.test(r))) {
        wrap.append(el('ul', {}, ...rows.map((r) => el('li', {}, ...inline(r.slice(2).trim())))));
      } else if (rows.every((r) => /^>/.test(r))) {
        wrap.append(el('blockquote', {}, el('p', {}, ...lines(rows.map((r) => r.replace(/^>\s?/, '')).join('\n')))));
      } else {
        wrap.append(el('p', {}, ...lines(block)));
      }
    }
    return wrap;
  }

  /* Content ---------------------------------------------------------- */
  // Media types: image, youtube {id}, vimeo {id, hash}, video {src} (a video file in images/)
  const isVideo = (m) => m && m.type === 'youtube';
  const isImage = (m) => m && m.type === 'image';
  // Older content stored images under `images`; newer uses `media` with a type.
  const mediaOf = (p) => (p.media || p.images || []).map((m) => (m.type ? m : { type: 'image', ...m }));

  /** Give every project a stable address (project.html?p=slug). */
  function withSlugs(projects) {
    const used = new Set();
    return (projects || []).map((p) => {
      let slug = p.slug || slugify(p.title), base = slug, n = 2;
      while (used.has(slug)) slug = `${base}-${n++}`;
      used.add(slug);
      return { ...p, slug, media: mediaOf(p) };
    });
  }

  /** A project's thumbnail: its first image, or the YouTube thumbnail if it starts with a video. */
  function thumbnail(m, alt) {
    if (!m) return el('span', { class: 'no-thumb' });
    if (!isVideo(m)) return el('img', { src: m.src, alt, loading: 'lazy', decoding: 'async' });
    const img = el('img', { src: `https://i.ytimg.com/vi/${m.id}/maxresdefault.jpg`, alt, loading: 'lazy', decoding: 'async' });
    // Videos without an HD thumbnail get a tiny placeholder; fall back to the medium one.
    const fallback = () => { if (!img.dataset.fb) { img.dataset.fb = '1'; img.src = `https://i.ytimg.com/vi/${m.id}/mqdefault.jpg`; } };
    img.addEventListener('error', fallback);
    img.addEventListener('load', () => { if (img.naturalWidth <= 120) fallback(); });
    return img;
  }

  function projectGrid(projects, label) {
    return el('ul', { class: 'works' },
      label && el('li', { class: 'label' }, el('h2', { text: label })),
      ...projects.map((p) => {
        const name = [p.title || 'Untitled', p.year].filter(Boolean).join(', ');
        // A chosen thumbnail image, otherwise the first image or YouTube video
        const source = p.thumb ? { type: 'image', src: p.thumb } : p.media.find((m) => isImage(m) || isVideo(m));
        return el('li', {}, el('a', { href: `project.html?p=${encodeURIComponent(p.slug)}`, title: name },
          thumbnail(source, name)));
      }));
  }

  // Header links: newer content has a list; older content had contact + instagram fields.
  const linksOf = (data) => (Array.isArray(data.links) ? data.links : [
    data.instagram && { label: 'Instagram', url: data.instagram },
    data.contact && { label: 'Contact', url: data.contact },
  ]).filter((l) => l && l.label && l.url);

  // Put a view on the page, skipping any parts that were left out (e.g. no banner)
  const show = (...nodes) => app.replaceChildren(...nodes.filter(Boolean));

  const backLink = () => el('p', { class: 'back-link' }, el('a', { href: './', 'aria-label': 'Back to all projects', text: '¬' }));

  /* Views ------------------------------------------------------------ */
  function renderHome(data, projects) {
    document.title = '&¬';
    const name = data.logo
      ? el('img', { src: data.logo, alt: data.title || '' })
      : el('h1', { class: 'name-text', text: data.title || '' });
    show(
      el('article', { class: 'index' },
        el('div', { class: 'name' }, data.logo && el('h1', { class: 'visually-hidden', text: data.title || '' }), name),
        el('div', { class: 'details' },
          data.tagline && el('h2', { class: 'tagline', text: data.tagline }),
          data.intro && richText(data.intro, 'intro'),
          el('ul', { class: 'links' }, ...linksOf(data).map((l) => el('li', {}, link(safeUrl(l.url), { text: l.label })))))),
      projectGrid(projects));
  }

  function renderProject(data, projects) {
    const slug = new URLSearchParams(location.search).get('p') || '';
    // Match the address; if it was changed in the admin, old links (and the
    // redirects from the previous site) still find the project by its title.
    const p = projects.find((x) => x.slug === slug) || projects.find((x) => slugify(x.title) === slug);
    if (!p) return notFound(projects);
    document.title = `&¬ ${p.title || ''}`;

    // The first image becomes the banner; everything else is shown below the text.
    const banner = p.media.find(isImage);
    const rest = p.media.filter((m) => m !== banner);
    const subtitle = p.subtitle || p.year;

    show(
      banner && el('div', { class: 'main-image' }, el('img', { src: banner.src, alt: banner.alt || '' })),
      el('article', { class: 'descr content' },
        backLink(),
        el('h1', { text: p.title || 'Untitled' }),
        subtitle && el('h2', { class: 'subtitle', text: subtitle }),
        richText(p.description),
        rest.length > 0 && el('div', { class: 'media' }, ...rest.map((m) => mediaItem(m, p.title)))),
      projectGrid(projects.filter((x) => x !== p), 'Other Projects'));
  }

  /** One image, video or text block on a project page, at full, half or third width. */
  function mediaItem(m, title) {
    const node = mediaNode(m, title);
    node.classList.add(`w-${m.type === 'text' ? 'full' : m.width || 'full'}`);
    return node;
  }
  function mediaNode(m, title) {
    const embed = (src) => el('div', { class: 'video' }, el('iframe', {
      src, title: m.alt || `${title} video`, loading: 'lazy',
      allow: 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen',
      allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin',
    }));
    switch (m.type) {
      case 'youtube':   // YouTube's privacy-enhanced player
        return embed(`https://www.youtube-nocookie.com/embed/${m.id}?rel=0`);
      case 'vimeo':     // dnt=1: Vimeo's do-not-track mode
        return embed(`https://player.vimeo.com/video/${m.id}?${m.hash ? `h=${m.hash}&` : ''}dnt=1&badge=0&byline=0&portrait=0`);
      case 'video': {   // a video file; "loop" ones play silently on repeat like a GIF
        const v = el('video', m.loop
          ? { src: m.src, poster: m.poster || null, autoplay: true, muted: true, loop: true, playsinline: true, preload: 'metadata', 'aria-label': m.alt || null }
          : { src: m.src, poster: m.poster || null, controls: true, playsinline: true, preload: 'metadata', 'aria-label': m.alt || null });
        v.muted = !!m.loop;   // browsers only autoplay muted video, and need the property set, not just the attribute
        return v;
      }
      case 'text':      // a block of text between images and videos
        return richText(m.body, 'rich text-block');
      default:
        return el('img', { src: m.src, alt: m.alt || '', loading: 'lazy', decoding: 'async', width: m.w || null, height: m.h || null });
    }
  }

  function renderPage(data, projects) {
    const slug = new URLSearchParams(location.search).get('p') || '';
    const page = (data.pages || []).find((pg) => pg.slug === slug);
    if (!page) return notFound(projects);
    document.title = `&¬ ${page.title || ''}`;
    show(el('article', { class: 'content page' },
      backLink(),
      el('h1', { text: page.title || '' }),
      richText(page.body)));
  }

  function notFound(projects) {
    document.title = '&¬ Not found';
    show(
      el('article', { class: 'descr content' }, backLink(), el('h1', { text: 'Not found' })),
      projectGrid(projects, 'Projects'));
  }

  /* Boot ------------------------------------------------------------- */
  fetch('content/site.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      const projects = withSlugs(data.projects);
      if (view === 'project') renderProject(data, projects);
      else if (view === 'page') renderPage(data, projects);
      else renderHome(data, projects);
    })
    .catch((err) => {
      console.error(err);
      show(el('p', { class: 'notice', text: 'This page could not be loaded.' }));
    });
})();
