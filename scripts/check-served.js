const http = require('http');
http.get('http://127.0.0.1:8765/', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    // Check for CSP meta tag
    if (data.includes('Content-Security-Policy')) {
      console.log('CSP: present');
      const csp = data.match(/content="([^"]+)"/);
      if (csp) console.log('CSP policy:', csp[1].substring(0, 100) + '...');
    }
    // Check for SRI on links
    const links = data.match(/<link[^>]*>/g) || [];
    links.forEach(l => {
      if (l.includes('integrity')) console.log('LINK with SRI:', l.substring(0, 100));
    });
    // Check for SRI on scripts
    const scripts = data.match(/<script[^>]*>/g) || [];
    scripts.forEach(s => {
      if (s.includes('integrity')) console.log('SCRIPT with SRI:', s.substring(0, 100));
    });
    console.log('\nTotal scripts:', scripts.length, 'Total links:', links.length);
  });
});