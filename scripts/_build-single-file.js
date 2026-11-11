// Builds PocketOffice-standalone.html: inlines css/ + js/ + lib/ into one file.
// Usage:  node scripts/_build-single-file.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

// Single source of truth for the version: js/version.js.
const verSrc = fs.readFileSync(path.join(ROOT, 'js', 'version.js'), 'utf8');
const VERSION = 'v' + (/version:\s*'([^']+)'/.exec(verSrc) || [])[1];

// index.html loads the big libraries on demand through js/libs.js. A single
// file can't fetch siblings, so inline every library listed in the Libs
// manifest up front; Libs.need() then finds them ready and resolves at once.
const libsSrc = fs.readFileSync(path.join(ROOT, 'js', 'libs.js'), 'utf8');
const lazyLibs = [...new Set(libsSrc.match(/'lib\/[^']+\.js'/g).map(s => s.slice(1, -1)))];

const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Inlined code must not contain a literal "</script" or the HTML parser
// ends the <script> element early. "<\/script" means the same thing in JS.
const safeJs = (code) => code.replace(/<\/script/gi, '<\\/script');

function inlineCss(html) {
  return html.replace(/<link[^>]*href="([^"]+\.css)"[^>]*>/g, (m, href) => {
    const p = path.join(ROOT, href);
    if (!fs.existsSync(p)) return m;
    return '<style>\n' + fs.readFileSync(p, 'utf8') + '\n</style>';
  });
}

function inlineScripts(html) {
  const marker = '<script src="js/version.js"></script>';
  if (!html.includes(marker)) throw new Error('index.html: version.js script tag not found');
  const workerCode = fs.readFileSync(path.join(ROOT, 'lib', 'pdf.worker.min.js'), 'utf8');
  // pdf.js can't load its worker from a sibling file here; hand it a Blob URL.
  // pdftools.js reads window.PO_PDF_WORKER_SRC when it first opens a PDF.
  const workerShim = '<script>\n(function(){try{var b=new Blob([' + safeJs(JSON.stringify(workerCode)) +
    '],{type:"application/javascript"});window.PO_PDF_WORKER_SRC=URL.createObjectURL(b);}catch(e){console.warn(e);}})();\n</script>';
  const eager = lazyLibs.map(src => `<script src="${src}"></script>`).join('\n') + '\n' + workerShim + '\n';
  // Function form: the worker source contains "$&"-style sequences that a
  // plain replacement string would expand.
  html = html.replace(marker, () => eager + marker);
  return html.replace(/<script\s+src="([^"]+)"[^>]*><\/script>/g, (m, src) => {
    const p = path.join(ROOT, src);
    if (!fs.existsSync(p)) throw new Error('Missing script ' + src);
    return '<script>\n' + safeJs(fs.readFileSync(p, 'utf8')) + '\n</script>';
  });
}

// Inlined CSS lives at the document root, so url('../lib/fonts/x.woff2')
// would break — swap every woff2 reference for a base64 data URL.
function inlineFonts(html) {
  return html.replace(/url\((?:'|")?([^'")]+\.woff2)(?:'|")?\)/g, (m, ref) => {
    const p = path.resolve(ROOT, 'css', ref);
    if (!fs.existsSync(p)) return m;
    return 'url(data:font/woff2;base64,' + fs.readFileSync(p).toString('base64') + ')';
  });
}

// index.html's CSP has no 'unsafe-inline'/hash in script-src and no 'data:'
// in font-src, because the served app never needs either: scripts load from
// sibling files and fonts from sibling .woff2 files. Inlining both for this
// one-file build changes that, but 'unsafe-inline' on script-src would let
// ANY injected <script> run (a much bigger blast radius than style-src ever
// had) — and unlike style-src, every inline script here is fully known at
// build time, so an exact 'sha256-…' allowlist is no harder to produce than
// 'unsafe-inline' and keeps the same guarantee the served app has: only
// script content this build actually wrote can execute.
function patchCsp(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => "'sha256-" + crypto.createHash('sha256').update(body, 'utf8').digest('base64') + "'");
  if (!hashes.length) throw new Error('No inline <script> blocks found to hash — did inlining run?');
  return html
    .replace(/script-src 'self';/, `script-src 'self' ${[...new Set(hashes)].join(' ')};`)
    .replace(/font-src 'self';/, `font-src 'self' data:;`);
}

let html = inlineCss(srcHtml);
html = inlineScripts(html);
html = inlineFonts(html);
// The HTML spec normalizes \r\n and lone \r to \n while parsing (including
// inside <script> text), so a CSP script-src hash must be computed over the
// same normalized text the browser sees — not the raw file bytes, which are
// CRLF here (checked out with core.autocrlf=true on Windows). Normalize the
// whole document once, before hashing, so what's hashed is what's served.
html = html.replace(/\r\n?/g, '\n');
html = patchCsp(html);
const out = '<!-- PocketOffice ' + VERSION + ' standalone build -->\n' + html;
const outFile = path.join(ROOT, 'PocketOffice-standalone.html');
fs.writeFileSync(outFile, out);
console.log('Wrote ' + outFile + ' (' + (fs.statSync(outFile).size / 1048576).toFixed(2) + ' MB, ' + VERSION + ')');
