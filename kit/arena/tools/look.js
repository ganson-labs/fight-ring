// `arena look`: a clip as pictures, frames in a row, so it can be looked at as images.
// `arena voice listen N`: what a voice variant sounds like in numbers (pitch, range, pace, pauses, loudness).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

export function cmdLook(opts, here) {
  const file = opts._[1] ? resolve(here, opts._[1]) : null;
  if (!file || !existsSync(file)) throw new Error('look <ролик.mp4> [--fps 4] [--from 0] [--to конец] [--cols 4] [--width 480]');
  const fps = Number(opts.fps || 4);
  const cols = Number(opts.cols || 4);
  const rows = Number(opts.rows || 4);
  const width = Number(opts.width || 480);
  const out = opts.out ? resolve(here, opts.out) : join(dirname(file), `${basename(file, '.mp4')}-frames`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const args = ['-y', '-v', 'error'];
  if (opts.from) args.push('-ss', String(opts.from));
  if (opts.to) args.push('-to', String(opts.to));
  args.push('-i', file, '-vf', `fps=${fps},scale=${width}:-1,tile=${cols}x${rows}`, join(out, 'sheet-%02d.jpg'));
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
  const sheets = readdirSync(out).filter((f) => f.endsWith('.jpg')).sort();
  const per = (cols * rows) / fps;
  console.log(`Кадры ${relative(here, file)}: ${fps} в секунду, ${cols}×${rows} на лист (${per.toFixed(1)} с на лист), слева направо и сверху вниз:`);
  sheets.forEach((s, i) => console.log(`  ${relative(here, join(out, s))}  — ${((opts.from ? Number(opts.from) : 0) + i * per).toFixed(1)}…${((opts.from ? Number(opts.from) : 0) + (i + 1) * per).toFixed(1)} с`));
}

// ---------- listening ----------

function pcm(file, rate = 16000) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

// Autocorrelation pitch per 40 ms frame, voiced frames only.
export function analyzeVoice(x, rate = 16000) {
  const frame = Math.round(rate * 0.04);
  const hop = Math.round(rate * 0.02);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.floor(rate / 60);
  const pitches = [];
  const energies = [];
  let silentRun = 0;
  const pauses = [];
  for (let i = 0; i + frame + maxLag < x.length; i += hop) {
    let e = 0;
    for (let k = 0; k < frame; k++) e += x[i + k] * x[i + k];
    e = Math.sqrt(e / frame);
    energies.push(e);
  }
  const loud = [...energies].sort((a, b) => a - b)[Math.floor(energies.length * 0.9)] || 0;
  const gate = loud * 0.12;
  energies.forEach((e, j) => {
    const i = j * hop;
    if (e < gate) {
      silentRun++;
      return;
    }
    if (silentRun * 0.02 >= 0.25) pauses.push(silentRun * 0.02);
    silentRun = 0;
    let best = 0;
    let lag = 0;
    let r0 = 0;
    for (let k = 0; k < frame; k++) r0 += x[i + k] * x[i + k];
    for (let L = minLag; L <= maxLag; L++) {
      let r = 0;
      for (let k = 0; k < frame; k++) r += x[i + k] * x[i + k + L];
      if (r > best) {
        best = r;
        lag = L;
      }
    }
    if (lag && best / (r0 || 1) > 0.45) pitches.push(rate / lag);
  });
  const sorted = [...pitches].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor((sorted.length - 1) * p)] || 0;
  const voiced = energies.filter((e) => e >= gate).length * 0.02;
  // loudness changes between neighbouring 200 ms windows: how lively the delivery is
  const win = 10;
  const w = [];
  for (let j = 0; j + win <= energies.length; j += win) w.push(energies.slice(j, j + win).reduce((a, b) => a + b, 0) / win);
  const dyn = w.length > 1 ? w.slice(1).reduce((s, v, j) => s + Math.abs(Math.log((v + 1e-4) / (w[j] + 1e-4))), 0) / (w.length - 1) : 0;
  return { seconds: x.length / rate, voicedSeconds: voiced, pitch: { median: q(0.5), low: q(0.1), high: q(0.9) }, pauses, dynamics: dyn };
}

const vowels = (t) => (String(t).toLowerCase().match(/[аеёиоуыэюяaeiouy]/g) || []).length;

function describe(a, text) {
  const p = a.pitch.median;
  const register = p < 110 ? 'очень низкий' : p < 150 ? 'низкий' : p < 200 ? 'средний' : p < 260 ? 'высокий' : 'очень высокий';
  const range = a.pitch.high / Math.max(1, a.pitch.low);
  const melody = range < 1.5 ? 'ровный, почти без интонации' : range < 2.2 ? 'с умеренной интонацией' : 'с сильными перепадами интонации';
  const pace = text ? vowels(text) / Math.max(0.5, a.voicedSeconds) : null;
  const paceWord = pace === null ? '' : pace < 3.5 ? 'медленный' : pace < 5.5 ? 'обычный' : pace < 7 ? 'быстрый' : 'очень быстрый';
  const dynWord = a.dynamics < 0.5 ? 'ровная громкость' : a.dynamics < 1.1 ? 'живая подача' : 'резкие перепады громкости';
  return [
    `длительность ${a.seconds.toFixed(1)} с, речь ${a.voicedSeconds.toFixed(1)} с`,
    `высота: ${register} (основной тон ≈ ${Math.round(p)} Гц, от ${Math.round(a.pitch.low)} до ${Math.round(a.pitch.high)} Гц), ${melody}`,
    pace === null ? null : `темп: ${paceWord} (≈ ${pace.toFixed(1)} слога в секунду речи)`,
    `пауз длиннее 0.25 с: ${a.pauses.length}${a.pauses.length ? ` (${a.pauses.map((x) => x.toFixed(1)).join(', ')} с)` : ''}; ${dynWord}`,
  ].filter(Boolean);
}

// voice listen [N | файл.mp3 ...]: every preview variant, or the given files
export function listen(dir, which) {
  const design = join(dir, 'voice', 'design', 'design.json');
  let items = [];
  if (which.length && which.every((w) => /\.mp3$/i.test(w))) items = which.map((f) => ({ label: f, file: resolve(f), text: null }));
  else {
    if (!existsSync(design)) throw new Error('вариантов голоса ещё нет: node arena/cli.mjs voice design');
    const d = JSON.parse(readFileSync(design, 'utf8'));
    items = d.previews.filter((p) => !which.length || which.map(Number).includes(p.n)).map((p) => ({ label: `вариант ${p.n} (${p.file})`, file: join(dir, p.file), text: d.text }));
    if (d.text) console.log(`Текст образца: «${d.text}»\n`);
  }
  for (const it of items) {
    if (!existsSync(it.file)) {
      console.log(`${it.label}: нет файла`);
      continue;
    }
    const a = analyzeVoice(pcm(it.file));
    console.log(`${it.label}:`);
    for (const l of describe(a, it.text)) console.log(`  ${l}`);
  }
}
