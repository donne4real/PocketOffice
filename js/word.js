/* ==========================================================================
   word.js — Writer: a rich-text word processor using contentEditable.
   Toolbar with formatting, table/image/link, find&replace, autosave, and
   export to .html / .txt / .pdf (jsPDF) / .docx (docx lib).
   ========================================================================== */

const Writer = (() => {
  let docHandle = null;       // FileSystemFileHandle for "Save" reuse
  let docName = 'Untitled-1.html';
  let dirty = false;
  let autosaveTimer = null;

  const $ = (id) => document.getElementById(id);
  let editor = null;          // the contenteditable div

  // ----- Toolbar definition (rendered into #writerToolbar) -----
  const FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New', 'Tahoma', 'Trebuchet MS', 'Comic Sans MS'];
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
    fontSel.innerHTML = FONTS.map(f => `<option>${f}</option>`).join('');
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
    name.textContent = docName + (dirty ? ' •' : '');
    tb.appendChild(name);
  }

  // ----- Command runner (delegates to execCommand or shows a dialog) -----
  async function run(cmd, value) {
    switch (cmd) {
      case 'open':       return openDoc();
      case 'save':       return saveDoc(false);
      case 'saveas':     return saveDoc(true);
      case 'export':     return exportMenu();
      case 'print':      return window.print();
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
      History.snapshot('writer', editor.innerHTML, (html) => { editor.innerHTML = html; markDirty(); });
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
        editor.innerHTML = sanitizeHtml(text);
      } else {
        // Plain text: convert to paragraphs
        editor.innerHTML = text.split(/\r?\n/).map(l => `<p>${escapeHtml(l) || '<br>'}</p>`).join('');
      }
      docName = f.name;
      docHandle = f.handle || null;
      dirty = false;
      updateName();
      autosaveSoon();
      History.reset('writer');
      UI.toast(`Opened ${f.name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Open failed: ' + e.message, 'error');
    }
  }

  // Read a .docx (ZIP of WordprocessingML) and convert to editable HTML via mammoth.
  async function openDocx(f) {
    if (typeof window.mammoth === 'undefined') {
      UI.toast('docx reader not loaded', 'error');
      return;
    }
    UI.toast(`Opening ${f.name}…`, 'info');
    try {
      // mammoth needs an ArrayBuffer view of the bytes
      const ab = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
      const result = await window.mammoth.convertToHtml({ arrayBuffer: ab });
      const html = result.value || '<p><br></p>';
      editor.innerHTML = sanitizeHtml(html);
      docName = f.name;
      docHandle = f.handle || null;
      dirty = false;
      updateName();
      autosaveSoon();
      History.reset('writer');
      const warns = (result.messages || []).filter(m => m.type === 'warning').length;
      UI.toast(`Opened ${f.name}${warns ? ` (${warns} formatting hints skipped)` : ''}`, 'success');
    } catch (e) {
      UI.toast(`Could not read ${f.name}: ${e.message || e}`, 'error');
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  }
  // Light sanitization: keep common formatting tags, strip scripts/handlers.
  function sanitizeHtml(html) {
    // Use the browser's parser via a temp element, then walk and clean.
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script, link, meta, iframe, object, embed, style').forEach(n => n.remove());
    tmp.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        if (a.name === 'href' && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
        if (a.name === 'src' && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
      });
    });
    // Pull the body content if it was a full HTML doc
    const bodyEl = tmp.querySelector('body');
    return (bodyEl ? bodyEl.innerHTML : tmp.innerHTML);
  }

  async function saveDoc(asNew) {
    const ext = docName.split('.').pop().toLowerCase();
    // Default save format = .html (round-trips cleanly); user picks others via Export.
    const outName = (ext === 'html' || ext === 'htm' || ext === 'txt') ? docName : docName.replace(/\.[^.]*$/, '') + '.html';
    let content, mime;
    if (outName.endsWith('.txt')) {
      content = editor.innerText;
      mime = 'text/plain';
    } else {
      content = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + escapeHtml(stripExt(docName)) +
        '</title></head><body>\n' + editor.innerHTML + '\n</body></html>';
      mime = 'text/html';
    }
    const bytes = new TextEncoder().encode(content);
    try {
      const res = await FS.save({ name: outName, mime, bytes, handle: asNew ? null : docHandle });
      if (res.handle) docHandle = res.handle;
      docName = outName;
      dirty = false;
      updateName();
      autosaveSoon();
      UI.toast(res.downloaded ? `Downloaded ${outName}` : `Saved ${outName}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Save failed: ' + e.message, 'error');
    }
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
    const base = stripExt(docName);
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

  async function exportPdf(base) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 56; // ~0.78in
    const maxWidth = pageW - margin * 2;
    let y = margin;

    // Walk block-level children and render line by line. Simple but reliable.
    const blocks = [...editor.children];
    const addLine = (text, opts) => {
      const size = opts.size || 12;
      const style = opts.style || 'normal';
      const font = opts.font || 'helvetica';
      pdf.setFont(font, style);
      pdf.setFontSize(size);
      const color = opts.color || [20, 20, 20];
      pdf.setTextColor(color[0], color[1], color[2]);
      const lines = pdf.splitTextToSize(text, maxWidth) || [];
      for (const ln of lines) {
        if (y > pageH - margin) { pdf.addPage(); y = margin; }
        pdf.text(ln, margin, y);
        y += size * 1.35;
      }
    };

    if (!blocks.length) {
      // fall back to innerText
      addLine(editor.innerText, {});
    } else {
      for (const el of blocks) {
        const tag = el.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          const sz = { h1: 22, h2: 18, h3: 16, h4: 14, h5: 13, h6: 12 }[tag];
          addLine(el.textContent, { size: sz, style: 'bold', color: [10, 10, 10] });
          y += 4;
        } else if (tag === 'ul' || tag === 'ol') {
          [...el.children].forEach((li, i) => {
            addLine((tag === 'ol' ? (i + 1) + '. ' : '•  ') + li.textContent, { size: 12 });
          });
          y += 3;
        } else if (tag === 'blockquote') {
          addLine('"' + el.textContent + '"', { size: 12, style: 'italic', color: [90, 90, 90] });
        } else if (tag === 'pre') {
          el.textContent.split('\n').forEach(l => addLine(l, { size: 10, font: 'courier' }));
        } else if (tag === 'table') {
          // Render table rows as text grid (best-effort)
          [...el.querySelectorAll('tr')].forEach(tr => {
            const cells = [...tr.querySelectorAll('td,th')].map(td => td.textContent);
            addLine(cells.join('   |   '), { size: 10 });
          });
        } else {
          // p, div, etc. — strip HTML tags from innerHTML to preserve inline spacing
          const text = htmlToPlain(el);
          addLine(text || '', { size: 12 });
        }
        y += 4;
      }
    }
    const ab = pdf.output('arraybuffer');
    await FS.save({ name: base + '.pdf', mime: 'application/pdf', bytes: new Uint8Array(ab), handle: null });
  }

  // Convert a rich-text element's content to a flat line, honouring <br> and <strong>.
  function htmlToPlain(el) {
    let out = '';
    const walk = (node) => {
      node.childNodes.forEach(c => {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.tagName === 'BR') out += '\n';
        else walk(c);
      });
    };
    walk(el);
    return out.replace(/\u00a0/g, ' ');
  }

  async function exportDocx(base) {
    if (typeof window.docx === 'undefined') {
      UI.toast('docx library not loaded', 'error'); return;
    }
    const D = window.docx;
    const children = [];
    const pushPara = (text, opts = {}) => {
      children.push(new D.Paragraph({
        children: [new D.TextRun({ text, bold: opts.bold, italics: opts.italics, size: opts.size, font: opts.font })],
        heading: opts.heading,
      }));
    };

    const blocks = [...editor.children];
    if (!blocks.length) pushPara(editor.innerText);
    for (const el of blocks) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        pushPara(el.textContent, { heading: D.HeadingLevel['HEADING_' + Math.min(6, +tag[1])], bold: true });
      } else if (tag === 'ul') {
        [...el.children].forEach(li => children.push(new D.Paragraph({ text: li.textContent, bullet: { level: 0 } })));
      } else if (tag === 'ol') {
        [...el.children].forEach(li => children.push(new D.Paragraph({ text: li.textContent, numbering: { reference: 'num', level: 0 } })));
      } else if (tag === 'blockquote') {
        pushPara(el.textContent, { italics: true });
      } else if (tag === 'pre') {
        pushPara(el.textContent, { font: 'Courier New', size: 20 });
      } else if (tag === 'table') {
        const rows = [...el.querySelectorAll('tr')].map(tr =>
          new D.TableRow({
            children: [...tr.querySelectorAll('td,th')].map(td =>
              new D.TableCell({ children: [new D.Paragraph(td.textContent || ' ')] })
            ),
          })
        );
        children.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } }));
      } else {
        // Split on <br> within the paragraph.
        const lines = htmlToPlain(el).split('\n');
        lines.forEach((l, i) => pushPara(l));
      }
    }
    const doc = new D.Document({
      numbering: { config: [{ reference: 'num', levels: [{ level: 0, format: D.LevelFormat.DECIMAL, text: '%1.', alignment: D.AlignmentType.START }] }] },
      sections: [{ properties: {}, children }],
    });
    const blob = await D.Packer.toBlob(doc);
    const buf = new Uint8Array(await blob.arrayBuffer());
    await FS.save({ name: base + '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: buf, handle: null });
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
    History.snapshot('writer', snap, (html) => { editor.innerHTML = html; markDirty(); });
  }
  function scheduleSnapshot() {
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoArmed = false; }, 600);
    armSnapshot();
  }
  function doUndo() { History.undo('writer'); }
  function doRedo() { History.redo('writer'); }

  // ----- Dirty + autosave -----
  function markDirty() {
    if (!dirty) { dirty = true; updateName(); }
    autosaveSoon();
    updateStatus();
  }
  function updateName() {
    const el = $('writerDocName');
    if (el) el.textContent = docName + (dirty ? ' •' : '');
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
    autosaveTimer = setTimeout(async () => {
      try {
        await Storage.save('writer:doc', { html: editor.innerHTML, name: docName });
        const el = $('statusAutosave');
        if (el) {
          const t = new Date().toLocaleTimeString();
          el.textContent = `autosaved ${t}`;
          setTimeout(() => { if (el.textContent === `autosaved ${t}`) el.textContent = ''; }, 2000);
        }
      } catch (e) { /* ignore */ }
    }, 800);
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

    // Load CSS for the writer surface (append to app.css via <style> to keep it simple)
    injectWriterStyles();

    buildToolbar();

    // Register undo: capture + restore current innerHTML.
    History.registerCurrentSnapshot('writer',
      () => editor.innerHTML,
      (html) => { editor.innerHTML = html; markDirty(); });
    History.reset('writer');

    editor.addEventListener('input', () => { scheduleSnapshot(); markDirty(); });
    editor.addEventListener('keyup', updateToolbarState);
    editor.addEventListener('mouseup', updateToolbarState);

    // Keyboard shortcuts at the editor level
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); saveDoc(false);
      }
    });

    // Restore last session
    try {
      const saved = await Storage.load('writer:doc');
      if (saved && saved.html) {
        editor.innerHTML = saved.html;
        if (saved.name) { docName = saved.name; }
        updateName();
        History.reset('writer');
      }
    } catch (e) { /* ignore */ }
    updateStatus();
  }

  function injectWriterStyles() {
    if (document.getElementById('writer-styles')) return;
    const s = document.createElement('style');
    s.id = 'writer-styles';
    s.textContent = `
      .writer-surface {
        flex: 1; overflow: auto;
        background: var(--bg);
        padding: 0;
      }
      .writer-doc {
        background: var(--surface);
        max-width: 8.5in;
        min-height: 11in;
        margin: 24px auto;
        padding: 1in 1in;
        box-shadow: var(--shadow);
        border-radius: 2px;
        font-family: var(--font-doc);
        font-size: 16px;
        line-height: 1.5;
        color: #1a1a1a;
        outline: none;
      }
      .writer-doc:focus { outline: none; }
      .writer-doc p { margin: 0 0 12px; }
      .writer-doc h1 { font-size: 2em; margin: .67em 0; }
      .writer-doc h2 { font-size: 1.5em; margin: .75em 0; }
      .writer-doc h3 { font-size: 1.17em; margin: .83em 0; }
      .writer-doc h4 { font-size: 1em; margin: 1.12em 0; }
      .writer-doc ul, .writer-doc ol { margin: 0 0 12px; padding-left: 32px; }
      .writer-doc blockquote {
        border-left: 3px solid #ccc; padding-left: 12px; color: #555; margin: 0 0 12px;
      }
      .writer-doc pre {
        background: #f4f4f4; padding: 10px; border-radius: 4px;
        font-family: var(--font-mono); font-size: 13px; white-space: pre-wrap;
      }
      .writer-doc a { color: var(--accent); }
      .writer-doc img { max-width: 100%; }
      body.theme-dark .writer-doc { color: #222; background: #fdfdfd; }
    `;
    document.head.appendChild(s);
  }

  function onActivate() {
    setTimeout(() => editor && editor.focus(), 0);
  }

  return { boot, onActivate };
})();
