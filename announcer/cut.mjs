// The announcer's lines cut out of a Voice Design preview: the preview text is exactly the lines of voice.json in
// order, so silences split it into the lines without recording them again.
//   node announcer/cut.mjs [N]   (N — preview number, 2 by default)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const n = Number(process.argv[2] || 2);
const src = join(dir, 'voice', 'design', `preview-${n}.mp3`);
const lines = JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8')).lines;
const err = spawnSync('ffmpeg', ['-hide_banner', '-i', src, '-af', 'silencedetect=noise=-38dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
const total = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' }));
// speech segments between silences
const segs = [];
let cursor = 0;
for (let i = 0; i < starts.length; i++) {
  if (starts[i] - cursor > 0.15) segs.push([cursor, starts[i]]);
  cursor = ends[i] ?? total;
}
if (total - cursor > 0.15) segs.push([cursor, total]);
if (segs.length !== lines.length) {
  console.error(`в образце ${segs.length} фраз, в voice.json ${lines.length}: подбери порог или другой образец`);
  console.error(segs.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)}`).join(', '));
  process.exit(1);
}
mkdirSync(join(dir, 'voice'), { recursive: true });
segs.forEach(([a, b], i) => {
  const from = Math.max(0, a - 0.05);
  const to = Math.min(total, b + 0.12);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ss', from.toFixed(3), '-to', to.toFixed(3), '-af', 'afade=t=out:st=' + Math.max(0, to - from - 0.06).toFixed(3) + ':d=0.06', '-c:a', 'libmp3lame', '-b:a', '160k', join(dir, 'voice', `${lines[i].id}.mp3`)]);
  console.log(`${lines[i].id}: ${(to - from).toFixed(2)} с — «${lines[i].text}»`);
});
