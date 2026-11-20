// Builds the ring's sound set kit/arena/sounds/ from scripts/sounds.sources.json:
//   node scripts/build-sounds.mjs [--check | --alt]
// Sources (not part of this repository): a pack of sounds from third-party libraries (RING_SOUND_PACK, with source
// and licence of every file in its sounds.json) and sounds generated with ElevenLabs (RING_SOUND_GEN). Each file is trimmed of
// silence, peak-normalised, given short fades (no clicks), loops get a crossfaded seam; Opus in Ogg. Writes the
// catalogue (catalog.js), the inventory with origins and licences (README.md) and prints a listening report:
// length, peak, loudness, edges and the loop seam of every file. --check only prints the report of what is built.
// Every sound gets a second copy in AAC (.m4a) made from the finished .ogg: Safari before 18.4 does not decode Opus in
// Ogg, and the game falls back to the copy (viewer/sfx.js). --alt makes only these copies from the .ogg files that are
// there; it needs no sources and leaves the .ogg files, the catalogue and the inventory as they are.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(root, 'kit', 'arena', 'sounds');
const SR = 48000;
// where the author keeps the sources; another machine names its own folders
const PACK = process.env.RING_SOUND_PACK || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'VideoAgent', 'models', 'sounds-pack');
const GEN = process.env.RING_SOUND_GEN || join(homedir(), 'Documents', 'Видео-агент', 'library', 'sounds');
const GEN_LICENSE = 'ElevenLabs Sound Effects / Music, сгенерировано автором ринга на платном тарифе (Creator): коммерческое использование разрешено';
const spec = JSON.parse(readFileSync(join(root, 'scripts', 'sounds.sources.json'), 'utf8')).sounds;
const check = process.argv.includes('--check');

function decode(file, ch) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', String(ch), '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
}

function encode(data, ch, file, kbps) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', String(ch), '-i', '-', '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', file], { input: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
}

// The AAC copy of a finished sound. ffmpeg's own encoder (it is in every build of ffmpeg) writes how many samples of
// the encoder's run-in to skip, so the copy decodes to the very length of the .ogg and a loop stays seamless. The
// copy is a fallback for phones: 64 kbit/s for a mono sound, 96 kbit/s for a stereo loop.
const ALT = 'm4a';
function encodeAlt(ogg, ch) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', ogg, '-map_metadata', '-1', '-fflags', '+bitexact', '-c:a', 'aac', '-b:a', ch === 2 ? '96k' : '64k', '-flags:a', '+bitexact', '-movflags', '+faststart', ogg.replace(/\.ogg$/, `.${ALT}`)]);
}
const samples = (file) => decode(file, 1).length;
// the copies of every .ogg in the folder, and no copy without its .ogg
function buildAlts() {
  const oggs = readdirSync(OUT).filter((f) => f.endsWith('.ogg'));
  for (const f of oggs) {
    const ch = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', join(OUT, f)]).toString().trim());
    encodeAlt(join(OUT, f), ch);
    const [a, b] = [samples(join(OUT, f)), samples(join(OUT, f.replace(/\.ogg$/, `.${ALT}`)))];
    if (a !== b) throw new Error(`${f}: копия AAC другой длины (${b} против ${a} отсчётов), петля даст щелчок`);
  }
  for (const f of readdirSync(OUT)) if (f.endsWith(`.${ALT}`) && !oggs.includes(f.replace(new RegExp(`\\.${ALT}$`), '.ogg'))) rmSync(join(OUT, f));
  return oggs.length;
}

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);

// one-shot: trim silence, peak −2 dBFS, 3 ms fade in, fade out up to 60 ms
function shapeShot(x, ch) {
  const n = x.length / ch;
  const amp = (i) => {
    let m = 0;
    for (let c = 0; c < ch; c++) m = Math.max(m, Math.abs(x[i * ch + c]));
    return m;
  };
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, amp(i));
  const th = Math.max(0.0025, peak * 0.004);
  let a = 0;
  while (a < n && amp(a) < th) a++;
  let b = n - 1;
  while (b > a && amp(b) < th) b--;
  a = Math.max(0, a - Math.round(SR * 0.004));
  b = Math.min(n - 1, b + Math.round(SR * 0.02));
  const len = b - a + 1;
  const y = new Float32Array(len * ch);
  const g = peak > 0 ? 0.794 / peak : 1;
  const fi = Math.round(SR * 0.003);
  const fo = Math.min(Math.round(SR * 0.06), Math.round(len * 0.15));
  for (let i = 0; i < len; i++) {
    let k = 1;
    if (i < fi) k = i / fi;
    if (i > len - fo) k = Math.min(k, (len - i) / fo);
    for (let c = 0; c < ch; c++) y[i * ch + c] = x[(a + i) * ch + c] * g * k;
  }
  return y;
}

