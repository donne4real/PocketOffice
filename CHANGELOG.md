# Changelog

## v2.0.0 — 2026-09-23

v1.4.0 is archived unchanged in `../PocketOffice-archive/PocketOffice-v1.4.0/`.
Existing autosaved work from v1 is picked up automatically.

### Security
- **PDF Tools:** PDFs are opened with `isEvalSupported: false`, which closes
  CVE-2024-4367 (a crafted PDF could run script) in the bundled pdf.js.
- **Calc:** SheetJS upgraded 0.18.5 → 0.20.3 (CVE-2023-30533, CVE-2024-22363).
- **Writer / Markdown:** HTML from opened files and Markdown previews is
  cleaned by DOMPurify 3.2.6 instead of two hand-rolled copies of a partial
  sanitizer. Markdown preview links open in a new tab.
- **Impress:** deck data from `.json`/`.pptx` files and storage is validated
  (element kinds, numbers, `#hex` colors, image data URLs) and is no longer
  pasted into HTML strings, so a crafted deck can't inject markup.

### Data-loss fixes
- Writer, Calc and Impress no longer hand out a tab id that is already in
  use after a restart (restoring tabs `w2, w3` used to create a second `w3`).
  Impress element ids are unique too.
- Text Editor autosave is keyed by tab, not by file name: renaming a file or
  changing its mode no longer leaves a ghost tab, two files with the same
  name no longer overwrite each other, and tab order and unsaved markers
  survive a restart.
- Every tool writes its pending autosave when the page is hidden or closed
  (previously the last ~800 ms of typing could be lost).
- **Writer:** saving a document opened from `.docx` now writes a real `.docx`
  (after a one-time "Overwrite?" confirmation). v1 wrote HTML into the
  original `.docx` file.
- Writer, Text Editor and Markdown remember which file each tab came from, so
  Ctrl+S after a restart saves in place (the browser asks for permission once).
- Save dialogs: if you rename the file in the picker, the tab shows the new name.

### Calc
- New formula engine (`js/formula.js`), unit-tested: unknown characters and
  leftover tokens are errors instead of silently wrong answers (`=50%` was
  50, `=1 2` was 1); `%`, `$A$1` absolute references and `Sheet!A1` /
  `'Sheet name'!A1` references work; Excel operator precedence; errors
  propagate; `IF`/`IFERROR` evaluate lazily; case-insensitive text comparison;
  new `COUNTIF`, `SUMIF`, `AVERAGEIF`, `COUNTBLANK`, `IFNA`, `ISNA`, `ISERR`,
  `ISLOGICAL`, `COLUMN`; `ROW()` works; cycles show `#CYCLE!`.
- Typed values: only whole-string numbers become numbers (`2026-09-23` stays
  text instead of becoming 2026; `1,000` is 1000; `50%` is 0.5).
- Charts stay draggable (v1 lost the drag after any other click).
- Ctrl+D fill down works, and adjusts relative references like Excel.
- Import reads every worksheet (each becomes a tab; their cross-sheet formulas
  resolve). Export to `.xlsx` keeps formulas, can include all open sheets,
  and is named after the sheet (was always `Sheet1.xlsx`).
- The grid is built as you scroll instead of 100,000 cells at startup, and a
  recalculation touches only cells whose display changed.

### Writer
- `.docx` and PDF export keep inline formatting (bold, italic, underline,
  strikethrough, colors, highlight, fonts, sizes), links, images, nested
  lists, alignment and tables (`js/docexport.js`). PDF export maps system
  serif and monospace fonts to Times and Courier.

### Impress
- "Edit text" works (v1 replaced the text with `[object Promise]`).
- Save and export use the deck name instead of `presentation.*`.

### Performance
- The large libraries (pdf.js, pdf-lib, jsPDF, SheetJS, docx, mammoth, JSZip,
  PptxGenJS, Chart.js) load the first time a tool needs them (`js/libs.js`)
  instead of at startup.
- Undo history for text documents is capped at about 50 MB per document, so
  pasting large images no longer grows memory without limit.

### Other
- Ctrl+Z / Ctrl+Y now work in Markdown and PDF Tools.
- The version lives in one place (`js/version.js`); the About box lists all
  six tools.
- CSS that four modules injected from JavaScript now lives in `css/app.css`.
- Tests: `node --test tests/*.test.js` (formula engine and shared helpers)
  and browser checks in `tests/browser/`. Library versions and advisories
  are tracked in `lib/VERSIONS.md`.
