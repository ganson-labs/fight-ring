// `arena parts`: body parts as separate transparent layers in one style, and help to seat them on bones.
//   parts sheet --ref art/character.png [--parts "…"] [--note "…"]   one generation: the pieces drawn apart on a
//                                         transparent sheet as the fighter describes them, then split
//   parts split <image>                   cut a sheet with separate parts into one PNG per part + an index picture
//   parts guess <part.png>                the two ends of the part's main axis: candidates for pivot and tip; for a
//                                         torso or pelvis also armholes, neckline, hips and anchors for the children
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { decodeImage, encodePNG } from './png.js';
import { paint, keyBackground } from './paint.js';
import { BONES, BONE_NAMES } from '../engine/skeleton.js';
import { suggestAnchors, OPENING_PARTS, fighterPoses } from '../render/fit.js';

const PART_LIST = 'head with neck; torso; pelvis; near upper arm; near forearm; near hand; far upper arm; far forearm; far hand; near thigh; near shin; near foot; far thigh; far shin; far foot';

// The generator's request: the fighter's own description of the pieces (which, how drawn, from which angle, how they
// meet at the joints) inside the ring's technical frame only — separate pieces on a transparent sheet that the
// splitter can cut. parts: the fighter's own list of pieces (by default the ring's 15 bones, one piece each).
export function sheetPrompt(note, parts = null) {
  const list = parts && String(parts).trim() ? String(parts).trim() : PART_LIST;
  const n = list.split(/[;\n]/).filter((x) => x.trim()).length;
  return [
    'A sheet of separate body-part pieces of exactly the character shown in the reference image, for 2D skeletal animation.',
    `Pieces (${n}): ${list}.`,
    'Same art style, colours and lighting as the reference.',
    note ? note : '',
    'Each piece drawn as large as the sheet allows, spread out with clear empty space between pieces, none touching or overlapping, nothing cut off by the edge; no assembled figure, no labels, no numbers, no guide lines.',
  ].filter(Boolean).join(' ');
}

// Connected pieces on alpha. Returns [{ x0, y0, x1, y1, area, label }] sorted in reading order.
export function findPieces(img, { minArea = 0.0008, cell = 4 } = {}) {
  const { width: w, height: h, data } = img;
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const mask = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 40) mask[((y / cell) | 0) * cw + ((x / cell) | 0)] = 1;
  // dilate one cell so thin gaps inside a piece do not split it
  const dil = new Uint8Array(mask);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (mask[y * cw + x]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx;
    const yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < cw && yy < ch) dil[yy * cw + xx] = 1;
  }
  const label = new Int32Array(cw * ch).fill(-1);
  const pieces = [];
  const stack = [];
  for (let i = 0; i < cw * ch; i++) {
    if (!dil[i] || label[i] >= 0) continue;
    const id = pieces.length;
    const p = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0, id };
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const j = stack.pop();
      const x = j % cw;
      const y = (j / cw) | 0;
      if (mask[j]) p.area += cell * cell;
      p.x0 = Math.min(p.x0, x);
      p.y0 = Math.min(p.y0, y);
      p.x1 = Math.max(p.x1, x);
      p.y1 = Math.max(p.y1, y);
      for (const k of [j - 1, j + 1, j - cw, j + cw]) {
        if (k < 0 || k >= cw * ch || label[k] >= 0 || !dil[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === cw - 1)) continue;
        label[k] = id;
        stack.push(k);
      }
    }
    pieces.push(p);
  }
  const keep = pieces.filter((p) => p.area >= minArea * w * h);
  for (const p of keep) {
    p.x0 *= cell;
    p.y0 *= cell;
    p.x1 = Math.min(w - 1, p.x1 * cell + cell - 1);
    p.y1 = Math.min(h - 1, p.y1 * cell + cell - 1);
  }
  const rowH = Math.max(40, h / 12);
  keep.sort((a, b) => Math.floor(a.y0 / rowH) - Math.floor(b.y0 / rowH) || a.x0 - b.x0);
  return { pieces: keep, label, cw, cell };
}

export function cropPiece(img, piece, found, pad = 12) {
  const { width: w, data } = img;
  const x0 = Math.max(0, piece.x0 - pad);
  const y0 = Math.max(0, piece.y0 - pad);
  const x1 = Math.min(img.width - 1, piece.x1 + pad);
  const y1 = Math.min(img.height - 1, piece.y1 + pad);
  const cwid = x1 - x0 + 1;
  const chei = y1 - y0 + 1;
  const out = new Uint8Array(cwid * chei * 4);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const cellLabel = found.label[((y / found.cell) | 0) * found.cw + ((x / found.cell) | 0)];
    if (cellLabel !== piece.id) continue;
    const si = (y * w + x) * 4;
    const di = ((y - y0) * cwid + (x - x0)) * 4;
    out[di] = data[si];
    out[di + 1] = data[si + 1];
    out[di + 2] = data[si + 2];
    out[di + 3] = data[si + 3];
  }
  return { width: cwid, height: chei, data: out };
}

