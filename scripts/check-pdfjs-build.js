// Checks whether pdf.js has started shipping a classic-<script> (non-ESM)
// build again for a version that fixes CVE-2024-4367 (>= 4.2.67). PocketOffice
// is stuck on pdfjs-dist 3.11.174 (see lib/VERSIONS.md) specifically because
// every 4.x+ release only ships .mjs files, which don't load over file://.
// Run manually with `node scripts/check-pdfjs-build.js`, or on the schedule
// in .github/workflows/check-pdfjs.yml. Exits non-zero (fails the CI job) if
// a usable classic build turns up, so this doesn't silently rot — it's the
// "revisit if a classic-script build appears" note in VERSIONS.md made into
// something that actually checks itself.
const https = require('https');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pocketoffice-ci' } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fileList(files, prefix = '') {
  const out = [];
  for (const f of files) {
    if (f.type === 'file') out.push(prefix + f.name);
    else out.push(...fileList(f.files, prefix + f.name + '/'));
  }
  return out;
}

(async () => {
  const latest = await getJson('https://registry.npmjs.org/pdfjs-dist/latest');
  console.log(`pdfjs-dist latest published version: ${latest.version}`);
  const pkg = await getJson(`https://data.jsdelivr.com/v1/packages/npm/pdfjs-dist@${latest.version}`);
  const files = fileList(pkg.files);
  // A "classic" build: a plain .js file (not .min counterpart's own .mjs
  // sibling) under build/ or legacy/build/, named like pdf(.min).js — not
  // pdf.worker.js or pdf.sandbox.js, and not a .mjs module.
  const classic = files.filter((f) => /^(legacy\/)?build\/pdf(\.min)?\.js$/.test(f));
  if (classic.length) {
    console.error('Found a classic-script pdf.js build:', classic.join(', '));
    console.error(`Revisit lib/VERSIONS.md — PocketOffice may be able to upgrade off pdfjs-dist 3.11.174 (CVE-2024-4367) now.`);
    process.exit(1);
  }
  console.log('Still ESM-only (.mjs). No classic-script build to upgrade to yet — nothing to do.');
})().catch((e) => {
  console.error('Check failed to run:', e.message);
  process.exit(1);
});
