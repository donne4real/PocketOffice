<div align="center">

# 📦 PocketOffice

**A complete office suite that runs in your browser — no install, no admin rights, no internet.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![No Dependencies](https://img.shields.io/badge/runtime-zero%20deps-success)](#)
[![Runs Offline](https://img.shields.io/badge/runs-100%25%20offline-success)](#)
[![Size](https://img.shields.io/badge/size-4.4_MB-informational)](#)

**Writer** · **Calc** · **Impress** · **Text Editor** · **PDF Tools**

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
| 📡 No internet | Every library is bundled locally in `lib/`. Zero CDN calls. |

> 💡 **Tip:** Copy the whole folder to a USB stick, plug into any locked-down
> PC, and double-click `start.bat`. It just works.

## The five tools

| | Tool | Highlights | Formats |
|---|------|------------|---------|
| 📝 | **Writer** | Full rich-text toolbar: font/color/headings/lists/tables/images/links, find-replace, autosave. Reads **and** writes `.docx`. | `.docx` `.pdf` `.html` `.txt` |
| 📊 | **Calc** | 1000×100 grid + hand-written formula engine (60+ functions: `SUM`, `IF`, `VLOOKUP`, `ROUND`, `CONCAT`, `STDEV`…). Cell refs, ranges, error values. | `.xlsx` `.csv` |
| 📽️ | **Impress** | 16:9 slides, text/shapes/images, drag-and-resize, inspector, **fullscreen present mode**. | `.pptx` `.pdf` |
| 📄 | **Text Editor** | Tabbed, line numbers, real tab key, find, word/char count. Multi-format. | any text |
| 📕 | **PDF Tools** | View, **merge**, **split** (page ranges), reorder, rotate, delete, **add text**, **sign by drawing**, export. | `.pdf` |

### Honest limitation

Editing *existing* text baked into a PDF (rewriting words already in the file)
isn't supported — even LibreOffice struggles with that. You can add text,
signatures, images, and restructure pages freely.

## Quick start

### Option A — run locally (USB / offline use)

1. Download or clone this repo.
2. Open the `PocketOffice/` folder.
3. **Double-click `start.bat`** (finds Edge/Chrome automatically) — or double-click `index.html`.

### Option B — run the live demo

Just open **[donne4real.github.io/PocketOffice](https://donne4real.github.io/PocketOffice/)**.

> Note: the hosted version needs internet only to *load* the page. Once loaded,
> everything runs locally in your browser.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+1`…`Alt+5` | Switch between the five tools |
| `Ctrl+S` | Save current document (Writer, Text Editor) |
| `Ctrl+Shift+T` | Toggle dark mode |
| `Ctrl+B` / `I` / `U` | Bold / italic / underline (Writer) |
| `F2` | Edit current cell (Calc) |
| `Enter` / `Tab` / `Arrows` | Navigate cells (Calc) |
| `Arrows` / `Space` / `Esc` | Navigate / exit present mode (Impress) |

## Architecture

```
PocketOffice/
├── index.html              ← double-click to launch
├── start.bat               ← launcher (finds Edge/Chrome)
├── README.md  START-HERE.txt  LICENSE
├── samples/                ← .docx, .xlsx, .pptx to test with
├── css/app.css             ← shared theme (light + dark)
├── lib/                    ← 9 vendored libraries, ~4 MB, no network at runtime
│   ├── pdf.min.js + pdf.worker.min.js   ← pdf.js: render existing PDFs
│   ├── pdf-lib.min.js                   ← manipulate PDFs (merge/split/draw)
│   ├── jspdf.umd.min.js                 ← export Writer/Impress → PDF
│   ├── xlsx.full.min.js                 ← SheetJS: .xlsx/.csv
│   ├── docx.umd.js                      ← Writer → real .docx
│   ├── mammoth.browser.js               ← reads existing .docx → HTML
│   ├── jszip.min.js                     ← required by pptxgenjs
│   └── pptxgenjs.min.js                 ← Impress → real .pptx
└── js/                     ← vanilla JS, classic <script> tags, no build step
    ├── app.js              ← shell: tabs, theme, status bar, boot
    ├── storage.js          ← IndexedDB autosave + File System Access API
    ├── texteditor.js  word.js  calc.js  impress.js  pdftools.js
```

Everything is **vanilla JS** with classic `<script>` tags — no build step,
no bundler, no ES modules (those break on `file://`). The app code (~3,000
lines) is readable and tweakable.

## Privacy

**100% local.** No data leaves the machine — not in the USB version, not in
the live demo. No telemetry, no accounts, no analytics, no network calls of
any kind at runtime. Every library is in `lib/`. Your documents live either
in your browser's IndexedDB (autosave) or wherever you choose to save them
on disk.

## Build the standalone single-file version

Want everything inlined into one `.html` for email-friendly distribution?

```bash
node _build-single-file.js
# → produces PocketOffice-standalone.html (~3.8 MB)
```

(That script is included in the repo but git-ignored output.)

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
| [JSZip](https://stuk.github.io/jszip/) | MIT | Zip handling |
| [PptxGenJS](https://gitbrent.github.io/PptxGenJS/) | MIT | PowerPoint generation |

PocketOffice itself is plain vanilla JS — read it, learn from it, change it.

## License

[MIT](LICENSE) © 2026 donne4real
