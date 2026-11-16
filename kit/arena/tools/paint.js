// `arena paint`: one picture from a description through the ring's image generator (Codex CLI built-in
// image tool). The same tool and the same limit for every contestant; the prompt is the contestant's own
// description wrapped in fixed technical instructions only.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { ensure, spend, serviceEnv, operatorHome } from './ring.js';
import { decodeImage, encodePNG } from './png.js';

export const ASPECTS = { square: 'Square 1:1 image.', portrait: 'Portrait 2:3 image.', landscape: 'Landscape 3:2 image.' };
const TIMEOUT_MS = 15 * 60 * 1000;

// Every contestant paints through the same generator profile, whatever agent runs them: the operator's main
// Codex home (or RING_PAINT_CODEX_HOME from services.env), never the contestant's own clean profile.
function paintEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CODEX_(THREAD|SANDBOX|SESSION|CI|MANAGED)/.test(k)) delete env[k];
  env.CODEX_HOME = serviceEnv().RING_PAINT_CODEX_HOME || join(operatorHome(), '.codex');
  return env;
}

function codexExe() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' });
  const first = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  const pick = first.find((p) => /\.(cmd|exe)$/i.test(p)) || first[0];
  if (!pick) throw new Error('нет генератора картинок: Codex CLI не найден в PATH (npm i -g @openai/codex, затем codex login)');
  return pick;
}

export function buildPrompt({ description, aspect = 'square', transparent = false, refs = 0, file = 'image.png' }) {
  const parts = [
    `Use the built-in image generation tool to create exactly ONE image and save it in the current directory as ${file}.`,
    ASPECTS[aspect],
  ];
  if (refs) parts.push(refs === 1 ? 'The attached image is a reference.' : `The ${refs} attached images are references.`);
  if (transparent) parts.push('The image must have a fully transparent background (PNG with alpha channel): no backdrop, no floor, no cast shadow.');
  parts.push(`Image description: ${description}`);
  parts.push('Do not create or modify any other files. Do not add captions, labels, watermarks or signatures unless the description asks for them.');
  return parts.join(' ');
}

function hasAlpha(file) {
  const img = decodeImage(file);
  const { width: w, height: h, data } = img;
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => data[i * 4 + 3]);
  return { img, transparent: corners.every((a) => a < 16) };
}

// Fallback when the generator returned an opaque picture: key out the flat background colour from the border.
export function keyBackground(img, tolerance = 38) {
  const { width: w, height: h, data } = img;
  const border = [];
  for (let x = 0; x < w; x += 4) border.push((0 * w + x) * 4, ((h - 1) * w + x) * 4);
  for (let y = 0; y < h; y += 4) border.push((y * w) * 4, (y * w + w - 1) * 4);
  const med = [0, 1, 2].map((c) => {
    const v = border.map((i) => data[i + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  });
  const out = new Uint8Array(data);
  for (let i = 0; i < w * h; i++) {
    const d = Math.hypot(data[i * 4] - med[0], data[i * 4 + 1] - med[1], data[i * 4 + 2] - med[2]);
    const a = d < tolerance ? 0 : d < tolerance * 2 ? (d - tolerance) / tolerance : 1;
    out[i * 4 + 3] = Math.round(Math.min(data[i * 4 + 3] / 255, a) * 255);
  }
  return { width: w, height: h, data: out };
}

export async function paint({ description, out, refs = [], aspect = 'square', transparent = false, log = console.log }) {
  if (!description || !String(description).trim()) throw new Error('нужно описание картинки в кавычках');
  if (!ASPECTS[aspect]) throw new Error(`--aspect: ${Object.keys(ASPECTS).join(', ')}`);
  if (!out) throw new Error('нужен --out путь/к/картинке.png');
  out = resolve(out);
  if (extname(out).toLowerCase() !== '.png') throw new Error('--out: файл .png');
  const absRefs = refs.map((r) => resolve(r));
  for (const r of absRefs) if (!existsSync(r)) throw new Error(`нет референса ${r}`);
  ensure('paint', 1);
  const exe = codexExe();
  const work = mkdtempSync(join(tmpdir(), 'ring-paint-'));
  const prompt = buildPrompt({ description, aspect, transparent, refs: absRefs.length });
  const args = ['exec', '--skip-git-repo-check', '--disable', 'memories', '-s', 'workspace-write', '-'];
  for (const r of absRefs) args.push('-i', r);
  log(`Рисую (${aspect}${transparent ? ', прозрачный фон' : ''}${absRefs.length ? `, референсов ${absRefs.length}` : ''}), обычно 1–4 минуты…`);
  const t0 = Date.now();
  let output = '';
  const code = await new Promise((res) => {
    // .cmd needs a shell on Windows: one quoted command line (the description goes through stdin, not here)
    const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const p = /\.cmd$/i.test(exe)
      ? spawn([exe, ...args].map(q).join(' '), { cwd: work, shell: true, windowsHide: true, env: paintEnv() })
      : spawn(exe, args, { cwd: work, windowsHide: true, env: paintEnv() });
    p.stdout.on('data', (d) => (output += d));
    p.stderr.on('data', (d) => (output += d));
    p.stdin.end(prompt);
    const timer = setTimeout(() => p.kill(), TIMEOUT_MS);
    p.on('close', (c) => {
      clearTimeout(timer);
      res(c);
    });
  });
  const ledger = spend('paint', 1, `${relative(process.cwd(), out)}: ${String(description).slice(0, 120)}`);
  const made = readdirSync(work).filter((f) => /\.png$/i.test(f)).map((f) => join(work, f)).sort((a, b) => statSync(b).size - statSync(a).size);
  if (code !== 0 || !made.length) {
    const tail = output.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
    rmSync(work, { recursive: true, force: true });
    throw new Error(`генератор не вернул картинку (код ${code}). Генерация засчитана: ${ledger.used} из ${ledger.limit}.\n${tail}`);
  }
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(made[0], out);
  rmSync(work, { recursive: true, force: true });
  let note = '';
  if (transparent) {
    const { img, transparent: ok } = hasAlpha(out);
    if (!ok) {
      writeFileSync(out, encodePNG(img.width, img.height, keyBackground(img).data));
      note = ' Фон пришёл непрозрачным — вырезан по цвету краёв, проверь края.';
    }
  }
  writeFileSync(out.replace(/\.png$/i, '.paint.json'), JSON.stringify({ description, aspect, transparent, refs: absRefs.map((r) => relative(dirname(out), r)), at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) }, null, 2) + '\n');
  log(`Готово: ${relative(process.cwd(), out)} за ${Math.round((Date.now() - t0) / 1000)} с. Генераций: ${ledger.used} из ${ledger.limit}.${note}`);
  return out;
}

export async function cmdPaint(opts, here) {
  const description = opts._.slice(1).join(' ');
  await paint({ description, out: opts.out ? resolve(here, opts.out) : null, refs: opts.ref.map((r) => resolve(here, r)), aspect: opts.aspect || 'square', transparent: !!opts.transparent });
}

