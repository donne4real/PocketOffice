// Builds PocketOffice-standalone.html: inlines css/ + js/ + lib/ into one file.
// Usage:  node _build-single-file.js
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const VERSION = 'v1.4.0';
const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function inlineCss(html) {
  return html.replace(/<link[^>]*href="([^"]+\.css)"[^>]*>/g, (m, href) => {
    const p = path.join(ROOT, href);
    if (!fs.existsSync(p)) return m;
    return '<style>\n' + fs.readFileSync(p, 'utf8') + '\n</style>';
  });
}
function inlineScripts(html) {
  const workerPath = path.join(ROOT, 'lib', 'pdf.worker.min.js');
  const workerCode = fs.readFileSync(workerPath, 'utf8');
  // pdf.js worker can't be inlined as a plain script; load it from a Blob URL.
  // The shim must run AFTER pdftools.js (which sets workerSrc to the relative
  // lib/ path) so the blob URL wins. Marker goes in before inlining so it
  // targets the raw script tag; inlining preserves it.
  const workerShim = '<script>\n(function(){try{var s=' + JSON.stringify(workerCode) + ';var b=new Blob([s],{type:"application/javascript"});var u=URL.createObjectURL(b);if(window.pdfjsLib){pdfjsLib.workerSrc=u;if(pdfjsLib.GlobalWorkerOptions)pdfjsLib.GlobalWorkerOptions.workerSrc=u;}}catch(e){console.warn(e);}})();\n</script>';
  html = html.replace('<script src="js/pdftools.js"></script>', '<script src="js/pdftools.js"></script>\n__SHIM__');
  let out = html.replace(/<script\s+src="([^"]+)"[^>]*><\/script>/g, (m, src) => {
    if (/pdf\.worker\.min\.js/.test(src)) return '';
    const p = path.join(ROOT, src);
    if (!fs.existsSync(p)) return m;
    return '<script>\n' + fs.readFileSync(p, 'utf8') + '\n</script>';
  });
  out = out.replace('__SHIM__', workerShim);
  return out;
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
console.log('Wrote ' + outFile + ' (' + (fs.statSync(outFile).size / 1048576).toFixed(2) + ' MB)');
