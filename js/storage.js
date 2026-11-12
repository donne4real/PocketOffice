/* ==========================================================================
   storage.js — IndexedDB persistence + File System Access API helpers
   Shared by every tool. No external deps. Works on file:// in Edge/Chrome.
   ========================================================================== */

const Storage = (() => {
  const DB_NAME = 'pocketoffice';
  const DB_VERSION = 1;
  const STORE = 'docs';
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  let frozen = false;   // set while a restore is replacing everything

  // Tell the shell an autosave could not be written (full disk, wiped
  // profile, storage blocked by policy…) so the user is not left thinking
  // their work is safe. DataCloneError is expected and retried by callers.
  function report(e) {
    if (!e || e.name === 'DataCloneError' || typeof window === 'undefined') return;
    try { window.dispatchEvent(new CustomEvent('po:storage-error', { detail: { name: e.name || 'Error', message: e.message || '' } })); } catch (err) { /* ignore */ }
  }

  function put(db, records, clearFirst) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (clearFirst) store.clear();
      for (const r of records) store.put(r);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      // A full disk usually surfaces as an abort (QuotaExceededError), not an error.
      tx.onabort = () => reject(tx.error || new Error('Storage write was aborted'));
    });
  }

  // Save a document object under a key like "writer:Untitled" or "text:notes.md"
  async function save(key, value) {
    if (frozen) return true;
    try {
      const db = await open();
      return await put(db, [{ key, value, updatedAt: Date.now() }], false);
    } catch (e) {
      report(e);
      throw e;
    }
  }

  // Replace the whole store (restore from a backup). After this, further
  // saves are ignored: the page is about to reload, and a late autosave of
  // the old in-memory documents must not overwrite what was just restored.
  async function replaceAll(records) {
    const db = await open();
    frozen = true;
    try {
      return await put(db, records.map(r => ({ key: r.key, value: r.value, updatedAt: r.updatedAt || Date.now() })), true);
    } catch (e) {
      frozen = false;
      throw e;
    }
  }

  // Browser storage facts: bytes used, quota, and whether the browser has
  // promised not to evict this data when the disk runs low.
  async function health() {
    const out = { usage: null, quota: null, persisted: null };
    try {
      const ns = navigator.storage;
      if (ns && ns.estimate) { const e = await ns.estimate(); out.usage = e.usage; out.quota = e.quota; }
      if (ns && ns.persisted) out.persisted = await ns.persisted();
    } catch (e) { /* not available (old browser, some file:// setups) */ }
    return out;
  }
  // Ask the browser to keep our data (no prompt in Chromium; it decides).
  async function requestPersist() {
    try {
      const ns = navigator.storage;
      if (!ns || !ns.persist) return null;
      return (await ns.persisted()) || (await ns.persist());
    } catch (e) { return null; }
  }

  async function load(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function list(prefix) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const out = req.result
          .filter(r => !prefix || r.key.startsWith(prefix))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  return { open, save, load, remove, list, replaceAll, health, requestPersist };
})();

/* --------------------------------------------------------------------------
   File System Access API wrappers (Edge/Chrome desktop).
   Falls back to <input type=file> for open and Blob download for save
   everywhere else (older browsers, Firefox, file:// quirks).
   The "supportsFSAccess" flag lets each tool pick the right path.
   -------------------------------------------------------------------------- */
