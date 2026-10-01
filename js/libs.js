/* ==========================================================================
   libs.js — on-demand loader for the vendored libraries in lib/.
   The big libraries (~5 MB) used to load at startup even though most
   sessions only touch one tool. Each tool now asks for what it needs the
   first time it needs it:   await Libs.need('xlsx', 'chart');
   Classic <script> injection works on file://, unlike ES module imports.
   The standalone build inlines every file listed here, so ready() is
   already true there and need() resolves without touching the network.
   ========================================================================== */

const Libs = (() => {
  // Files load in the listed order (pptxgenjs needs JSZip first).
  const MANIFEST = {
    pdfjs:   { files: ['lib/pdf.min.js'],                              ready: () => typeof window.pdfjsLib !== 'undefined' },
    pdflib:  { files: ['lib/pdf-lib.min.js'],                          ready: () => typeof window.PDFLib !== 'undefined' },
    jspdf:   { files: ['lib/jspdf.umd.min.js', 'lib/embedded-fonts.js'], ready: () => !!(window.jspdf && window.EMBEDDED_TTF) },
    xlsx:    { files: ['lib/xlsx.full.min.js'],                        ready: () => typeof window.XLSX !== 'undefined' },
    docx:    { files: ['lib/docx.umd.js'],                             ready: () => typeof window.docx !== 'undefined' },
    mammoth: { files: ['lib/mammoth.browser.js'],                      ready: () => typeof window.mammoth !== 'undefined' },
    jszip:   { files: ['lib/jszip.min.js'],                            ready: () => typeof window.JSZip !== 'undefined' },
    pptx:    { files: ['lib/jszip.min.js', 'lib/pptxgenjs.min.js'],    ready: () => typeof window.PptxGenJS !== 'undefined' },
    chart:   { files: ['lib/chart.umd.min.js'],                        ready: () => typeof window.Chart !== 'undefined' },
  };

  // Subresource Integrity hashes for the dynamically loaded libraries.
  // Recompute with:  node -e "..."  (see lib/VERSIONS.md)
  const SRI = {
    'lib/pdf.min.js':          'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
    'lib/pdf.worker.min.js':   'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2',
    'lib/pdf-lib.min.js':      'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
    'lib/jspdf.umd.min.js':   'sha384-en/ztfPSRkGfME4KIm05joYXynqzUgbsG5nMrj/xEFAHXkeZfO3yMK8QQ+mP7p1/',
    'lib/embedded-fonts.js':   'sha384-7jDCRWTL4A07dfsa60uJfxMcgrh+MfyMB6C3zO5eOuN9E4hE0acLaWKtlwepSCDg',
    'lib/xlsx.full.min.js':    'sha384-KxTQhJ4PSplGXtuombYakDpnHoXsNNh8wnk456xVdrKipiN4QP+x9+YcYuVUswkA',
    'lib/docx.umd.js':         'sha384-4xaIisuLEy2lo2HkB2C4rEf7v8jbTb2kuogX6TkuEt9feTWKBSFSOzsqNNbV+sKh',
    'lib/mammoth.browser.js':  'sha384-nFoSjZIoH3CCp8W639jJyQkuPHinJ2NHe7on1xvlUA7SuGfJAfvMldrsoAVm6ECz',
    'lib/jszip.min.js':        'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
    'lib/pptxgenjs.min.js':    'sha384-MKtHyQQnXtUFOKSavqQmtt5Qvk6cGeMJekOw28rk1RHMaEeFU5t0sG2KxvlG4Zue',
    'lib/chart.umd.min.js':    'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4',
  };

  const loading = {};   // src -> Promise

  function loadScript(src) {
    if (loading[src]) return loading[src];
    loading[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      if (SRI[src]) {
        s.integrity = SRI[src];
        s.crossOrigin = 'anonymous';
      }
      s.onload = () => resolve();
      s.onerror = () => { delete loading[src]; reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
    return loading[src];
  }

  async function loadOne(name) {
    const lib = MANIFEST[name];
    if (!lib) throw new Error('Unknown library: ' + name);
    if (lib.ready()) return;
    for (const src of lib.files) await loadScript(src);
    if (!lib.ready()) throw new Error('Library did not initialise: ' + name);
  }

  function need(...names) {
    return Promise.all(names.map(loadOne));
  }

  function isReady(name) {
    const lib = MANIFEST[name];
    return !!(lib && lib.ready());
  }

  return { need, isReady, MANIFEST };
})();
