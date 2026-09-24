// Builds PocketOffice-standalone.html: inlines css/ + js/ + lib/ into one file.
// Usage:  node _build-single-file.js
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

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

let html = inlineCss(srcHtml);
html = inlineScripts(html);
html = inlineFonts(html);
const out = '<!-- PocketOffice ' + VERSION + ' standalone build -->\n' + html;
const outFile = path.join(ROOT, 'PocketOffice-standalone.html');
fs.writeFileSync(outFile, out);
console.log('Wrote ' + outFile + ' (' + (fs.statSync(outFile).size / 1048576).toFixed(2) + ' MB, ' + VERSION + ')');