const FS = (() => {
  const supported = () =>
    typeof window !== 'undefined' &&
    typeof window.showSaveFilePicker === 'function' &&
    typeof window.showOpenFilePicker === 'function';

  // ---- Remember the last opened/saved file so dialogs reopen in the same folder ----
  // FileSystemHandles are structured-cloneable, so IndexedDB persists them; a
  // file handle passed as `startIn` makes the picker open in its parent folder.
  async function rememberHandle(handle) {
    if (!handle) return;
    try {
      await Storage.save('fs:lastHandle', handle);
    } catch (e) {
      // QuotaExceededError is common on locked-down corporate PCs with
      // roaming profiles; DataCloneError means the browser can't store
      // FileSystemFileHandles. Both are non-fatal but worth surfacing.
      if (e && (e.name === 'QuotaExceededError' || e.name === 'DataCloneError')) {
        if (typeof UI !== 'undefined' && UI.toast) {
          UI.toast('Could not remember file location (' + e.name + ')', 'warn');
        }
      }
    }
  }
  async function lastStartIn() {
    try {
      const h = await Storage.load('fs:lastHandle');
      return (h && typeof h === 'object') ? h : null;
    } catch (e) { return null; }
  }

  // Open: returns { name, text, bytes, handle? }
  async function open({ accept = [{ description: 'All files', accept: { '*/*': [] } }], multiple = false } = {}) {
    if (supported()) {
      const opts = { multiple, types: accept, excludeAcceptAllOption: false };
      const startIn = await lastStartIn();
      let handles;
      try {
        handles = await window.showOpenFilePicker(startIn ? { ...opts, startIn } : opts);
      } catch (e) {
        // A stale remembered location (deleted folder, unplugged drive) can make
        // the picker throw — retry once from the browser's default location.
        if (startIn && e.name !== 'AbortError') handles = await window.showOpenFilePicker(opts);
        else throw e;
      }
      if (handles && handles[0]) rememberHandle(handles[0]);
      const results = [];
      for (const h of handles) {
        const f = await h.getFile();
        const buf = new Uint8Array(await f.arrayBuffer());
        results.push({ name: f.name, text: () => f.text(), bytes: buf, handle: h });
      }
      return multiple ? results : results[0];
    }
    // Fallback: hidden file input
    return new Promise((resolve, reject) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = multiple;
      inp.onchange = async () => {
        if (!inp.files.length) return reject(new Error('cancelled'));
        const results = [];
        for (const f of inp.files) {
          const buf = new Uint8Array(await f.arrayBuffer());
          results.push({ name: f.name, text: () => f.text(), bytes: buf });
        }
        resolve(multiple ? results : results[0]);
      };
      inp.click();
    });
  }

  // Save: if a handle is supplied and writable, reuse it (true Save). Otherwise
  // either prompt with showSaveFilePicker (Save As) or fall back to download.
  async function save({
    name = 'untitled.txt',
    mime = 'application/octet-stream',
    bytes,            // Uint8Array
    handle = null,    // optional FileSystemFileHandle from a previous save
  } = {}) {
    // Try to re-use an existing handle (Ctrl+S on an already-opened file).
    if (handle && handle.createWritable) {
      try {
        // Handles restored from a previous session start without write
        // permission; asking here (inside the Save click) shows the prompt.
        if (handle.queryPermission) {
          let p = await handle.queryPermission({ mode: 'readwrite' });
          if (p !== 'granted' && handle.requestPermission) p = await handle.requestPermission({ mode: 'readwrite' });
          if (p !== 'granted') throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
        }
        const w = await handle.createWritable();
        await w.write(bytes);
        await w.close();
        rememberHandle(handle);
        return { handle, downloaded: false };
      } catch (e) {
        // Permission may have been revoked — fall through to picker.
        if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') console.warn(e);
        if (e.name === 'AbortError') throw e;
      }
    }
    if (supported()) {
      try {
        const ext = (name.split('.').pop() || 'txt').toLowerCase();
        const opts = {
          suggestedName: name,
          types: [{
            description: mime,
            accept: { [mime]: ['.' + ext] },
          }],
        };
        const startIn = await lastStartIn();
        let h;
        try {
          h = await window.showSaveFilePicker(startIn ? { ...opts, startIn } : opts);
        } catch (e) {
          // Stale remembered location — retry once from the default location.
          if (startIn && e.name !== 'AbortError') h = await window.showSaveFilePicker(opts);
          else throw e;
        }
        rememberHandle(h);
        const w = await h.createWritable();
        await w.write(bytes);
        await w.close();
        return { handle: h, downloaded: false };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // fall through to download
      }
    }
    // Universal fallback: trigger a download.
    downloadBlob(name, bytes, mime);
    return { handle: null, downloaded: true };
  }

  function downloadBlob(name, bytes, mime = 'application/octet-stream') {
    // bytes may be a Uint8Array or an ArrayBuffer
    const ab = bytes && bytes.buffer ? bytes.buffer.slice(0) : bytes;
    const blob = new Blob([ab], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  return { supported, open, save, downloadBlob };
})();

/* --------------------------------------------------------------------------
   Tiny UI helpers shared across tools.
   -------------------------------------------------------------------------- */
const UI = (() => {
  // Shared toolbar-button builder. label renders as textContent unless
  // opts.html is set (the four rich-formatting buttons in Writer need
  // real markup); every other option here is optional.
  function button(label, opts = {}) {
    const b = document.createElement('button');
    b.className = 'tb-btn' + (opts.primary ? ' primary' : '') + (opts.iconOnly ? ' icon-only' : '') + (opts.ghost ? ' ghost' : '');
    if (opts.html) b.innerHTML = label; else b.textContent = label;
    if (opts.title) { b.title = opts.title; b.setAttribute('aria-label', opts.title); }
    if (opts.onClick) b.onclick = opts.onClick;
    return b;
  }

  function sep() {
    const s = document.createElement('span');
    s.className = 'tb-sep';
    return s;
  }

  function toast(msg, kind = 'info', ms = 3200) {
    const root = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'success' ? 'ok' : kind === 'error' ? 'err' : kind === 'warn' ? 'warn' : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => el.remove(), 250);
    }, ms);
  }

  // Give every <label> that sits beside a single form control a proper
  // for/id link, so screen readers announce the field's name. Lets callers
  // keep writing plain <label>Rows</label><input …> markup.
  let fieldSeq = 0;
  function linkLabels(root) {
    root.querySelectorAll('label').forEach(label => {
      if (label.htmlFor || label.querySelector('input, select, textarea')) return;
      const control = label.parentElement && label.parentElement.querySelector('input, select, textarea');
      if (!control) return;
      if (!control.id) control.id = 'po-field-' + (++fieldSeq);
      label.htmlFor = control.id;
    });
  }

  const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  let dialogSeq = 0;

  // A modal dialog. Keyboard: focus starts inside, Tab stays inside, Escape
  // cancels, and focus returns to where it was when the dialog closes.
  function dialog({ title, body, okText = 'OK', cancelText = 'Cancel', onOk, onCancel }) {
    const root = document.getElementById('dialogRoot');
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'dialog-backdrop';
    const dlg = document.createElement('div');
    const titleId = 'dialog-title-' + (++dialogSeq);
    dlg.className = 'dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', titleId);
    dlg.innerHTML = `<h3></h3><div class="dialog-body"></div>
      <div class="actions">
        <button class="tb-btn ghost" data-act="cancel"></button>
        <button class="tb-btn primary" data-act="ok"></button>
      </div>`;
    dlg.querySelector('h3').id = titleId;
    dlg.querySelector('h3').textContent = title;
    dlg.querySelector('.dialog-body').appendChild(body);
    dlg.querySelector('[data-act=cancel]').textContent = cancelText;
    dlg.querySelector('[data-act=ok]').textContent = okText;
    // A dialog with no Cancel (cancelText: null) should not leave an empty,
    // unlabeled button in the tab order.
    if (cancelText == null || cancelText === '') dlg.querySelector('[data-act=cancel]').hidden = true;
    linkLabels(dlg);
    back.appendChild(dlg);
    root.appendChild(back);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      back.remove();
      // Hand focus back, unless the caller already moved it somewhere useful.
      const a = document.activeElement;
      if ((!a || a === document.body) && opener && opener.isConnected && typeof opener.focus === 'function') {
        try { opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
    };
    const cancel = () => { if (closed) return; close(); onCancel && onCancel(); };
    dlg.querySelector('[data-act=cancel]').onclick = cancel;
    dlg.querySelector('[data-act=ok]').onclick = async () => {
      if (onOk) { const r = await onOk(dlg); if (r !== false) close(); }
      else close();
    };
    back.addEventListener('mousedown', (e) => { if (e.target === back) cancel(); });
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      if (e.key !== 'Tab') return;
      const items = [...dlg.querySelectorAll(FOCUSABLE)].filter(n => !n.disabled && !n.hidden && n.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    });
    // Start on the first field, or on the main button when there is none.
    const start = dlg.querySelector('.dialog-body input:not([type=hidden]), .dialog-body select, .dialog-body textarea') ||
      dlg.querySelector('.dialog-body button') || dlg.querySelector('[data-act=ok]');
    try { start.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    return { close, el: dlg };
  }

  function prompt({ title, label, value = '', okText = 'OK' }) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.className = 'row';
      body.innerHTML = `<label></label><input type="text" />`;
      body.querySelector('label').textContent = label;
      const input = body.querySelector('input');
      input.value = value;
      const d = dialog({
        title, body, okText,
        onOk: () => resolve(input.value),
        onCancel: () => resolve(null),
      });
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { d.close(); resolve(input.value); }
        if (e.key === 'Escape') { d.close(); resolve(null); }
      });
    });
  }

  function confirm({ title, message, okText = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.textContent = message;
      const d = dialog({
        title, body, okText,
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
      if (danger) d.el.querySelector('[data-act=ok]').style.background = 'var(--danger)';
    });
  }

  return { button, sep, toast, dialog, prompt, confirm, linkLabels };
})();