// Main axis of the opaque pixels: its two ends (rounded pixels), length and angle.
export function guessAxis(img) {
  const { width: w, height: h, data } = img;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 100) {
    n++;
    sx += x;
    sy += y;
  }
  if (!n) return null;
  const mx = sx / n;
  const my = sy / n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 100) {
    xx += (x - mx) ** 2;
    yy += (y - my) ** 2;
    xy += (x - mx) * (y - my);
  }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const proj = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 100) proj.push((x - mx) * ux + (y - my) * uy);
  proj.sort((a, b) => a - b);
  const lo = proj[Math.floor(proj.length * 0.03)];
  const hi = proj[Math.floor(proj.length * 0.97)];
  // thickness near each end; the joint sits inside a rounded end, about half its thickness in from the edge
  const near = (s0) => {
    let t0 = Infinity;
    let t1 = -Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 100) {
      const s = (x - mx) * ux + (y - my) * uy;
      if (Math.abs(s - s0) > (hi - lo) * 0.1) continue;
      const t = -(x - mx) * uy + (y - my) * ux;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    return t1 > t0 ? t1 - t0 : 0;
  };
  const len = hi - lo;
  const inLo = Math.min(near(lo) * 0.45, len * 0.2);
  const inHi = Math.min(near(hi) * 0.45, len * 0.2);
  let a = [Math.round(mx + ux * lo), Math.round(my + uy * lo)];
  let b = [Math.round(mx + ux * hi), Math.round(my + uy * hi)];
  let ja = [Math.round(mx + ux * (lo + inLo)), Math.round(my + uy * (lo + inLo))];
  let jb = [Math.round(mx + ux * (hi - inHi)), Math.round(my + uy * (hi - inHi))];
  if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) [a, b, ja, jb] = [b, a, jb, ja];
  return { endA: a, endB: b, jointA: ja, jointB: jb, length: Math.round(len), width: w, height: h };
}

async function indexPicture(dir, files) {
  const { launch } = await import('./browser.js');
  const { serveFolders } = await import('./serve.js');
  const cells = files.map((f, i) => `<figure><div class="im"><img src="${f.name}"></div><figcaption><b>${String(i + 1).padStart(2, '0')}</b> ${f.name} · ${f.width}×${f.height}</figcaption></figure>`).join('');
  writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#202330;font:16px Arial;color:#fff;display:flex;flex-wrap:wrap;gap:10px;padding:10px;width:1580px}figure{margin:0;width:300px;background:repeating-conic-gradient(#3a3d4a 0 25%,#2c2f3a 0 50%) 0 0/20px 20px}.im{height:260px;display:flex;align-items:center;justify-content:center}img{max-width:290px;max-height:250px}figcaption{background:#111;padding:6px}</style>${cells}`);
  const server = await serveFolders({ '/raw/': dir });
  const browser = await launch({ width: 1600, height: 900 });
  try {
    const page = await browser.open(`${server.url}/raw/index.html`, { w: 1600, h: 900 });
    await page.evaluate('Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => i.onload = i.onerror = r)))');
    const height = await page.evaluate('document.body.scrollHeight');
    await page.resize(1600, height);
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1600, height } });
    writeFileSync(join(dir, 'index.png'), png);
  } finally {
    await browser.close();
    await server.close();
  }
  rmSync(join(dir, 'index.html'), { force: true });
}

export async function split(image, outDir, log = console.log) {
  let img = decodeImage(image);
  const corners = [0, img.width - 1, (img.height - 1) * img.width, img.height * img.width - 1].map((i) => img.data[i * 4 + 3]);
  if (corners.some((a) => a > 16)) {
    img = keyBackground(img);
    log('Фон непрозрачный: вырезан по цвету краёв.');
  }
  const found = findPieces(img);
  if (!found.pieces.length) throw new Error('на картинке не нашлось отдельных частей');
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (/^piece-\d+\.png$/.test(f)) rmSync(join(outDir, f));
  const files = [];
  found.pieces.forEach((p, i) => {
    const crop = cropPiece(img, p, found);
    const name = `piece-${String(i + 1).padStart(2, '0')}.png`;
    writeFileSync(join(outDir, name), encodePNG(crop.width, crop.height, crop.data));
    files.push({ name, width: crop.width, height: crop.height, axis: guessAxis(crop) });
  });
  await indexPicture(outDir, files);
  log(`Частей: ${files.length} → ${relative(process.cwd(), outDir)}`);
  log(`Обзор с номерами: ${relative(process.cwd(), join(outDir, 'index.png'))}`);
  for (const f of files) log(`  ${f.name}  ${f.width}×${f.height}  ось: ${JSON.stringify(f.axis.endA)} → ${JSON.stringify(f.axis.endB)}, длина ${f.axis.length}px, суставы ${JSON.stringify(f.axis.jointA)} · ${JSON.stringify(f.axis.jointB)}`);
  return files;
}

