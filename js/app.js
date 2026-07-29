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
  };

  let currentApp = 'text';
  const apps = ['writer', 'calc', 'impress', 'text', 'pdf'];

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
  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ignore when typing in an input/textarea (except for tool-specific ones handled there)
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea';

      // Alt+1..5 switches apps
      if (e.altKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        setApp(apps[+e.key - 1]);
      }
      // Ctrl/Cmd+Shift+T toggles theme
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault(); toggleTheme();
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

    setApp('text');
    UI.toast('PocketOffice ready — Alt+1..5 to switch apps', 'success', 4000);
  });
})();
