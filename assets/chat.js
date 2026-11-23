/*
 * Chat widget: a small "talk" button that opens a conversation about the
 * artwork. It tells the chat server which page the visitor is on, and keeps
 * the conversation going as they move between pages (until the tab closes).
 *
 * Set ENDPOINT to your Worker's address after deploying it (see SITE-README.md).
 */
(() => {
  const ENDPOINT = 'https://alexmyers-chat.aandnota.workers.dev';
  const STORE = 'chat.v1';
  const NAME = '(Un)Realistic Beauty Expectations';   // the chatbot's name, shown at the top of the panel

  /* State, kept per browser tab ------------------------------------- */
  const load = () => { try { return JSON.parse(sessionStorage.getItem(STORE)) || {}; } catch { return {}; } };
  const state = { messages: [], open: false, ...load() };
  const save = () => { try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private mode */ } };

  /** Where the visitor is right now: home, a project, or a text page. */
  function currentPage() {
    const view = document.body.dataset.view || 'home';
    const slug = new URLSearchParams(location.search).get('p') || '';
    const h1 = document.querySelector('#app h1:not(.visually-hidden)');
    return { view, slug, title: view === 'home' ? '' : (h1 ? h1.textContent.trim() : '') };
  }

  /* Building blocks ------------------------------------------------- */
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...kids.filter(Boolean));
    return n;
  };

  // Replies may contain [label](link), **bold** and *italic*. Built as DOM nodes, never innerHTML.
  const SAFE_LINK = /^(project|page)\.html\?p=[\w%-]+$|^https:\/\/\S+$/;
  const TOKENS = /(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;
  function inline(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(TOKENS)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const [tok] = m;
      if (m[1]) {
        const [, label, url] = tok.match(/^\[(.+)\]\((.+)\)$/);
        out.push(SAFE_LINK.test(url)
          ? el('a', { href: url, target: url.startsWith('https:') ? '_blank' : null, rel: url.startsWith('https:') ? 'noopener' : null, text: label })
          : label);
      } else if (m[2]) out.push(el('strong', { text: tok.slice(2, -2) }));
      else out.push(el('em', { text: tok.slice(1, -1) }));
      last = m.index + tok.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  const paragraphs = (text) => text.trim().split(/\n\s*\n/).map((p) =>
    el('p', {}, ...p.split('\n').flatMap((line, i) => (i ? [el('br'), ...inline(line)] : inline(line)))));

  function greeting() {
    const p = currentPage();
    if (p.view === 'project' && p.title) return `Hi. You're looking at ${p.title}. What do you notice first?`;
    return 'Hi. Ask me anything about the work on this site, or open a project and we can talk about it.';
  }

  /* The widget ------------------------------------------------------ */
  const log = el('div', { class: 'chat-log', 'aria-live': 'polite' });
  const input = el('textarea', { class: 'chat-input', rows: '1', maxlength: '2000', placeholder: 'Say something…', 'aria-label': 'Your message' });
  const send = el('button', { type: 'submit', class: 'chat-send', text: 'send' });
  const form = el('form', { class: 'chat-form' }, input, send);
  const close = el('button', { type: 'button', class: 'chat-close', 'aria-label': 'Close chat', text: '×' });
  const clear = el('button', { type: 'button', class: 'chat-clear', text: 'start over' });
  const panel = el('section', { class: 'chat-panel', id: 'chat-panel', 'aria-label': NAME, hidden: true },
    el('header', { class: 'chat-head' }, el('span', { class: 'chat-title', text: NAME }), clear, close),
    log, form,
    el('p', { class: 'chat-note', text: 'An AI chatbot that has read Alex’s writing. It can get things wrong.' }));
  const toggle = el('button', { type: 'button', class: 'chat-toggle', 'aria-controls': 'chat-panel', 'aria-expanded': 'false', text: 'talk ¬' });

  function bubble(role, text) {
    const b = el('div', { class: `chat-msg chat-${role}` });
    b.append(...paragraphs(text));
    return b;
  }
  function render() {
    const intro = state.messages.length ? [] : [bubble('assistant', greeting())];
    log.replaceChildren(...intro, ...state.messages.map((m) => bubble(m.role, m.content)));
    log.scrollTop = log.scrollHeight;
  }
  function setOpen(open, focus = true) {
    state.open = open; save();
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.hidden = open;
    if (open) { render(); if (focus) input.focus(); } else if (focus) toggle.focus();
  }

  let busy = false;
  async function ask(text) {
    if (busy || !text.trim()) return;
    busy = true; send.disabled = true;
    state.messages.push({ role: 'user', content: text.trim(), page: currentPage() });
    save(); render();

    const reply = el('div', { class: 'chat-msg chat-assistant chat-pending' }, el('p', { text: '…' }));
    log.append(reply); log.scrollTop = log.scrollHeight;
    let answer = '';
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: state.messages, page: currentPage() }),
      });
      if (!res.ok || !res.body) throw new Error((await res.text()) || 'The chat is unavailable right now.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        reply.classList.remove('chat-pending');
        reply.replaceChildren(...paragraphs(answer || '…'));
        log.scrollTop = log.scrollHeight;
      }
      if (!answer.trim()) throw new Error('No reply came back. Try again?');
      state.messages.push({ role: 'assistant', content: answer.trim() });
      save();
    } catch (err) {
      // Put their message back in the box so they can retry.
      const lost = state.messages.pop();
      if (answer.trim()) { state.messages.push(lost, { role: 'assistant', content: answer.trim() }); }
      else input.value = lost.content;
      save(); render();
      log.append(el('div', { class: 'chat-msg chat-error', text: String(err.message || err).slice(0, 200) }));
      log.scrollTop = log.scrollHeight;
    } finally {
      busy = false; send.disabled = false; input.focus();
    }
  }

  /* Events ---------------------------------------------------------- */
  toggle.addEventListener('click', () => setOpen(true));
  close.addEventListener('click', () => setOpen(false));
  clear.addEventListener('click', () => { state.messages = []; save(); render(); input.focus(); });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  form.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value; input.value = ''; grow(); ask(t); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
  input.addEventListener('input', grow);

  document.body.append(toggle, panel);
  // Reopen if it was open on the previous page. Wait for site.js to fill in the title for the greeting.
  if (state.open) {
    const app = document.getElementById('app');
    const reopen = () => setOpen(true, false);
    if (app && !app.children.length) {
      const obs = new MutationObserver(() => { obs.disconnect(); reopen(); });
      obs.observe(app, { childList: true });
      setTimeout(() => { obs.disconnect(); if (panel.hidden) reopen(); }, 1500);
    } else reopen();
  }
})();
