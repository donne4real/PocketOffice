<div align="center">

# 📦 PocketOffice

**A complete office suite that runs in your browser — no install, no admin rights, no internet.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![No Dependencies](https://img.shields.io/badge/runtime-zero%20deps-success)](#)
[![Runs Offline](https://img.shields.io/badge/runs-100%25%20offline-success)](#)
[![Size](https://img.shields.io/badge/size-6_MB-informational)](#)

**Writer** · **Calc** · **Impress** · **Text Editor** · **PDF Tools** · **Markdown**

### 🌐 **[Try the live demo →](https://donne4real.github.io/PocketOffice/)**

*The link above runs the full app right in your browser — no download needed.*

</div>

---

## Why?

Built for PCs where you have **no admin rights**, **IT blocks unknown `.exe`
files**, and/or **there's no internet connection**. PocketOffice sidesteps all
three constraints:

| Constraint | How PocketOffice beats it |
|------------|---------------------------|
| 🔒 No admin / no installer | It's just files. Opening HTML in a browser needs no privileges. |
| 🚫 AppLocker blocks unknown `.exe` | We run no `.exe` at all. The trusted browser (Edge/Chrome, already installed) does everything. |
| 📡 No internet | Every library — and even three typeface families — is bundled locally in `lib/`. Zero CDN calls. |

> 💡 **Tip:** Copy the whole folder to a USB stick, plug into any locked-down
> PC, and double-click `start.bat`. It just works.

## The six tools

All four document tools — Writer, Calc, Impress, Text Editor — are
**multi-document**: open as many files as you like, each in its own tab.
Tabs autosave with their content and are restored on the next launch.
Opening a file into a pristine untitled tab reuses it (browser-style);
closing a tab with unsaved work asks first.

| | Tool | Highlights | Formats |
|---|------|------------|---------|
| 📝 | **Writer** | Tabbed rich-text editor: font/color/headings/lists/tables/images/links, find-replace, autosave, **21 fonts** (incl. 3 bundled). Reads **and** writes `.docx`. | `.docx` `.pdf` `.html` `.txt` |
| 📊 | **Calc** | Tabbed sheets: 1000×100 grid, unit-tested formula engine (70+ functions: `SUM`, `IF`, `VLOOKUP`, `SUMIF`, `COUNTIF`, `ROUND`, `STDEV`…), `$A$1` and `Sheet!A1` references, `%`, error values, fill-down, **charts**. Multi-sheet `.xlsx` import/export keeps formulas. | `.xlsx` `.csv` |
| 📽️ | **Impress** | Tabbed decks: 16:9 slides, text/shapes/images, drag-and-resize, inspector with **font picker**, **fullscreen present mode**. | `.pptx` `.pdf` `.json` |
| 📄 | **Text Editor** | Tabbed, line numbers, real tab key, find, word/char count. Multi-format. | any text |
| 📕 | **PDF Tools** | View, **merge**, **split** (page ranges), reorder, rotate, delete, **add text**, **sign by drawing**, export. | `.pdf` |
| 📖 | **Markdown** | Split-pane editor with **live preview**, GFM rendering (tables, task lists, code), print & HTML export. | `.md` `.html` |

Every document tool also has a **＋ New** button (toolbar and tab strip) to
start a fresh document in a new tab instantly.

## Fonts

The font menus offer two groups:

- **System fonts** (Calibri, Segoe UI, Cambria, Consolas, …) — whatever the
  host PC already has. Nothing to download.
- **Bundled fonts** — **Inter**, **Lora**, and **JetBrains Mono**, shipped as
  variable WOFF2 files in `lib/fonts/` (~220 KB total, all weights + italics).
  These render identically on every PC, fully offline, and survive into
  `.pptx` export. Licensed under the SIL Open Font License — see
  `lib/fonts/OFL-LICENSES.md`.

### Honest limitations

Editing *existing* text baked into a PDF (rewriting words already in the file)
isn't supported — even LibreOffice struggles with that. You can add text,
signatures, images, and restructure pages freely.

**PDF export** embeds the three bundled font families (Inter, Lora, JetBrains
Mono — regular/bold/italic, latin subset) into generated PDFs, so those
documents look right on any machine. System fonts (Calibri, Cambria, …) can't
be embedded: they export as the closest PDF standard font (Helvetica, Times or
Courier), and in `.docx`/`.pptx` exports they depend on the recipient's PC
having them installed.

**Writer's `.docx` round trip** keeps text, headings, lists, tables, images,
links and character formatting. Page layout, headers/footers, comments and
tracked changes from an opened Word file are not kept, so Save asks before
overwriting the original (use Save As… to keep it untouched).

## Quick start

### Option A — run locally (USB / offline use)

1. Download or clone this repo.
2. Open the `PocketOffice/` folder.
3. **Double-click `start.bat`** (finds Edge/Chrome automatically) — or double-click `index.html`.

### Option B — run the live demo

Just open **[donne4real.github.io/PocketOffice](https://donne4real.github.io/PocketOffice/)**.

> Note: the hosted version needs internet to load the page, and to load each
> tool's libraries the first time you use that tool. Your documents are
> processed locally in your browser either way.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+1`…`Alt+6` | Switch between the six tools |
| `Ctrl+S` | Save current document (Writer, Text Editor, Markdown) |
| `Ctrl+Shift+T` | Reopen the last closed tab (Writer, Calc, Impress, Text Editor) |
| `Ctrl+Shift+D` | Toggle dark mode |
| `Ctrl+B` / `I` / `U` | Bold / italic / underline (Writer) |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo in the active tool |
| `Ctrl+D` | Fill down (Calc) |
| `F2` | Edit current cell (Calc) |
| `Enter` / `Tab` / `Arrows` | Navigate cells (Calc) |
| `Arrows` / `Space` / `Esc` | Navigate / exit present mode (Impress) |

Tabs in every document tool can be **dragged to reorder**.

## Architecture

```
PocketOffice/
├── index.html              ← double-click to launch
├── start.bat               ← launcher (finds Edge/Chrome)
├── README.md  START-HERE.txt  CHANGELOG.md  LICENSE
├── samples/                ← .docx, .xlsx, .pptx to test with
├── tests/                  ← node --test unit tests + tests/browser/ checks
├── css/app.css             ← theme (light + dark) and every tool's styles
├── css/fonts.css           ← @font-face for the bundled fonts
├── lib/                    ← vendored libraries (versions: lib/VERSIONS.md)
│   ├── pdf.min.js + pdf.worker.min.js   ← pdf.js: render existing PDFs
│   ├── pdf-lib.min.js                   ← manipulate PDFs (merge/split/draw)
│   ├── jspdf.umd.min.js                 ← export Writer/Impress → PDF
│   ├── xlsx.full.min.js                 ← SheetJS: .xlsx/.csv
│   ├── docx.umd.js                      ← Writer → real .docx
│   ├── mammoth.browser.js               ← reads existing .docx → HTML
│   ├── jszip.min.js                     ← required by pptxgenjs
│   ├── pptxgenjs.min.js                 ← Impress → real .pptx
│   ├── chart.umd.min.js                 ← charts in Calc
│   ├── marked.min.js                    ← markdown rendering
│   ├── purify.min.js                    ← DOMPurify: cleans opened HTML
│   └── fonts/                           ← Inter, Lora, JetBrains Mono (OFL)
└── js/                     ← vanilla JS, classic <script> tags, no build step
    ├── version.js          ← the version number (single source)
    ├── libs.js             ← loads the big libraries on first use
    ├── app.js              ← shell: tabs, theme, status bar, boot
    ├── storage.js          ← IndexedDB autosave, File System Access, shared UI,
    │                          sanitizer, undo history, Fonts lists, Tabs strip
    ├── formula.js          ← Calc's formula engine (pure, unit-tested)
    ├── docexport.js        ← Writer → .docx / .pdf with formatting
    ├── texteditor.js  word.js  calc.js  impress.js
    ├── pdftools.js  markdown.js
```

Everything is **vanilla JS** with classic `<script>` tags — no build step,
no bundler, no ES modules (those break on `file://`). The app code is
readable and tweakable; add a font by dropping a WOFF2 into `lib/fonts/`,
declaring it in `css/fonts.css`, and adding the name to the `Fonts` lists
in `js/storage.js`.

## Tests

```bash
npm test                  # formula engine + shared helpers (node --test)
npm run serve             # in one terminal: serves the app on :8765
npm run test:browser -- "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
```

The browser checks drive a headless Edge/Chrome over the DevTools protocol
with a throwaway profile; no npm packages are needed.

## Privacy

**100% local.** No data leaves the machine — not in the USB version, not in
the live demo. No telemetry, no accounts, no analytics, no network calls of
any kind at runtime. Every library and font is in `lib/`. Your documents live
either in your browser's IndexedDB (autosave) or wherever you choose to save
them on disk.

## Build the standalone single-file version

Want everything inlined into one `.html` for email-friendly distribution?

```bash
node _build-single-file.js
# → produces PocketOffice-standalone.html (~6 MB: every library, the fonts
#    and the pdf.js worker embedded — truly one file)
```

(The build script is tracked in the repo; only the generated `.html` is
git-ignored.)

## Credits

Built with these excellent open-source libraries, all bundled locally:

| Library | License | Purpose |
|---------|---------|---------|
| [pdf.js](https://mozilla.github.io/pdf.js/) | Apache-2.0 | PDF rendering |
| [pdf-lib](https://pdf-lib.js.org/) | MIT | PDF manipulation |
| [jsPDF](https://github.com/parallax/jsPDF) | MIT | PDF generation |
| [SheetJS](https://sheetjs.com/) | Apache-2.0 | Spreadsheets |
| [docx](https://docx.js.org/) | MIT | Word document generation |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | BSD-2-Clause | Reading `.docx` |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Apache-2.0 / MPL-2.0 | HTML sanitizing |
| [JSZip](https://stuk.github.io/jszip/) | MIT | Zip handling |
| [PptxGenJS](https://gitbrent.github.io/PptxGenJS/) | MIT | PowerPoint generation |
| [Chart.js](https://www.chartjs.org/) | MIT | Calc charts |
| [marked](https://marked.js.org/) | MIT | Markdown rendering |
| [Inter](https://rsms.me/inter/) · [Lora](https://github.com/cyrealtype/Lora-Cyrillic) · [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | SIL OFL 1.1 | Bundled fonts |

PocketOffice itself is plain vanilla JS — read it, learn from it, change it.

## License

[MIT](LICENSE) © 2026 donne4real