/* --------------------------------------------------------------------------
   History — per-tool undo/redo stacks.
   Each tool registers a unique key (e.g. 'calc', 'impress'). Before every
   mutating action, the tool calls History.snapshot(key, stateClone, restoreFn)
   where stateClone is a deep-copy of the pre-mutation state and restoreFn is
   a closure that re-applies it. undo()/redo() call the recorded restoreFn.
   -------------------------------------------------------------------------- */
const History = (() => {
  const MAX = 60;
  // String snapshots (Writer/Text/Markdown) are whole documents, and a
  // Writer page with a pasted photo is megabytes of base64 per entry. Cap
  // each key's stacks at roughly this many characters (~50 MB of memory);
  // the oldest undo steps go first. The newest step is always kept.
  const MAX_CHARS = 25e6;
  // stacks[key] = { undo: [], redo: [] }
  const stacks = {};

  function ensure(key) {
    if (!stacks[key]) stacks[key] = { undo: [], redo: [] };
    return stacks[key];
  }
  const sizeOf = (state) => typeof state === 'string' ? state.length : 0;
  function trim(s) {
    let total = 0;
    for (const e of s.undo) total += e.size;
    for (const e of s.redo) total += e.size;
    while (s.undo.length > 1 && (s.undo.length > MAX || total > MAX_CHARS)) {
      total -= s.undo.shift().size;
    }
  }

  // Record a pre-mutation snapshot. stateClone must be a deep copy the tool
  // already made; restoreFn(stateClone) applies it back. Returns nothing.
  function snapshot(key, stateClone, restoreFn) {
    const s = ensure(key);
    s.undo.push({ state: stateClone, restore: restoreFn, size: sizeOf(stateClone) });
    // A new action invalidates the redo branch.
    s.redo.length = 0;
    trim(s);
  }

  function undo(key) {
    const s = ensure(key);
    if (!s.undo.length) return false;
    const entry = s.undo.pop();
    // Before restoring the old state, snapshot the CURRENT state so redo works.
    // We rely on the tool's restoreFn to give us a fresh clone via its own
    // capture; simpler: the tool passes a currentState clone alongside.
    // To keep the API simple, we ask the tool for a "current snapshot" callback
    // stored on ensure(). See registerCurrentSnapshot().
    const curSnapshot = s.capture ? s.capture() : null;
    if (curSnapshot != null && s.captureRestore) {
      s.redo.push({ state: curSnapshot, restore: s.captureRestore, size: sizeOf(curSnapshot) });
    }
    entry.restore(entry.state);
    return true;
  }

  function redo(key) {
    const s = ensure(key);
    if (!s.redo.length) return false;
    const entry = s.redo.pop();
    const curSnapshot = s.capture ? s.capture() : null;
    if (curSnapshot != null && s.captureRestore) {
      s.undo.push({ state: curSnapshot, restore: s.captureRestore, size: sizeOf(curSnapshot) });
      trim(s);
    }
    entry.restore(entry.state);
    return true;
  }

  // A tool tells History how to capture+restore the CURRENT state (for the
  // opposite-direction stack during undo/redo). capture() returns a clone;
  // captureRestore(clone) applies it.
  function registerCurrentSnapshot(key, capture, captureRestore) {
    const s = ensure(key);
    s.capture = capture;
    s.captureRestore = captureRestore;
  }

  function can(key) {
    const s = ensure(key);
    return { undo: s.undo.length > 0, redo: s.redo.length > 0 };
  }

  function reset(key) {
    if (stacks[key]) { stacks[key].undo.length = 0; stacks[key].redo.length = 0; }
    else ensure(key);
  }

  return { snapshot, undo, redo, can, reset, registerCurrentSnapshot };
})();

