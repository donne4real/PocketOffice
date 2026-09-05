/* ==========================================================================
   app.js — shell controller: tab switching, theme, status bar, boot
   ========================================================================== */

(function () {
  const APP_LABELS = {
    writer:  'Writer',
    calc:    'Calc',
    impress: 'Impress',
    text:    'Text Editor',
    pdf:     'PDF Tools',
    markdown:'Markdown',
  };

  let currentApp = 'text';
  const apps = ['writer', 'calc', 'impress', 'text', 'pdf', 'markdown'];

  function setApp(name) {
    if (!apps.includes(name)) return;
    currentApp = name;
    document.querySelectorAll('.app-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.app === name);
    });
    document.querySelectorAll('.tool-panel').forEach(p => {
      p.classList.toggle('active', p.dataset.app === name);
    });
    document.getElementById('statusApp').textContent = APP_LABELS[name];
    if (name === 'text' && TextEditor.onActivate) TextEditor.onActivate();
    if (name === 'writer' && Writer.onActivate) Writer.onActivate();
    if (name === 'calc' && Calc.onActivate) Calc.onActivate();
    if (name === 'impress' && Impress.onActivate) Impress.onActivate();
    if (name === 'markdown' && MarkdownReader.onActivate) MarkdownReader.onActivate();
  }

  function setTheme(theme) {
    document.body.classList.toggle('theme-dark', theme === 'dark');
    try { localStorage.setItem('po:theme', theme); } catch (e) { /* ignore */ }
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function toggleTheme() {
    const isDark = document.body.classList.contains('theme-dark');
    setTheme(isDark ? 'light' : 'dark');
  }

  function showAbout() {
    const body = document.createElement('div');
    body.style.cssText = 'line-height:1.6;font-size:13px;max-width:460px';
    body.innerHTML = `
      <p style="margin:0 0 10px"><b>PocketOffice v1.0</b> (built 2026-07-28) — a tiny office suite that runs in your browser,
      with no install, no admin rights, and no internet.</p>
      <p style="margin:0 0 10px"><b>What's inside</b></p>
      <ul style="margin:0 0 10px; padding-left:22px">
        <li><b>Writer</b> — word processor (.docx/.pdf/.html)</li>
        <li><b>Calc</b> — spreadsheet with formulas (.xlsx/.csv)</li>
        <li><b>Impress</b> — slides (.pptx/.pdf)</li>
        <li><b>Text Editor</b> — tabbed code/text editor</li>
        <li><b>PDF Tools</b> — view, merge, split, annotate PDFs</li>
      </ul>
      <p class="muted" style="margin:0">All documents autosave to your browser's storage.
      Use the toolbar buttons to open and save real files.</p>
      <p class="muted" style="margin:8px 0 0">Built with pdf.js, pdf-lib, jsPDF, SheetJS, docx, and PptxGenJS (all bundled locally).</p>
    `;
    UI.dialog({ title: 'About PocketOffice', body, okText: 'Close', cancelText: null });
    // hide the cancel button if present
    const cancel = document.querySelector('#dialogRoot [data-act=cancel]');
    if (cancel && cancel.textContent === '') cancel.remove();
  }

  // ---- Global keyboard shortcuts ----
  // Route undo/redo through each tool's own API: since v1.3.0 the History
  // keys are per-document ('writer:w2', …), so only the tool knows its
  // active key. Text Editor is the same (per-buffer keys).
  function toolFor(app) {
    return { writer: Writer, calc: Calc, impress: Impress, text: TextEditor, markdown: MarkdownReader }[app];
  }
  function doUndoRedo(which) {
    const tool = toolFor(currentApp);
    if (!tool) return;
    if (which === 'undo' && typeof tool.undo === 'function') return tool.undo();
    if (which === 'redo' && typeof tool.redo === 'function') return tool.redo();
  }
  function doReopen() {
    const tool = toolFor(currentApp);
    if (tool && typeof tool.reopen === 'function') tool.reopen();
  }

  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ignore when typing in an input/textarea (except for tool-specific ones handled there)
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea';

      // Alt+1..6 switches apps
      if (e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        setApp(apps[+e.key - 1]);
      }
      // Ctrl/Cmd+Shift+T reopens the last closed tab (browser convention)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault(); doReopen(); return;
      }
      // Ctrl/Cmd+Shift+D toggles theme
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault(); toggleTheme(); return;
      }
      // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo/redo — only in the active tool,
      // and only when the focus is in the document area (not a toolbar input).
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          // Avoid stealing native undo from toolbar inputs the tools manage
          // internally (formula bar, find bar, …).
          if (tag === 'input' || tag === 'select') return;
          e.preventDefault(); doUndoRedo('undo');
        } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
          if (tag === 'input' || tag === 'select') return;
          e.preventDefault(); doUndoRedo('redo');
        }
      }
    });
  }

  // ---- Boot ----
  window.addEventListener('DOMContentLoaded', async () => {
    // theme
    let theme = 'light';
    try { theme = localStorage.getItem('po:theme') || 'light'; } catch (e) { /* ignore */ }
    setTheme(theme);

    // tab strip
    document.querySelectorAll('.app-tab').forEach(t => {
      t.addEventListener('click', () => setApp(t.dataset.app));
    });
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    document.getElementById('aboutBtn').addEventListener('click', showAbout);

    wireShortcuts();

    // boot tools (each is independent)
    try { await TextEditor.boot(); } catch (e) { console.error('TextEditor boot:', e); }
    try { await Writer.boot(); } catch (e) { console.error('Writer boot:', e); }
    try { await Calc.boot(); } catch (e) { console.error('Calc boot:', e); }
    try { await Impress.boot(); } catch (e) { console.error('Impress boot:', e); }
    try { await PdfTools.boot(); } catch (e) { console.error('PdfTools boot:', e); }
    try { await MarkdownReader.boot(); } catch (e) { console.error('MarkdownReader boot:', e); }

    setApp('text');
    UI.toast('PocketOffice ready — Alt+1..6 to switch apps', 'success', 4000);
  });
})();
