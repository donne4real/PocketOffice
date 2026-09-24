// Minimal static server for manual testing: node serve.js <root> <port>
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || '.');
const port = +(process.argv[3] || 8765);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2',
  '.json': 'application/json', '.png': 'image/png', '.pdf': 'application/pdf', '.xlsx': 'application/octet-stream',
  '.docx': 'application/octet-stream', '.pptx': 'application/octet-stream' };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(root, url === '/' ? 'index.html' : url);
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log('serving ' + root + ' on ' + port));