/* --------------------------------------------------------------------------
   Util — small shared helpers.
   -------------------------------------------------------------------------- */
const Util = (() => {
  // Convert a Uint8Array + filename to a data: URL. Used by Writer/Impress/PdfTools.
  function bytesToBase64(bytes, name) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const ext = (name.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
               : ext === 'gif' ? 'image/gif'
               : ext === 'webp' ? 'image/webp'
               : 'image/png';
    return 'data:' + mime + ';base64,' + btoa(bin);
  }
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  // Next free number for ids like 'w7', 's3', 'e12'. Restored sessions can
  // have gaps (w2, w3 after closing w1), so counting the list is not enough —
  // that handed out 'w3' twice.
  function nextSeq(ids, prefix) {
    let max = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
      const n = parseInt(id.slice(prefix.length), 10);
      if (n > max) max = n;
    }
    return max + 1;
  }
  // A CSS color we are willing to put in markup, or the fallback.
  function safeColor(c, fallback) {
    return (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim())) ? c.trim() : fallback;
  }
  function safeNum(n, fallback) {
    const v = typeof n === 'number' ? n : parseFloat(n);
    return isFinite(v) ? v : fallback;
  }
  // Save a record that may contain FileSystemFileHandles. Browsers that
  // can't store handles in IndexedDB throw DataCloneError — retry without.
  async function saveWithHandles(key, value, stripHandles) {
    try {
      await Storage.save(key, value);
    } catch (e) {
      if (e && e.name === 'DataCloneError') await Storage.save(key, stripHandles(value));
      else throw e;
    }
  }
  return { bytesToBase64, deepClone, nextSeq, safeColor, safeNum, saveWithHandles };
})();

