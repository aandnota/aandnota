/*
 * Admin page for a GitHub Pages site.
 *
 * Signs in with a GitHub fine-grained token (Contents: read & write on this
 * one repository), edits content/site.json in the browser, and publishes all
 * changes — text and images together — as a single commit.
 */
(() => {
  const API = 'https://api.github.com';
  const CONTENT_PATH = 'content/site.json';
  const MAX_EDGE = 2400;          // longest side of uploaded photos, px
  const QUALITY = 0.86;
  const KEY = { token: 'admin.token', repo: 'admin.repo' };

  const app = document.getElementById('app');
  const store = () => (localStorage.getItem(KEY.token) ? localStorage : sessionStorage);

  let cfg = { token: '', repo: '', branch: 'main' };
  let data = null;                 // the parsed site.json being edited
  let pending = new Map();         // repo path -> Blob (new images not yet published)
  let previews = new Map();        // repo path -> object URL (so new images show right away)
  let removed = new Set();         // repo paths to delete on publish
  let dirty = false;
  let view = { name: 'list', index: -1 };
  let busy = false;
  let LOCAL = false;               // true when editing the site folder on your computer
  let dirHandle = null;            // that folder (File System Access API)
  let DOWNLOAD = false;            // local, but the browser can't write files (Firefox, Zen, Safari)

  /* Helpers ------------------------------------------------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slugify = (s) =>
    (s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
      .trim().replace(/[\s_-]+/g, '-').slice(0, 60).replace(/-+$/, '') || 'project';
  const rand = () => Math.random().toString(36).slice(2, 8);
  const imgUrl = (path) => previews.get(path) ||
    (LOCAL ? new URL('../' + path, location.href).href : '') ||
    `https://raw.githubusercontent.com/${cfg.repo}/${encodeURIComponent(cfg.branch)}/${path}`;

  /** Bring older content up to date: images → media, contact/instagram → links. */
  function normalize(d) {
    d = { title: '', logo: '', tagline: '', intro: '', projects: [], pages: [], ...(d || {}) };
    if (!Array.isArray(d.pages)) d.pages = [];
    if (!Array.isArray(d.links)) {
      d.links = [];
      if (d.instagram) d.links.push({ label: 'instagram', url: d.instagram });
      if (d.contact) d.links.push({ label: 'contact', url: d.contact });
    }
    delete d.instagram; delete d.contact;
    const usedSlugs = new Set();
    d.projects.forEach((p) => {
      if (!Array.isArray(p.media)) p.media = (p.images || []).map((img) => ({ type: 'image', ...img }));
      delete p.images;
      // Every project gets a stable address: project.html?p=<slug>
      let slug = p.slug || slugify(p.title), base = slug, n = 2;
      while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
      usedSlugs.add(slug);
      p.slug = slug;
    });
    return d;
  }

  /** Accepts a YouTube link (watch, youtu.be, shorts, live, embed), embed code, or a bare video ID. */
  function youtubeId(input) {
    input = (input || '').trim();
    const embed = input.match(/youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/);
    if (embed) return embed[1];
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
      const u = new URL(/^https?:/i.test(input) ? input : 'https://' + input);
      const host = u.hostname.replace(/^(www|m|music)\./, '');
      if (host === 'youtu.be') return (u.pathname.match(/^\/([\w-]{11})/) || [])[1] || null;
      if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
        const v = u.searchParams.get('v');
        if (v && /^[\w-]{11}$/.test(v)) return v;
        return (u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/) || [])[1] || null;
      }
    } catch {}
    return null;
  }

  /** Accepts a Vimeo link or embed code: vimeo.com/123, vimeo.com/123/abc, player.vimeo.com/video/123?h=abc */
  function vimeoRef(input) {
    input = (input || '').trim();
    const src = (input.match(/src="([^"]+)"/) || [])[1] || input;
    try {
      const u = new URL(/^https?:/i.test(src) ? src : 'https://' + src);
      if (!/(^|\.)vimeo\.com$/.test(u.hostname)) return null;
      const m = u.pathname.match(/(?:\/video)?\/(\d{5,})(?:\/([0-9a-f]{6,}))?/i);
      if (!m) return null;
      return { id: m[1], hash: m[2] || u.searchParams.get('h') || '' };
    } catch { return null; }
  }

  // Media types: image {src}, video {src} (a video file), youtube {id}, vimeo {id, hash}, text {body}
  // Images and videos can also have width: 'half' | 'third' (default full).
  const isVideo = (m) => m && m.type !== 'image' && m.type !== 'text';   // anything that plays
  const hasFile = (m) => m && (m.type === 'image' || m.type === 'video');
  const thumbFor = (m) => !m ? '' : m.type === 'youtube' ? `https://i.ytimg.com/vi/${m.id}/mqdefault.jpg` : m.type === 'image' ? imgUrl(m.src) : '';
  const listThumb = (p) => (p.thumb ? imgUrl(p.thumb) : thumbFor((p.media || []).find((m) => m.type === 'image' || m.type === 'youtube')));
  const mediaCount = (p) => {
    const v = (p.media || []).filter(isVideo).length;
    const i = (p.media || []).filter((m) => m.type === 'image').length;
    return [i && `${i} image${i === 1 ? '' : 's'}`, v && `${v} video${v === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'empty';
  };
  function mediaPreview(m) {
    if (m.type === 'video') return `<video src="${esc(previews.get(m.src) || (LOCAL ? new URL('../' + m.src, location.href).href : imgUrl(m.src)))}"${m.poster ? ` poster="${esc(imgUrl(m.poster))}"` : ''} muted preload="metadata"></video>`;
    if (m.type === 'vimeo') return `<span class="ph">Vimeo<br><small>${esc(m.id)}</small></span>`;
    return `<img src="${esc(thumbFor(m))}" alt="">`;
  }

  /* Text pages: page.html?p=<slug>. A page can have a link in the header. */
  const pageUrl = (slug) => `page.html?p=${slug}`;
  const autoSlug = new WeakSet();     // pages whose address still follows the title
  const headerLinkFor = (pg) => data.links.find((l) => l.url === pageUrl(pg.slug));
  function uniqueSlug(base, except, list = data.pages) {
    let slug = slugify(base) || 'page', n = 2;
    while (list.some((x) => x !== except && x.slug === slug)) slug = `${slugify(base) || 'page'}-${n++}`;
    return slug;
  }

  function guessRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return '';
    const first = location.pathname.split('/').filter(Boolean)[0];
    return first && first !== 'admin' ? `${m[1]}/${first}` : `${m[1]}/${m[1]}.github.io`;
  }

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).message || msg; } catch {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  async function decode(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      return img;
    }
  }

  /** Resize big photos and drop camera metadata (incl. GPS). GIFs untouched. */
  async function processImage(file, { keepOriginal = false } = {}) {
    const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext = types[file.type];
    if (!ext) throw new Error(`${file.name} isn't a JPG, PNG, GIF or WebP image.`);
    const src = await decode(file);
    const w0 = src.width, h0 = src.height;
    if (ext === 'gif' || keepOriginal) {
      src.close?.();
      return { blob: file, w: w0, h: h0, ext };
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
    const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    src.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, file.type, QUALITY));
    return { blob: blob || file, w, h, ext };
  }

  function addPending(path, blob) {
    pending.set(path, blob);
    previews.set(path, URL.createObjectURL(blob));
  }

  function removeFile(path) {
    if (!path) return;
    if (pending.has(path)) pending.delete(path);
    else removed.add(path);
  }

  function markDirty() {
    dirty = true;
    const btn = document.querySelector('[data-action="publish"]');
    if (btn) btn.disabled = false;
    setStatus('Unsaved changes', 'warn');
  }

  function setStatus(text, kind = '') {
    const s = document.getElementById('status');
    if (s) { s.textContent = text; s.className = 'status ' + kind; }
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  /* Sign in ------------------------------------------------------- */
  function renderLogin(error = '') {
    const repo = localStorage.getItem(KEY.repo) || sessionStorage.getItem(KEY.repo) || guessRepo();
    app.innerHTML = `
      <main class="login">
        <h1>Site admin</h1>
        <form id="login" class="panel">
          ${error ? `<p class="error">${esc(error)}</p>` : ''}
          <label>Repository
            <input name="repo" placeholder="username/repo-name" value="${esc(repo)}" required autocomplete="off" spellcheck="false">
          </label>
          <label>GitHub access token
            <input name="token" type="password" required autocomplete="current-password" spellcheck="false">
          </label>
          <label class="check"><input type="checkbox" name="remember" checked> Keep me signed in on this device</label>
          <button class="primary" type="submit">Sign in</button>
        </form>
        <details class="help">
          <summary>How do I get a token?</summary>
          <ol>
            <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.</li>
            <li>Name it something like “Website admin” and choose an expiration.</li>
            <li>Under <b>Repository access</b>, pick <b>Only select repositories</b> and choose this site’s repo.</li>
            <li>Under <b>Permissions → Repository permissions</b>, set <b>Contents</b> to <b>Read and write</b>.</li>
            <li>Generate the token, copy it, and paste it above.</li>
          </ol>
          <p>The token only works on that one repository and is stored only in this browser.</p>
        </details>
      </main>`;
    document.getElementById('login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      cfg.repo = String(f.get('repo')).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
      cfg.token = String(f.get('token')).trim();
      const s = f.get('remember') ? localStorage : sessionStorage;
      [localStorage, sessionStorage].forEach((x) => { x.removeItem(KEY.token); x.removeItem(KEY.repo); });
      s.setItem(KEY.token, cfg.token);
      s.setItem(KEY.repo, cfg.repo);
      e.target.querySelector('button').disabled = true;
      connect();
    });
  }

  async function connect() {
    try {
      const repo = await gh(`/repos/${cfg.repo}`);
      if (!repo.permissions?.push) throw new Error('This token can read the repository but not write to it. Give it “Contents: Read and write”.');
      cfg.branch = repo.default_branch;
      await loadContent();
      render();
    } catch (err) {
      const msg = err.status === 401 ? 'That token was not accepted. It may have expired.'
        : err.status === 404 ? `Couldn’t find ${cfg.repo}, or the token doesn’t have access to it.`
        : err.message;
      [localStorage, sessionStorage].forEach((x) => x.removeItem(KEY.token));
      renderLogin(msg);
    }
  }

  async function loadContent() {
    try {
      const text = await gh(`/repos/${cfg.repo}/contents/${CONTENT_PATH}?ref=${encodeURIComponent(cfg.branch)}`, {
        headers: { Accept: 'application/vnd.github.raw+json' },
      });
      data = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (err) {
      if (err.status !== 404) throw err;
      data = {};
    }
    data = normalize(data);
    pending.clear(); removed.clear(); dirty = false;
  }

  /* Publish ------------------------------------------------------- */
  function referencedPaths() {
    const set = new Set();
    if (data.logo) set.add(data.logo);
    data.projects.forEach((p) => {
      if (p.thumb) set.add(p.thumb);
      (p.media || []).forEach((m) => { if (hasFile(m)) set.add(m.src); if (m.poster) set.add(m.poster); });
    });
    return set;
  }

  /* Local folder mode ---------------------------------------------
   * When the admin is opened from Live Server (localhost / 127.0.0.1) in
   * Chrome or Edge, it can read and write the site folder directly.
   */
  const idb = (mode, fn) => new Promise((resolve, reject) => {
    const open = indexedDB.open('site-admin', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
  const savedFolder = () => idb('readonly', (st) => st.get('dir')).catch(() => null);
  const rememberFolder = (h) => idb('readwrite', (st) => st.put(h, 'dir')).catch(() => {});

  const safeLocalPath = (path) => typeof path === 'string' && /^(images|imgs|content)\/[\w./ -]+$/.test(path) && !path.includes('..');

  async function locate(path, create) {
    if (!safeLocalPath(path)) throw new Error('Refusing to touch ' + path);
    const parts = path.split('/');
    let dir = dirHandle;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return [dir, parts[parts.length - 1]];
  }
  async function writeLocal(path, content) {
    const [dir, name] = await locate(path, true);
    const file = await dir.getFileHandle(name, { create: true });
    const out = await file.createWritable();
    await out.write(content);
    await out.close();
  }
  async function readLocal(path) {
    const [dir, name] = await locate(path, false);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }
  async function deleteLocal(path) {
    try { const [dir, name] = await locate(path, false); await dir.removeEntry(name); } catch {}
  }

  async function openFolder(handle) {
    try { await handle.getFileHandle('index.html'); }
    catch { throw new Error(`“${handle.name}” doesn’t look like the website folder (no index.html inside).`); }
    dirHandle = handle;
    LOCAL = true;
    let json = {};
    try { json = JSON.parse(await readLocal(CONTENT_PATH)); } catch (err) {
      if (err.name !== 'NotFoundError') throw new Error('content/site.json could not be read: ' + err.message);
    }
    data = normalize(json);
    pending.clear(); removed.clear(); dirty = false;
    await rememberFolder(handle);
    render();
  }

  function renderFolderPicker(stored, error = '') {
    const supported = 'showDirectoryPicker' in window;
    app.innerHTML = `
      <main class="login">
        <h1>Site admin <span class="pill">Local</span></h1>
        <div class="panel">
          ${error ? `<p class="error">${esc(error)}</p>` : ''}
          ${supported ? `
            <p>You’re running the site on your computer. Choose the website folder (the one with <code>index.html</code>) and edits will be saved straight into it.</p>
            <div class="stack-buttons">
              ${stored ? `<button class="primary" data-local="reconnect">Continue editing “${esc(stored.name)}”</button>` : ''}
              <button class="${stored ? '' : 'primary'}" data-local="pick">${stored ? 'Choose a different folder' : 'Choose website folder'}</button>
            </div>`
          : `<p>Editing local files needs <b>Chrome</b> or <b>Edge</b>. Open this page in one of those, or sign in with GitHub instead.</p>`}
        </div>
        <p><button class="link" data-local="github">Sign in with GitHub instead</button></p>
      </main>`;
    app.querySelectorAll('[data-local]').forEach((b) => b.addEventListener('click', async () => {
      try {
        if (b.dataset.local === 'github') return renderLogin();
        let handle = stored;
        if (b.dataset.local === 'reconnect') {
          if (await stored.requestPermission({ mode: 'readwrite' }) !== 'granted') return;
        } else {
          handle = await window.showDirectoryPicker({ id: 'site-folder', mode: 'readwrite' });
        }
        await openFolder(handle);
      } catch (err) {
        if (err.name !== 'AbortError') renderFolderPicker(stored, err.message);
      }
    }));
  }

  async function saveLocal() {
    const used = referencedPaths();
    const uploads = [...pending].filter(([path]) => used.has(path));
    let n = 0;
    for (const [path, blob] of uploads) {
      setStatus(`Saving image ${++n} of ${uploads.length}…`);
      await writeLocal(path, blob);
    }
    await writeLocal(CONTENT_PATH, JSON.stringify(data, null, 2) + '\n');
    for (const path of removed) if (!used.has(path)) await deleteLocal(path);
    pending.clear(); removed.clear(); dirty = false;
    setStatus('Saved to your folder. Refresh the site tab to see it.', 'ok');
  }

  /* Download mode (Firefox / Zen / Safari) -------------------------
   * These browsers can't save into a folder, so "Download changes" builds a
   * small zip with the new site.json and any new images, sorted into folders
   * named after where they belong. */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  /** Minimal uncompressed .zip writer: files = [{ name, data: Uint8Array }] */
  function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const body = [], directory = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
      head.setUint16(10, time, true); head.setUint16(12, date, true); head.setUint32(14, crc, true);
      head.setUint32(18, size, true); head.setUint32(22, size, true); head.setUint16(26, name.length, true);
      body.push(head, name, f.data);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true); entry.setUint16(12, time, true); entry.setUint16(14, date, true);
      entry.setUint32(16, crc, true); entry.setUint32(20, size, true); entry.setUint32(24, size, true);
      entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
      directory.push(entry, name);
      offset += 30 + name.length + size;
    }
    const dirSize = directory.reduce((n, part) => n + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, dirSize, true); end.setUint32(16, offset, true);
    return new Blob([...body, ...directory, end], { type: 'application/zip' });
  }

  async function downloadChanges() {
    const enc = new TextEncoder();
    const used = referencedPaths();
    const files = [{ name: 'put-in-content-folder/site.json', data: enc.encode(JSON.stringify(data, null, 2) + '\n') }];
    for (const [path, blob] of pending) {
      if (!used.has(path)) continue;
      files.push({ name: 'put-in-images-folder/' + path.replace(/^images\//, ''), data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const unused = [...removed].filter((p) => !used.has(p));
    const steps = [
      'How to apply these changes',
      '',
      '1. Move site.json from "put-in-content-folder" into your site\'s content folder,',
      '   replacing the old one.',
      files.length > 1 ? '2. Move the files inside "put-in-images-folder" into your site\'s images folder.' : '2. (No new images this time.)',
      '   Move the files themselves, not the folder, so nothing already there is replaced.',
      '3. Refresh the site tab to see the changes.',
      ...(unused.length ? ['', 'These images are no longer used. You can delete them from your site folder:', ...unused.map((p) => '   ' + p)] : []),
    ];
    files.push({ name: 'HOW-TO-APPLY.txt', data: enc.encode(steps.join('\n') + '\n') });

    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(makeZip(files));
    a.download = `site-update-${stamp}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);

    pending.clear(); removed.clear(); dirty = false;
    setStatus(`Downloaded ${a.download}. Move its files into your site folder (see HOW-TO-APPLY.txt).`, 'ok');
  }

  async function publish() {
    if (busy) return;
    busy = true;
    const btn = document.querySelector('[data-action="publish"]');
    if (btn) btn.disabled = true;
    try {
      if (DOWNLOAD) return await downloadChanges();
      if (LOCAL) return await saveLocal();
      setStatus('Publishing…');
      const ref = await gh(`/repos/${cfg.repo}/git/ref/heads/${cfg.branch}`);
      const head = ref.object.sha;
      const commit = await gh(`/repos/${cfg.repo}/git/commits/${head}`);
      const existing = await gh(`/repos/${cfg.repo}/git/trees/${commit.tree.sha}?recursive=1`);
      const existingPaths = new Set(existing.tree.map((t) => t.path));
      const used = referencedPaths();
      const tree = [];

      const uploads = [...pending].filter(([path]) => used.has(path));
      let n = 0;
      for (const [path, blob] of uploads) {
        setStatus(`Uploading image ${++n} of ${uploads.length}…`);
        const b = await gh(`/repos/${cfg.repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: await blobToBase64(blob), encoding: 'base64' }),
        });
        tree.push({ path, mode: '100644', type: 'blob', sha: b.sha });
      }

      setStatus('Saving…');
      const json = await gh(`/repos/${cfg.repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: JSON.stringify(data, null, 2) + '\n', encoding: 'utf-8' }),
      });
      tree.push({ path: CONTENT_PATH, mode: '100644', type: 'blob', sha: json.sha });

      for (const path of removed) {
        if (!used.has(path) && existingPaths.has(path)) {
          tree.push({ path, mode: '100644', type: 'blob', sha: null });
        }
      }

      const newTree = await gh(`/repos/${cfg.repo}/git/trees`, {
        method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha, tree }),
      });
      const newCommit = await gh(`/repos/${cfg.repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: 'Update site content', tree: newTree.sha, parents: [head] }),
      });
      await gh(`/repos/${cfg.repo}/git/refs/heads/${cfg.branch}`, {
        method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }),
      });

      pending.clear(); removed.clear(); dirty = false;
      setStatus('Published. The live site updates in about a minute.', 'ok');
    } catch (err) {
      setStatus((DOWNLOAD ? 'Download failed: ' : LOCAL ? 'Save failed: ' : 'Publish failed: ') + err.message + ' Your edits are still here; try again.', 'error');
      if (btn) btn.disabled = false;
    } finally {
      busy = false;
    }
  }

  /* Views --------------------------------------------------------- */
  function render() {
    const siteUrl = new URL('../', location.href).href;
    app.innerHTML = `
      <header class="bar">
        <div class="bar-left">
          <strong>Site admin</strong>${LOCAL ? '<span class="pill">Local</span>' : ''}
          <a href="${esc(siteUrl)}" target="_blank" rel="noopener">View site ↗</a>
        </div>
        <div class="bar-right">
          <span id="status" class="status"></span>
          <button class="primary" data-action="publish" ${dirty ? '' : 'disabled'}>${DOWNLOAD ? 'Download changes' : LOCAL ? 'Save' : 'Publish'}</button>
          ${LOCAL ? '' : '<button data-action="signout" class="link">Sign out</button>'}
        </div>
      </header>
      <main class="wrap">${view.name === 'edit' ? editView() : view.name === 'page' ? pageView() : listView()}</main>`;
    if (dirty) setStatus('Unsaved changes', 'warn');
  }

  function listView() {
    const projects = data.projects.map((p, i) => {
      const thumb = listThumb(p);
      return `
        <li class="row">
          <div class="thumb">${thumb ? `<img src="${esc(thumb)}" alt="">` : ''}</div>
          <div class="row-text">
            <strong>${esc(p.title || 'Untitled')}</strong>
            <span class="muted">${esc([p.year, mediaCount(p)].filter(Boolean).join(' · '))}</span>
          </div>
          <div class="row-actions">
            <button data-action="move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button data-action="move" data-i="${i}" data-dir="1" ${i === data.projects.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button data-action="edit" data-i="${i}">Edit</button>
            <button data-action="delete" data-i="${i}" class="danger">Delete</button>
          </div>
        </li>`;
    }).join('');

    const notice = DOWNLOAD ? `
      <section class="panel note">
        <b>This browser can’t save into your folder directly.</b>
        Make your edits, press <b>Download changes</b>, then move the files from the zip into your site folder
        (the zip includes a short HOW-TO-APPLY.txt). Download often: changes you haven’t downloaded are lost if you close or reload this page.
      </section>` : '';
    return notice + `
      <section class="panel">
        <h2>Site</h2>
        <div class="grid2">
          <label>Site name <small>(used as the page title and logo alt text)</small>
            <input data-field="title" value="${esc(data.title)}">
          </label>
          <div class="logo-field">
            <span class="label">Logo (animated GIF)</span>
            <div class="logo-row">
              <div class="logo-preview" data-path="${esc(data.logo)}">${data.logo ? `<img src="${esc(imgUrl(data.logo))}" alt="">` : '<span class="muted">None</span>'}</div>
              <label class="button">Choose file<input type="file" accept="image/gif,image/png,image/jpeg,image/webp" data-action="logo" hidden></label>
              ${data.logo ? '<button data-action="logo-remove" class="link">Remove</button>' : ''}
            </div>
          </div>
          <label>Tagline <small>(optional, beside the name)</small>
            <input data-field="tagline" value="${esc(data.tagline)}" placeholder="Media artworks, landscapes, and installations.">
          </label>
          <label>Intro <small>(optional)</small>
            <textarea data-field="intro" rows="3">${esc(data.intro)}</textarea>
          </label>
        </div>
        <span class="label">Links <small>(under the intro; an email address becomes a mail link)</small></span>
        <ul class="link-rows">
          ${data.links.map((l, i) => `
            <li class="link-row">
              <input data-link="${i}" data-key="label" value="${esc(l.label)}" placeholder="Label" aria-label="Link label">
              <input data-link="${i}" data-key="url" value="${esc(l.url)}" placeholder="https://… or you@example.com" aria-label="Link address">
              <button data-action="link-move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
              <button data-action="link-move" data-i="${i}" data-dir="1" ${i === data.links.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
              <button data-action="link-remove" data-i="${i}" class="danger" aria-label="Remove link">Remove</button>
            </li>`).join('')}
        </ul>
        <button data-action="link-add">+ Add link</button>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Projects</h2>
          <button class="primary" data-action="new">+ New project</button>
        </div>
        ${projects ? `<ul class="rows">${projects}</ul>` : '<p class="muted">No projects yet.</p>'}
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Pages</h2>
          <button class="primary" data-action="page-new">+ New page</button>
        </div>
        ${data.pages.length ? `<ul class="rows">${data.pages.map((pg, i) => `
          <li class="row">
            <div class="row-text">
              <strong>${esc(pg.title || 'Untitled page')}</strong>
              <span class="muted">${esc(pageUrl(pg.slug))}${headerLinkFor(pg) ? ' · linked on home page' : ''}</span>
            </div>
            <div class="row-actions">
              <button data-action="page-edit" data-i="${i}">Edit</button>
              <button data-action="page-delete" data-i="${i}" class="danger">Delete</button>
            </div>
          </li>`).join('')}</ul>` : '<p class="muted">No pages yet.</p>'}
      </section>`;
  }

  function pageView() {
    const pg = data.pages[view.index];
    const live = new URL('../' + pageUrl(pg.slug), location.href).href;
    return `
      <button data-action="back" class="link back">← Back</button>
      <section class="panel">
        <div class="panel-head">
          <h2>${esc(pg.title || 'New page')}</h2>
          <a href="${esc(live)}" target="_blank" rel="noopener">View page ↗</a>
        </div>
        <div class="grid2">
          <label>Title<input data-page="title" value="${esc(pg.title)}"></label>
          <label>Address <small>(page.html?p=…)</small><input data-page="slug" value="${esc(pg.slug)}" spellcheck="false"></label>
        </div>
        <label class="check"><input type="checkbox" data-action="page-header" ${headerLinkFor(pg) ? 'checked' : ''}> Show a link to this page on the home page</label>
        <label>Text
          <textarea data-page="body" rows="22" class="page-body">${esc(pg.body)}</textarea>
        </label>
        <details class="help">
          <summary>Formatting</summary>
          <table class="fmt">
            <tr><td><code># Heading</code></td><td>Section heading</td></tr>
            <tr><td><code>## Small heading</code></td><td>e.g. a course title</td></tr>
            <tr><td><code>&gt; A quotation</code></td><td>Large quote</td></tr>
            <tr><td><code>- item</code></td><td>Bulleted list (one per line)</td></tr>
            <tr><td><code>[Creighton](https://creighton.edu)</code></td><td>Link with your own wording</td></tr>
            <tr><td><code>*italic*</code> &nbsp; <code>**bold**</code></td><td>Emphasis</td></tr>
            <tr><td>Blank line</td><td>New paragraph</td></tr>
          </table>
          <p class="muted">The same formatting works in project descriptions and the intro.</p>
        </details>
      </section>`;
  }

  function editView() {
    const p = data.projects[view.index];
    const banner = (p.media || []).find((m) => m.type === 'image');
    const kind = { youtube: 'YouTube', vimeo: 'Vimeo', video: 'Video file' };
    const widthPicker = (img, i) => `
        <label class="check small">Width
          <select data-action="media-width" data-i="${i}">
            ${[['', 'Full'], ['half', 'Half'], ['third', 'Third']].map(([v, l]) => `<option value="${v}" ${(img.width || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>`;
    const moveButtons = (i, all) => `
          <button data-action="img-move" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">←</button>
          <button data-action="img-move" data-i="${i}" data-dir="1" ${i === all.length - 1 ? 'disabled' : ''} aria-label="Move later">→</button>`;
    const imgs = (p.media || []).map((img, i, all) => img.type === 'text' ? `
      <li class="img-item text-item">
        <span class="label">Text</span>
        <textarea data-text-body="${i}" rows="4" placeholder="Text shown between the images. Same formatting as the description.">${esc(img.body)}</textarea>
        <div class="img-actions">${moveButtons(i, all)}
          <button data-action="img-remove" data-i="${i}" class="danger">Remove</button>
        </div>
      </li>` : `
      <li class="img-item">
        <div class="img-thumb" data-path="${esc(hasFile(img) ? img.src : '')}">${mediaPreview(img)}${img === banner ? '<span class="badge">Banner</span>' : ''}${isVideo(img) ? `<span class="badge video">▶ ${kind[img.type]}</span>` : ''}</div>
        <input data-img-alt="${i}" value="${esc(img.alt)}" placeholder="${isVideo(img) ? 'Video title (for screen readers)' : 'Alt text (describe the image)'}">
        ${img === banner ? '' : `<textarea data-img-caption="${i}" rows="3" placeholder="Caption shown below (optional). Same formatting as the description.">${esc(img.caption)}</textarea>`}
        ${img.type === 'video' ? `<label class="check small"><input type="checkbox" data-action="video-loop" data-i="${i}" ${img.loop ? 'checked' : ''}> Play silently on repeat (like a GIF)</label>` : ''}
        ${img === banner ? '' : widthPicker(img, i)}
        <div class="img-actions">${moveButtons(i, all)}
          ${i ? `<button data-action="img-cover" data-i="${i}">Move to first</button>` : ''}
          <button data-action="img-remove" data-i="${i}" class="danger" aria-label="Remove">Remove</button>
        </div>
      </li>`).join('');

    return `
      <button data-action="back" class="link back">← All projects</button>
      <section class="panel">
        <div class="panel-head">
          <h2>${esc(p.title || 'New project')}</h2>
          <a href="${esc(new URL('../project.html?p=' + encodeURIComponent(p.slug), location.href).href)}" target="_blank" rel="noopener">View project ↗</a>
        </div>
        <div class="grid2">
          <label>Title<input data-pfield="title" value="${esc(p.title)}"></label>
          <label>Year <small>(shown when you hover a thumbnail)</small><input data-pfield="year" value="${esc(p.year)}"></label>
          <label>Subtitle <small>(under the title, e.g. “Animations made between 2021 - 2026”; the year is used if empty)</small>
            <input data-pfield="subtitle" value="${esc(p.subtitle)}"></label>
          <label>Address <small>(project.html?p=…)</small><input data-pfield="slug" value="${esc(p.slug)}" spellcheck="false"></label>
        </div>
        <label>Description
          <textarea data-pfield="description" rows="12" placeholder="Leave a blank line between paragraphs.">${esc(p.description)}</textarea>
        </label>
        <p class="muted">Formatting: blank line = new paragraph · <code>[link text](https://…)</code> · <code>*italic*</code> · <code>**bold**</code> · <code># Heading</code> · <code>- list item</code></p>
      </section>

      <section class="panel">
        <h2>Thumbnail</h2>
        <p class="muted">Shown in the grid on the home page (cropped to 16:10). If you don’t choose one, the first image or YouTube video is used.</p>
        <div class="logo-row">
          <div class="thumb wide" data-path="${esc(p.thumb || '')}">${listThumb(p) ? `<img src="${esc(listThumb(p))}" alt="">` : ''}</div>
          <label class="button">${p.thumb ? 'Replace' : 'Choose image'}<input type="file" accept="image/*" data-action="thumb" hidden></label>
          ${p.thumb ? '<button data-action="thumb-remove" class="link">Use first item instead</button>' : ''}
        </div>
      </section>

      <section class="panel">
        <h2>Images &amp; videos</h2>
        <p class="muted">The first <b>image</b> is the wide banner at the top of the project page; everything else appears below the description, in this order. Large photos are resized to ${MAX_EDGE}px and camera/location data is removed. Video files (MP4) are uploaded as-is; keep them under 50 MB.</p>
        <label class="drop" id="drop">
          <input type="file" accept="image/*,video/mp4,video/webm" multiple data-action="images" hidden>
          <span><b>Add images or video files</b>: click or drag files here</span>
        </label>
        <form class="yt-add" data-form="youtube">
          <input name="yt" placeholder="Paste a YouTube or Vimeo link (or embed code)" aria-label="YouTube or Vimeo link" autocomplete="off">
          <button type="submit">Add video</button>
          <button type="button" data-action="text-add">+ Text block</button>
        </form>
        <p class="muted">Set images to <b>Half</b> or <b>Third</b> width to show them side by side.</p>
        ${imgs ? `<ul class="img-grid">${imgs}</ul>` : ''}
      </section>
      <p class="muted">Changes are kept here until you press <b>${DOWNLOAD ? 'Download changes' : LOCAL ? 'Save' : 'Publish'}</b>.</p>`;
  }

  /* Events -------------------------------------------------------- */
  async function addImages(files) {
    const p = data.projects[view.index];
    p.media = p.media || [];
    const errors = [];
    let i = 0;
    for (const file of files) {
      setStatus(`Preparing file ${++i} of ${files.length}…`);
      try {
        if (/^video\//.test(file.type)) {
          if (file.size > 95 * 1024 * 1024) throw new Error(`${file.name} is over 95 MB, which GitHub won’t accept. Upload it to YouTube or Vimeo instead.`);
          const ext = file.type === 'video/webm' ? 'webm' : 'mp4';
          const path = `images/${slugify(p.title)}-${rand()}.${ext}`;
          addPending(path, file);
          p.media.push({ type: 'video', src: path, alt: '', loop: false });
          continue;
        }
        const { blob, w, h, ext } = await processImage(file);
        const path = `images/${slugify(p.title)}-${rand()}.${ext}`;
        addPending(path, blob);
        p.media.push({ type: 'image', src: path, w, h, alt: '' });
      } catch (err) {
        errors.push(err.message);
      }
    }
    markDirty();
    render();
    if (errors.length) setStatus(errors.join(' '), 'error');
  }

  app.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.field) { data[t.dataset.field] = t.value; markDirty(); }
    else if (t.dataset.pfield) {
      const p = data.projects[view.index];
      const key = t.dataset.pfield;
      if (key === 'title' && (autoSlug.has(p) || p.slug === slugify(p.title))) {
        // The address follows the title until it's changed by hand
        p.slug = uniqueSlug(t.value || 'project', p, data.projects);
        const slugInput = app.querySelector('[data-pfield="slug"]');
        if (slugInput) slugInput.value = p.slug;
      }
      if (key === 'slug') { autoSlug.delete(p); p.slug = slugify(t.value); }
      else p[key] = t.value;
      markDirty();
    }
    else if (t.dataset.imgAlt) { data.projects[view.index].media[+t.dataset.imgAlt].alt = t.value; markDirty(); }
    else if (t.dataset.imgCaption) {
      const m = data.projects[view.index].media[+t.dataset.imgCaption];
      if (t.value.trim()) m.caption = t.value; else delete m.caption;
      markDirty();
    }
    else if (t.dataset.textBody) { data.projects[view.index].media[+t.dataset.textBody].body = t.value; markDirty(); }
    else if (t.dataset.link) { data.links[+t.dataset.link][t.dataset.key] = t.value; markDirty(); }
    else if (t.dataset.page) {
      const pg = data.pages[view.index];
      const link = headerLinkFor(pg);
      const key = t.dataset.page;
      if (key === 'title') {
        // Keep the address and header link in step with the title until they're changed by hand
        if (autoSlug.has(pg) || !pg.slug || pg.slug === slugify(pg.title)) {
          pg.slug = uniqueSlug(t.value, pg);
          const slugInput = app.querySelector('[data-page="slug"]');
          if (slugInput) slugInput.value = pg.slug;
        }
        if (link && (!link.label || link.label === pg.title)) link.label = t.value;
        pg.title = t.value;
      } else if (key === 'slug') {
        autoSlug.delete(pg);
        pg.slug = slugify(t.value);
      } else {
        pg[key] = t.value;
      }
      if (link) link.url = pageUrl(pg.slug);
      markDirty();
    }
  });

  app.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.action === 'images' && t.files.length) addImages([...t.files]);
    if (t.dataset.action === 'media-width') {
      const m = data.projects[view.index].media[+t.dataset.i];
      if (t.value) m.width = t.value; else delete m.width;
      markDirty();
    }
    if (t.dataset.action === 'video-loop') {
      data.projects[view.index].media[+t.dataset.i].loop = t.checked;
      markDirty();
    }
    if (t.dataset.action === 'thumb' && t.files[0]) {
      const p = data.projects[view.index];
      try {
        const { blob, ext } = await processImage(t.files[0]);
        if (p.thumb) removeFile(p.thumb);
        p.thumb = `images/${slugify(p.title)}-thumb-${rand()}.${ext}`;
        addPending(p.thumb, blob);
        markDirty();
        render();
      } catch (err) { setStatus(err.message, 'error'); }
    }
    if (t.dataset.pfield === 'slug') {          // tidy the address once editing it is finished
      const p = data.projects[view.index];
      p.slug = uniqueSlug(t.value || p.title || 'project', p, data.projects);
      t.value = p.slug;
    }
    if (t.dataset.page === 'slug') {           // tidy the address once editing it is finished
      const pg = data.pages[view.index];
      const link = headerLinkFor(pg);
      pg.slug = uniqueSlug(t.value || pg.title, pg);
      t.value = pg.slug;
      if (link) link.url = pageUrl(pg.slug);
    }
    if (t.dataset.action === 'page-header') {
      const pg = data.pages[view.index];
      const link = headerLinkFor(pg);
      if (t.checked && !link) data.links.push({ label: pg.title || 'Page', url: pageUrl(pg.slug) });
      if (!t.checked && link) data.links.splice(data.links.indexOf(link), 1);
      markDirty();
    }
    if (t.dataset.action === 'logo' && t.files[0]) {
      try {
        const { blob, ext } = await processImage(t.files[0], { keepOriginal: true });
        removeFile(data.logo);
        data.logo = `images/logo-${rand()}.${ext}`;
        addPending(data.logo, blob);
        markDirty();
        render();
      } catch (err) { setStatus(err.message, 'error'); }
    }
  });

  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || t.tagName === 'INPUT') return;
    const i = +t.dataset.i;
    const dir = +t.dataset.dir;
    const swap = (arr, a, b) => { [arr[a], arr[b]] = [arr[b], arr[a]]; };

    switch (t.dataset.action) {
      case 'publish': return publish();
      case 'signout':
        if (dirty && !confirm('You have unpublished changes. Sign out anyway?')) return;
        [localStorage, sessionStorage].forEach((x) => x.removeItem(KEY.token));
        dirty = false;
        return renderLogin();
      case 'new':
        data.projects.unshift({ title: '', year: '', subtitle: '', slug: uniqueSlug('project', null, data.projects), description: '', media: [] });
        autoSlug.add(data.projects[0]);
        view = { name: 'edit', index: 0 };
        markDirty();
        render();
        return document.querySelector('[data-pfield="title"]').focus();
      case 'edit':
        view = { name: 'edit', index: i };
        return render(), scrollTo(0, 0);
      case 'back':
        view = { name: 'list', index: -1 };
        return render();
      case 'move':
        swap(data.projects, i, i + dir);
        break;
      case 'delete': {
        const p = data.projects[i];
        if (!confirm(`Delete “${p.title || 'Untitled'}” and its images? (Videos stay on YouTube.)`)) return;
        (p.media || []).forEach((m) => { if (hasFile(m)) removeFile(m.src); });
        if (p.thumb) removeFile(p.thumb);
        data.projects.splice(i, 1);
        break;
      }
      case 'logo-remove':
        removeFile(data.logo);
        data.logo = '';
        break;
      case 'img-move':
        swap(data.projects[view.index].media, i, i + dir);
        break;
      case 'img-cover': {
        const imgs = data.projects[view.index].media;
        imgs.unshift(imgs.splice(i, 1)[0]);
        break;
      }
      case 'img-remove': {
        const imgs = data.projects[view.index].media;
        if (hasFile(imgs[i])) removeFile(imgs[i].src);
        if (imgs[i].poster) removeFile(imgs[i].poster);
        imgs.splice(i, 1);
        break;
      }
      case 'page-new': {
        const pg = { title: '', slug: uniqueSlug('page'), body: '' };
        data.pages.push(pg);
        autoSlug.add(pg);
        data.links.push({ label: '', url: pageUrl(pg.slug) });
        view = { name: 'page', index: data.pages.length - 1 };
        markDirty();
        render();
        return document.querySelector('[data-page="title"]').focus();
      }
      case 'page-edit':
        view = { name: 'page', index: i };
        return render(), scrollTo(0, 0);
      case 'page-delete': {
        const pg = data.pages[i];
        if (!confirm(`Delete the page “${pg.title || 'Untitled page'}”?`)) return;
        data.links = data.links.filter((l) => l.url !== pageUrl(pg.slug));
        data.pages.splice(i, 1);
        break;
      }
      case 'text-add':
        data.projects[view.index].media.push({ type: 'text', body: '' });
        break;
      case 'thumb-remove': {
        const p = data.projects[view.index];
        removeFile(p.thumb);
        delete p.thumb;
        break;
      }
      case 'link-add':
        data.links.push({ label: '', url: '' });
        break;
      case 'link-remove':
        data.links.splice(i, 1);
        break;
      case 'link-move':
        swap(data.links, i, i + dir);
        break;
      default: return;
    }
    markDirty();
    render();
  });

  // Add a YouTube video
  app.addEventListener('submit', (e) => {
    if (e.target.dataset.form !== 'youtube') return;
    e.preventDefault();
    const raw = e.target.elements.yt.value;
    const id = youtubeId(raw);
    const vimeo = !id && vimeoRef(raw);
    if (!id && !vimeo) return setStatus('That doesn’t look like a YouTube or Vimeo link. Try copying the address from the video page or its Share button.', 'error');
    data.projects[view.index].media.push(id ? { type: 'youtube', id, alt: '' } : { type: 'vimeo', ...vimeo, alt: '' });
    markDirty();
    render();
    document.querySelector('[data-form="youtube"] input')?.focus();
  });

  // Drag-and-drop images onto the drop zone
  app.addEventListener('dragover', (e) => {
    const drop = e.target.closest('#drop');
    if (drop) { e.preventDefault(); drop.classList.add('over'); }
  });
  app.addEventListener('dragleave', (e) => e.target.closest('#drop')?.classList.remove('over'));
  app.addEventListener('drop', (e) => {
    const drop = e.target.closest('#drop');
    if (!drop) return;
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...e.dataTransfer.files].filter((f) => /^(image|video)\//.test(f.type));
    if (files.length) addImages(files);
  });

  // If GitHub's raw file server can't show an image, fall back to the live site copy.
  app.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG' || img.dataset.fallback) return;
    const path = img.closest('[data-path]')?.dataset.path;
    if (path) { img.dataset.fallback = '1'; img.src = new URL('../' + path, location.href).href; }
  }, true);

  /* Boot ---------------------------------------------------------- */
  async function bootDownloadMode() {
    LOCAL = true;
    DOWNLOAD = true;
    try {
      const res = await fetch('../content/site.json', { cache: 'no-store' });
      data = normalize(res.ok ? await res.json() : {});
    } catch {
      data = normalize({});
    }
    render();
  }

  (async () => {
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (isLocal) {
      if (!('showDirectoryPicker' in window)) return bootDownloadMode();
      const stored = await savedFolder();
      if (stored && await stored.queryPermission?.({ mode: 'readwrite' }) === 'granted') {
        try { return await openFolder(stored); } catch {}
      }
      return renderFolderPicker(stored);
    }
    cfg.token = store().getItem(KEY.token) || '';
    cfg.repo = store().getItem(KEY.repo) || '';
    if (cfg.token && cfg.repo) connect(); else renderLogin();
  })();
})();
