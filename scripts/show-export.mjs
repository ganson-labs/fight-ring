// The screens of the show and the fighters alone in the frame as separate elements for the montage, in 4K: a still and
// a clip of the entrance, each with the background and on alpha (to lay over any footage). Into show/pack/elements/.
//   node scripts/show-export.mjs [--only race,tier,hero-fable50] [--fps 30] [--scale 2] [--jobs 6] [--pages 0] [--heroes 0]
//   <name>.png, <name>-alpha.png — the final frame (pages); <name>.mp4 — with the background (H.264);
//   <name>-alpha.mov — ProRes 4444 with an alpha channel
// Order: the pages of the show first, then the assembly of every fighter, its idle loop and victory, then its moves.
// A 4K frame takes Chrome about two seconds, so the work is spread over several browsers.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../kit/arena/tools/browser.js';

const RING = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.indexOf(`--${k}`) < 0 ? d : args[args.indexOf(`--${k}`) + 1]);
const fps = Number(opt('fps', 30));
const scale = Number(opt('scale', 2)); // the video is 4K: the pages are laid out at 1920×1080 and shot at ×2
const jobs = Number(opt('jobs', 6));
const only = opt('only') ? String(opt('only')).split(',') : null;
const P = join(RING, 'show', 'p');
const OUT = join(RING, 'show', 'pack', 'elements');
const PORT = 4861;
mkdirSync(OUT, { recursive: true });
const want = (name) => !only || only.some((o) => name.startsWith(o));

const tasks = [];
if (opt('pages', '1') !== '0') for (const f of readdirSync(P).filter((x) => x.endsWith('.html'))) {
  const name = f.slice(0, -5);
  if (want(name)) for (const alpha of [false, true]) tasks.push({ name, alpha, kind: 'page', url: `${pathToFileURL(join(P, f)).href}?bg=${alpha ? 0 : 1}` });
}
if (opt('heroes', '1') !== '0') {
  const data = JSON.parse(readFileSync(join(RING, 'show', 'data.json'), 'utf8'));
  // --hero-set short: only the assembly, the idle loop and the victory, and only on alpha (15 clips instead of 100)
  const short = opt('hero-set') === 'short';
  const whats = (p) => ['reveal', 'idle', 'victory', ...(short ? [] : p.moves.filter((m) => m.slot !== 'normal').map((m) => `move:${m.id}`))];
  const longest = Math.max(...data.people.map((p) => whats(p).length));
  for (let k = 0; k < longest; k++) for (const p of data.people) {
    const what = whats(p)[k];
    const name = what && `hero-${p.id}-${what.replace('move:', 'move-')}`;
    if (name && want(name)) for (const alpha of short ? [true] : [false, true]) tasks.push({ name, alpha, kind: 'hero', url: `http://localhost:${PORT}/viewer/show/hero.html?id=${p.id}&do=${encodeURIComponent(what)}&bg=${alpha ? 0 : 1}` });
  }
}
const todo = tasks.filter((t) => !existsSync(join(OUT, `${t.name}${t.alpha ? '-alpha.mov' : '.mp4'}.done`)));
const server = todo.some((t) => t.kind === 'hero') ? spawn(process.execPath, [join(RING, 'serve.mjs'), '--port', String(PORT)], { cwd: RING, stdio: 'ignore' }) : null;
if (server) await new Promise((r) => setTimeout(r, 1500));

const encode = (out, alpha) => {
  const codec = alpha ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'] : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'fast'];
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', ...codec, '-r', String(fps), out], { stdio: ['pipe', 'ignore', 'inherit'] });
  return { write: (buf) => new Promise((res) => (ff.stdin.write(buf) ? res() : ff.stdin.once('drain', res))), end: () => new Promise((res) => { ff.on('close', res); ff.stdin.end(); }) };
};

async function one(browser, t) {
  const page = await browser.open(t.url, { w: 1920, h: 1080, scale });
  if (t.alpha) await page.cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  let seconds;
  let seek;
  if (t.kind === 'page') {
    // the clock of the page's animations is driven from here: every frame is the same on any machine
    const end = await page.evaluate(`(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); const a = document.getAnimations(); a.forEach((x) => x.pause()); window.__seek = (t) => a.forEach((x) => { x.currentTime = t; }); return Math.max(0, ...a.map((x) => Number(x.effect.getComputedTiming().endTime) || 0)); })()`);
    seconds = Math.min(t.name === 'changelog' ? 150 : 24, end / 1000 + 1.2); // the full list rolls like credits, the rest are short
    seek = (i) => `window.__seek(${(i * 1000) / fps})`;
  } else {
    await page.evaluate('window.ready');
    seconds = await page.evaluate('window.__seconds');
    seek = () => `window.__step(${1000 / fps})`;
  }
  const file = join(OUT, `${t.name}${t.alpha ? '-alpha.mov' : '.mp4'}`);
  const enc = encode(file, t.alpha);
  let last = null;
  try {
    for (let i = 0; i < Math.ceil(seconds * fps); i++) {
      await page.evaluate(seek(i));
      last = await page.screenshot({ format: 'png' });
      await enc.write(last);
    }
  } finally {
    await enc.end(); // a clip that failed midway must not leave its encoder waiting for frames
  }
  if (t.kind === 'page') writeFileSync(join(OUT, `${t.name}${t.alpha ? '-alpha' : ''}.png`), last);
  writeFileSync(`${file}.done`, ''); // a clip cut short by a restart is made again
  await page.close();
  console.log(`  ${t.name}${t.alpha ? ' (прозрачный)' : ''}: ${seconds.toFixed(1)} с`);
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, async () => {
  let browser = await launch({ width: 1920, height: 1080 });
  try {
    while (next < todo.length) {
      const t = todo[next++];
      try {
        await one(browser, t);
      } catch (err) {
        console.log(`  ! ${t.name}${t.alpha ? ' (прозрачный)' : ''}: ${String(err.message).split('\n')[0]}`);
        // a browser that stopped answering takes every next clip with it: start a fresh one
        await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
        browser = await launch({ width: 1920, height: 1080 });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}));
server?.kill();
console.log(`Элементы для монтажа: ${OUT} (${todo.length} роликов из ${tasks.length})`);
