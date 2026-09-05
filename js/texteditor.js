/* ==========================================================================
   texteditor.js — tabbed plain-text editor with autosave & native file I/O
   ========================================================================== */

const TextEditor = (() => {
  // Each buffer: { id, name, mode, text, dirty, handle }
  const buffers = [];
  let activeId = null;
  let seq = 1;
  const closedBuffers = [];    // recently closed, for Ctrl+Shift+T reopen
  let tabs = null;             // shared tab strip (see Tabs in storage.js)

  const $ = (id) => document.getElementById(id);
  const els = {
    tabs:     () => $('teTabs'),
    gutter:   () => $('teGutter'),
    textarea: () => $('teTextarea'),
    mode:     () => $('teMode'),
    findBar:  () => $('teFindBar'),
    findIn:   () => $('teFindInput'),
    findCnt:  () => $('teFindCount'),
    status:   () => $('statusInfo'),
  };

  const EXT_FOR_MODE = { txt: 'txt', md: 'md', json: 'json', js: 'js', csv: 'csv', html: 'html', log: 'log', ini: 'ini' };
  const MODE_FOR_EXT = {
    txt: 'txt', text: 'txt', md: 'md', markdown: 'md',
    json: 'json', js: 'js', mjs: 'js', csv: 'csv', html: 'html', htm: 'html',
    log: 'log', ini: 'ini', cfg: 'ini', conf: 'ini', yaml: 'txt', yml: 'txt', xml: 'html',
  };

  function newBuffer({ name = null, text = '', mode = 'txt', handle = null } = {}) {
    const id = 'b' + (seq++);
    if (!name) name = `Untitled-${seq - 1}.${EXT_FOR_MODE[mode] || 'txt'}`;
    buffers.push({ id, name, text, mode, dirty: false, handle });
    activeId = id;
    History.reset('text:' + id);
    renderTabs();
    loadIntoEditor();
    autosaveSoon();
    return id;
  }

  function active() { return buffers.find(b => b.id === activeId); }

  function activate(id) {
    captureActive();
    activeId = id;
    renderTabs();
    loadIntoEditor();
  }

  function closeBuffer(id) {
    const i = buffers.findIndex(b => b.id === id);
    if (i < 0) return;
    const b = buffers[i];
    const doClose = async () => {
      // Park the closed buffer for Ctrl+Shift+T reopen. Text is current:
      // inactive buffers hold theirs; the active one syncs just below.
      if (b.id === activeId) captureActive();
      closedBuffers.unshift(b);
      if (closedBuffers.length > 10) closedBuffers.length = 10;
      buffers.splice(i, 1);
      Storage.remove('text:' + b.name);
      History.reset('text:' + b.id);
      if (activeId === id) {
        activeId = buffers.length ? buffers[Math.max(0, i - 1)].id : null;
      }
      if (!buffers.length) {
        newBuffer();
      } else {
        renderTabs();
        loadIntoEditor();
      }
    };
    if (b.dirty) {
      UI.confirm({ title: `Close ${b.name}?`, message: 'Unsaved changes will be lost.', okText: 'Close anyway', danger: true })
        .then(ok => { if (ok) doClose(); });
    } else {
      doClose();
    }
  }

  // Reopen the most recently closed buffer (Ctrl+Shift+T).
  function reopenBuffer() {
    if (!closedBuffers.length) { UI.toast('No recently closed tabs', 'info'); return; }
    const b = closedBuffers.shift();
    buffers.push(b);
    activeId = b.id;
    renderTabs();
    loadIntoEditor();
    autosaveSoon();
    UI.toast(`Reopened ${b.name}`, 'success');
  }

  function captureActive() {
    const b = active();
    if (b) { b.text = els.textarea().value; }
  }

  function loadIntoEditor() {
    const b = active();
    if (!b) { els.textarea().value = ''; updateGutter(); updateStatus(); return; }
    els.textarea().value = b.text;
    els.mode().value = b.mode;
    updateGutter();
    updateStatus();
    els.textarea().focus();
  }

  function renderTabs() {
    if (!tabs) return;
    tabs.render(buffers.map(b => ({ id: b.id, name: b.name, dirty: b.dirty })), activeId);
  }

  // Drag-to-reorder callback from the shared tab strip.
  function reorderBuffers(fromId, toId) {
    const from = buffers.findIndex(b => b.id === fromId);
    const to = buffers.findIndex(b => b.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = buffers.splice(from, 1);
    buffers.splice(to, 0, moved);
    renderTabs();
    autosaveSoon();
  }

  // ----- Undo (per-buffer, debounced on input) -----
  let teUndoTimer = null;
  let teUndoArmed = {};
  function teSnapshotKey() { const b = active(); return b ? 'text:' + b.id : null; }
  function teCapture() { const b = active(); return b ? b.text : null; }
  function teRestore(text) {
    const b = active(); if (!b) return;
    b.text = text; els.textarea().value = text;
    updateGutter(); updateStatus(); markDirty();
  }
  function teScheduleSnapshot() {
    const b = active(); if (!b) return;
    const key = 'text:' + b.id;
    clearTimeout(teUndoTimer);
    teUndoTimer = setTimeout(() => { teUndoArmed[key] = false; }, 600);
    if (teUndoArmed[key]) return;
    teUndoArmed[key] = true;
    History.registerCurrentSnapshot(key, () => teCapture(), (t) => teRestore(t));
    History.snapshot(key, b.text, (t) => teRestore(t));
  }
  function teUndo() { const k = teSnapshotKey(); if (k) History.undo(k); }
  function teRedo() { const k = teSnapshotKey(); if (k) History.redo(k); }

  function markDirty() {
    const b = active();
    if (!b) return;
    b.text = els.textarea().value;
    if (!b.dirty) { b.dirty = true; renderTabs(); }
    updateGutter();
    updateStatus();
    autosaveSoon();
  }

  function updateGutter() {
    const ta = els.textarea();
    const lines = ta.value.split('\n').length;
    const nums = [];
    for (let i = 1; i <= lines; i++) nums.push(i);
    els.gutter().textContent = nums.join('\n');
  }

  function updateStatus() {
    const b = active();
    if (!b) { els.status().textContent = ''; return; }
    const text = b.text;
    const lines = text.split('\n').length;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    els.status().textContent = `${lines} lines · ${words} words · ${chars} chars`;
  }

  // ----- Save / Open -----
  async function openFile() {
    try {
      const f = await FS.open({ multiple: false });
      const text = await f.text();
      newBuffer({ name: f.name, text, mode: MODE_FOR_EXT[(f.name.split('.').pop() || 'txt').toLowerCase()] || 'txt', handle: f.handle || null });
      UI.toast(`Opened ${f.name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Open failed: ' + e.message, 'error');
    }
  }

  async function saveFile(asNew = false) {
    const b = active();
    if (!b) return;
    b.text = els.textarea().value;
    const ext = EXT_FOR_MODE[b.mode] || 'txt';
    const name = b.name.endsWith('.' + ext) ? b.name : b.name.replace(/\.[^.]*$/, '') + '.' + ext;
    const mime = b.mode === 'html' ? 'text/html'
      : b.mode === 'json' || b.mode === 'js' || b.mode === 'csv' ? 'text/plain'
      : 'text/plain';
    const bytes = new TextEncoder().encode(b.text);
    try {
      const res = await FS.save({
        name,
        mime,
        bytes,
        handle: asNew ? null : b.handle,
      });
      if (res.handle) b.handle = res.handle;
      b.name = name;
      b.dirty = false;
      renderTabs();
      autosaveSoon();
      UI.toast(res.downloaded ? `Downloaded ${name}` : `Saved ${name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Save failed: ' + e.message, 'error');
    }
  }

  // ----- Find -----
  let findMatches = [];
  let findIdx = -1;

  function toggleFind() {
    const bar = els.findBar();
    bar.classList.toggle('open');
    if (bar.classList.contains('open')) els.findIn().focus();
  }

  function runFind() {
    const q = els.findIn().value;
    const ta = els.textarea();
    if (!q) { findMatches = []; findIdx = -1; els.findCnt().textContent = ''; return; }
    const text = ta.value;
    findMatches = [];
    let i = 0;
    const lower = text.toLowerCase();
    const lq = q.toLowerCase();
    while ((i = lower.indexOf(lq, i)) !== -1) { findMatches.push(i); i += lq.length; }
    if (!findMatches.length) {
      els.findCnt().textContent = '0 / 0';
      ta.setSelectionRange(0, 0);
      return;
    }
    findIdx = 0;
    jumpToMatch();
  }

  function jumpToMatch(dir = 1) {
    if (!findMatches.length) return;
    findIdx = (findIdx + dir + findMatches.length) % findMatches.length;
    const start = findMatches[findIdx];
    const q = els.findIn().value;
    const ta = els.textarea();
    ta.focus();
    ta.setSelectionRange(start, start + q.length);
    // scroll into view
    const lineNum = ta.value.substr(0, start).split('\n').length;
    const lineHeight = 19.5;
    ta.scrollTop = (lineNum - 4) * lineHeight;
    els.findCnt().textContent = `${findIdx + 1} / ${findMatches.length}`;
  }

  // ----- Autosave to IndexedDB -----
  let autosaveTimer = null;
  function autosaveSoon() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 800);
  }
  async function autosaveNow() {
    for (const b of buffers) {
      try { await Storage.save('text:' + b.name, { text: b.text, mode: b.mode }); } catch (e) { /* ignore */ }
    }
    const el = document.getElementById('statusAutosave');
    if (el) {
      const t = new Date().toLocaleTimeString();
      el.textContent = `autosaved ${t}`;
      setTimeout(() => { if (el.textContent === `autosaved ${t}`) el.textContent = ''; }, 2000);
    }
  }

  // ----- Boot: restore from IndexedDB or start fresh -----
  async function boot() {
    // Swap the static #teTabs div for the shared Tabs strip (same classes,
    // plus drag-to-reorder) mounted in the same spot.
    const oldStrip = els.tabs();
    const mount = oldStrip.parentElement;
    oldStrip.remove();
    tabs = Tabs.create({
      mount,
      onActivate: activate,
      onClose: closeBuffer,
      onNew: () => newBuffer(),
      onReorder: reorderBuffers,
      newTitle: 'New text file',
    });
    wireEvents();
    try {
      const items = await Storage.list('text:');
      if (items.length) {
        for (const it of items) {
          const v = it.value || {};
          buffers.push({
            id: 'b' + (seq++),
            name: it.key.replace(/^text:/, ''),
            text: v.text || '',
            mode: v.mode || 'txt',
            dirty: false,
            handle: null,
          });
        }
        activeId = buffers[0].id;
        renderTabs();
        loadIntoEditor();
        return;
      }
    } catch (e) { /* ignore */ }
    newBuffer({ name: 'Untitled-1.txt', text: '', mode: 'txt' });
  }

  function wireEvents() {
    const ta = els.textarea();
    ta.addEventListener('input', () => { teScheduleSnapshot(); markDirty(); });
    ta.addEventListener('keydown', (e) => {
      // Tab inserts 4 spaces instead of moving focus
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.substring(0, s) + '    ' + ta.value.substring(en);
        ta.selectionStart = ta.selectionEnd = s + 4;
        markDirty();
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Enter = quick save
        e.preventDefault();
        saveFile(false);
      }
      if (e.ctrlKey && (e.key === 's')) {
        e.preventDefault();
        saveFile(false);
      }
    });
    ta.addEventListener('scroll', () => { els.gutter().scrollTop = ta.scrollTop; });

    $('teNew').onclick = () => newBuffer();
    $('teOpen').onclick = openFile;
    $('teSave').onclick = () => saveFile(false);
    $('teSaveAs').onclick = () => saveFile(true);

    els.mode().onchange = () => {
      const b = active(); if (!b) return;
      b.mode = els.mode().value;
      b.name = b.name.replace(/\.[^.]*$/, '') + '.' + (EXT_FOR_MODE[b.mode] || 'txt');
      markDirty();
      renderTabs();
    };

    $('teFind').onclick = toggleFind;
    $('teFindClose').onclick = toggleFind;
    $('teFindNext').onclick = () => jumpToMatch(1);
    $('teFindPrev').onclick = () => jumpToMatch(-1);
    els.findIn().addEventListener('input', runFind);
    els.findIn().addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); jumpToMatch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') toggleFind();
    });

    const wrapBtn = $('teWordWrap');
    let wrapped = false;
    wrapBtn.onclick = () => {
      wrapped = !wrapped;
      ta.wrap = wrapped ? 'soft' : 'off';
      wrapBtn.classList.toggle('active', wrapped);
    };
  }

  function onActivate() {
    // when switching TO text editor
    setTimeout(() => els.textarea().focus(), 0);
  }

  return { boot, newBuffer, onActivate, undo: teUndo, redo: teRedo, reopen: reopenBuffer };
})();
