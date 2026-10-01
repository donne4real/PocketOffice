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
| `pdf-lib.min.js` | pdf-lib | unknown — not stamped in the file | npm `pdf-lib` | PDF Tools |
| `jspdf.umd.min.js` | jsPDF | 2.5.2 | npm `jspdf` | PDF export |
| `embedded-fonts.js` | Inter / Lora / JetBrains Mono subsets | generated | `scripts/_gen-embedded-fonts.js` | PDF export |
| `xlsx.full.min.js` | SheetJS CE | 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/ | Calc |
| `docx.umd.js` | docx | unknown — not stamped in the file (API matches 8.x) | npm `docx` | Writer .docx export |
| `mammoth.browser.js` | mammoth | unknown — not stamped in the file | npm `mammoth` | Writer .docx open |
| `jszip.min.js` | JSZip | 3.10.1 | npm `jszip` | Impress |
| `pptxgenjs.min.js` | PptxGenJS | 3.12.0 | npm `pptxgenjs` | Impress |
| `chart.umd.min.js` | Chart.js | 4.4.1 | npm `chart.js` | Calc charts |
| `fonts/*` | Inter, Lora, JetBrains Mono | — | Google Fonts, SIL OFL 1.1 | CSS / PDF export |

## Known advisories and how they are handled

- **pdf.js 3.11.174 — CVE-2024-4367** (a crafted font in a PDF can run
  JavaScript). Fixed upstream in 4.2.67, but pdf.js 4+ ships only as ES
  modules, which don't load over `file://`. Mitigated by opening every PDF
  with `isEvalSupported: false` (`js/pdftools.js`), the workaround pdf.js
  recommends. Revisit if a classic-script build of a fixed version appears.
- **SheetJS — CVE-2023-30533 and CVE-2024-22363** (prototype pollution and
  ReDoS when reading crafted files). Fixed by upgrading from 0.18.5 to
  0.20.3 in v2.0.0. Note that SheetJS no longer publishes to npm; get
  updates from cdn.sheetjs.com.

## Updating a library

1. Replace the file here and update this table.
2. `node --test tests/*.test.js` and the browser checks in `tests/browser/`.
3. `node scripts/_build-single-file.js` to refresh the standalone build.

## Subresource Integrity (SRI)

Every script loaded at runtime carries a SHA-384 integrity hash. The static
scripts (marked.min.js, purify.min.js, and all js/*.js) have `integrity`
attributes in `index.html`. The dynamically loaded libraries in this folder
(pdf.min.js, xlsx.full.min.js, etc.) have their hashes in the `SRI` map in
`js/libs.js`.

**When updating a library file, you must recompute its hash.** From the
project root:

```bash
# PowerShell
$hash = Get-FileHash -Path lib/FILE.js -Algorithm SHA384
[Convert]::ToBase64String([byte[]]($hash.Hash -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) }))

# macOS / Linux
openssl dgst -sha384 -binary lib/FILE.js | openssl base64 -A
```

Then update the hash in `index.html` (for static scripts) or in the `SRI`
map in `js/libs.js` (for dynamically loaded ones).
