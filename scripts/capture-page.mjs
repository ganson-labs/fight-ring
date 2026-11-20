// Records an HTML page that draws itself by time (window.setT(t), window.DURATION) into an MP4, frame by frame.
// node scripts/capture-page.mjs <folder with index.html> <out.mp4> [--fps 30] [--still <t> <out.png>]
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launch } from '../kit/arena/tools/browser.js';

const [dir, out] = process.argv.slice(2);
const argv = process.argv;
const fps = Number(argv[argv.indexOf('--fps') + 1]) || 30;
const query = argv.includes('--query') ? `?${argv[argv.indexOf('--query') + 1]}` : '';
const still = argv.includes('--still') ? { t: Number(argv[argv.indexOf('--still') + 1]), out: argv[argv.indexOf('--still') + 2] } : null;
const b = await launch({ width: 1920, height: 1080 });
const page = await b.open(pathToFileURL(join(resolve(dir), 'index.html')).href + query, { w: 1920, h: 1080 });
await page.evaluate('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {})))).then(() => true)');
if (still) {
  await page.evaluate(`window.setT(${still.t}); true`);
  writeFileSync(still.out, await page.screenshot({ format: 'png' }));
} else {
  const dur = await page.evaluate('window.DURATION');
  const frames = join(resolve(dir), `.frames-${process.pid}`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const n = Math.ceil(dur * fps);
  for (let i = 0; i < n; i++) {
    await page.evaluate(`window.setT(${i / fps}); true`);
    writeFileSync(join(frames, `${String(i).padStart(5, '0')}.jpg`), await page.screenshot({ format: 'jpeg', quality: 92 }));
  }
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(frames, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', out]);
  rmSync(frames, { recursive: true, force: true });
  console.log(`${out}: ${n} кадров, ${dur.toFixed(1)} с`);
}
await b.close();