/* --------------------------------------------------------------------------
   Sanitize — the one HTML cleaner for Writer (opened .html/.docx) and the
   Markdown preview. Uses the vendored DOMPurify (lib/purify.min.js); the
   hand-rolled fallback only runs if that file is missing.
   -------------------------------------------------------------------------- */
const Sanitize = (() => {
  const FORBID_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'link', 'meta', 'base'];
  let hooked = false;

  function html(dirty, { newTabLinks = false } = {}) {
    const P = typeof window !== 'undefined' ? window.DOMPurify : null;
    if (P && P.sanitize) {
      if (!hooked) {
        // Opt-in per call: links in the Markdown preview open in a new tab
        // so a click can't navigate PocketOffice itself away.
        P.addHook('afterSanitizeAttributes', (node) => {
          if (Sanitize._newTabLinks && node.tagName === 'A' && node.getAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        });
        hooked = true;
      }
      Sanitize._newTabLinks = newTabLinks;
      try {
        return P.sanitize(dirty, { FORBID_TAGS, FORBID_ATTR: ['formaction', 'srcdoc'], ADD_ATTR: ['target'] });
      } finally {
        Sanitize._newTabLinks = false;
      }
    }
    return fallback(dirty);
  }

  // Parse inertly (DOMParser never loads images or runs handlers), strip
  // active content, keep formatting.
  function fallback(dirty) {
    const doc = new DOMParser().parseFromString('<body>' + dirty, 'text/html');
    doc.body.querySelectorAll('script, svg, math, ' + FORBID_TAGS.join(', ')).forEach(n => n.remove());
    doc.body.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => {
        const v = a.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
        if (/^on/i.test(a.name) || a.name === 'srcdoc' || a.name === 'formaction') el.removeAttribute(a.name);
        else if (/^(href|src|xlink:href|action)$/i.test(a.name) &&
                 (v.startsWith('javascript:') || v.startsWith('vbscript:') ||
                  (v.startsWith('data:') && !(a.name === 'src' && v.startsWith('data:image/') && !v.startsWith('data:image/svg')))))
          el.removeAttribute(a.name);
      });
    });
    return doc.body.innerHTML;
  }

  // Pull the <body> content out of a full HTML document string.
  function bodyOf(htmlText) {
    const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(htmlText);
    return m ? m[1] : htmlText;
  }

  return { html, bodyOf, _newTabLinks: false };
})();

/* --------------------------------------------------------------------------
   Fonts — the font picker lists shared by Writer and Impress.
   BUNDLED families are @font-face'd from lib/fonts/ in css/fonts.css, so
   they render identically everywhere, fully offline. SYSTEM families depend
   on what the host PC has installed (Windows-bundled ClearType fonts first).
   -------------------------------------------------------------------------- */
const Fonts = (() => {
  const SYSTEM = [
    'Calibri', 'Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS',
    'Times New Roman', 'Georgia', 'Palatino Linotype', 'Cambria',
    'Candara', 'Constantia', 'Corbel',
    'Courier New', 'Consolas', 'Lucida Console',
    'Comic Sans MS', 'Impact',
  ];
  const BUNDLED = ['Inter', 'Lora', 'JetBrains Mono'];

  // <option> HTML for a font <select>, grouped by source.
  function options(selected) {
    const opt = (f) => `<option value="${f}" ${f === selected ? 'selected' : ''}>${f}</option>`;
    return `<optgroup label="System fonts">${SYSTEM.map(opt).join('')}</optgroup>` +
           `<optgroup label="Bundled (offline)">${BUNDLED.map(opt).join('')}</optgroup>`;
  }
  return { SYSTEM, BUNDLED, options };
})();

