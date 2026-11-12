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
      const isActive = t.dataset.app === name;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      t.setAttribute('tabindex', isActive ? '0' : '-1');
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
    body.className = 'about-body';
    body.innerHTML = `
      <p><b>PocketOffice v${PO_VERSION.version}</b> (${PO_VERSION.date}) — a tiny office suite that runs in your browser,
      with no install, no admin rights, and no internet.</p>
      <p><b>What's inside</b></p>
      <ul>
        <li><b>Writer</b> — word processor (.docx/.pdf/.html)</li>
        <li><b>Calc</b> — spreadsheet with formulas and charts (.xlsx/.csv)</li>
        <li><b>Impress</b> — slides (.pptx/.pdf)</li>
        <li><b>Text Editor</b> — tabbed code/text editor</li>
        <li><b>PDF Tools</b> — view, merge, split, annotate, sign PDFs</li>
        <li><b>Markdown</b> — live-preview editor, print and HTML export</li>
      </ul>
      <p class="muted tight">All documents autosave to your browser's storage.
      Use the toolbar buttons to open and save real files, and the 🛟 button to back everything up.</p>
      <p class="muted spaced">Built with pdf.js, pdf-lib, jsPDF, SheetJS, docx, mammoth, PptxGenJS,
      Chart.js, marked and DOMPurify (all bundled locally — see lib/VERSIONS.md).</p>
    `;
    if (installPrompt) {
      const p = document.createElement('p');
      const b = UI.button('⬇ Install PocketOffice as an app', { title: 'Adds PocketOffice to this device so it opens in its own window and works offline' });
      b.classList.add('primary');
      b.onclick = async () => {
        const ev = installPrompt;
        installPrompt = null;
        b.remove();
        try { await ev.prompt(); } catch (e) { /* dismissed */ }
      };
      p.appendChild(b);
      body.appendChild(p);
    }
    UI.dialog({ title: 'About PocketOffice', body, okText: 'Close', cancelText: null });
  }

  // ---- Backup & storage ----
  const fmtBytes = (n) => n == null ? '?' : n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB'
    : n < 1024 * 1024 * 1024 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB';
  const lastBackupText = () => {
    let t = null;
    try { t = localStorage.getItem('po:lastBackup'); } catch (e) { /* ignore */ }
    const d = t ? new Date(t) : null;
    return d && !isNaN(d) ? d.toLocaleString() : 'never';
  };

  async function backupNow() {
    try {
      flushAll();
      await new Promise(r => setTimeout(r, 400));   // let pending autosaves land
      const b = await Backup.create();
      const res = await FS.save({ name: b.name, mime: 'application/zip', bytes: b.bytes, handle: null });
      try { localStorage.setItem('po:lastBackup', new Date().toISOString()); } catch (e) { /* ignore */ }
      UI.toast((res.downloaded ? 'Downloaded ' : 'Saved ') + ((res.handle && res.handle.name) || b.name) + ' — ' + b.documents + ' document' + (b.documents === 1 ? '' : 's'), 'success', 5000);
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') UI.toast('Backup failed: ' + (e.message || e), 'error', 6000);
      return false;
    }
  }

  async function restoreBackup() {
    let f;
    try {
      f = await FS.open({ accept: [{ description: 'PocketOffice backup', accept: { 'application/zip': ['.zip'] } }] });
    } catch (e) {
      if (e.name !== 'AbortError' && e.message !== 'cancelled') UI.toast('Could not open the file: ' + (e.message || e), 'error');
      return;
    }
    let data;
    try { data = await Backup.read(f.bytes); } catch (e) { UI.toast(e.message || String(e), 'error', 6000); return; }
    const when = data.created && !isNaN(new Date(data.created)) ? new Date(data.created).toLocaleString() : 'an unknown date';
    const ok = await UI.confirm({
      title: 'Restore this backup?',
      message: 'Everything now open in PocketOffice (all tabs in every tool) will be replaced by the backup from ' + when +
        '. Files saved on your disk are not touched. PocketOffice will reload.',
      okText: 'Replace and reload', danger: true,
    });
    if (!ok) return;
    try {
      window.PO_RESTORING = true;   // stop the page-hide flush from saving the old documents back
      await Storage.replaceAll(data.records);
      location.reload();
    } catch (e) {
      window.PO_RESTORING = false;
      UI.toast('Restore failed: ' + (e.message || e), 'error', 6000);
    }
  }

  async function showBackup() {
    const body = document.createElement('div');
    body.className = 'about-body';
    body.innerHTML = `
      <p>PocketOffice keeps your open documents in this browser's storage so they are still here next time.
      That storage belongs to the browser: clearing browsing data, a profile reset or an IT clean-up removes it.</p>
      <p><b>A backup is one .zip file</b> with everything from every tool, plus ordinary copies of each document.</p>
      <div class="menu-col">
        <button class="tb-btn primary justify-start" id="bkNow">💾 Back up all documents (.zip)</button>
        <button class="tb-btn justify-start" id="bkRestore">📂 Restore from a backup…</button>
      </div>
      <p class="muted tight" id="bkLast"></p>
      <p class="muted tight" id="bkUsage">Checking storage…</p>
      <p class="muted tight" id="bkPersist"></p>`;
    const d = UI.dialog({ title: 'Backup & storage', body, okText: 'Close', cancelText: null });
    const last = body.querySelector('#bkLast');
    const showLast = () => { last.textContent = 'Last backup from this browser: ' + lastBackupText(); };
    showLast();
    body.querySelector('#bkNow').onclick = async () => { if (await backupNow()) showLast(); };
    body.querySelector('#bkRestore').onclick = () => { d.close(); restoreBackup(); };
    const h = await Storage.health();
    const usage = body.querySelector('#bkUsage'), persist = body.querySelector('#bkPersist');
    if (!usage.isConnected) return;
    usage.textContent = h.usage == null ? 'Storage use: not reported by this browser.'
      : 'Storage used: ' + fmtBytes(h.usage) + ' of about ' + fmtBytes(h.quota) + ' available.';
    persist.textContent = h.persisted == null ? ''
      : h.persisted ? 'Protected: the browser will not clear this data on its own when the disk runs low.'
      : 'Not protected: the browser may clear this data if the disk runs low — keep a backup.';
  }

  // Storage problems must be visible: a silent autosave failure looks
  // exactly like everything being fine.
  let lastStorageWarn = 0;
  function wireStorageHealth() {
    window.addEventListener('po:storage-error', (e) => {
      const el = document.getElementById('statusAutosave');
      if (el) el.textContent = '⚠ autosave is failing';
      if (Date.now() - lastStorageWarn < 60000) return;
      lastStorageWarn = Date.now();
      const full = e.detail && e.detail.name === 'QuotaExceededError';
      UI.toast((full ? 'Browser storage is full' : 'The browser refused to store your documents') +
        ' — changes are NOT being autosaved. Save your files to disk, or use Backup (🛟) now.', 'error', 12000);
    });
    Storage.requestPersist();
    Storage.health().then(h => {
      if (h.usage != null && h.quota && h.usage / h.quota > 0.8) {
        UI.toast('Browser storage is ' + Math.round(h.usage / h.quota * 100) + '% full. Back up (🛟) and close documents you no longer need.', 'warn', 9000);
      }
    });
  }

  // ---- Offline use of the hosted copy (service worker) ----
  // Only over http(s): opened from a folder (file://) the app is already
  // fully offline and service workers are not available there.
  let installPrompt = null;
  function wireOffline() {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
    window.addEventListener('appinstalled', () => { installPrompt = null; });
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    // The single-file build carries everything inside itself and has no
    // sw.js beside it (PO_PDF_WORKER_SRC is set only by that build).
    if (window.PO_PDF_WORKER_SRC) return;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'po:offline-ready') return;
      let seen = null;
      try { seen = localStorage.getItem('po:offlineReady'); } catch (err) { /* ignore */ }
      if (seen === e.data.version) return;
      try { localStorage.setItem('po:offlineReady', e.data.version); } catch (err) { /* ignore */ }
      UI.toast('PocketOffice is saved on this device — it now works without internet.', 'success', 6000);
    });
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }

  // ---- Global keyboard shortcuts ----
  // Route undo/redo through each tool's own API: since v1.3.0 the History
  // keys are per-document ('writer:w2', …), so only the tool knows its
  // active key. Text Editor is the same (per-buffer keys).
  function toolFor(app) {
    return { writer: Writer, calc: Calc, impress: Impress, text: TextEditor, pdf: PdfTools, markdown: MarkdownReader }[app];
  }

  // Autosaves wait 800 ms after the last change. When the page is hidden or
  // closed, write whatever is pending straight away so nothing is lost.
  function flushAll() {
    if (window.PO_RESTORING) return;
    for (const tool of [Writer, Calc, Impress, TextEditor, MarkdownReader]) {
      try { if (tool && typeof tool.flush === 'function') tool.flush(); } catch (e) { /* keep going */ }
    }
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
    const appTabs = [...document.querySelectorAll('.app-tab')];
    appTabs.forEach((t, i) => {
      t.addEventListener('click', () => setApp(t.dataset.app));
      // Tab-list keyboard pattern: arrows (and Home/End) move between tools.
      t.addEventListener('keydown', (e) => {
        const to = e.key === 'ArrowRight' ? (i + 1) % appTabs.length
          : e.key === 'ArrowLeft' ? (i + appTabs.length - 1) % appTabs.length
          : e.key === 'Home' ? 0 : e.key === 'End' ? appTabs.length - 1 : -1;
        if (to < 0) return;
        e.preventDefault();
        setApp(appTabs[to].dataset.app);
        appTabs[to].focus();
      });
    });
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    document.getElementById('aboutBtn').addEventListener('click', showAbout);
    document.getElementById('backupBtn').addEventListener('click', showBackup);
    wireStorageHealth();
    wireOffline();

    wireShortcuts();
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAll();
    });

    const ver = document.getElementById('statusVersion');
    if (ver) ver.textContent = `v${PO_VERSION.version} · ${PO_VERSION.date}`;

    // boot tools (each is independent)
    try { await TextEditor.boot(); } catch (e) { console.error('TextEditor boot:', e); }
    try { await Writer.boot(); } catch (e) { console.error('Writer boot:', e); }
    try { await Calc.boot(); } catch (e) { console.error('Calc boot:', e); }
    try { await Impress.boot(); } catch (e) { console.error('Impress boot:', e); }
    try { await PdfTools.boot(); } catch (e) { console.error('PdfTools boot:', e); }
    try { await MarkdownReader.boot(); } catch (e) { console.error('MarkdownReader boot:', e); }

    // Name each toolbar for assistive technology (the tools build theirs at boot).
    document.querySelectorAll('.tool-panel').forEach(panel => {
      panel.querySelectorAll('.toolbar, .md-toolbar').forEach(tb => {
        if (!tb.getAttribute('role')) tb.setAttribute('role', 'toolbar');
        if (!tb.getAttribute('aria-label')) tb.setAttribute('aria-label', (APP_LABELS[panel.dataset.app] || '') + ' toolbar');
      });
    });

    setApp('text');
    UI.toast('PocketOffice ready — Alt+1..6 to switch apps', 'success', 4000);
  });
})();
