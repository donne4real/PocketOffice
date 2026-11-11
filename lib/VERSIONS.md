# Vendored libraries

Everything PocketOffice runs is in this folder — nothing is fetched from the
internet. Check this list against the libraries' security advisories when
updating. "Loaded" says when the file is pulled in (`js/libs.js` loads the
on-demand ones the first time a tool needs them).

| File | Library | Version | Source | Loaded |
|------|---------|---------|--------|--------|
| `marked.min.js` | marked | 12.0.2 | npm `marked` | startup |
| `purify.min.js` | DOMPurify | 3.2.6 | npm `dompurify` (`dist/purify.min.js`) | startup |
| `pdf.min.js` + `pdf.worker.min.js` | pdf.js | 3.11.174 | npm `pdfjs-dist` (`build/`) | PDF Tools |
| `pdf-lib.min.js` | pdf-lib | 1.17.1 | npm `pdf-lib` (`dist/pdf-lib.min.js`) | PDF Tools |
| `jspdf.umd.min.js` | jsPDF | 2.5.2 | npm `jspdf` | PDF export |
| `embedded-fonts.js` | Inter / Lora / JetBrains Mono subsets | generated | `scripts/_gen-embedded-fonts.js` | PDF export |
| `xlsx.full.min.js` | SheetJS CE | 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/ | Calc |
| `docx.umd.js` | docx | 8.5.0 | npm `docx` (`build/index.umd.js`) | Writer .docx export |
| `mammoth.browser.js` | mammoth | 1.12.3 | npm `mammoth` (`mammoth.browser.min.js`, despite the local filename) | Writer .docx open |
| `jszip.min.js` | JSZip | 3.10.1 | npm `jszip` | Impress |
| `pptxgenjs.min.js` | PptxGenJS | 3.12.0 | npm `pptxgenjs` | Impress |
| `chart.umd.min.js` | Chart.js | 4.4.1 | npm `chart.js` | Calc charts |
| `fonts/*` | Inter, Lora, JetBrains Mono | — | Google Fonts, SIL OFL 1.1 | CSS / PDF export |

## Known advisories and how they are handled

- **pdf.js 3.11.174 — CVE-2024-4367** (a crafted font in a PDF can run
  JavaScript). Fixed upstream in 4.2.67, but pdf.js 4+ ships only as ES
  modules, which don't load over `file://`. Mitigated by opening every PDF
  with `isEvalSupported: false` (`js/pdftools.js`), the workaround pdf.js
  recommends. `.github/workflows/check-pdfjs.yml` runs
  `scripts/check-pdfjs-build.js` monthly and fails the job if a classic-script
  build of a fixed version ever appears, so this doesn't rely on anyone
  remembering to check by hand.
- **SheetJS — CVE-2023-30533 and CVE-2024-22363** (prototype pollution and
  ReDoS when reading crafted files). Fixed by upgrading from 0.18.5 to
  0.20.3 in v2.0.0. Note that SheetJS no longer publishes to npm; get
  updates from cdn.sheetjs.com.
- **mammoth 1.6.0 — CVE-2025-11849 / GHSA-rmjr-87wv-gf87** (directory
  traversal, fixed in 1.11.0). `pdf-lib.min.js`, `docx.umd.js`, and
  `mammoth.browser.js` previously had no version recorded here; diffing
  their vendored bytes against published npm releases (exact sha256 match)
  found the mammoth build was actually 1.6.0 — in the vulnerable range.
  A crafted .docx with an image using an external link (`r:link` instead of
  an embedded `r:embed`) makes mammoth resolve that URI as a local file
  path, read it, and inline it as a base64 data URI in the converted HTML —
  letting an opened .docx exfiltrate arbitrary local files (or hang the tab
  by linking a device file like `/dev/random`) through Writer's "Open"
  button. Fixed by upgrading the vendored file to 1.12.3 (last release
  before mammoth's 1.13.0 bundler rewrite; still outside the vulnerable
  range, and closest to a drop-in replacement for the old build). Re-run
  `node --test tests/*.test.js` and the "Writer .docx" browser checks after
  touching this file — they cover bold/italic/underline, text color,
  hyperlinks, lists, and table+image fidelity.

## Updating a library

1. Replace the file here and update this table.
2. `node --test tests/*.test.js` and the browser checks in `tests/browser/`.
3. `node scripts/_build-single-file.js` to refresh the standalone build.