/* --------------------------------------------------------------------------
   Tabs — the multi-document tab strip shared by Writer, Calc and Impress.
   Renders the same .te-tab markup the Text Editor uses, so all four tools
   look identical (and the print styles already hide it). Items are
   { id, name, dirty }. The strip owns no state; the tool re-renders it.
   -------------------------------------------------------------------------- */
const Tabs = (() => {
  function create({ mount, onActivate, onClose, onNew, onReorder, newTitle = 'New' }) {
    const strip = document.createElement('div');
    strip.className = 'te-tabs';
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', 'Document tabs');
    mount.appendChild(strip);
    let dragId = null;
    // The strip is rebuilt on every render; put focus back on the same tab.
    const refocus = (id) => {
      const t = [...strip.querySelectorAll('.te-tab')].find(n => n.dataset.tabId === id);
      if (t) t.focus();
    };
    const clearOver = () => strip.querySelectorAll('.drag-over').forEach(n => n.classList.remove('drag-over'));
    // Let the strip itself absorb stray drops (drops on the gaps between
    // tabs would otherwise be treated as a URL drop by the browser).
    strip.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
    strip.addEventListener('drop', (e) => { if (dragId) { e.preventDefault(); dragId = null; clearOver(); } });
    function render(list, activeId) {
      strip.innerHTML = '';
      list.forEach(d => {
        const isActive = d.id === activeId;
        const t = document.createElement('div');
        t.className = 'te-tab' + (isActive ? ' active' : '') + (d.dirty ? ' dirty' : '');
        t.title = d.name;
        t.draggable = true;
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        t.setAttribute('tabindex', isActive ? '0' : '-1');
        t.addEventListener('dragstart', (e) => {
          dragId = d.id;
          t.classList.add('dragging');
          try { e.dataTransfer.setData('text/plain', d.id); } catch (err) { /* IE */ }
          e.dataTransfer.effectAllowed = 'move';
        });
        t.addEventListener('dragend', () => { t.classList.remove('dragging'); dragId = null; clearOver(); });
        t.addEventListener('dragover', (e) => {
          if (!dragId || dragId === d.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          clearOver();
          t.classList.add('drag-over');
        });
        t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
        t.addEventListener('drop', (e) => {
          e.preventDefault();
          const id = dragId;
          clearOver();
          dragId = null;
          if (id && id !== d.id && onReorder) onReorder(id, d.id);
        });
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = d.name;
        t.appendChild(nm);
        const x = document.createElement('span');
        x.className = 'close';
        x.textContent = '✕';
        x.title = 'Close';
        x.setAttribute('role', 'button');
        x.setAttribute('aria-label', 'Close ' + d.name);
        x.onclick = (e) => { e.stopPropagation(); onClose(d.id); };
        t.appendChild(x);
        t.onclick = () => { if (d.id !== activeId) onActivate(d.id); };
        // Keyboard: arrows move between tabs, Enter/Space opens one, Delete closes it.
        t.addEventListener('keydown', (e) => {
          if (e.target !== t) return;
          const all = [...strip.querySelectorAll('.te-tab')];
          const i = all.indexOf(t);
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const next = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
            if (next) next.focus();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (d.id !== activeId) { onActivate(d.id); refocus(d.id); }
          } else if (e.key === 'Delete') {
            e.preventDefault();
            onClose(d.id);
          }
        });
        t.dataset.tabId = d.id;
        // Every tab can take focus; only the active one is in the Tab order.
        if (!isActive) t.addEventListener('focus', () => t.setAttribute('tabindex', '0'));
        if (!isActive) t.addEventListener('blur', () => t.setAttribute('tabindex', '-1'));
        strip.appendChild(t);
      });
      const plus = document.createElement('button');
      plus.className = 'te-new';
      plus.textContent = '＋ New';
      plus.title = newTitle;
      plus.setAttribute('aria-label', newTitle);
      plus.onclick = onNew;
      strip.appendChild(plus);
    }
    return { render };
   }
   return { create };
})();

/* --------------------------------------------------------------------------
   PdfFonts — jsPDF custom-font support for the bundled families.
   lib/embedded-fonts.js (generated by _gen-embedded-fonts.js) maps
   'Family|style' -> base64 TTF so exports work offline, file:// safe.
   register(pdf) loads the fonts into one jsPDF instance (once per
   instance); pick() maps a document font + bold/italic onto an available
   { family, style }, degrading to the built-in Helvetica when needed.
   -------------------------------------------------------------------------- */
