// Tiny Chrome DevTools Protocol driver (Node 22+: global WebSocket/fetch).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function launch({ browser, port = 9333, profile }) {
  if (typeof WebSocket === 'undefined') throw new Error(`Node 22+ is required (no global WebSocket in ${process.version})`);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Keep the tail of the browser's stderr so a failed launch explains itself.
  let stderr = '', exited = null;
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  proc.on('error', (e) => { exited = `could not be started: ${e.message}`; });
  proc.on('exit', (code, signal) => { exited = exited || `exited early (code ${code}, signal ${signal})`; });
  let page;
  for (let i = 0; i < 150 && !page && !exited; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) {}
    if (!page) await new Promise(r => setTimeout(r, 200));
  }
  if (!page) {
    proc.kill();
    throw new Error(`Browser ${exited || 'did not open a debuggable page within 30s'}: ${browser}\n--- browser stderr ---\n${stderr.trim() || '(empty)'}`);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); return; }
    events.push(msg);
    if (msg.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning'))
      errors.push(msg.params.type.toUpperCase() + ' ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push('LOG ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async function goto(url) {
    const loaded = new Promise(res => { const t = setInterval(() => { const i = events.findIndex(e => e.method === 'Page.loadEventFired'); if (i >= 0) { events.splice(i, 1); clearInterval(t); res(); } }, 50); });
    events.length = 0;
    await send('Page.navigate', { url });
    await loaded;
  }
  async function close() { try { await send('Browser.close'); } catch (e) {} proc.kill(); }
  return { send, evaluate, goto, close, errors };
}
module.exports = { launch };
