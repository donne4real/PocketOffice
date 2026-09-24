// End-to-end checks for PocketOffice v2 in headless Chromium.
// Start the server first:  node tests/browser/serve.js . 8765
// Then:  node tests/browser/e2e.js "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
// Uses a throwaway browser profile in the system temp folder.
const { launch } = require('./cdp.js');
const path = require('path');
const BROWSER = process.argv[2] || process.env.PO_BROWSER;
const BASE = process.argv[3] || 'http://127.0.0.1:8765/';

// Injected after every page load.
const HELPERS = `
FS.__realSave = FS.__realSave || FS.save;
window.T = {
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  async waitFor(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) {} await T.sleep(50); } throw new Error('timeout: ' + fn); },
  app(name) { document.querySelector('.app-tab[data-app=' + name + ']').click(); },
  key(el, key, opts = {}) { el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, opts))); },
  saved: [],
  fakeSave() { FS.save = async (o) => { T.saved.push(o); return { handle: null, downloaded: true }; }; },
  fakeOpen(file) { FS.open = async () => file; },
  cell(addr) { return document.querySelector('.calc-cell[data-addr="' + addr + '"]'); },
  async setCell(addr, raw) {
    T.cell(addr).click();
    const fx = document.getElementById('calcFx'); fx.value = raw;
    T.key(fx, 'Enter');
  },
  dialogOk() { const b = document.querySelector('#dialogRoot [data-act=ok]'); b.click(); },
  async flushAll() { for (const t of [Writer, Calc, Impress, TextEditor, MarkdownReader]) t.flush && t.flush(); await T.sleep(300); },
};
true;`;

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); }