const PdfFonts = (() => {
  const FAMILIES = ['Inter', 'Lora', 'JetBrains Mono'];
  const registered = new WeakSet();
  const embedded = () => window.EMBEDDED_TTF || null;
  function register(pdf) {
    const ttf = embedded();
    if (!ttf || registered.has(pdf)) return;
    registered.add(pdf);
    for (const key of Object.keys(ttf)) {
      const [fam, style] = key.split('|');
      const fname = fam.replace(/\s+/g, '') + '-' + style + '.ttf';
      try {
        pdf.addFileToVFS(fname, ttf[key]);
        pdf.addFont(fname, fam, style);
      } catch (e) { /* skip unreadable font */ }
    }
  }
  // System fonts can't be embedded, so map them onto the closest of the
  // PDF standard families instead of always falling back to Helvetica.
  const SERIF = /times|georgia|cambria|palatino|constantia|garamond|book antiqua|serif$/i;
  const MONO = /courier|consolas|lucida console|mono/i;
  function standardFamily(family) {
    if (family && MONO.test(family)) return 'courier';
    if (family && SERIF.test(family) && !/sans/i.test(family)) return 'times';
    return 'helvetica';
  }
  function pick(family, bold, italic) {
    const want = (bold && italic) ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal';
    const ttf = embedded();
    if (!family || !ttf || !FAMILIES.includes(family)) {
      return { family: standardFamily(family), style: want };
    }
    const has = (st) => !!ttf[family + '|' + st];
    // JetBrains Mono ships without italics — degrade italic to its weights.
    if (has(want)) return { family, style: want };
    if (want === 'bolditalic' && has('bold')) return { family, style: 'bold' };
    if ((want === 'italic' || want === 'bolditalic') && has('normal')) return { family, style: 'normal' };
    return { family: standardFamily(family), style: want };
  }
  return { register, pick };
})();

/* --------------------------------------------------------------------------
   Backup — everything PocketOffice keeps in the browser, as one .zip.
   The zip holds pocketoffice-backup.json (what Restore reads back) plus
   readable copies of each document, so the files are useful even without
   PocketOffice. Browser storage can be wiped by the browser, by IT policy
   or by a profile reset; a backup on disk cannot.
   -------------------------------------------------------------------------- */
