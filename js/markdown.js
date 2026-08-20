/* ==========================================================================
   markdown.js — Markdown reader/editor: split-pane editor + live preview,
   print, export to HTML, autosave, undo/redo. Renders via marked (GFM).
   ========================================================================== */

const MarkdownReader = (() => {
  let source = '';            // the markdown text
  let docName = 'Untitled-1.md';
  let docHandle = null;
  let dirty = false;
  let viewMode = 'split';     // 'split' | 'read'
  let renderTimer = null;
  let autosaveTimer = null;
  // Undo: debounced snapshots of the source string (like Writer).
  let undoTimer = null;
  let undoArmed = false;

  const $ = (id) => document.getElementById(id);

  // ---------- Layout + toolbar ----------
  function buildUI() {
    const root = $('mdContent');
    root.innerHTML = `
      <div class="md-toolbar" id="mdToolbar"></div>
      <div class="md-split" id="mdSplit">
        <div class="md-editor-pane" id="mdEditorPane">
          <textarea class="md-editor" id="mdEditor" spellcheck="false"
            placeholder="# Type markdown here…&#10;&#10;Live preview appears on the right."></textarea>
        </div>
        <div class="md-divider" id="mdDivider"></div>
        <div class="md-preview-pane" id="mdPreviewPane">
          <div class="md-preview" id="mdPreview"></div>
        </div>
      </div>`;
    buildToolbar();
    wireEditor();
  }

  function buildToolbar() {
    const tb = $('mdToolbar');
    const btn = (label, fn, title, primary = false) => {
      const b = document.createElement('button');
      b.className = 'tb-btn' + (primary ? ' primary' : '');
      b.innerHTML = label; b.title = title || ''; b.onclick = fn;
      return b;
    };
    const sep = () => { const s = document.createElement('span'); s.className = 'tb-sep'; return s; };
    tb.innerHTML = '';
    tb.appendChild(btn('📂 Open', openDoc, 'Open .md / .markdown / .txt'));
    tb.appendChild(btn('💾 Save', () => saveDoc(false), 'Save (Ctrl+S)'));
    tb.appendChild(btn('Save As…', () => saveDoc(true), 'Save As…'));
    tb.appendChild(sep());
    tb.appendChild(btn('↶', doUndo, 'Undo (Ctrl+Z)'));
    tb.appendChild(btn('↷', doRedo, 'Redo (Ctrl+Y)'));
    tb.appendChild(sep());
    const viewBtn = btn('⇆ Split', toggleView, 'Toggle split / read-only view');
    viewBtn.id = 'mdViewToggle';
    tb.appendChild(viewBtn);
    tb.appendChild(sep());
    tb.appendChild(btn('📥 Export ▾', exportMenu, 'Export to HTML'));
    tb.appendChild(btn('🖨️', () => printDoc(), 'Print the rendered document', true));
    // Doc name + dirty indicator on the right
    const name = document.createElement('span');
    name.className = 'tb-label';
    name.id = 'mdDocName';
    name.style.marginLeft = 'auto';
    name.textContent = docName + (dirty ? ' •' : '');
    tb.appendChild(name);
    // Status (word count) is in the global status bar via updateStatus()
  }

  // ---------- Rendering ----------
  function render() {
    const preview = $('mdPreview');
    if (!preview) return;
    let html;
    try {
      html = marked.parse(source, { gfm: true, breaks: true });
    } catch (e) {
      html = '<p><em>(markdown parse error: ' + (e.message || e) + ')</em></p>';
    }
    preview.innerHTML = sanitizeHtml(html);
    updateStatus();
  }
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
  }

  // Light sanitization (copy of Writer's): strip scripts/on-handlers.
  function sanitizeHtml(html) {
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
    return tmp.innerHTML;
  }

  // ---------- Editor wiring ----------
  function wireEditor() {
    const ta = $('mdEditor');
    ta.addEventListener('input', () => {
      source = ta.value;
      scheduleRender();
      scheduleSnapshot();
      markDirty();
    });
    // Tab key inserts two spaces (common in markdown editors)
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.substring(0, s) + '  ' + ta.value.substring(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
        source = ta.value; scheduleRender(); markDirty();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); saveDoc(false);
      }
    });
  }

  // ---------- View toggle ----------
  function toggleView() {
    viewMode = viewMode === 'split' ? 'read' : 'split';
    applyViewMode();
  }
  function applyViewMode() {
    const split = $('mdSplit');
    const editorPane = $('mdEditorPane');
    const divider = $('mdDivider');
    const btn = $('mdViewToggle');
    if (viewMode === 'read') {
      split.classList.add('md-readmode');
      editorPane.style.display = 'none';
      divider.style.display = 'none';
      if (btn) btn.innerHTML = '✎ Edit';
    } else {
      split.classList.remove('md-readmode');
      editorPane.style.display = '';
      divider.style.display = '';
      if (btn) btn.innerHTML = '⇆ Split';
    }
  }

  // ---------- Open / Save / Export ----------
  async function openDoc() {
    try {
      const f = await FS.open({
        accept: [
          { description: 'Markdown / text', accept: {
            'text/markdown': ['.md', '.markdown'],
            'text/plain': ['.txt'],
          } },
        ],
      });
      const text = await f.text();
      snapshot();   // record pre-open state for undo
      source = text;
      docName = f.name;
      docHandle = f.handle || null;
      dirty = false;
      $('mdEditor').value = source;
      render();
      updateName();
      History.reset('markdown');
      autosaveSoon();
      UI.toast(`Opened ${f.name}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Open failed: ' + (e.message || e), 'error');
    }
  }

  async function saveDoc(asNew) {
    source = $('mdEditor').value;
    const ext = (docName.split('.').pop() || 'md').toLowerCase();
    const outName = (ext === 'md' || ext === 'markdown' || ext === 'txt') ? docName
      : docName.replace(/\.[^.]*$/, '') + '.md';
    const mime = outName.endsWith('.txt') ? 'text/plain' : 'text/markdown';
    const bytes = new TextEncoder().encode(source);
    try {
      const res = await FS.save({ name: outName, mime, bytes, handle: asNew ? null : docHandle });
      if (res.handle) docHandle = res.handle;
      docName = outName;
      dirty = false;
      updateName();
      autosaveSoon();
      UI.toast(res.downloaded ? `Downloaded ${outName}` : `Saved ${outName}`, 'success');
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Save failed: ' + (e.message || e), 'error');
    }
  }

  function exportMenu() {
    const body = document.createElement('div');
    body.style.cssText = 'min-width:240px';
    body.innerHTML = `
      <p class="muted" style="margin:0 0 10px">Export the rendered document.</p>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="tb-btn" data-x="html" style="justify-content:flex-start">🌐 Web page (.html)</button>
      </div>`;
    const d = UI.dialog({ title: 'Export', body, okText: 'Close', cancelText: null });
    d.el.querySelectorAll('[data-x]').forEach(b => b.onclick = () => { d.close(); doExport(b.dataset.x); });
  }

  async function doExport(fmt) {
    const base = docName.replace(/\.[^.]+$/, '');
    if (fmt === 'html') {
      // Standalone HTML with the markdown styles inlined.
      const rendered = marked.parse(source, { gfm: true, breaks: true });
      const safe = sanitizeHtml(rendered);
      const css = previewCssForExport();
      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(base)}</title>
<style>${css}</style>
</head><body>
<article class="md-preview">
${safe}
</article>
</body></html>`;
      const bytes = new TextEncoder().encode(html);
      try {
        await FS.save({ name: base + '.html', mime: 'text/html', bytes, handle: null });
        UI.toast(`Exported ${base}.html`, 'success');
      } catch (e) {
        if (e.name !== 'AbortError') UI.toast('Export failed: ' + (e.message || e), 'error');
      }
    }
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  // The CSS shipped with the exported HTML so it looks the same standalone.
  function previewCssForExport() {
    return `
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1c1e22; background: #fff; line-height: 1.6; margin: 0; }
      .md-preview { max-width: 760px; margin: 40px auto; padding: 0 24px; font-size: 16px; }
      .md-preview h1 { font-size: 2em; border-bottom: 1px solid #eee; padding-bottom: .3em; margin-top: 0; }
      .md-preview h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: .3em; }
      .md-preview h3 { font-size: 1.25em; }
      .md-preview h4 { font-size: 1em; }
      .md-preview a { color: #1668e6; }
      .md-preview code { font-family: Consolas, "Liberation Mono", Menlo, monospace; background: #f4f5f7; padding: 2px 5px; border-radius: 4px; font-size: .9em; }
      .md-preview pre { background: #f4f5f7; padding: 14px; border-radius: 6px; overflow: auto; }
      .md-preview pre code { background: none; padding: 0; }
      .md-preview blockquote { border-left: 4px solid #d7dae0; margin: 0; padding: 4px 16px; color: #5a606b; }
      .md-preview table { border-collapse: collapse; }
      .md-preview th, .md-preview td { border: 1px solid #d7dae0; padding: 6px 12px; }
      .md-preview th { background: #f4f5f7; }
      .md-preview img { max-width: 100%; }
      .md-preview hr { border: 0; border-top: 2px solid #eee; margin: 24px 0; }
    `;
  }

  // ---------- Print ----------
  let lastPrintAt = 0;
  function printDoc() {
    // Guard: a second window.print() while the dialog is still open closes it
    // (double-click on the button, or button + Ctrl+P). Ignore repeats <1s.
    const now = Date.now();
    if (now - lastPrintAt < 1000) return;
    lastPrintAt = now;
    // Ensure preview is up to date before printing.
    render();
    // In read mode the editor is already hidden; in split mode, the @media print
    // rule hides .md-editor-pane / .md-divider and flattens .md-preview.
    window.print();
  }

  // ---------- Undo ----------
  function scheduleSnapshot() {
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { undoArmed = false; }, 600);
    if (undoArmed) return;
    undoArmed = true;
    History.snapshot('markdown', source, (text) => {
      source = text;
      $('mdEditor').value = text;
      render(); markDirty();
    });
  }
  function snapshot() {
    History.snapshot('markdown', source, (text) => {
      source = text;
      $('mdEditor').value = text;
      render(); markDirty();
    });
  }
  function doUndo() { History.undo('markdown'); }
  function doRedo() { History.redo('markdown'); }

  // ---------- Dirty + autosave + status ----------
  function markDirty() {
    if (!dirty) { dirty = true; updateName(); }
    autosaveSoon();
    updateStatus();
  }
  function updateName() {
    const el = $('mdDocName');
    if (el) el.textContent = docName + (dirty ? ' •' : '');
  }
  function updateStatus() {
    const info = $('statusInfo');
    if (info) {
      const words = source.trim() ? source.trim().split(/\s+/).length : 0;
      const lines = source.split('\n').length;
      info.textContent = `${lines} lines · ${words} words · ${source.length} chars`;
    }
  }
  function autosaveSoon() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveNow, 800);
  }
  async function autosaveNow() {
    try {
      await Storage.save('markdown:doc', { source, name: docName });
      const el = $('statusAutosave');
      if (el) {
        const t = new Date().toLocaleTimeString();
        el.textContent = `autosaved ${t}`;
        setTimeout(() => { if (el.textContent === `autosaved ${t}`) el.textContent = ''; }, 2000);
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- Styles ----------
  function injectStyles() {
    if (document.getElementById('markdown-styles')) return;
    const s = document.createElement('style');
    s.id = 'markdown-styles';
    s.textContent = `
      .md-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .md-toolbar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
        min-height: var(--tb-h); padding: 5px 10px; background: var(--surface);
        border-bottom: 1px solid var(--border); flex-shrink: 0; }
      .md-split { display: flex; flex: 1; min-height: 0; }
      .md-editor-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .md-divider { width: 1px; background: var(--border); flex-shrink: 0; }
      .md-preview-pane { flex: 1; min-width: 0; overflow: auto; background: var(--bg); }
      .md-editor {
        flex: 1; width: 100%; border: 0; outline: none; resize: none; padding: 18px 24px;
        background: var(--surface); color: var(--text);
        font-family: var(--font-mono); font-size: 14px; line-height: 1.6; tab-size: 2;
      }
      .md-readmode .md-preview-pane { flex: 1; }

      /* Rendered markdown preview */
      .md-preview {
        max-width: 760px; margin: 24px auto; padding: 8px 24px;
        font-family: var(--font-doc); font-size: 16px; line-height: 1.6; color: var(--text);
        word-wrap: break-word;
      }
      .md-preview h1 { font-size: 2em; border-bottom: 1px solid var(--border-soft); padding-bottom: .3em; margin: .8em 0 .5em; }
      .md-preview h2 { font-size: 1.5em; border-bottom: 1px solid var(--border-soft); padding-bottom: .3em; margin: 1em 0 .5em; }
      .md-preview h3 { font-size: 1.25em; margin: 1em 0 .4em; }
      .md-preview h4 { font-size: 1em; margin: 1em 0 .3em; }
      .md-preview h5, .md-preview h6 { color: var(--text-dim); margin: 1em 0 .3em; }
      .md-preview p { margin: 0 0 12px; }
      .md-preview a { color: var(--accent); }
      .md-preview ul, .md-preview ol { margin: 0 0 12px; padding-left: 28px; }
      .md-preview li { margin: 3px 0; }
      .md-preview code {
        font-family: var(--font-mono); font-size: .9em;
        background: var(--surface-3); padding: 2px 5px; border-radius: 4px;
      }
      .md-preview pre { background: var(--surface-3); padding: 14px; border-radius: 6px; overflow: auto; margin: 0 0 12px; }
      .md-preview pre code { background: none; padding: 0; font-size: 13px; }
      .md-preview blockquote {
        border-left: 4px solid var(--border); margin: 0 0 12px; padding: 4px 16px;
        color: var(--text-dim);
      }
      .md-preview table { border-collapse: collapse; margin: 0 0 12px; }
      .md-preview th, .md-preview td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
      .md-preview th { background: var(--surface-2); }
      .md-preview img { max-width: 100%; }
      .md-preview hr { border: 0; border-top: 2px solid var(--border-soft); margin: 20px 0; }
      .md-preview input[type=checkbox] { margin-right: 6px; }
    `;
    document.head.appendChild(s);
  }

  // ---------- Boot ----------
  async function boot() {
    injectStyles();
    buildUI();
    // Register undo: capture + restore the current source string.
    History.registerCurrentSnapshot('markdown',
      () => source,
      (text) => {
        source = text;
        const ta = $('mdEditor'); if (ta) ta.value = text;
        render();
      });
    History.reset('markdown');
    // Restore last session.
    try {
      const saved = await Storage.load('markdown:doc');
      if (saved && typeof saved.source === 'string') {
        source = saved.source;
        if (saved.name) docName = saved.name;
        $('mdEditor').value = source;
        render();
        updateName();
      } else {
        // Seed with a friendly starter doc so the preview isn't blank.
        source = starterDoc();
        $('mdEditor').value = source;
        render();
      }
    } catch (e) { /* ignore */ }
  }

  function starterDoc() {
    return `# Welcome to Markdown

This is a **live** markdown editor — type on the left, see the rendered result on the right.

## What you can do

- **Bold**, *italic*, ~~strikethrough~~
- \`inline code\` and code blocks:
\`\`\`
function hello() {
  console.log("hi");
}
\`\`\`
- [Links](https://example.com)
- Task lists:
  - [x] Render markdown
  - [x] Print the result
  - [ ] Add syntax highlighting

## Tables

| Format | Reads | Writes |
|--------|-------|--------|
| .md    | ✓     | ✓      |
| .html  | —     | ✓      |

> Tip: use the **🖨️ Print** button (or Ctrl+P) to print or save as PDF.
`;
  }

  function onActivate() {
    setTimeout(() => $('mdEditor') && $('mdEditor').focus(), 0);
  }

  return { boot, onActivate };
})();
