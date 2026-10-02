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

  const loading = {};   // src -> Promise

  function loadScript(src) {
    if (loading[src]) return loading[src];
    loading[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
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
