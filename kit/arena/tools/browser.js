// Headless Chrome over the DevTools protocol (no packages): open a page, evaluate, collect console errors.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function chromePaths() {
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    process.env.RING_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  // Playwright's own Chromium, if installed
  const pw = local ? join(local, 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
      list.push(join(pw, d, 'chrome-win64', 'chrome.exe'), join(pw, d, 'chrome-win', 'chrome.exe'), join(pw, d, 'chrome-linux', 'chrome'));
    }
  }
  return list.filter(Boolean);
}

export function findChrome() {
  const p = chromePaths().find((x) => existsSync(x));
  if (!p) throw new Error('нет Chrome или Edge для съёмки: поставь Google Chrome или задай RING_CHROME=<путь к chrome.exe>');
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A timer that never keeps the process alive (used for timeouts that usually lose the race).
const idle = (ms) => new Promise((r) => setTimeout(r, ms).unref());
// p, or what fallback() gives after ms; the timer goes as soon as p settles: a timer left waiting keeps the answer of
// p alive until it fires (frames of a clip, 600 KB each, piled up to gigabytes within its two minutes)
function within(p, ms, fallback) {
  let timer;
  const t = new Promise((res, rej) => {
    timer = setTimeout(() => {
      try {
        res(fallback());
      } catch (e) {
        rej(e);
      }
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// A contestant's tools keep Chrome's profile inside the contestant's folder (out/.chrome), so the Chrome processes of
// two contestants differ by path on the command line; the judge's own renders keep it in the system temp folder.
export function profileBase() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (existsSync(join(root, 'contestant.json'))) {
    const dir = join(root, 'out', '.chrome');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return tmpdir();
}

// Profiles of Chrome left behind (a process that died, a file Chrome held past the wait in close()) go at the next
// start; a profile younger than six hours may belong to a render still running.
function sweepProfiles(base) {
  let names = [];
  try {
    names = readdirSync(base).filter((n) => n.startsWith('ring-chrome-'));
  } catch {
    return;
  }
  for (const n of names) {
    const dir = join(base, n);
    try {
      if (Date.now() - statSync(dir).mtimeMs > 6 * 3600e3) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

export async function launch({ width = 1280, height = 720 } = {}) {
  const exe = findChrome();
  const base = profileBase();
  sweepProfiles(base);
  const profile = mkdtempSync(join(base, 'ring-chrome-'));
  const proc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', '--ignore-gpu-blocklist',
    // no downloads of Chrome's own components into every new profile (~100 MB each: models, Safe Browsing lists)
    '--disable-background-networking', '--disable-component-update',
    // RING_GPU=1 renders on the video card (much faster on a desktop); the default software renderer works everywhere
    ...(process.env.RING_GPU === '1' ? ['--use-angle=' + (process.platform === 'win32' ? 'd3d11' : 'default'), '--enable-gpu'] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']),
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let port = null;
  let path = null;
  for (let i = 0; i < 200 && !port; i++) {
    await sleep(50);
    const f = join(profile, 'DevToolsActivePort');
    if (existsSync(f)) {
      let text = '';
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue; // Chrome is still writing it
      }
      const [p, wsPath] = text.split(/\r?\n/);
      if (p && wsPath) {
        port = p;
        path = wsPath;
      }
    }
  }
  if (!port) {
    proc.kill();
    throw new Error(`Chrome не открыл порт отладки (${exe})`);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('нет связи с Chrome'));
  });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function open(url, { w = width, h = height, scale = 1, mobile = false } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const console = [];
    listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) console.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      if (msg.method === 'Runtime.exceptionThrown') console.push(`exception: ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
    });
    await s('Runtime.enable');
    await s('Page.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile });
    if (mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true });
    const loaded = new Promise((res) => listeners.push((msg) => msg.sessionId === sessionId && msg.method === 'Page.loadEventFired' && res()));
    await s('Page.navigate', { url });
    await Promise.race([loaded, idle(20000)]);
    const evaluate = async (expression, { timeout = 120000 } = {}) => {
      const r = await within(s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), timeout, () => {
        throw new Error(`страница не ответила за ${timeout / 1000} с: ${expression.slice(0, 60)}`);
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    // A long string from the page (a data URL of a pose sheet runs to several MB): one DevTools answer above ~4 MB
    // never arrives and the page looks hung, so the text is kept in the page and read in 1 MB slices.
    const evaluateText = async (expression, { timeout = 120000, chunk = 1 << 20 } = {}) => {
      const n = await evaluate(`(async () => { const v = await (${expression}); window.__ringText = String(v); return window.__ringText.length; })()`, { timeout });
      let out = '';
      for (let i = 0; i < n; i += chunk) out += await evaluate(`window.__ringText.slice(${i}, ${i + chunk})`, { timeout });
      await evaluate('delete window.__ringText', { timeout });
      return out;
    };
    // a screenshot under a heavy WebGL load now and then never answers: give up after a minute and try once more
    const shot = (params) => within(s('Page.captureScreenshot', params), 60000, () => null);
    const capture = async (params) => {
      for (let i = 0; i < 2; i++) {
        const r = await shot(params);
        if (r) return Buffer.from(r.data, 'base64');
      }
      throw new Error('Chrome не отдал снимок страницы за две минуты');
    };
    const screenshot = ({ clip, format = 'png', quality } = {}) => capture({ format, ...(quality ? { quality } : {}), ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
    const resize = (ww, hh, sc = 1, mob = false) => s('Emulation.setDeviceMetricsOverride', { width: ww, height: hh, deviceScaleFactor: sc, mobile: mob });
    // a key press as the page sees it: key('KeyJ'), key('ArrowDown', 'keyUp')
    const key = (code, type = null, keyName = null) => {
      const k = keyName || (code.startsWith('Key') ? code.slice(3).toLowerCase() : code === 'Space' ? ' ' : code);
      const one = (t) => s('Input.dispatchKeyEvent', { type: t, code, key: k, windowsVirtualKeyCode: code.startsWith('Key') ? code.charCodeAt(3) : { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32, Enter: 13, Escape: 27, Tab: 9 }[code] || 0 });
      return type ? one(type) : one('keyDown').then(() => one('keyUp'));
    };
    return { evaluate, evaluateText, screenshot, resize, key, cdp: s, console, close: () => send('Target.closeTarget', { targetId }) };
  }

  async function close() {
    try {
      await send('Browser.close');
    } catch {}
    ws.close();
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
    await Promise.race([exited, idle(3000)]);
    if (proc.exitCode === null) proc.kill();
    // Chrome's helper processes may hold the profile for a moment after exit
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
  return { open, close };
}
