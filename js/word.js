/* ==========================================================================
   word.js — Writer: a rich-text word processor using contentEditable.
   Toolbar with formatting, table/image/link, find&replace, autosave, and
   export to .html / .txt / .pdf (jsPDF) / .docx (docx lib).
   ========================================================================== */

const Writer = (() => {
  // Open documents: { id, name, handle, dirty, html }. The active tab's
  // content lives in the editor DOM; inactive tabs park theirs in .html.
  const docs = [];
  let activeId = null;
  let docSeq = 1;
  const closedDocs = [];       // recently closed, for Ctrl+Shift+T reopen
  let autosaveTimer = null;
  let tabs = null;            // shared tab strip (see Tabs in storage.js)

  const $ = (id) => document.getElementById(id);
  let editor = null;          // the contenteditable div

  function activeDoc() { return docs.find(d => d.id === activeId); }
  function docKey() { return 'writer:' + activeId; }
  // A pristine untitled tab (never typed in, never saved) can be reused in
  // place when opening a file — browser-style.
  function isPristine() {
    const d = activeDoc();
    return !!d && !d.dirty && /^Untitled-\d+\.html$/.test(d.name) &&
      editor.textContent.trim() === '' && !editor.querySelector('img, table, hr, a');
  }

  // ----- Toolbar definition (rendered into #writerToolbar) -----
  const SIZES = [1, 2, 3, 4, 5, 6, 7];   // document.execCommand fontSize uses 1..7

  function buildToolbar() {
    const tb = $('writerToolbar');
    tb.innerHTML = '';

    const group = (items) => {
      const g = document.createElement('span');
      g.className = 'tb-group';
      items.forEach(i => g.appendChild(i));
      tb.appendChild(g);
      const sep = document.createElement('span');
      sep.className = 'tb-sep';
      tb.appendChild(sep);
    };
    const btn = (label, cmd, title, opts = {}) => {
      const b = document.createElement('button');
      b.className = 'tb-btn' + (opts.primary ? ' primary' : '') + (opts.iconOnly ? ' icon-only' : '');
      b.innerHTML = label;
      b.title = title || '';
      b.onclick = () => { editor.focus(); run(cmd, opts.value); };
      return b;
    };

    // File group
    group([
      btn('＋ New', 'new', 'New document'),
      btn('📂 Open', 'open', 'Open…'),
      btn('💾 Save', 'save', 'Save (Ctrl+S)'),
      btn('Save As…', 'saveas', 'Save As…'),
      btn('Export ▾', 'export', 'Export to .docx / .pdf', { iconOnly: false }),
      btn('🖨️', 'print', 'Print'),
    ]);

    // Undo/redo
    const undoBtn = document.createElement('button');
    undoBtn.className = 'tb-btn icon-only'; undoBtn.innerHTML = '↶'; undoBtn.title = 'Undo (Ctrl+Z)';
    undoBtn.onclick = () => { editor.focus(); doUndo(); };
    const redoBtn = document.createElement('button');
    redoBtn.className = 'tb-btn icon-only'; redoBtn.innerHTML = '↷'; redoBtn.title = 'Redo (Ctrl+Y)';
    redoBtn.onclick = () => { editor.focus(); doRedo(); };
    group([undoBtn, redoBtn]);

    // Font + size
    const fontSel = document.createElement('select');
    fontSel.className = 'tb-select';
    fontSel.innerHTML = Fonts.options('Calibri');
    fontSel.style.minWidth = '130px';
    fontSel.onchange = () => { editor.focus(); run('fontname', fontSel.value); };
    const sizeSel = document.createElement('select');
    sizeSel.className = 'tb-select';
    sizeSel.style.width = '60px';
    sizeSel.innerHTML = SIZES.map(s => `<option value="${s}">${s}</option>`).join('');
    sizeSel.value = 3;
    sizeSel.onchange = () => { editor.focus(); run('fontsize', sizeSel.value); };
    group([fontSel, sizeSel]);

    // Inline format
    group([
      btn('<b>B</b>', 'bold', 'Bold (Ctrl+B)'),
      btn('<i>I</i>', 'italic', 'Italic (Ctrl+I)'),
      btn('<u>U</u>', 'underline', 'Underline (Ctrl+U)'),
      btn('<s>S</s>', 'strikeThrough', 'Strikethrough'),
      btn('🎨', 'foreColor', 'Text color', { value: null }),
      btn('🟡', 'hiliteColor', 'Highlight', { value: null }),
    ]);

    // Block format
    const blockSel = document.createElement('select');
    blockSel.className = 'tb-select';
    blockSel.style.minWidth = '110px';
    blockSel.innerHTML = `
      <option value="p">Paragraph</option>
      <option value="h1">Heading 1</option>
      <option value="h2">Heading 2</option>
      <option value="h3">Heading 3</option>
      <option value="h4">Heading 4</option>
      <option value="pre">Code</option>
      <option value="blockquote">Quote</option>`;
    blockSel.onchange = () => {
      editor.focus();
      const v = blockSel.value;
      if (v === 'pre' || v === 'blockquote') run('formatBlock', '<' + v + '>');
      else run('formatBlock', '<' + v + '>');
    };
    group([blockSel]);

    // Alignment + list
    group([
      btn('⬅', 'justifyLeft', 'Align left'),
      btn('⬌', 'justifyCenter', 'Center'),
      btn('➡', 'justifyRight', 'Align right'),
      btn('⚖', 'justifyFull', 'Justify'),
      btn('•≡', 'insertUnorderedList', 'Bulleted list'),
      btn('1.≡', 'insertOrderedList', 'Numbered list'),
      btn('⇥', 'indent', 'Increase indent'),
      btn('⇤', 'outdent', 'Decrease indent'),
    ]);

    // Insert
    group([
      btn('🔗', 'createLink', 'Insert link', { value: null }),
      btn('🖼️', 'insertImage', 'Insert image', { value: null }),
      btn('▦', 'insertTable', 'Insert table'),
      btn('―', 'insertHorizontalRule', 'Horizontal rule'),
    ]);

    // Tools
    group([
      btn('🔍', 'find', 'Find & replace'),
      btn('🧹', 'removeFormat', 'Clear formatting'),
    ]);

    // Status: dirty indicator (re-used)
    const name = document.createElement('span');
    name.className = 'tb-label';
    name.id = 'writerDocName';
    name.style.marginLeft = 'auto';
    const d0 = activeDoc();
    name.textContent = (d0 ? d0.name : '') + (d0 && d0.dirty ? ' •' : '');
    tb.appendChild(name);
  }

  // ----- Command runner (delegates to execCommand or shows a dialog) -----
  async function run(cmd, value) {
    switch (cmd) {
      case 'new':        return newDoc();
      case 'open':       return openDoc();
      case 'save':       return saveDoc(false);
      case 'saveas':     return saveDoc(true);
      case 'export':     return exportMenu();
      case 'print':      return printDoc();
      case 'find':       return findReplace();
      case 'foreColor': {
        const c = await pickColor('Text color'); if (c) exec('foreColor', c); return;
      }
      case 'hiliteColor': {
        const c = await pickColor('Highlight'); if (c) exec('hiliteColor', c); return;
      }
      case 'createLink': {
        const url = await UI.prompt({ title: 'Insert link', label: 'URL', value: 'https://' });
        if (url) exec('createLink', url); return;
      }
      case 'insertImage': {
        // Offer file-from-disk (default) or URL. The disk path uses the shared
        // FS picker + Util.bytesToBase64 to produce a data URL.
        const body = document.createElement('div');
        body.style.cssText = 'min-width:320px';
        body.innerHTML = `
          <p class="muted" style="margin:0 0 12px">Insert an image from your computer or by URL.</p>
          <div style="display:flex;gap:8px">
            <button class="tb-btn primary" id="imgFile" style="flex:1">📂 From file…</button>
            <button class="tb-btn" id="imgUrl" style="flex:1">🔗 From URL…</button>
          </div>`;
        const d = UI.dialog({ title: 'Insert image', body, okText: 'Cancel', cancelText: null });
        d.el.querySelector('[data-act=ok]').textContent = 'Close';
        d.el.querySelector('#imgFile').onclick = async () => {
          d.close();
          try {
            const f = await FS.open({ accept: [{ description: 'Image', accept: { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/gif': ['.gif'], 'image/webp': ['.webp'] } }] });
            const dataUrl = Util.bytesToBase64(f.bytes, f.name);
            exec('insertImage', dataUrl);
          } catch (e) { if (e.name !== 'AbortError') UI.toast('Image failed: ' + e.message, 'error'); }
        };
        d.el.querySelector('#imgUrl').onclick = async () => {
          d.close();
          const url = await UI.prompt({ title: 'Insert image from URL', label: 'URL', value: 'https://' });
          if (url) exec('insertImage', url);
        };
        return;
      }
      case 'insertTable': return insertTable();
      default:
        exec(cmd, value);
    }
  }

  function exec(cmd, value) {
    editor.focus();
    // Snapshot before formatting actions so each is one undo entry.
    if (cmd !== 'undo' && cmd !== 'redo') {
      History.snapshot(docKey(), editor.innerHTML, (html) => { editor.innerHTML = html; markDirty(); });
      undoArmed = false;
    }
    // Some browsers want styleWithCSS on for color/hilite.
    try { document.execCommand('styleWithCSS', false, (cmd === 'foreColor' || cmd === 'hiliteColor') + ''); } catch (e) {}
    document.execCommand(cmd, false, value === undefined ? null : value);
    markDirty();
    updateToolbarState();
  }

  function pickColor(title) {
    return new Promise((resolve) => {
      const palette = ['#000000','#444444','#666666','#999999','#cccccc','#ffffff',
        '#ff0000','#ff9900','#ffff00','#00cc00','#0066cc','#6633cc','#cc0099',
        '#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#42d4f4',
        '#f032e6','#9a6324','#800000','#808000','#000075','#469990'];
      const body = document.createElement('div');
      body.style.cssText = 'display:grid;grid-template-columns:repeat(8,1fr);gap:4px;';
      palette.forEach(c => {
        const sw = document.createElement('button');
        sw.className = 'tb-btn';
        sw.style.cssText = `width:30px;height:30px;background:${c};border:1px solid #ccc;padding:0;`;
        sw.onclick = () => { d.close(); resolve(c); };
        body.appendChild(sw);
      });
      const d = UI.dialog({ title, body, okText: 'None', cancelText: 'Cancel',
        onOk: () => { resolve(null); }, onCancel: () => { resolve(null); } });
    });
  }

  function insertTable() {
    const body = document.createElement('div');
    body.innerHTML = `<div class="row"><label>Rows</label><input type="number" id="tR" value="3" min="1" max="50"></div>
                      <div class="row"><label>Columns</label><input type="number" id="tC" value="3" min="1" max="20"></div>`;
    UI.dialog({
      title: 'Insert table', body, okText: 'Insert',
      onOk: () => {
        const r = +body.querySelector('#tR').value || 3;
        const c = +body.querySelector('#tC').value || 3;
        let html = '<table style="border-collapse:collapse;border:1px solid #888;width:100%">';
        for (let i = 0; i < r; i++) {
          html += '<tr>';
          for (let j = 0; j < c; j++) {
            html += '<td style="border:1px solid #888;padding:6px;min-width:60px">&nbsp;</td>';
          }
          html += '</tr>';
        }
        html += '</table><p><br></p>';
        editor.focus();
        document.execCommand('insertHTML', false, html);
        markDirty();
      }
    });
  }

  // ----- Find & replace -----
  function findReplace() {
    const body = document.createElement('div');
    body.style.cssText = 'min-width:380px';
    body.innerHTML = `
      <div class="row"><label>Find</label><input type="text" id="frFind"></div>
      <div class="row"><label>Replace</label><input type="text" id="frRepl"></div>
      <div class="actions" style="justify-content:flex-start;margin-top:8px">
        <button class="tb-btn" id="frNext">Find next</button>
        <button class="tb-btn" id="frOne">Replace</button>
        <button class="tb-btn primary" id="frAll">Replace all</button>
        <span class="tb-label" id="frInfo"></span>
      </div>`;
    const dlg = UI.dialog({ title: 'Find & replace', body, okText: 'Close', cancelText: null,
      onOk: () => {} });
    dlg.el.querySelector('[data-act=cancel]')?.remove();

    const findInp = body.querySelector('#frFind');
    const replInp = body.querySelector('#frRepl');
    const info = body.querySelector('#frInfo');
    let selRange = null;

    function findNext() {
      const q = findInp.value;
      if (!q) return;
      const found = window.find(q, false, false, true);
      info.textContent = found ? 'Found' : 'No more matches';
    }
    function replaceOne() {
      const q = findInp.value, r = replInp.value;
      const sel = window.getSelection();
      if (sel.rangeCount && sel.toString() === q) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(r));
        markDirty();
        findNext();
      } else {
        findNext();
      }
    }
    function replaceAll() {
      const q = findInp.value, r = replInp.value;
      if (!q) return;
      // Operate on innerText-level replacement via innerHTML is unsafe; do a DOM walk.
      let count = 0;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      const toUpdate = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.includes(q)) toUpdate.push(node);
      }
      toUpdate.forEach(n => {
        const parts = n.nodeValue.split(q);
        n.nodeValue = parts.join(r);
        count += parts.length - 1;
      });
      markDirty();
      info.textContent = `Replaced ${count} occurrence${count === 1 ? '' : 's'}`;
    }
    body.querySelector('#frNext').onclick = findNext;
    body.querySelector('#frOne').onclick = replaceOne;
    body.querySelector('#frAll').onclick = replaceAll;
    findInp.focus();
  }

  // ----- Open / Save / Export -----
  // Start a fresh document in a new tab (nothing is discarded).
  function newDoc() {
    addDoc();
    editor.focus();
  }

  function addDoc({ name = null, html = '<p><br></p>', handle = null } = {}) {
    const n = docSeq++;
    const id = 'w' + n;
    if (!name) name = 'Untitled-' + n + '.html';
    const doc = { id, name, handle, dirty: false, html };
    docs.push(doc);
    activateDoc(id);
    autosaveSoon();   // persist the new tab in the session manifest soon
    return doc;
  }

  function activateDoc(id) {
    const cur = activeDoc();
    if (cur) cur.html = editor.innerHTML;
    activeId = id;
    const d = activeDoc();
    editor.innerHTML = d.html || '<p><br></p>';
    undoArmed = false;   // a fresh tab starts a fresh undo burst
    clearTimeout(undoTimer);
    // Initialize undo once per document — switching tabs must NOT wipe a
    // doc's accumulated undo stack, so guard with a per-doc flag.
    if (!d.historyReady) {
      History.reset('writer:' + id);
      History.registerCurrentSnapshot('writer:' + id,
        () => editor.innerHTML,
        (html) => { editor.innerHTML = html; markDirty(); });
      d.historyReady = true;
    }
    updateName(); renderTabs(); updateStatus();
  }

  function closeDoc(id) {
    const i = docs.findIndex(d => d.id === id);
    if (i < 0) return;
    const d = docs[i];
    const doClose = () => {
      // Park the closed doc for Ctrl+Shift+T reopen (content snapshot first).
      d.html = d.id === activeId ? editor.innerHTML : d.html;
      closedDocs.unshift({ id: d.id, name: d.name, handle: d.handle, dirty: d.dirty, html: d.html });
      if (closedDocs.length > 10) closedDocs.length = 10;
      docs.splice(i, 1);
      if (activeId === id) {
        activeId = null;
        if (docs.length) activateDoc(docs[Math.max(0, i - 1)].id);
        else addDoc();
      } else {
        renderTabs();
      }
      autosaveSoon();
    };
    if (d.dirty) {
      UI.confirm({ title: `Close ${d.name}?`, message: 'Unsaved changes will be lost.', okText: 'Close anyway', danger: true })
        .then(ok => { if (ok) doClose(); });
    } else {
      doClose();
    }
  }

  // Reopen the most recently closed document (Ctrl+Shift+T).
  function reopenDoc() {
    if (!closedDocs.length) { UI.toast('No recently closed documents', 'info'); return; }
    const d = closedDocs.shift();
    docs.push({ id: d.id, name: d.name, handle: d.handle, dirty: d.dirty, html: d.html });
    activateDoc(d.id);
    autosaveSoon();
    UI.toast(`Reopened ${d.name}`, 'success');
  }

  function renderTabs() {
    if (!tabs) return;
    tabs.render(docs.map(d => ({ id: d.id, name: d.name, dirty: d.dirty })), activeId);
  }

  // Drag-to-reorder callback from the shared tab strip.
  function reorderDocs(fromId, toId) {
    const from = docs.findIndex(d => d.id === fromId);
    const to = docs.findIndex(d => d.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = docs.splice(from, 1);
    docs.splice(to, 0, moved);
    renderTabs();
    autosaveSoon();
  }

  // Load opened file content into the pristine active tab, or a new tab.
  function openIntoDoc(name, handle, html) {
    if (isPristine()) {
      const d = activeDoc();
      editor.innerHTML = html;
      d.name = name; d.handle = handle; d.dirty = false;
      History.reset(docKey());
      updateName(); renderTabs(); autosaveSoon();
    } else {
      addDoc({ name, handle, html });
    }
  }

  async function openDoc() {
    try {
      const f = await FS.open({
        accept: [
          { description: 'Documents', accept: {
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
            'application/msword': ['.doc'],
            'text/html': ['.html', '.htm'],
            'text/plain': ['.txt'],
            'application/pdf': ['.pdf'],
          } },
        ],
      });
      const name = f.name.toLowerCase();
      const ext = name.split('.').pop();
      if (ext === 'pdf') {
        // Switch to PDF viewer and load it there
        document.querySelector('.app-tab[data-app=pdf]').click();
        UI.toast('PDFs open in the PDF Tools tab. Switching…', 'warn');
        return;
      }
      if (ext === 'docx' || ext === 'doc') {
        await openDocx(f);
        return;
      }
      const text = await f.text();
      if (ext === 'html' || ext === 'htm') {
        openIntoDoc(f.name, f.handle || null, Sanitize.html(Sanitize.bodyOf(text)));
      } else {
        // Plain text: convert to paragraphs
        const html = text.split(/\r?\n/).map(l => `<p>${escapeHtml(l) || '<br>'}</p>`).join('');
        openIntoDoc(f.name, f.handle || null, html);
      }
      UI.toast(`Opened ${f.name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Open failed: ' + e.message, 'error');
    }
  }

  // Read a .docx (ZIP of WordprocessingML) and convert to editable HTML via mammoth.
  async function openDocx(f) {
    UI.toast(`Opening ${f.name}…`, 'info');
    try {
      await Libs.need('mammoth');
      // mammoth needs an ArrayBuffer view of the bytes
      const ab = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
      const result = await window.mammoth.convertToHtml({ arrayBuffer: ab });
      const html = result.value || '<p><br></p>';
      openIntoDoc(f.name, f.handle || null, Sanitize.html(html));
      const warns = (result.messages || []).filter(m => m.type === 'warning').length;
      UI.toast(`Opened ${f.name}${warns ? ` (${warns} formatting hints skipped)` : ''}`, 'success');
    } catch (e) {
      UI.toast(`Could not read ${f.name}: ${e.message || e}`, 'error');
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  }
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  async function saveDoc(asNew) {
    const d = activeDoc(); if (!d) return;
    const ext = d.name.split('.').pop().toLowerCase();
    try {
      // Word documents save back as Word. (v1 saved them as .html — and
      // wrote that HTML into the opened .docx file itself.)
      if (ext === 'docx' || ext === 'doc') return await saveWord(d, asNew, ext);
      // Everything else defaults to .html, which round-trips losslessly.
      const outName = (ext === 'html' || ext === 'htm' || ext === 'txt') ? d.name : stripExt(d.name) + '.html';
      let content, mime;
      if (outName.endsWith('.txt')) {
        content = editor.innerText;
        mime = 'text/plain';
      } else {
        content = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + escapeHtml(stripExt(d.name)) +
          '</title></head><body>\n' + editor.innerHTML + '\n</body></html>';
        mime = 'text/html';
      }
      const bytes = new TextEncoder().encode(content);
      const sameFile = outName === d.name;
      const res = await FS.save({ name: outName, mime, bytes, handle: asNew || !sameFile ? null : d.handle });
      afterSave(d, res, outName);
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Save failed: ' + e.message, 'error');
    }
  }

  async function saveWord(d, asNew, ext) {
    const canOverwrite = !asNew && ext === 'docx' && d.handle;
    if (canOverwrite && !d.docxOverwriteOk) {
      const ok = await UI.confirm({
        title: `Overwrite ${d.name}?`,
        message: 'PocketOffice rewrites the Word file from what you see here. Text, headings, lists, tables, ' +
          'images, links and character formatting are kept; page layout, headers/footers, comments and tracked ' +
          'changes from the original are not. Use Save As… to keep the original file untouched.',
        okText: 'Overwrite',
      });
      if (!ok) return;
      d.docxOverwriteOk = true;
    }
    await Libs.need('docx');
    const bytes = await DocExport.toDocx(editor);
    const outName = stripExt(d.name) + '.docx';
    const res = await FS.save({ name: outName, mime: DOCX_MIME, bytes, handle: canOverwrite ? d.handle : null });
    afterSave(d, res, outName);
  }

  function afterSave(d, res, outName) {
    if (res.handle) d.handle = res.handle;
    // The picker may have been given a different name; the handle knows.
    d.name = (res.handle && res.handle.name) || outName;
    d.dirty = false;
    updateName();
    renderTabs();
    autosaveSoon();
    UI.toast(res.downloaded ? `Downloaded ${d.name}` : `Saved ${d.name}`, 'success');
  }

  async function exportMenu() {
    const body = document.createElement('div');
    body.style.cssText = 'min-width:280px';
    body.innerHTML = `
      <p class="muted" style="margin:0 0 10px">Export the current document to a downloadable file.</p>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="tb-btn" data-x="docx" style="justify-content:flex-start">📄 Microsoft Word (.docx)</button>
        <button class="tb-btn" data-x="pdf"  style="justify-content:flex-start">📕 PDF (.pdf)</button>
        <button class="tb-btn" data-x="html" style="justify-content:flex-start">🌐 Web page (.html)</button>
        <button class="tb-btn" data-x="txt"  style="justify-content:flex-start">📝 Plain text (.txt)</button>
      </div>`;
    const d = UI.dialog({ title: 'Export document', body, okText: 'Cancel', cancelText: null });
    d.el.querySelector('[data-act=ok]').textContent = 'Close';
    d.el.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { d.close(); doExport(b.dataset.x); });
  }

  async function doExport(fmt) {
    const d = activeDoc(); if (!d) return;
    const base = stripExt(d.name);
    try {
      if (fmt === 'html') {
        const html = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + escapeHtml(base) +
          '</title></head><body>\n' + editor.innerHTML + '\n</body></html>';
        await FS.save({ name: base + '.html', mime: 'text/html', bytes: new TextEncoder().encode(html), handle: null });
      } else if (fmt === 'txt') {
        await FS.save({ name: base + '.txt', mime: 'text/plain', bytes: new TextEncoder().encode(editor.innerText), handle: null });
      } else if (fmt === 'pdf') {
        await exportPdf(base);
      } else if (fmt === 'docx') {
        await exportDocx(base);
      }
      UI.toast(`Exported ${base}.${fmt}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Export failed: ' + e.message, 'error');
    }
  }

  // Inline formatting, links, images, nested lists and tables are kept —
  // see docexport.js.
  async function exportPdf(base) {
    await Libs.need('jspdf');
    const bytes = await DocExport.toPdf(editor);
    await FS.save({ name: base + '.pdf', mime: 'application/pdf', bytes, handle: null });
  }

  async function exportDocx(base) {
    await Libs.need('docx');
    const bytes = await DocExport.toDocx(editor);
    await FS.save({ name: base + '.docx', mime: DOCX_MIME, bytes, handle: null });
  }

  // ----- Print -----
  let lastPrintAt = 0;
  function printDoc() {
    // Guard against double-click firing window.print() twice (2nd call closes the dialog).
    const now = Date.now();
    if (now - lastPrintAt < 1000) return;
    lastPrintAt = now;
    window.print();
  }

  // ----- Undo -----
  // Debounced innerHTML snapshots: typing produces many input events, so we
  // coalesce them into one undo entry per ~600ms pause.
  let undoTimer = null;
  let undoArmed = false;
  function armSnapshot() {
    if (undoArmed) return;
    undoArmed = true;
    const snap = editor.innerHTML;
    History.snapshot(docKey(), snap, (html) => { editor.innerHTML = html; markDirty(); });
  }
  function scheduleSnapshot() {
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoArmed = false; }, 600);
    armSnapshot();
  }
  function doUndo() { History.undo(docKey()); }
  function doRedo() { History.redo(docKey()); }

  // ----- Dirty + autosave -----
  function markDirty() {
    const d = activeDoc();
    if (d && !d.dirty) { d.dirty = true; updateName(); renderTabs(); }
    autosaveSoon();
    updateStatus();
  }
  function updateName() {
    const el = $('writerDocName');
    const d = activeDoc();
    if (el) el.textContent = (d ? d.name : '') + (d && d.dirty ? ' •' : '');
  }
  function updateStatus() {
    const info = $('statusInfo');
    if (info) {
      const words = (editor.innerText.trim().match(/\S+/g) || []).length;
      const chars = editor.innerText.length;
      info.textContent = `${words} words · ${chars} chars`;
    }
  }
  function autosaveSoon() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 800);
  }
  async function autosaveNow() {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    if (!editor || !docs.length) return;
    // File handles are stored too, so Ctrl+S after a restart saves back to
    // the same file instead of asking where.
    const record = {
      active: activeId,
      docs: docs.map(d => ({
        id: d.id, name: d.name, dirty: d.dirty, handle: d.handle || null,
        html: d.id === activeId ? editor.innerHTML : d.html,
      })),
    };
    try {
      await Util.saveWithHandles('writer:docs', record,
        (r) => Object.assign({}, r, { docs: r.docs.map(d => Object.assign({}, d, { handle: null })) }));
      const el = $('statusAutosave');
      if (el) {
        const t = new Date().toLocaleTimeString();
        el.textContent = `autosaved ${t}`;
        setTimeout(() => { if (el.textContent === `autosaved ${t}`) el.textContent = ''; }, 2000);
      }
    } catch (e) { /* ignore */ }
  }
  // Called when the page is being hidden or closed: write any pending
  // autosave now rather than losing the last 800 ms of typing.
  function flush() {
    if (autosaveTimer) autosaveNow();
  }

  // ----- Toolbar state (active buttons) -----
  function updateToolbarState() {
    // Reflect bold/italic/underline active state.
    document.querySelectorAll('#writerToolbar .tb-btn').forEach(b => {
      // Lightweight: only check the three basics.
    });
  }

  function stripExt(n) { return n.replace(/\.[^.]+$/, ''); }

  // ----- Boot -----
  async function boot() {
    editor = $('writerContent');
    // Convert the placeholder into a real editor surface.
    editor.className = 'writer-surface';
    editor.innerHTML = '';
    const doc = document.createElement('div');
    doc.className = 'writer-doc';
    doc.contentEditable = 'true';
    doc.spellcheck = true;
    doc.innerHTML = '<p><br></p>';
    editor.appendChild(doc);
    editor = doc;

    buildToolbar();

    tabs = Tabs.create({
      mount: $('writerTabs'),
      onActivate: activateDoc,
      onClose: closeDoc,
      onNew: newDoc,
      onReorder: reorderDocs,
      newTitle: 'New document',
    });

    editor.addEventListener('input', () => { scheduleSnapshot(); markDirty(); });
    editor.addEventListener('keyup', updateToolbarState);
    editor.addEventListener('mouseup', updateToolbarState);

    // Keyboard shortcuts at the editor level
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); saveDoc(false);
      }
    });

    // Restore last session: the open tabs and their content.
    try {
      const saved = await Storage.load('writer:docs');
      if (saved && Array.isArray(saved.docs) && saved.docs.length) {
        const seen = new Set();
        saved.docs.forEach((s) => {
          const id = (typeof s.id === 'string' && !seen.has(s.id)) ? s.id : null;
          if (id) seen.add(id);
          docs.push({
            id,
            name: s.name || 'Untitled.html',
            handle: (s.handle && typeof s.handle === 'object') ? s.handle : null,
            dirty: !!s.dirty,
            html: s.html || '<p><br></p>',
          });
        });
        // Continue numbering after the highest id in use (not the tab count).
        docSeq = Util.nextSeq([...seen], 'w');
        docs.forEach(d => { if (!d.id) d.id = 'w' + (docSeq++); });
        activateDoc(saved.active && docs.some(d => d.id === saved.active) ? saved.active : docs[0].id);
      } else {
        // Migrate the pre-tabs single-document autosave (v1.2.x).
        const legacy = await Storage.load('writer:doc');
        if (legacy && legacy.html) {
          addDoc({ name: legacy.name || 'Untitled-1.html', html: legacy.html });
        } else {
          addDoc();
        }
      }
    } catch (e) {
      if (!docs.length) addDoc();
    }
    updateStatus();
  }

  function onActivate() {
    setTimeout(() => editor && editor.focus(), 0);
  }

  return { boot, onActivate, flush, undo: doUndo, redo: doRedo, reopen: reopenDoc };
})();