const Backup = (() => {
  const DATA_FILE = 'pocketoffice-backup.json';
  const KEY_RE = /^[a-z]{2,20}:[\w.:\- ]{1,120}$/i;
  const MAX_BYTES = 300 * 1024 * 1024;

  const safeName = (s, fallback) => (String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || fallback).slice(0, 80);
  // File handles cannot be written to JSON; everything else is plain data.
  const plain = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k === 'handle' ? null : val)));
  const withExt = (name, ext) => /\.[a-z0-9]{1,5}$/i.test(name) ? name : name + '.' + ext;

  // Raw cell text as CSV (formulas kept as typed).
  function cellsToCsv(cells) {
    let maxR = -1, maxC = -1;
    const grid = new Map();
    for (const addr of Object.keys(cells || {})) {
      const a = Formula.parseAddr(addr);
      if (!a) continue;
      maxR = Math.max(maxR, a.row); maxC = Math.max(maxC, a.col);
      grid.set(a.row + ':' + a.col, String(cells[addr] ?? ''));
    }
    const lines = [];
    for (let r = 0; r <= maxR; r++) {
      const row = [];
      for (let c = 0; c <= maxC; c++) {
        const v = grid.get(r + ':' + c) || '';
        row.push(/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
      }
      lines.push(row.join(','));
    }
    return lines.join('\r\n');
  }

  // Human-readable copies: [{ path, content }].
  function readableCopies(get) {
    const out = [];
    const used = new Set();
    const add = (folder, name, content) => {
      let path = folder + '/' + name, n = 2;
      while (used.has(path.toLowerCase())) path = folder + '/' + name.replace(/(\.[^.]*)?$/, ' (' + (n++) + ')$1');
      used.add(path.toLowerCase());
      out.push({ path, content });
    };
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const w = get('writer:docs');
    for (const d of (w && Array.isArray(w.docs) ? w.docs : [])) {
      const name = safeName(d.name, 'document').replace(/\.(docx?|txt)$/i, '') ;
      add('Writer', withExt(name, 'html').replace(/\.htm$/i, '.html'),
        '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + esc(name) + '</title></head><body>\n' + (d.html || '') + '\n</body></html>');
    }
    const t = get('texteditor:session');
    for (const b of (t && Array.isArray(t.buffers) ? t.buffers : [])) add('Text Editor', withExt(safeName(b.name, 'untitled'), 'txt'), String(b.text ?? ''));
    const m = get('markdown:doc');
    if (m && typeof m.source === 'string' && m.source.trim()) add('Markdown', withExt(safeName(m.name, 'document'), 'md'), m.source);
    const c = get('calc:sheets');
    for (const s of (c && Array.isArray(c.sheets) ? c.sheets : [])) {
      const csv = cellsToCsv(s.cells);
      if (csv) add('Calc', safeName(s.name, 'sheet') + '.csv', csv);
    }
    const i = get('impress:decks');
    for (const d of (i && Array.isArray(i.decks) ? i.decks : [])) {
      add('Impress', safeName(d.name, 'deck') + '.json', JSON.stringify({ slides: d.slides || [] }, null, 2));
    }
    return out;
  }

  // Build the backup. Returns { bytes, name, documents }.
  async function create() {
    await Libs.need('jszip');
    const records = (await Storage.list())
      .filter(r => typeof r.key === 'string' && !r.key.startsWith('fs:'))
      .map(r => ({ key: r.key, value: plain(r.value), updatedAt: r.updatedAt }));
    const zip = new window.JSZip();
    const created = new Date();
    zip.file(DATA_FILE, JSON.stringify({ app: 'PocketOffice', format: 1, version: PO_VERSION.version, created: created.toISOString(), records }));
    const get = (key) => (records.find(r => r.key === key) || {}).value;
    const copies = readableCopies(get);
    for (const f of copies) zip.file(f.path, f.content);
    zip.file('README.txt',
      'PocketOffice backup, made ' + created.toLocaleString() + '\r\n\r\n' +
      'To restore everything: open PocketOffice, click the Backup button (top right),\r\n' +
      'choose "Restore from a backup" and pick this .zip file.\r\n\r\n' +
      'The folders hold ordinary copies of each document (.html, .txt, .md, .csv, .json)\r\n' +
      'that open in any program. Calc copies are CSV, so they keep the cell contents\r\n' +
      'and formulas but not the formatting or charts - Restore brings those back.\r\n');
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const stamp = created.getFullYear() + '-' + String(created.getMonth() + 1).padStart(2, '0') + '-' + String(created.getDate()).padStart(2, '0');
    return { bytes, name: 'PocketOffice-backup-' + stamp + '.zip', documents: copies.length };
  }

  // Read a backup zip and return its records, validated. Throws if it is
  // not a PocketOffice backup.
  async function read(bytes) {
    if (!bytes || bytes.length > MAX_BYTES) throw new Error('That file is too large to be a PocketOffice backup.');
    await Libs.need('jszip');
    let zip;
    try { zip = await window.JSZip.loadAsync(bytes); } catch (e) { throw new Error('That file is not a .zip backup.'); }
    const entry = zip.file(DATA_FILE);
    if (!entry) throw new Error('No ' + DATA_FILE + ' inside — this is not a PocketOffice backup.');
    let data;
    try { data = JSON.parse(await entry.async('string')); } catch (e) { throw new Error('The backup data is damaged.'); }
    if (!data || data.app !== 'PocketOffice' || !Array.isArray(data.records)) throw new Error('This is not a PocketOffice backup.');
    const records = [];
    for (const r of data.records) {
      if (!r || typeof r.key !== 'string' || !KEY_RE.test(r.key) || r.key.startsWith('fs:') || r.value == null) continue;
      const rec = { key: r.key, value: r.value, updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now() };
      // A backup is a file from outside: clean Writer's HTML like any opened file.
      if (rec.key === 'writer:docs' && rec.value && Array.isArray(rec.value.docs)) {
        rec.value.docs = rec.value.docs.filter(d => d && typeof d === 'object')
          .map(d => Object.assign({}, d, { html: Sanitize.html(String(d.html || '')), handle: null }));
      }
      records.push(rec);
    }
    if (!records.length) throw new Error('The backup holds no documents.');
    return { records, created: typeof data.created === 'string' ? data.created : '', version: String(data.version || '') };
  }

  return { create, read, cellsToCsv, DATA_FILE };
})();

// Node (unit tests) can load the pure helpers from this file.
if (typeof module !== 'undefined' && module.exports) module.exports = { Util, History, Backup };

