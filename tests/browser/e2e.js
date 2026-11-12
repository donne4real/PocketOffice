// End-to-end checks for PocketOffice v2 in headless Chromium.
// Start the server first:  node tests/browser/serve.js . 8765
// Then:  node tests/browser/e2e.js "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
// Uses a throwaway browser profile in the system temp folder.
const { launch } = require('./cdp.js');
const path = require('path');
const BROWSER = process.argv[2] || process.env.PO_BROWSER;
const BASE = process.argv[3] || 'http://127.0.0.1:8765/';
const fs = require('fs');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const APP_VERSION = /version:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8'))[1];

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
    check('version shown from version.js', boot.ver.includes(APP_VERSION), boot.ver);
    check('big libraries not loaded at startup', boot.lazy);
    check('DOMPurify loaded', boot.purify);
    // 21 rows, not 20: setActive('A1') during boot also pre-renders a 20-row
    // lookahead past the active cell (js/calc.js setActive) for smooth arrow-key
    // navigation. Still far below the old 100-row/10,000-cell startup grid.
    check('Calc grid starts small (21 rows)', boot.cells === 21 * 100, boot.cells + ' cells');

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

    // Selection, clipboard, formatting, sort, filter, freeze (v2.1).
    const c2 = await run(async () => {
      document.querySelector('#calcToolbar .tb-btn[title="New blank sheet"]').click();
      await T.sleep(100);
      const down = (addr, opts = {}) => T.cell(addr).dispatchEvent(new MouseEvent('mousedown', Object.assign({ bubbles: true, cancelable: true, button: 0 }, opts)));
      const up = () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      const clipEv = (type, text) => {
        const dt = new DataTransfer();
        if (text != null) dt.setData('text/plain', text);
        document.activeElement.dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
        return dt.getData('text/plain');
      };
      const texts = (...addrs) => addrs.map(a => T.cell(a).textContent).join(',');
      const out = {};
      // Paste a block copied from another program.
      down('A1'); up();
      clipEv('paste', 'Item\tQty\tPrice\r\nPen\t3\t1.5\r\nBook\t1\t12\r\n"Cup, big"\t2\t4\r\n');
      out.pasted = texts('A1', 'B2', 'C3', 'A4');
      await T.setCell('D2', '=B2*C2');
      // Drag-select D2:D4, fill down.
      down('D2'); T.cell('D4').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); up();
      T.key(document.activeElement, 'd', { ctrlKey: true });
      out.fill = texts('D2', 'D3', 'D4');
      out.status = document.getElementById('statusInfo').textContent;
      out.overlay = getComputedStyle(document.querySelector('.calc-sel')).display;
      // Copy the selection and paste one column over: relative refs shift.
      const copied = clipEv('copy');
      out.copied = copied;
      down('E2'); up();
      clipEv('paste', copied);
      T.cell('E2').click();
      out.fxE2 = document.getElementById('calcFx').value;
      // Number format on C2:C4 (shift+click), bold on row 1 (row header + Ctrl+B).
      down('C2'); down('C4', { shiftKey: true }); up();
      const nf = document.getElementById('calcNumFmt');
      nf.value = '$#,##0.00'; nf.dispatchEvent(new Event('change'));
      out.currency = T.cell('C2').textContent;
      document.querySelector('.calc-rowhead').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); up();
      T.key(document.activeElement, 'b', { ctrlKey: true });
      out.bold = T.cell('B1').style.fontWeight + '/' + T.cell('B2').style.fontWeight;
      // Sort by Qty, largest first; the header row stays, formulas follow their rows.
      down('B2'); up();
      document.querySelector('#calcFormatBar .tb-btn[title^="Sort rows"]').click();
      await T.sleep(50);
      out.headGuess = document.getElementById('srtHead').checked;
      document.getElementById('srtDir').value = 'desc';
      T.dialogOk(); await T.sleep(50);
      out.sorted = texts('A1', 'A2', 'A3', 'A4', 'D2', 'D3', 'D4', 'C3');
      // Filter Qty > 1, then clear.
      document.getElementById('calcFilterBtn').click(); await T.sleep(50);
      document.getElementById('fltOp').value = 'gt';
      document.getElementById('fltVal').value = '1';
      T.dialogOk(); await T.sleep(50);
      out.filtered = ['A1', 'A2', 'A3', 'A4'].map(a => getComputedStyle(T.cell(a)).display === 'none' ? 'hidden' : 'shown').join(',');
      document.getElementById('calcFilterBtn').click(); await T.sleep(50);
      out.unfiltered = getComputedStyle(T.cell('A4')).display !== 'none';
      // Freeze row 1.
      document.getElementById('calcFreezeBtn').click();
      out.frozen = getComputedStyle(T.cell('A1')).position;
      // Delete clears the whole selection; undo brings it back.
      down('E2'); down('E4', { shiftKey: true }); up();
      T.key(document.activeElement, 'Delete');
      out.cleared = texts('E2', 'E3', 'E4');
      Calc.undo();
      out.undone = T.cell('E3').textContent !== '';
      // Formats and freeze are saved, and the number format reaches .xlsx.
      await T.flushAll();
      const saved = await Storage.load('calc:sheets');
      const sh = saved.sheets.find(s => s.id === saved.active);
      out.saved = (sh.fmts && sh.fmts.C2 && sh.fmts.C2.nf) + '|' + (sh.fmts && sh.fmts.A1 && sh.fmts.A1.b) + '|' + sh.freeze;
      T.fakeSave(); T.saved.length = 0;
      document.querySelector('#calcToolbar .tb-btn[title="Export"]').click();
      await T.sleep(50);
      document.querySelector('#dialogRoot [data-x=xlsx][data-scope=one]').click();
      await T.waitFor(() => T.saved.length);
      const ws = XLSX.read(T.saved.pop().bytes, { type: 'array', cellNF: true });
      out.xlsxFormat = ws.Sheets[ws.SheetNames[0]].C2.z;
      return out;
    });
    check('Calc: paste a block from another program', c2.pasted === 'Item,3,12,Cup, big', c2.pasted);
    check('Calc: drag-select + fill down', c2.fill === '4.5,12,8' && c2.overlay === 'block', c2.fill + ' overlay=' + c2.overlay);
    check('Calc: status bar shows Sum/Average/Count', c2.status.startsWith('D2:D4 · Sum 24.5 · Average') && c2.status.endsWith('Count 3'), c2.status);
    check('Calc: copy gives tab-separated text, paste shifts formulas', c2.copied === '4.5\n12\n8' && c2.fxE2 === '=C2*D2', JSON.stringify(c2.copied) + ' ' + c2.fxE2);
    check('Calc: number format + bold', c2.currency === '$1.50' && c2.bold === '700/', c2.currency + ' ' + c2.bold);
    check('Calc: sort keeps header, moves whole rows and their formulas', c2.headGuess && c2.sorted === 'Item,Pen,Cup, big,Book,4.5,8,12,$4.00', c2.headGuess + ' ' + c2.sorted);
    check('Calc: filter hides non-matching rows, clear shows them', c2.filtered === 'shown,shown,shown,hidden' && c2.unfiltered, c2.filtered + ' ' + c2.unfiltered);
    check('Calc: freeze row 1', c2.frozen === 'sticky', c2.frozen);
    check('Calc: Delete clears a range, undo restores it', c2.cleared === ',,' && c2.undone, JSON.stringify(c2.cleared) + ' ' + c2.undone);
    check('Calc: formats and freeze saved; number format exported', c2.saved === '$#,##0.00|true|true' && c2.xlsxFormat === '$#,##0.00', c2.saved + ' ' + c2.xlsxFormat);

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

    // Page breaks, header/footer, selection word count (v2.1).
    const w2 = await run(async () => {
      const tb = (t) => document.querySelector('#writerToolbar .tb-btn[title="' + t + '"]');
      const tabNamed = (s) => T.waitFor(() => [...document.querySelectorAll('#writerTabs .te-tab')].some(t => t.textContent.includes(s)));
      tb('New document').click(); await T.sleep(100);
      const ed = document.querySelector('.writer-doc');
      ed.innerHTML = '<p>First page text here</p><p>Second page</p>';
      const sel = getSelection();
      const caret = document.createRange(); caret.setStart(ed.firstChild.firstChild, 3); caret.collapse(true);
      sel.removeAllRanges(); sel.addRange(caret);
      tb('Insert page break (Ctrl+Enter)').click(); await T.sleep(50);
      const out = {};
      out.structure = [...ed.children].map(n => n.tagName + (n.className ? '.' + n.className : '')).join(' ');
      tb('Header and footer for printing and export').click(); await T.sleep(50);
      document.getElementById('psHead').value = '{title} draft';
      document.getElementById('psNumbers').click();
      T.dialogOk(); await T.sleep(50);
      const all = document.createRange(); all.selectNodeContents(ed.firstChild);
      sel.removeAllRanges(); sel.addRange(all);
      await T.sleep(400);
      out.status = document.getElementById('statusInfo').textContent;
      T.fakeSave(); T.saved.length = 0;
      const exp = async (fmt) => {
        tb('Export to .docx / .pdf').click(); await T.sleep(30);
        document.querySelector('#dialogRoot [data-x=' + fmt + ']').click();
        await T.waitFor(() => T.saved.length, 20000);
        return T.saved.pop();
      };
      const pdf = new TextDecoder('latin1').decode((await exp('pdf')).bytes);
      out.pdfPages = (pdf.match(/\/Type \/Page\b/g) || []).length;
      out.pdfMargins = pdf.includes('Page 2 of 2') && pdf.includes(' draft');
      const docx = await exp('docx');
      await Libs.need('jszip');
      const zip = await JSZip.loadAsync(docx.bytes);
      out.docxBreak = /<w:br w:type="page"\/>/.test(await zip.file('word/document.xml').async('string'));
      const footName = Object.keys(zip.files).find(n => /^word\/footer\d*\.xml$/.test(n));
      const foot = footName ? await zip.file(footName).async('string') : '';
      out.docxFooter = /PAGE/.test(foot) && /NUMPAGES/.test(foot);
      const html = await exp('html');
      const htmlText = new TextDecoder().decode(html.bytes);
      out.htmlMeta = htmlText.includes('<meta name="po:footer" content="Page {page} of {pages}">') && /break-after:\s*page/.test(htmlText);
      // A Word page break comes back as a Writer page break…
      T.fakeOpen({ name: 'breaks.docx', bytes: docx.bytes, text: async () => '' });
      tb('Open…').click(); await tabNamed('breaks'); await T.sleep(150);
      out.reopened = document.querySelectorAll('.writer-doc hr.page-break').length;
      // …and a saved .html brings its header/footer back.
      T.fakeOpen({ name: 'meta.html', bytes: html.bytes, text: async () => htmlText });
      tb('Open…').click(); await tabNamed('meta'); await T.sleep(100);
      tb('Header and footer for printing and export').click(); await T.sleep(50);
      out.metaBack = document.getElementById('psHead').value + '|' + document.getElementById('psFoot').value;
      document.querySelector('#dialogRoot [data-act=cancel]').click();
      return out;
    });
    check('Writer: page break inserted after the current paragraph', w2.structure === 'P HR.page-break P P', w2.structure);
    check('Writer: status counts selected words and page breaks', w2.status.startsWith('4 of 6 words selected') && w2.status.endsWith('1 page break'), w2.status);
    check('Writer .pdf: page break starts page 2, header/footer on pages', w2.pdfPages === 2 && w2.pdfMargins, w2.pdfPages + ' pages, margins=' + w2.pdfMargins);
    check('Writer .docx: page break + page-number footer', w2.docxBreak && w2.docxFooter, w2.docxBreak + ' ' + w2.docxFooter);
    check('Writer: page break survives a .docx round trip', w2.reopened === 1, w2.reopened + ' breaks');
    check('Writer .html: header/footer saved and restored', w2.htmlMeta && w2.metaBack === '{title} draft|Page {page} of {pages}', w2.htmlMeta + ' ' + w2.metaBack);

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

    // Stacking order, grouping and speaker notes (v2.1).
    const imp2 = await run(async () => {
      const tb = (t) => document.querySelector('#impressToolbar .tb-btn[title="' + t + '"]');
      tb('New presentation').click(); await T.sleep(100);
      tb('Add rectangle').click(); tb('Add ellipse').click(); await T.sleep(50);
      const canvas = document.getElementById('impCanvas');
      const nodes = () => [...canvas.querySelectorAll('.imp-el')];
      const isShape = (n) => n.classList.contains('imp-shape');
      const order = () => nodes().map(n => !isShape(n) ? 'T' : n.style.borderRadius ? 'E' : 'R').join('');
      const down = (n, opts = {}) => n.dispatchEvent(new MouseEvent('mousedown', Object.assign({ bubbles: true, cancelable: true, clientX: 5, clientY: 5 }, opts)));
      const up = () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      const selCount = () => canvas.querySelectorAll('.imp-el.selected').length;
      const out = { start: order() };
      // The ellipse was added last, so it is selected and on top.
      document.getElementById('iBack').click(); out.back = order();
      document.getElementById('iForward').click(); out.forward = order();
      // Shift+click the rectangle too, group, deselect, then drag one of them.
      down(nodes().find(n => isShape(n) && !n.style.borderRadius), { shiftKey: true }); up();
      out.multi = selCount();
      document.getElementById('iGroup').click(); await T.sleep(30);
      down(canvas); up();
      out.none = selCount();
      down(nodes().find(n => isShape(n) && !n.style.borderRadius), { clientX: 100, clientY: 100 });
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 160, clientY: 100 })); up();
      out.groupSel = selCount();
      out.movedTogether = nodes().filter(isShape).every(n => parseFloat(n.style.left) > 25);
      // Speaker notes survive a .pptx round trip and show in Present mode.
      const notes = document.getElementById('impNotes');
      notes.focus(); notes.value = 'Say hello\nThen pause';
      notes.dispatchEvent(new Event('input', { bubbles: true }));
      T.fakeSave(); T.saved.length = 0;
      tb('Export to .pptx or .pdf').click(); await T.sleep(50);
      document.querySelector('#dialogRoot [data-x=pptx]').click();
      await T.waitFor(() => T.saved.length, 20000);
      T.fakeOpen({ name: 'round.pptx', bytes: T.saved.pop().bytes, text: async () => '' });
      tb('Open .pptx or .json').click();
      await T.waitFor(() => [...document.querySelectorAll('#impressTabs .te-tab')].some(t => t.textContent.includes('round')));
      await T.sleep(100);
      out.notesBack = document.getElementById('impNotes').value;
      tb('Present (Esc to exit)').click(); await T.sleep(50);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
      const pn = document.getElementById('presNotes');
      out.presNotes = pn.textContent + '|' + pn.classList.contains('hidden');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.presClosed = !document.getElementById('impPresent');
      return out;
    });
    check('Impress: send to back / bring forward', imp2.start === 'TRE' && imp2.back === 'ETR' && imp2.forward === 'TER', [imp2.start, imp2.back, imp2.forward].join(' '));
    check('Impress: shift+click multi-select, group moves together', imp2.multi === 2 && imp2.none === 0 && imp2.groupSel === 2 && imp2.movedTogether, JSON.stringify([imp2.multi, imp2.none, imp2.groupSel, imp2.movedTogether]));
    check('Impress: speaker notes round-trip through .pptx', imp2.notesBack === 'Say hello\nThen pause', JSON.stringify(imp2.notesBack));
    check('Impress: notes in Present mode (N), Esc exits', imp2.presNotes === 'Say hello\nThen pause|false' && imp2.presClosed, JSON.stringify(imp2.presNotes));

    // ---------- Markdown ----------
    const md = await run(async () => {
      T.app('markdown'); await T.sleep(50);
      const ta = document.getElementById('mdEditor');
      ta.value = '[x](https://example.com) <img src=x onerror="window.MDPWN=1"> <a href="javascript:alert(1)">j</a>';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await T.sleep(400);
      const a = document.querySelector('#mdPreview a[href^="https"]');
      const img = document.querySelector('#mdPreview img');
      return { target: a && a.target, onerr: img && img.hasAttribute('onerror'), js: !!document.querySelector('#mdPreview a[href^="javascript"]'), ran: !!window.MDPWN };
    });
    check('Markdown: links open in new tab', md.target === '_blank');
    check('Markdown: handlers and javascript: links stripped', !md.onerr && !md.js && !md.ran, JSON.stringify(md));

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

    // ---------- Accessibility (v2.1) ----------
    const a11y = await run(async () => {
      T.app('text'); await T.sleep(50);
      const opener = document.getElementById('aboutBtn');
      opener.focus(); opener.click(); await T.sleep(50);
      const dlg = document.querySelector('#dialogRoot .dialog');
      const out = {
        inside: dlg.contains(document.activeElement),
        labelled: !!document.getElementById(dlg.getAttribute('aria-labelledby')),
        cancelHidden: getComputedStyle(dlg.querySelector('[data-act=cancel]')).display === 'none',
      };
      T.key(document.activeElement, 'Escape'); await T.sleep(30);
      out.closed = !document.querySelector('#dialogRoot .dialog');
      out.focusBack = document.activeElement === opener;
      // Arrow keys move between the tools.
      const tab = document.querySelector('.app-tab[data-app=text]');
      tab.focus(); T.key(tab, 'ArrowRight');
      out.nextTool = document.querySelector('.app-tab.active').dataset.app + '/' + document.activeElement.dataset.app;
      // Document tabs open with Enter.
      T.app('writer'); await T.sleep(50);
      const inactive = [...document.querySelectorAll('#writerTabs .te-tab')].find(t => !t.classList.contains('active'));
      const wanted = inactive.querySelector('.name').textContent;
      inactive.focus(); T.key(inactive, 'Enter'); await T.sleep(50);
      out.docTab = document.querySelector('#writerTabs .te-tab.active .name').textContent === wanted;
      // Dialog fields have names; toolbars are named; no button is nameless.
      document.querySelector('#writerToolbar .tb-btn[title="Insert table"]').click(); await T.sleep(50);
      out.unlabelled = [...document.querySelectorAll('#dialogRoot input, #dialogRoot select')].filter(c => !(c.labels && c.labels.length) && !c.getAttribute('aria-label')).length;
      document.querySelector('#dialogRoot [data-act=cancel]').click();
      out.toolbars = [...document.querySelectorAll('.toolbar, .md-toolbar')].filter(t => !t.getAttribute('aria-label')).length;
      out.nameless = [...document.querySelectorAll('button')].filter(x => !(x.textContent.trim() || x.getAttribute('aria-label') || x.title)).length;
      out.fields = [...document.querySelectorAll('.tool-panel input, .tool-panel select, .tool-panel textarea')]
        .filter(c => c.type !== 'hidden' && !(c.labels && c.labels.length) && !c.getAttribute('aria-label') && !c.title).map(c => c.id || c.className).join(',');
      return out;
    });
    check('A11y: dialog takes focus, is labelled, Esc closes, focus returns', a11y.inside && a11y.labelled && a11y.cancelHidden && a11y.closed && a11y.focusBack, JSON.stringify(a11y));
    check('A11y: arrow keys switch tools, Enter opens a document tab', a11y.nextTool === 'pdf/pdf' && a11y.docTab, a11y.nextTool + ' ' + a11y.docTab);
    check('A11y: every toolbar, button and field has a name', a11y.unlabelled === 0 && a11y.toolbars === 0 && a11y.nameless === 0 && a11y.fields === '', JSON.stringify([a11y.unlabelled, a11y.toolbars, a11y.nameless, a11y.fields]));

    // ---------- Backup & restore (v2.1) ----------
    const bk = await run(async () => {
      T.app('text'); await T.sleep(50);
      const ta = document.getElementById('teTextarea');
      ta.value = 'backed up text';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      T.fakeSave(); T.saved.length = 0;
      document.getElementById('backupBtn').click(); await T.sleep(100);
      document.getElementById('bkNow').click();
      await T.waitFor(() => T.saved.length, 20000);
      const sv = T.saved.pop();
      const zip = await JSZip.loadAsync(sv.bytes);
      const names = Object.keys(zip.files);
      const data = JSON.parse(await zip.file('pocketoffice-backup.json').async('string'));
      const out = {
        name: sv.name,
        folders: ['Writer/', 'Calc/', 'Impress/', 'Text Editor/'].filter(f => names.some(n => n.startsWith(f))).length,
        keys: data.records.map(r => r.key).sort().join(','),
        csv: await zip.file(names.find(n => n.startsWith('Calc/') && n.endsWith('.csv'))).async('string'),
      };
      await T.waitFor(() => /Storage use/.test(document.getElementById('bkUsage').textContent));
      out.usage = document.getElementById('bkUsage').textContent;
      T.dialogOk();
      // Not a backup -> refused. A crafted backup -> bad keys dropped, Writer HTML cleaned.
      try { await Backup.read(new Uint8Array([1, 2, 3])); out.bad = 'accepted'; } catch (e) { out.bad = e.message; }
      const evil = new JSZip();
      evil.file('pocketoffice-backup.json', JSON.stringify({ app: 'PocketOffice', records: [
        { key: 'writer:docs', value: { docs: [{ id: 'w1', name: 'x.html', html: '<p onclick="x()">hi</p><scr' + 'ipt>window.BKPWN=1</scr' + 'ipt>' }] } },
        { key: 'fs:lastHandle', value: {} }, { key: '../bad', value: 1 }] }));
      const r = await Backup.read(await evil.generateAsync({ type: 'uint8array' }));
      out.clean = r.records.length + '|' + r.records[0].value.docs[0].html;
      // Change the text, then restore the backup: the page reloads with the backed-up text.
      ta.value = 'changed after the backup';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await T.flushAll();
      T.fakeOpen({ name: sv.name, bytes: sv.bytes });
      document.getElementById('backupBtn').click(); await T.sleep(100);
      document.getElementById('bkRestore').click();
      await T.waitFor(() => /Restore this backup/.test((document.querySelector('#dialogRoot h3') || {}).textContent || ''));
      setTimeout(() => T.dialogOk(), 50);   // reloads the page
      return out;
    });
    await new Promise(r => setTimeout(r, 1500));
    await b.evaluate(`new Promise(r => { const t = setInterval(() => { if (document.readyState === 'complete' && document.querySelector('.calc-cell') && document.querySelector('#writerTabs .te-tab')) { clearInterval(t); r(true); } }, 100); })`);
    await b.evaluate(HELPERS);
    const restored = await run(async () => {
      await T.sleep(300);
      T.app('text'); await T.sleep(50);
      return document.getElementById('teTextarea').value;
    });
    check('Backup: one .zip with data + readable copies', /^PocketOffice-backup-\d{4}-\d\d-\d\d\.zip$/.test(bk.name) && bk.folders === 4 && bk.keys.includes('calc:sheets') && bk.keys.includes('writer:docs') && !bk.keys.includes('fs:'), bk.name + ' folders=' + bk.folders + ' ' + bk.keys);
    check('Backup: Calc copy is CSV with formulas', /^10,=50%\r\n=A1\*2,/.test(bk.csv) && bk.csv.includes('"1,000"'),bk.csv.slice(0, 60).replace(/\r?\n/g, ' / '));
    check('Backup: storage use reported', /Storage use/.test(bk.usage), bk.usage);
    check('Restore: rejects non-backups, drops bad keys, cleans HTML', /not a \.zip/.test(bk.bad) && bk.clean === '1|<p>hi</p>', bk.bad + ' ; ' + bk.clean);
    check('Restore: replaces documents and reloads', restored === 'backed up text', restored);

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

    // ---------- Offline: the hosted copy keeps working with no server (v2.1) ----------
    // Runs against its own server on another port so it can be switched off.
    const offPort = 8791;
    const offBase = 'http://127.0.0.1:' + offPort + '/';
    let offServer = spawn(process.execPath, [path.join(__dirname, 'serve.js'), ROOT, String(offPort)], { stdio: 'ignore' });
    try {
      await new Promise(r => setTimeout(r, 1000));
      await load(offBase);
      const cached = await run(async () => {
        const reg = await Promise.race([navigator.serviceWorker.ready, T.sleep(30000).then(() => null)]);
        if (!reg) return { ready: false };
        await T.waitFor(() => navigator.serviceWorker.controller, 10000);
        const name = (await caches.keys()).find(n => n.startsWith('pocketoffice-'));
        const keys = (await (await caches.open(name)).keys()).map(r => new URL(r.url).pathname);
        const need = ['/', '/index.html', '/css/app.css', '/js/calc.js', '/js/version.js', '/lib/xlsx.full.min.js', '/lib/pdf.min.js',
          '/lib/pdf.worker.min.js', '/lib/embedded-fonts.js', '/lib/fonts/inter-var.woff2', '/icons/icon-192.png', '/manifest.webmanifest'];
        return { ready: true, name, count: keys.length, missing: need.filter(k => !keys.includes(k)) };
      });
      check('Offline: service worker saves the whole app', cached.ready && cached.name === 'pocketoffice-' + APP_VERSION && cached.missing.length === 0, JSON.stringify(cached));
      offServer.kill(); offServer = null;
      await new Promise(r => setTimeout(r, 700));
      const errsBefore = b.errors.length;
      await load(offBase);
      const off = await run(async () => {
        let serverUp = true;
        try { await fetch('never-cached-' + Date.now()); } catch (e) { serverUp = false; }
        T.app('calc'); await T.sleep(50);
        await T.setCell('A1', '=1+1');
        await Libs.need('xlsx', 'pdfjs', 'docx');
        return { serverUp, a1: T.cell('A1').textContent, libs: [typeof XLSX, typeof pdfjsLib, typeof docx].join(','), font: (await fetch('lib/fonts/lora-var.woff2')).ok };
      });
      b.errors.length = errsBefore;   // "connection refused" noise is expected while the server is off
      check('Offline: app, libraries and fonts load with the server switched off', !off.serverUp && off.a1 === '2' && off.libs === 'object,object,object' && off.font, JSON.stringify(off));
    } finally {
      if (offServer) offServer.kill();
    }
  } catch (e) {
    check('harness', false, e.stack || e.message);
  } finally {
    // The hostile-input tests above feed on*= attributes to the sanitizer on
    // purpose. Chrome logs a CSP violation as soon as any parser (even
    // DOMPurify's inert DOMParser document) sees one, so "inline event handler
    // ... has been blocked" is the CSP doing its job, not an app error. Every
    // other CSP violation (inline <script>, eval, remote loads) still fails.
    const expectedCsp = /^LOG Executing inline event handler violates the following Content Security Policy directive .*The action has been blocked\./;
    const errs = b.errors.filter(e => !/favicon|:\d+\/x$/.test(e) && !expectedCsp.test(e));
    check('no console errors or exceptions', errs.length === 0, errs.slice(0, 8).join('\n    '));
    await b.close();
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
