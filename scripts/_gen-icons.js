// Renders icons/icon.svg into the PNG sizes the web app manifest needs.
// Only needed again if the icon artwork changes.
// Usage:  node scripts/_gen-icons.js "<path to chrome or edge>"
// Uses the browser itself to rasterize, so there is nothing to install.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('../tests/browser/cdp.js');

const ROOT = path.join(__dirname, '..');
const BROWSER = process.argv[2] || process.env.PO_BROWSER;
if (!BROWSER) { console.error('Usage: node scripts/_gen-icons.js "<browser path>"'); process.exit(1); }

const svg = fs.readFileSync(path.join(ROOT, 'icons', 'icon.svg'), 'utf8');
// Maskable icons are cropped to a circle or squircle by the OS: fill the
// whole square and keep the artwork inside the central "safe zone".
const maskable = svg
  .replace(/<rect[^>]*rx="112"[^>]*\/>/, '<rect width="512" height="512" fill="url(#g)"/>')
  .replace('<path ', '<path transform="translate(256 256) scale(0.78) translate(-256 -256)" ');
if (maskable === svg) throw new Error('icon.svg changed shape; update the maskable transform here');

const JOBS = [
  { file: 'icon-192.png', size: 192, src: svg },
  { file: 'icon-512.png', size: 512, src: svg },
  { file: 'icon-maskable-512.png', size: 512, src: maskable },
];

(async () => {
  const b = await launch({ browser: BROWSER, port: 9355, profile: path.join(os.tmpdir(), 'pocketoffice-icon-profile') });
  try {
    for (const job of JOBS) {
      const dataUrl = await b.evaluate(`(async () => {
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(job.src).toString('base64'))};
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = ${job.size};
        c.getContext('2d').drawImage(img, 0, 0, ${job.size}, ${job.size});
        return c.toDataURL('image/png');
      })()`);
      const out = path.join(ROOT, 'icons', job.file);
      fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log('Wrote ' + out + ' (' + fs.statSync(out).size + ' bytes)');
    }
  } finally {
    await b.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