// loop: the tail crossfades into the head (equal power), RMS to the target, peak at most −1 dBFS
function shapeLoop(x, ch, { fade = 1.5, rms = -20 } = {}) {
  const n = x.length / ch;
  const F = Math.min(Math.round(SR * fade), Math.floor(n / 4));
  const len = n - F;
  const y = new Float32Array(len * ch);
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) y[i * ch + c] = x[i * ch + c];
  for (let i = 0; i < F; i++) {
    const t = i / F;
    const kin = Math.sin((t * Math.PI) / 2);
    const kout = Math.cos((t * Math.PI) / 2);
    for (let c = 0; c < ch; c++) y[i * ch + c] = x[i * ch + c] * kin + x[(len + i) * ch + c] * kout;
  }
  let s = 0;
  let peak = 0;
  for (const v of y) {
    s += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const cur = Math.sqrt(s / y.length);
  let g = cur > 0 ? 10 ** (rms / 20) / cur : 1;
  if (peak * g > 0.89) g = 0.89 / peak;
  for (let i = 0; i < y.length; i++) y[i] *= g;
  return y;
}

// what a listener hears: length, peak, loudness, how hard the edges start and stop, the loop seam
function report(name, file, ch, loop) {
  const x = decode(file, ch);
  const n = x.length / ch;
  let peak = 0;
  let s = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
    s += v * v;
  }
  const edge = (i) => Math.max(...Array.from({ length: ch }, (_, c) => Math.abs(x[i * ch + c])));
  // the largest jump between two neighbouring samples relative to the local level: a click shows as a spike
  let jump = 0;
  for (let i = 1; i < n; i++) for (let c = 0; c < ch; c++) jump = Math.max(jump, Math.abs(x[i * ch + c] - x[(i - 1) * ch + c]));
  const seam = loop ? Math.max(...Array.from({ length: ch }, (_, c) => Math.abs(x[c] - x[(n - 1) * ch + c]))) : null;
  return { name, seconds: +(n / SR).toFixed(2), peak: +db(peak).toFixed(1), rms: +db(Math.sqrt(s / x.length)).toFixed(1), start: +db(edge(0)).toFixed(0), end: +db(edge(n - 1)).toFixed(0), jump: +jump.toFixed(2), seam: seam === null ? null : +db(seam).toFixed(0) };
}

if (process.argv.includes('--alt')) {
  console.log(`копий AAC: ${buildAlts()}`);
  process.exit(0);
}

const packMeta = existsSync(join(PACK, 'sounds.json')) ? JSON.parse(readFileSync(join(PACK, 'sounds.json'), 'utf8')) : {};
function source(ref) {
  const [where, id] = ref.split(':');
  if (where === 'pack') {
    const m = packMeta[id];
    if (!m) throw new Error(`в наборе сторонних звуков нет звука ${id}`);
    return { file: join(PACK, m.file), origin: m.source, license: m.license };
  }
  const f = ['sounds', 'music'].flatMap((d) => ['mp3', 'wav', 'ogg', 'opus'].map((e) => join(GEN, '..', d, `${id}.${e}`))).find(existsSync);
  if (!f) throw new Error(`нет сгенерированного звука ${id} в ${GEN}`);
  return { file: f, origin: `ElevenLabs, сгенерирован для ринга (${id})`, license: GEN_LICENSE };
}