// The fighter folder a part picture belongs to: the nearest folder up with body.json.
function fighterOf(file) {
  for (let d = dirname(file), i = 0; i < 4; i++, d = dirname(d)) if (existsSync(join(d, 'body.json'))) return d;
  return null;
}

const pt = (p) => `[${p.join(', ')}]`;

async function guessAnchors(file, bone) {
  const img = decodeImage(file);
  const dir = fighterOf(file);
  let ctx = null;
  if (dir) {
    const { readFighterDir, fighterParts } = await import('./load.js');
    const res = readFighterDir(dir);
    if (res.fighter?.parts[bone]) ctx = { ...fighterParts(dir, res.fighter.parts), parts: res.fighter.parts, poses: fighterPoses(res.fighter) };
    else console.log(`
body.json в ${relative(process.cwd(), dir) || '.'} ${res.fighter ? `не рисует ${bone} этой картинкой` : 'не проходит проверку'}: якоря только по картинке, без поз бойца.`);
  }
  const s = suggestAnchors(img, bone, ctx);
  console.log(`
Дети ${bone} и где они растут на этой картинке (якоря — пиксели картинки, куда садится pivot ребёнка):`);
  for (const n of s.notes) console.log(`  ${n}`);
  const anchors = Object.fromEntries(Object.entries(s.anchors).filter(([c]) => BONE_NAMES.includes(c)));
  if (Object.keys(anchors).length) console.log(`В body.json → parts.${bone}: "anchors": { ${Object.entries(anchors).map(([c, p]) => `"${c}": ${pt(p)}`).join(', ')} }`);
  for (const [c, z] of Object.entries(s.z)) console.log(`В body.json → parts.${c}: "z": ${z}`);
  if (ctx) console.log('Проверка после правки: node arena/cli.mjs check и лист поз preview --sheet (якоря отмечены на крупных картинках частей).');
}

export async function cmdParts(opts, here) {
  const sub = opts._[1];
  if (sub === 'sheet') {
    const ref = opts.ref[0];
    if (!ref) throw new Error('нужен --ref: лист или портрет персонажа, по которому рисовать части');
    const out = resolve(here, opts.out || 'art/parts-sheet.png');
    await paint({ description: sheetPrompt(opts.note, opts.parts), out, refs: opts.ref.map((r) => resolve(here, r)), aspect: opts.aspect || 'square', transparent: true });
    await split(out, resolve(here, opts.into || 'fighter/parts/raw'));
    return;
  }
  if (sub === 'split') {
    const image = opts._[2];
    if (!image || !existsSync(resolve(here, image))) throw new Error('parts split <картинка>');
    await split(resolve(here, image), resolve(here, opts.out || 'fighter/parts/raw'));
    return;
  }
  if (sub === 'guess') {
    const file = opts._[2];
    if (!file || !existsSync(resolve(here, file))) throw new Error('parts guess <part.png>');
    const a = guessAxis(decodeImage(resolve(here, file)));
    console.log(`${basename(file)}: ${a.width}×${a.height}, главная ось ${JSON.stringify(a.endA)} → ${JSON.stringify(a.endB)} (${a.length}px).`);
    console.log(`Суставы внутри скруглённых концов: ${JSON.stringify(a.jointA)} и ${JSON.stringify(a.jointB)} — кандидаты в pivot и tip.`);
    console.log('pivot — точка сустава с родителем, tip — сустав со следующей костью. Длины костей ринга (ед.):');
    console.log('  ' + BONES.map((b) => `${b.name} ${b.length}`).join(', '));
    const bone = typeof opts.bone === 'string' ? opts.bone : basename(file).replace(/\.[^.]+$/, '');
    if (OPENING_PARTS.includes(bone)) await guessAnchors(resolve(here, file), bone);
    return;
  }
  throw new Error('parts sheet --ref <картинка> | parts split <картинка> | parts guess <part.png>');
}
