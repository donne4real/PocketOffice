const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = 'C:/Users/leyea/OneDrive/Documents/ZCodeProject/PocketOffice';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const regex = /(src|href)="([^"]+)"[^>]*integrity="([^"]+)"/g;
let m;
let mismatches = 0;
while ((m = regex.exec(html)) !== null) {
  const filePath = m[2];
  const declared = m[3];
  const fullPath = path.join(ROOT, filePath);
  try {
    const content = fs.readFileSync(fullPath);
    const hash = 'sha384-' + crypto.createHash('sha384').update(content).digest('base64');
    if (hash !== declared) {
      console.log('MISMATCH:', filePath);
      console.log('  declared:', declared);
      console.log('  actual:  ', hash);
      mismatches++;
    } else {
      console.log('OK:', filePath);
    }
  } catch (e) {
    console.log('MISSING:', filePath);
    mismatches++;
  }
}
console.log('\n' + (mismatches === 0 ? 'All hashes match!' : mismatches + ' mismatches found'));