mkdirSync(OUT, { recursive: true });
const catalog = {};
const rows = [];
const lines = [];
for (const [name, s] of Object.entries(spec)) {
  const ch = s.loop ? 2 : 1;
  const files = [];
  s.from.forEach((ref, i) => {
    const file = `${name}${s.from.length > 1 ? `-${i + 1}` : ''}.ogg`;
    const dst = join(OUT, file);
    const src = source(ref);
    if (!check) {
      const x = decode(src.file, ch);
      const y = s.loop ? shapeLoop(x, ch, s.kind === 'music' ? { fade: 2, rms: -18 } : { fade: 1.2, rms: -21 }) : shapeShot(x, ch);
      encode(y, ch, dst, s.loop ? 128 : 96);
    }
    files.push(file);
    lines.push(`| ${file} | ${s.what} | ${src.origin} | ${src.license} |`);
    rows.push(report(file, dst, ch, !!s.loop));
  });
  catalog[name] = { kind: s.kind, what: s.what, files, gain: s.gain, ...(s.loop ? { loop: true } : {}) };
}
if (!check) {
  const known = new Set(Object.values(catalog).flatMap((c) => c.files));
  for (const f of readdirSync(OUT)) if (f.endsWith('.ogg') && !known.has(f)) rmSync(join(OUT, f));
  buildAlts();
  writeFileSync(join(OUT, 'catalog.js'), `// The ring's sound catalogue, built by scripts/build-sounds.mjs from scripts/sounds.sources.json (origins and\n// licences: README.md here). kind: sfx — a fighter may choose it for a move (moves.json → sounds), ui — menus,\n// ambience and music — stage beds that loop. gain: its level in the ring's mix.\nexport const SOUNDS = ${JSON.stringify(catalog, null, 2)};\n\n// names a fighter can use in moves.json → sounds\nexport const SOUND_NAMES = Object.keys(SOUNDS).filter((n) => SOUNDS[n].kind === 'sfx');\n\n// beside every file lies its copy in AAC with this extension, for a browser that does not decode Opus in Ogg\nexport const SOUND_ALT = '${ALT}';\n`);
  // the engine checks moves.json → sounds by these names; it keeps its own copy so a snapshot of the engine runs alone
  writeFileSync(join(root, 'kit', 'arena', 'engine', 'soundnames.js'), `// Names of the ring's sounds a fighter may use in moves.json → sounds. Written by scripts/build-sounds.mjs from the
// catalogue (kit/arena/sounds/catalog.js); the engine keeps its own copy so its snapshot runs without the sounds.
export const SOUND_NAMES = ${JSON.stringify(Object.keys(catalog).filter((n) => catalog[n].kind === 'sfx'))};
`);
  writeFileSync(join(OUT, 'README.md'), `# Звуки ринга\n\nСобраны \`node scripts/build-sounds.mjs\` из \`scripts/sounds.sources.json\`: тишина по краям обрезана, пик звуков −2 dBFS, края с плавным входом 3 мс и затуханием до 60 мс, петли фона и музыки — бесшовные (хвост перетекает в начало), громкость петель по RMS (фон −21 dBFS, музыка −18 dBFS). Opus в Ogg: звуки моно 96 кбит/с, петли стерео 128 кбит/с. Рядом с каждым файлом лежит его копия в AAC (\`.m4a\`, моно 64 кбит/с, петли 96 кбит/с), сделанная из готового \`.ogg\`: её берёт Safari до версии 18.4, который не декодирует Opus в Ogg. Источник и лицензия копии те же, что у её \`.ogg\`. Каталог с уровнями в миксе — \`catalog.js\`, имена для \`moves.json → sounds\` печатает \`node arena/cli.mjs sounds\`.\n\nИсточники: звуки из сторонних библиотек (Pixabay, Sonniss #GameAudioGDC, Mixkit; источник и лицензия каждого файла — в таблице) и звуки, сгенерированные для ринга через ElevenLabs. Исходные файлы в репозиторий не входят. Все лицензии разрешают звук в играх, роликах и коммерческих проектах без указания автора; продавать или раздавать сами звуки отдельной библиотекой нельзя.\n\n| Файл | Что | Источник | Лицензия |\n|---|---|---|---|\n${lines.join('\n')}\n`);
}
console.log('файл'.padEnd(26), 'сек'.padStart(6), 'пик'.padStart(6), 'RMS'.padStart(6), 'вход'.padStart(5), 'выход'.padStart(6), 'скачок'.padStart(7), 'шов');
for (const r of rows) console.log(r.name.padEnd(26), String(r.seconds).padStart(6), String(r.peak).padStart(6), String(r.rms).padStart(6), String(r.start).padStart(5), String(r.end).padStart(6), String(r.jump).padStart(7), r.seam ?? '');
