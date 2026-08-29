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

  // Save a document object under a key like "writer:Untitled" or "text:notes.md"
  async function save(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        key,
        value,
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
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

  return { open, save, load, remove, list };
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
    try { await Storage.save('fs:lastHandle', handle); } catch (e) { /* non-fatal */ }
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

  function dialog({ title, body, okText = 'OK', cancelText = 'Cancel', onOk, onCancel }) {
    const root = document.getElementById('dialogRoot');
    const back = document.createElement('div');
    back.className = 'dialog-backdrop';
    const dlg = document.createElement('div');
    dlg.className = 'dialog';
    dlg.innerHTML = `<h3></h3><div class="dialog-body"></div>
      <div class="actions">
        <button class="tb-btn ghost" data-act="cancel"></button>
        <button class="tb-btn primary" data-act="ok"></button>
      </div>`;
    dlg.querySelector('h3').textContent = title;
    dlg.querySelector('.dialog-body').appendChild(body);
    dlg.querySelector('[data-act=cancel]').textContent = cancelText;
    dlg.querySelector('[data-act=ok]').textContent = okText;
    back.appendChild(dlg);
    root.appendChild(back);
    const close = () => back.remove();
    dlg.querySelector('[data-act=cancel]').onclick = () => { close(); onCancel && onCancel(); };
    dlg.querySelector('[data-act=ok]').onclick = async () => {
      if (onOk) { const r = await onOk(dlg); if (r !== false) close(); }
      else close();
    };
    back.addEventListener('mousedown', (e) => { if (e.target === back) { close(); onCancel && onCancel(); } });
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

  return { toast, dialog, prompt, confirm };
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
  // stacks[key] = { undo: [], redo: [] }
  const stacks = {};

  function ensure(key) {
    if (!stacks[key]) stacks[key] = { undo: [], redo: [] };
    return stacks[key];
  }

  // Record a pre-mutation snapshot. stateClone must be a deep copy the tool
  // already made; restoreFn(stateClone) applies it back. Returns nothing.
  function snapshot(key, stateClone, restoreFn) {
    const s = ensure(key);
    s.undo.push({ state: stateClone, restore: restoreFn });
    if (s.undo.length > MAX) s.undo.shift();
    // A new action invalidates the redo branch.
    s.redo.length = 0;
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
    if (curSnapshot && s.captureRestore) {
      s.redo.push({ state: curSnapshot, restore: s.captureRestore });
    }
    entry.restore(entry.state);
    return true;
  }

  function redo(key) {
    const s = ensure(key);
    if (!s.redo.length) return false;
    const entry = s.redo.pop();
    const curSnapshot = s.capture ? s.capture() : null;
    if (curSnapshot && s.captureRestore) {
      s.undo.push({ state: curSnapshot, restore: s.captureRestore });
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
  return { bytesToBase64, deepClone };
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
  function create({ mount, onActivate, onClose, onNew, newTitle = 'New' }) {
    const strip = document.createElement('div');
    strip.className = 'te-tabs';
    mount.appendChild(strip);
    function render(list, activeId) {
      strip.innerHTML = '';
      list.forEach(d => {
        const t = document.createElement('div');
        t.className = 'te-tab' + (d.id === activeId ? ' active' : '') + (d.dirty ? ' dirty' : '');
        t.title = d.name;
        const nm = document.createElement('span');
        nm.className = 'name';
        nm.textContent = d.name;
        t.appendChild(nm);
        const x = document.createElement('span');
        x.className = 'close';
        x.textContent = '✕';
        x.title = 'Close';
        x.onclick = (e) => { e.stopPropagation(); onClose(d.id); };
        t.appendChild(x);
        t.onclick = () => { if (d.id !== activeId) onActivate(d.id); };
        strip.appendChild(t);
      });
      const plus = document.createElement('button');
      plus.className = 'te-new';
      plus.textContent = '＋ New';
      plus.title = newTitle;
      plus.onclick = onNew;
      strip.appendChild(plus);
    }
    return { render };
  }
  return { create };
})();