(async () => {
  const b = await launch({ browser: BROWSER, profile: path.join(require('os').tmpdir(), 'pocketoffice-e2e-profile') });
  const load = async (url = BASE) => { await b.goto(url); await b.evaluate(HELPERS); await b.evaluate(`T.waitFor(() => document.querySelector('.calc-cell') && document.querySelector('#writerTabs .te-tab'))`); await b.evaluate('T.sleep(300)'); };
  const run = (fn) => b.evaluate('(' + fn.toString() + ')()');
  try {
    await load();

    // ---------- Boot ----------
    const boot = await run(async () => ({
      ver: document.getElementById('statusVersion').textContent,
      lazy: typeof window.XLSX === 'undefined' && typeof window.pdfjsLib === 'undefined' && typeof window.docx === 'undefined',
      purify: !!window.DOMPurify,
      cells: document.querySelectorAll('.calc-cell').length,
    }));
    check('version shown from version.js', boot.ver.includes('2.0.0'), boot.ver);
    check('big libraries not loaded at startup', boot.lazy);
    check('DOMPurify loaded', boot.purify);
    check('Calc grid starts small (100 rows)', boot.cells === 100 * 100, boot.cells + ' cells');

    // ---------- Calc ----------
    const calc = await run(async () => {
      T.app('calc'); await T.sleep(50);
      await T.setCell('A1', '10');
      await T.setCell('A2', '=A1*2');
      await T.setCell('B1', '=50%');
      await T.setCell('B2', '2026-09-23');
      await T.setCell('B3', '=1 2');
      await T.setCell('B4', '=$A$1+A2');
      await T.setCell('B5', '1,000');
      const out = {};
      for (const a of ['A2', 'B1', 'B2', 'B3', 'B4', 'B5']) out[a] = T.cell(a).textContent;
      // Ctrl+D on A2 -> A3 = =A2*2 = 40
      T.cell('A2').click();
      T.key(T.cell('A2'), 'd', { ctrlKey: true });
      await T.sleep(50);
      out.A3 = T.cell('A3').textContent;
      out.fx = document.getElementById('calcFx').value;
      // lazy rows: select a far row
      T.cell('A1').click();
      for (let i = 0; i < 150; i++) T.key(document.activeElement, 'ArrowDown');
      out.rowsAfter = document.querySelectorAll('.calc-rowhead').length;
      out.active = document.getElementById('calcAddr').textContent;
      return out;
    });
    check('Calc: =A1*2', calc.A2 === '20', calc.A2);
    check('Calc: =50% is 0.5', calc.B1 === '0.5', calc.B1);
    check('Calc: date text stays text', calc.B2 === '2026-09-23', calc.B2);
    check('Calc: "=1 2" is an error', calc.B3 === '#ERROR!', calc.B3);
    check('Calc: $A$1 absolute ref', calc.B4 === '30', calc.B4);
    check('Calc: 1,000 is a thousand', calc.B5 === '1000', calc.B5);
    check('Calc: Ctrl+D fills down with shifted refs', calc.A3 === '40' && calc.fx === '=A2*2', calc.A3 + ' ' + calc.fx);
    check('Calc: rows grow when navigating down', calc.rowsAfter > 100 && calc.active === 'A151', calc.rowsAfter + ' rows, ' + calc.active);

    // Charts: create, click elsewhere, then drag must still work.
    const chart = await run(async () => {
      document.querySelector('#calcToolbar .tb-btn[title^="Create a chart"]').click();
      await T.sleep(50);
      document.querySelector('#chRange').value = 'A1:A3';
      T.dialogOk();
      await T.waitFor(() => window.Chart && document.querySelector('.calc-chart-panel canvas'));
      const panel = document.querySelector('.calc-chart-panel');
      const head = panel.querySelector('.calc-chart-head');
      // An unrelated click anywhere (v1 bug: this detached the drag listeners)
      T.cell('C3').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      const before = panel.style.left;
      const r = head.getBoundingClientRect();
      head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 20, clientY: r.top + 5 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left - 80, clientY: r.top + 40 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { before, after: panel.style.left };
    });
    check('Calc: chart still draggable after another click', chart.before !== chart.after, chart.before + ' -> ' + chart.after);

    // Export keeps formulas; import reads every sheet with cross-sheet refs.
    const xl = await run(async () => {
      T.fakeSave();
      document.querySelector('#calcToolbar .tb-btn[title="Export"]').click();
      await T.sleep(50);
      document.querySelector('#dialogRoot [data-x=xlsx][data-scope=one]').click();
      await T.waitFor(() => T.saved.length);
      const sv = T.saved.pop();
      const wb = XLSX.read(sv.bytes, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const exported = { name: sv.name, f: ws.A2 && ws.A2.f, v: ws.A2 && ws.A2.v };
      // Build a two-sheet workbook and import it.
      const nb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(nb, XLSX.utils.aoa_to_sheet([[5], [7]]), 'Data');
      const s2 = XLSX.utils.aoa_to_sheet([[0]]);
      s2.A1 = { t: 'n', v: 0, f: 'SUM(Data!A1:A2)*$B$1' };
      s2.B1 = { t: 'n', v: 2 };
      s2['!ref'] = 'A1:B1';
      XLSX.utils.book_append_sheet(nb, s2, 'Summary');
      const bytes = new Uint8Array(XLSX.write(nb, { bookType: 'xlsx', type: 'array' }));
      T.fakeOpen({ name: 'book.xlsx', bytes, text: async () => '' });
      document.querySelector('#calcToolbar .tb-btn[title^="Import"]').click();
      await T.waitFor(() => [...document.querySelectorAll('#calcTabs .te-tab')].some(t => t.textContent.includes('Summary')));
      const tabs = [...document.querySelectorAll('#calcTabs .te-tab .name')].map(t => t.textContent);
      // activate Summary
      [...document.querySelectorAll('#calcTabs .te-tab')].find(t => t.textContent.includes('Summary')).click();
      await T.sleep(100);
      return { exported, tabs, summaryA1: T.cell('A1').textContent };
    });
    check('Calc export: .xlsx keeps formulas', xl.exported.f === 'A1*2' && xl.exported.v === 20, JSON.stringify(xl.exported));
    check('Calc export: file named after the sheet', /^Sheet-\d+\.xlsx$/.test(xl.exported.name), xl.exported.name);
    check('Calc import: all sheets become tabs', xl.tabs.filter(t => t.startsWith('book – ')).length === 2, xl.tabs.join(', '));
    check('Calc import: cross-sheet + absolute refs evaluate', xl.summaryA1 === '24', xl.summaryA1);

    // ---------- Writer ----------
    const w = await run(async () => {
      T.app('writer'); await T.sleep(50);
      const ed = document.querySelector('.writer-doc');
      const c = document.createElement('canvas'); c.width = 40; c.height = 20; c.getContext('2d').fillRect(0, 0, 40, 20);
      ed.innerHTML = '<h1>Title</h1><p>Plain <b>bold</b> <i>ital</i> <u>under</u> <span style="color:#ff0000">red</span> <a href="https://example.com">link</a></p>' +
        '<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol><li>first</li><li>second</li></ol>' +
        '<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td><b>b</b></td></tr></table>' +
        '<p><img src="' + c.toDataURL() + '"></p>';
      await T.sleep(100);
      T.fakeSave();
      const exp = async (fmt) => {
        document.querySelector('#writerToolbar .tb-btn[title^="Export"]').click();
        await T.sleep(30);
        document.querySelector('#dialogRoot [data-x=' + fmt + ']').click();
        await T.waitFor(() => T.saved.length);
        return T.saved.pop();
      };
      const dx = await exp('docx');
      await Libs.need('jszip');
      const zip = await JSZip.loadAsync(dx.bytes);
      const xml = await zip.file('word/document.xml').async('string');
      const mediaNames = Object.keys(zip.files).filter(n => n.startsWith('word/media/') && !n.endsWith('/')); const media = mediaNames.length; window.__media = mediaNames;
      const pdf = await exp('pdf');
      const head = new TextDecoder().decode(pdf.bytes.slice(0, 5));
      const pdfText = new TextDecoder('latin1').decode(pdf.bytes);
      return {
        bold: xml.includes('<w:b/>'), ital: xml.includes('<w:i/>'), underline: xml.includes('<w:u '),
        color: /w:color w:val="FF0000"/.test(xml), link: xml.includes('<w:hyperlink'), num: xml.includes('<w:numPr>'),
        lvl1: xml.includes('<w:ilvl w:val="1"/>'), table: xml.includes('<w:tbl>'), media, mediaNames,
        pdfHead: head, pdfLink: pdfText.includes('example.com'), pdfSize: pdf.bytes.length,
      };
    });
    check('Writer .docx: bold/italic/underline kept', w.bold && w.ital && w.underline, JSON.stringify({ b: w.bold, i: w.ital, u: w.underline }));
    check('Writer .docx: text color kept', w.color);
    check('Writer .docx: hyperlink kept', w.link);
    check('Writer .docx: lists + nesting', w.num && w.lvl1);
    check('Writer .docx: table + one image', w.table && w.media === 1, 'media=' + w.mediaNames);
    check('Writer .pdf: valid PDF with link annotation', w.pdfHead === '%PDF-' && w.pdfLink, w.pdfSize + ' bytes');

    // Writer: open .docx with a handle, Save writes Word (not HTML) back after confirm.
    const wsave = await run(async () => {
      const bytes = new Uint8Array(await (await fetch('samples/sample-document.docx')).arrayBuffer());
      const written = [];
      const handle = { name: 'sample-document.docx', kind: 'file',
        queryPermission: async () => 'granted',
        createWritable: async () => ({ write: async (b) => written.push(b), close: async () => {} }) };
      T.fakeOpen({ name: 'sample-document.docx', bytes, handle, text: async () => '' });
      FS.save = FS.__realSave || FS.save;
      document.querySelector('#writerToolbar .tb-btn[title="Open…"]').click();
      await T.waitFor(() => document.getElementById('writerDocName').textContent.includes('sample-document.docx'));
      document.querySelector('.writer-doc').insertAdjacentHTML('beforeend', '<p>edited</p>');
      document.querySelector('#writerToolbar .tb-btn[title^="Save (Ctrl"]').click();
      await T.waitFor(() => document.querySelector('#dialogRoot .dialog h3'));
      const title = document.querySelector('#dialogRoot .dialog h3').textContent;
      T.dialogOk();
      await T.waitFor(() => written.length);
      const w0 = written[0];
      const u8 = w0 instanceof Uint8Array ? w0 : new Uint8Array(w0);
      return { title, magic: String.fromCharCode(u8[0], u8[1]), name: document.getElementById('writerDocName').textContent };
    });
    check('Writer: saving an opened .docx asks, then writes a real .docx', wsave.magic === 'PK' && /Overwrite/.test(wsave.title), JSON.stringify(wsave));

    // ---------- Impress ----------
    const imp = await run(async () => {
      T.app('impress'); await T.sleep(50);
      const el = document.querySelector('#impCanvas .imp-el');
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await T.waitFor(() => document.querySelector('#dialogRoot textarea'));
      document.querySelector('#dialogRoot textarea').value = 'Hello v2';
      T.dialogOk();
      await T.sleep(100);
      const text = document.querySelector('#impCanvas .imp-el').textContent;
      // Malicious deck
      const deck = { slides: [{ bg: 'red;"><img id=pwn1 src=x>', elements: [
        { id: 'e1', kind: 'rect', x: 1, y: 1, w: 10, h: 10, fill: '"><img id=pwn2 src=x onerror=window.PWNED=1>' },
        { id: 'e1', kind: 'text', x: '5"><img id=pwn3>', y: 2, w: 3, h: 4, text: '<b>t</b>', color: '#123456' },
        { id: 'x', kind: 'script', x: 0, y: 0, w: 1, h: 1 }] }] };
      T.fakeOpen({ name: 'evil.json', bytes: new Uint8Array(), text: async () => JSON.stringify(deck) });
      document.querySelector('#impressToolbar .tb-btn[title^="Open"]').click();
      await T.sleep(300);
      // select each element to render inspector
      for (const n of document.querySelectorAll('#impCanvas .imp-el')) { n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); document.dispatchEvent(new MouseEvent('mouseup')); }
      await T.sleep(100);
      const ids = [...document.querySelectorAll('#impCanvas .imp-el')].map(n => n.dataset.id);
      return { text, pwn: !!document.querySelector('#pwn1, #pwn2, #pwn3') || !!window.PWNED, count: ids.length, unique: new Set(ids).size === ids.length };
    });
    check('Impress: Edit text works (no [object Promise])', imp.text === 'Hello v2', imp.text);
    check('Impress: crafted deck cannot inject markup', !imp.pwn);
    check('Impress: unknown kinds dropped, ids unique', imp.count === 2 && imp.unique, imp.count + ' elements');

    // ---------- Markdown ----------
    const md = await run(async () => {
      T.app('markdown'); await T.sleep(50);
      const ta = document.getElementById('mdEditor');
      ta.value = '[x](https://example.com) <img src=x onerror="window.MDPWN=1"> <a href="javascript:alert(1)">j</a>';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await T.sleep(400);
      const a = document.querySelector('#mdPreview a[href^="https"]');
      const img = document.querySelector('#mdPreview img');
      return { target: a && a.target, onerr: img && img.hasAttribute('onerror'), js: !!document.querySelector('#mdPreview a[href^="javascript"]') };
    });
    check('Markdown: links open in new tab', md.target === '_blank');
    check('Markdown: handlers and javascript: links stripped', !md.onerr && !md.js, JSON.stringify(md));

    // ---------- PDF ----------
    const pdf = await run(async () => {
      T.app('pdf');
      await Libs.need('jspdf');
      const doc = new jspdf.jsPDF(); doc.text('page one', 20, 20); doc.addPage(); doc.text('page two', 20, 20);
      const bytes = new Uint8Array(doc.output('arraybuffer'));
      T.fakeOpen({ name: 't.pdf', bytes });
      document.getElementById('pdfOpen').click();
      await T.waitFor(() => document.querySelectorAll('#pdfPages canvas').length === 2);
      return { pages: document.querySelectorAll('#pdfPages canvas').length, info: document.getElementById('pdfPageInfo').textContent };
    });
    check('PDF Tools: pdf.js loads on demand and renders', pdf.pages === 2, pdf.info);

    // ---------- Persistence: flush, ids, text editor ----------
    await run(async () => {
      T.app('text'); await T.sleep(50);
      const ta = document.getElementById('teTextarea');
      ta.value = 'typed just before closing';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      // change mode -> renames buffer (v1 left a ghost entry)
      const mode = document.getElementById('teMode'); mode.value = 'md'; mode.dispatchEvent(new Event('change'));
      window.dispatchEvent(new Event('pagehide'));
      await T.sleep(400);
      // Seed Writer with a gap in ids (w2, w3) to reproduce the duplicate-id bug.
      await Storage.save('writer:docs', { docs: [
        { id: 'w2', name: 'a.html', html: '<p>A</p>' }, { id: 'w3', name: 'b.html', html: '<p>B</p>' }] });
      return true;
    });
    await load();
    const persist = await run(async () => {
      const te = await Storage.load('texteditor:session');
      const legacy = (await Storage.list('text:')).length;
      T.app('writer'); await T.sleep(50);
      document.querySelector('#writerTabs .te-new').click();
      await T.sleep(50);
      await T.flushAll();
      const wd = await Storage.load('writer:docs');
      return {
        teTexts: te.buffers.map(b => b.name + '=' + b.text), teCount: te.buffers.length, legacy,
        tabsShown: document.querySelectorAll('#teTabs .te-tab, .tool-panel[data-app=text] .te-tab').length,
        wIds: wd.docs.map(d => d.id), wNames: wd.docs.map(d => d.name),
      };
    });
    check('Flush on pagehide saved the last keystrokes', persist.teTexts.some(t => t.endsWith('=typed just before closing')), persist.teTexts.join(' | '));
    check('Text Editor: rename leaves no ghost tab', persist.teCount === 1 && persist.legacy === 0, persist.teTexts.join(' | '));
    check('Writer: new tab after restore gets a fresh id', new Set(persist.wIds).size === persist.wIds.length && persist.wIds.includes('w4'), persist.wIds.join(','));

    // Legacy Text Editor migration
    await run(async () => {
      await Storage.remove('texteditor:session');
      await Storage.save('text:old-notes.txt', { text: 'from v1', mode: 'txt' });
      return true;
    });
    await load();
    const mig = await run(async () => ({
      session: (await Storage.load('texteditor:session')).buffers.map(b => b.name + '=' + b.text),
      legacy: (await Storage.list('text:')).length,
      value: document.getElementById('teTextarea').value,
    }));
    check('Text Editor: v1 autosave migrated', mig.session.includes('old-notes.txt=from v1') && mig.legacy === 0, JSON.stringify(mig));

    // ---------- Standalone build ----------
    await b.goto(BASE + 'PocketOffice-standalone.html');
    await b.evaluate(HELPERS);
    await b.evaluate(`T.waitFor(() => document.querySelector('#writerTabs .te-tab'))`);
    const sa = await run(async () => {
      const ready = ['xlsx', 'pdfjs', 'docx', 'chart', 'pptx', 'jspdf', 'mammoth', 'pdflib'].every(n => Libs.isReady(n));
      T.app('pdf');
      const doc = new jspdf.jsPDF(); doc.text('x', 20, 20);
      T.fakeOpen({ name: 's.pdf', bytes: new Uint8Array(doc.output('arraybuffer')) });
      document.getElementById('pdfOpen').click();
      await T.waitFor(() => document.querySelectorAll('#pdfPages canvas').length === 1, 20000);
      return { ready, ver: document.getElementById('statusVersion').textContent, worker: String(window.PO_PDF_WORKER_SRC).slice(0, 5) };
    });
    check('Standalone: all libraries inlined, PDF worker via blob', sa.ready && sa.worker === 'blob:', JSON.stringify(sa));
  } catch (e) {
    check('harness', false, e.stack || e.message);
  } finally {
    const errs = b.errors.filter(e => !/favicon|8765\/x$/.test(e));
    check('no console errors or exceptions', errs.length === 0, errs.slice(0, 8).join('\n    '));
    await b.close();
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
