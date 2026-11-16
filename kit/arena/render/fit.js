// Where a child part grows out of its parent's picture. The ring skeleton puts every shoulder, hip and neck at the
// same spot for everyone, but each fighter draws them elsewhere: an armhole at the back of a vest, hips high under a
// skirt. A parent part may name, in pixels of its own picture, where each child's pivot sits ("anchors"); the ring
// then moves the child's picture (and everything hanging from it) there. Bones, lengths and boxes stay the ring's:
// looks never change the fight. Pure functions: browser and Node.
import { BONES, BONE, DEFAULT_Z, solvePose } from '../engine/skeleton.js';

// how far a drawn joint may move away from the ring's joint, units (the fighter is about 300 tall)
export const ANCHOR_MAX = 30;
export const CHILDREN = Object.fromEntries(BONES.map((b) => [b.name, BONES.filter((c) => c.parent === b.name).map((c) => c.name)]));

const D2R = Math.PI / 180;
const ALPHA = 100;

// Draw order back to front, as the Rig draws: the part's own "z", else the ring's default; ties keep the bone order.
export function drawOrder(parts) {
  return BONES.map((b, i) => ({ name: b.name, z: parts[b.name]?.z ?? DEFAULT_Z[b.name], i })).sort((a, b) => a.z - b.z || a.i - b.i).map((x) => x.name);
}

// A part's picture on its bone. at: { pivot, tip } as drawn (render/seat.js), width: thickness multiplier.
// along and side are units in the bone's frame: along from the joint towards the tip, side + forward (render/scene.js Rig).
export function pictureFrame(at, width, length) {
  const dx = at.tip[0] - at.pivot[0];
  const dy = at.tip[1] - at.pivot[1];
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  const s = length / L;
  const w = width ?? 1;
  return {
    scale: s,
    toBone(pt) {
      const vx = pt[0] - at.pivot[0];
      const vy = pt[1] - at.pivot[1];
      return [(vx * ux + vy * uy) * s, (-vx * uy + vy * ux) * s * w];
    },
    toPicture(along, side) {
      const a = along / s;
      const c = side / (s * w);
      return [at.pivot[0] + a * ux - c * uy, at.pivot[1] + a * uy + c * ux];
    },
  };
}

// bone frame → fighter space (y up, facing right) for a placed bone j
const toWorld = (j, along, side) => {
  const c = Math.cos(j.angle * D2R);
  const s = Math.sin(j.angle * D2R);
  return [j.x + along * c + side * s, j.y + along * s - side * c];
};
const fromWorld = (j, x, y) => {
  const c = Math.cos(j.angle * D2R);
  const s = Math.sin(j.angle * D2R);
  const dx = x - j.x;
  const dy = y - j.y;
  return [dx * c + dy * s, dx * s - dy * c];
};

function frames(parts, seat) {
  const out = {};
  for (const b of BONES) {
    const p = parts[b.name];
    if (p) out[b.name] = pictureFrame(seat?.[b.name] || p, p.width, b.length);
  }
  return out;
}

// Where every bone is drawn. solved: solvePose(); parts: body.json parts (with anchors); seat: render/seat.js per bone.
// A child with an anchor on its parent's picture starts there (no further than ANCHOR_MAX from the ring's joint);
// without one it keeps the ring's joint, moved together with its parent. Returns solvePose's shape plus shift and
// clamped (the anchor was further than ANCHOR_MAX).
export function placeBones(solved, parts, seat, fr = frames(parts, seat)) {
  const out = {};
  for (const b of BONES) {
    const j = solved[b.name];
    let sx = 0;
    let sy = 0;
    let clamped = false;
    if (b.parent) {
      const p = out[b.parent];
      sx = p.shift[0];
      sy = p.shift[1];
      const a = parts[b.parent]?.anchors?.[b.name];
      if (a && fr[b.parent]) {
        const w = toWorld(p, ...fr[b.parent].toBone(a));
        sx = w[0] - j.x;
        sy = w[1] - j.y;
        const d = Math.hypot(sx, sy);
        if (d > ANCHOR_MAX) {
          sx *= ANCHOR_MAX / d;
          sy *= ANCHOR_MAX / d;
          clamped = true;
        }
      }
    }
    out[b.name] = { ...j, x: j.x + sx, y: j.y + sy, tipX: j.tipX + sx, tipY: j.tipY + sy, shift: [sx, sy], clamped };
  }
  return out;
}

// The ring's joint of a child in its parent's picture, rest pose: where the child sits without an anchor.
export function ringJointOnPicture(parts, seat, child) {
  const parent = BONE[child].parent;
  const p = parts[parent];
  if (!p) return null;
  const fr = frames(parts, seat);
  const placed = placeBones(solvePose({ root: [0, 0], bones: {} }), { ...parts, [parent]: { ...p, anchors: undefined } }, seat, fr);
  const j = placed[child];
  return fr[parent].toPicture(...fromWorld(placed[parent], j.x, j.y));
}

// ---------- openings ----------

const lumOf = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Holes in a part's picture where a child is meant to come out: a flat dark area inside the part that differs in
// colour from the cloth around it (an armhole of a vest, the lining under a hem), or a transparent hole enclosed by
// the part. img: { width, height, data } RGBA. Returns [{ kind: 'dark' | 'empty', box: [x0, y0, x1, y1], center, share, pixels }]
// pixels: flat [x, y, …] sampled every `step` px.
export function findOpenings(img, { step = 0 } = {}) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const st = step || Math.max(1, Math.round(Math.max(w, h) / 160));
  let opaque = 0;
  const lums = [];
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] > ALPHA) {
    opaque++;
    if (i % 3 === 0) lums.push(lumOf(data, i * 4));
  }
  if (!opaque) return [];
  lums.sort((a, b) => a - b);
  const med = lums[lums.length >> 1] || 1;
  const label = new Int32Array(n).fill(-1);
  const regions = [];
  const stack = [];
  const TOL = 18;
  for (let s0 = 0; s0 < n; s0++) {
    if (label[s0] >= 0 || data[s0 * 4 + 3] <= ALPHA) continue;
    const r = { id: regions.length, n: 0, x0: w, y0: h, x1: 0, y1: 0, edge: 0, sr: 0, sg: 0, sb: 0 };
    label[s0] = r.id;
    stack.push(s0);
    while (stack.length) {
      const j = stack.pop();
      const x = j % w;
      const y = (j / w) | 0;
      r.n++;
      if (x < r.x0) r.x0 = x;
      if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y;
      if (y > r.y1) r.y1 = y;
      r.sr += data[j * 4];
      r.sg += data[j * 4 + 1];
      r.sb += data[j * 4 + 2];
      const mr = r.sr / r.n;
      const mg = r.sg / r.n;
      const mb = r.sb / r.n;
      for (let q = 0; q < 4; q++) {
        const xx = x + (q === 0 ? 1 : q === 1 ? -1 : 0);
        const yy = y + (q === 2 ? 1 : q === 3 ? -1 : 0);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
          r.edge++;
          continue;
        }
        const k = yy * w + xx;
        if (data[k * 4 + 3] <= ALPHA) {
          r.edge++;
          continue;
        }
        if (label[k] >= 0) continue;
        if (Math.abs(data[k * 4] - mr) > TOL || Math.abs(data[k * 4 + 1] - mg) > TOL || Math.abs(data[k * 4 + 2] - mb) > TOL) continue;
        label[k] = r.id;
        stack.push(k);
      }
    }
    regions.push(r);
  }
  const chroma = (r) => {
    const t = r.sr + r.sg + r.sb || 1;
    return [r.sr / t, r.sg / t, r.sb / t];
  };
  const main = regions.reduce((a, b) => (b.n > a.n ? b : a));
  const mc = chroma(main);
  const out = [];
  for (const r of regions) {
    if (r === main || r.n < opaque * 0.025 || r.edge > 0) continue;
    const fill = r.n / ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1));
    const L = (0.299 * r.sr + 0.587 * r.sg + 0.114 * r.sb) / r.n;
    const c = chroma(r);
    const hue = Math.hypot(c[0] - mc[0], c[1] - mc[1], c[2] - mc[2]);
    if (fill < 0.45 || L > med * 0.9 || !(hue >= 0.1 || L < med * 0.5)) continue;
    out.push(opening('dark', r, (i) => label[i] === r.id));
  }
  // transparent holes the part encloses: transparent pixels the outside cannot reach
  const outside = new Uint8Array(n);
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (data[(y * w + x) * 4 + 3] <= ALPHA && !outside[y * w + x]) fillOutside(y * w + x);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (data[(y * w + x) * 4 + 3] <= ALPHA && !outside[y * w + x]) fillOutside(y * w + x);
  function fillOutside(s) {
    outside[s] = 1;
    stack.push(s);
    while (stack.length) {
      const j = stack.pop();
      const x = j % w;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) {
        if (k < 0 || k >= n || outside[k] || data[k * 4 + 3] > ALPHA) continue;
        outside[k] = 1;
        stack.push(k);
      }
    }
  }
  const hole = new Int32Array(n).fill(-1);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (outside[s] || hole[s] >= 0 || data[s * 4 + 3] > ALPHA) continue;
    const r = { n: 0, x0: w, y0: h, x1: 0, y1: 0 };
    hole[s] = id;
    stack.push(s);
    while (stack.length) {
      const j = stack.pop();
      const x = j % w;
      const y = (j / w) | 0;
      r.n++;
      r.x0 = Math.min(r.x0, x);
      r.x1 = Math.max(r.x1, x);
      r.y0 = Math.min(r.y0, y);
      r.y1 = Math.max(r.y1, y);
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]) {
        if (k < 0 || k >= n || outside[k] || hole[k] >= 0 || data[k * 4 + 3] > ALPHA) continue;
        hole[k] = id;
        stack.push(k);
      }
    }
    const my = id++;
    if (r.n >= opaque * 0.015) out.push(opening('empty', r, (i) => hole[i] === my));
  }
  return out;

  function opening(kind, r, inside) {
    const pixels = [];
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let y = r.y0; y <= r.y1; y += st) for (let x = r.x0; x <= r.x1; x += st) if (inside(y * w + x)) {
      pixels.push(x, y);
      sx += x;
      sy += y;
      c++;
    }
    return { kind, box: [r.x0, r.y0, r.x1, r.y1], center: [Math.round(sx / (c || 1)), Math.round(sy / (c || 1))], share: r.n / opaque, pixels };
  }
}

// ---------- coverage ----------

const alphaAt = (img, x, y) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return 0;
  return img.data[(yi * img.width + xi) * 4 + 3];
};

// The share of an opening on `parent`'s picture that parts drawn above the parent cover, for each pose.
// images: bone → { width, height, data }. Returns [share per pose].
export function openingCover(parts, seat, images, poses, parent, op, fr = frames(parts, seat)) {
  const order = drawOrder(parts);
  const above = order.slice(order.indexOf(parent) + 1).filter((b) => parts[b] && images[b]);
  const pts = op.pixels;
  const count = pts.length / 2;
  return poses.map((pose) => {
    const placed = placeBones(solvePose(pose), parts, seat, fr);
    const pj = placed[parent];
    let covered = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const [x, y] = toWorld(pj, ...fr[parent].toBone([pts[i], pts[i + 1]]));
      for (const b of above) {
        const q = fr[b].toPicture(...fromWorld(placed[b], x, y));
        if (alphaAt(images[b], q[0], q[1]) > ALPHA) {
          covered++;
          break;
        }
      }
    }
    return count ? covered / count : 1;
  });
}

// ---------- the whole body ----------

// parts whose pictures hold the holes children come out of
export const OPENING_PARTS = ['torso', 'pelvis'];
const EDGE_CHILD = { thigh_front: 'bottom', thigh_back: 'bottom' };

// How deep inside the pelvis picture a thigh starts, units, when the thigh is drawn above the pelvis and should come
// out of its edge (from under a hem). null when it does not apply.
export function edgeDepth(parts, seat, images, child, fr = frames(parts, seat)) {
  const parent = BONE[child].parent;
  const order = drawOrder(parts);
  if (!EDGE_CHILD[child] || !parts[child] || !parts[parent] || !images[parent]) return null;
  if (order.indexOf(child) < order.indexOf(parent)) return null;
  const placed = placeBones(solvePose({ root: [0, 0], bones: {} }), parts, seat, fr);
  const pj = placed[parent];
  const j = placed[child];
  const img = images[parent];
  // walk from the child's joint across the parent's picture: up for the head, down for the thighs
  const dir = EDGE_CHILD[child] === 'top' ? 1 : -1;
  const s = fr[parent].scale;
  let inside = 0;
  let gap = 0;
  for (let d = 0; d < 400 && gap < 3 / s; d += 0.5) {
    const q = fr[parent].toPicture(...fromWorld(pj, j.x, j.y + dir * d));
    if (alphaAt(img, q[0], q[1]) > ALPHA) {
      inside = d;
      gap = 0;
    } else gap += 0.5;
  }
  return inside;
}

// Every finding about how children sit on their parents. images: bone → picture pixels. poses: list of poses.
// Returns { openings: [{ bone, op, rest, mean, child, gap }], deep: [{ child, parent, depth, thick }], clamped: [{ parent, child, dist }] }
export function bodyFit(parts, seat, images, poses) {
  const fr = frames(parts, seat);
  const rest = { root: [0, 0], bones: {} };
  const openings = [];
  for (const bone of OPENING_PARTS) {
    if (!parts[bone] || !images[bone]) continue;
    for (const op of findOpenings(images[bone])) {
      // the child meant for this opening: the one anchored in it, else the nearest one drawn above the parent;
      // the near arm belongs above the torso. A hem or a lining over children drawn below is the parent's own look.
      const order = drawOrder(parts);
      const placed = placeBones(solvePose(rest), parts, seat, fr);
      const [x0, y0, x1, y1] = op.box;
      const cands = CHILDREN[bone].filter((c) => parts[c]).map((c) => {
        const q = fr[bone].toPicture(...fromWorld(placed[bone], placed[c].x, placed[c].y));
        const a = parts[bone].anchors?.[c];
        return { child: c, gap: Math.hypot(q[0] - op.center[0], q[1] - op.center[1]) * fr[bone].scale, above: order.indexOf(c) > order.indexOf(bone), anchored: !!a && a[0] >= x0 && a[0] <= x1 && a[1] >= y0 && a[1] <= y1 };
      });
      const nearest = (list) => list.reduce((a, b) => (!a || b.gap < a.gap ? b : a), null);
      const best = cands.find((c) => c.anchored) || nearest(cands.filter((c) => c.above)) || (bone === 'torso' ? cands.find((c) => c.child === 'upper_arm_front') : null);
      if (!best) continue;
      const cover = openingCover(parts, seat, images, [rest, ...poses], bone, op, fr);
      const mean = cover.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, cover.length - 1);
      openings.push({ bone, op, rest: cover[0], mean: poses.length ? mean : cover[0], ...best });
    }
  }
  const deep = [];
  for (const child of Object.keys(EDGE_CHILD)) {
    const depth = edgeDepth(parts, seat, images, child, fr);
    if (depth == null) continue;
    const th = seat?.[child]?.ends?.pivot?.thick;
    const thick = th ? th * fr[child].scale * (parts[child].width ?? 1) : 20;
    deep.push({ child, parent: BONE[child].parent, depth, thick });
  }
  const clamped = [];
  const placed = placeBones(solvePose(rest), parts, seat, fr);
  const plain = solvePose(rest);
  for (const b of BONES) {
    if (!b.parent || !parts[b.parent]?.anchors?.[b.name] || !fr[b.parent]) continue;
    const pj = placed[b.parent];
    const w = toWorld(pj, ...fr[b.parent].toBone(parts[b.parent].anchors[b.name]));
    const dist = Math.hypot(w[0] - plain[b.name].x, w[1] - plain[b.name].y);
    if (dist > ANCHOR_MAX) clamped.push({ parent: b.parent, child: b.name, dist });
  }
  // a leg moved up or down by its hip anchor lifts its foot off the floor or sinks it
  const floating = ['thigh_front', 'thigh_back'].filter((c) => parts.pelvis?.anchors?.[c]).map((c) => ({ child: c, dy: placed[c].shift[1] })).filter((f) => Math.abs(f.dy) > FLOAT_MAX);
  return { openings, deep, clamped, floating };
}

// Openings left open: less than this share covered in the rest pose or on average over the poses
export const OPEN_LIMIT = 0.75;
// a child drawn above its parent may start this deep inside it: share of its own thickness, and at least in units
export const DEEP_SHARE = 0.5;
export const DEEP_MIN = 8;
// a hip anchor may move the leg up or down this much, units
export const FLOAT_MAX = 4;

const pct = (v) => `${Math.round(v * 100)} %`;
const px = (p) => `[${p.map((v) => Math.round(v)).join(', ')}]`;
const KIND = { dark: 'тёмная область', empty: 'пустая область' };

// Findings as lines for `check` and the pose sheet.
export function fitWarnings(fit, parts) {
  const out = [];
  for (const o of fit.openings) {
    if (o.rest >= OPEN_LIMIT && o.mean >= OPEN_LIMIT) continue;
    const where = `${KIND[o.op.kind]} ${px(o.op.box.slice(0, 2))}–${px(o.op.box.slice(2))} px`;
    let fix = '';
    if (o.child) {
      const z = parts[o.child]?.z;
      if (!o.above) fix = `; ${o.child} рисуется под ${o.bone}${z != null ? ` (z ${z})` : ''} и не может её закрыть`;
      else if (o.bone === 'pelvis') fix = `; ${o.child} рисуется поверх таза — поставь ему z ниже, чем у pelvis, и нога выйдет из-под подола (подсказка: parts guess ${parts[o.bone].image})`;
      else if (!parts[o.bone].anchors?.[o.child]) fix = `; ${o.child} садится в ${Math.round(o.gap)} ед. от неё — поставь ${o.bone}.anchors.${o.child} (подсказка: parts guess ${parts[o.bone].image})`;
    }
    out.push(`body.json → parts.${o.bone}: ${where} открыта — закрыта на ${pct(o.rest)} в покое и на ${pct(o.mean)} в среднем по позам${fix}`);
  }
  for (const d of fit.deep) {
    if (d.depth <= Math.max(DEEP_MIN, d.thick * DEEP_SHARE)) continue;
    const edge = EDGE_CHILD[d.child] === 'top' ? 'верхнего' : 'нижнего';
    const fix = d.parent === 'pelvis' ? `поставь ему z ниже, чем у pelvis: нога выйдет из-под подола` : `поставь ${d.parent}.anchors.${d.child} у края или z ниже, чем у ${d.parent}`;
    out.push(`body.json → parts.${d.child}: рисуется поверх ${d.parent} и начинается в ${Math.round(d.depth)} ед. от его ${edge} края — растёт из середины части; ${fix}`);
  }
  for (const f of fit.floating || []) out.push(`body.json → parts.pelvis.anchors.${f.child}: поднимает ногу на ${Math.round(f.dy)} ед. — в покое стопа ${f.dy > 0 ? 'висит над полом' : 'уходит в пол'}; бёдра сдвигай вперёд и назад, высоту оставь ринга`);
  for (const c of fit.clamped) out.push(`body.json → parts.${c.parent}.anchors.${c.child}: в ${Math.round(c.dist)} ед. от сустава ринга — ринг сдвигает часть не дальше ${ANCHOR_MAX}`);
  return out;
}

// Every pose the fighter shows: keys of its animations and moves.
export function fighterPoses(def) {
  const out = [];
  for (const a of Object.values(def.anims || {})) for (const k of a?.keys || []) out.push(k.pose);
  for (const m of def.moves || []) for (const k of m.anim?.keys || []) out.push(k.pose);
  return out;
}

// ---------- suggestions for `parts guess` ----------

function opaqueRows(img) {
  const { width: w, height: h, data } = img;
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > ALPHA) {
    if (y0 < 0) y0 = y;
    y1 = y;
    break;
  }
  return [y0, y1];
}

// the middle of the neckline: the top of the picture, a little in
function neckline(img) {
  const { width: w, data } = img;
  const [y0, y1] = opaqueRows(img);
  const y = Math.round(y0 + (y1 - y0) * 0.06);
  let sx = 0;
  let n = 0;
  for (let yy = y0; yy <= y; yy++) for (let x = 0; x < w; x++) if (data[(yy * w + x) * 4 + 3] > ALPHA) {
    sx += x;
    n++;
  }
  return n ? [Math.round(sx / n), y] : null;
}

// the lowest opaque pixel of every column (−1 where the column is empty)
function bottomProfile(img) {
  const { width: w, height: h, data } = img;
  const out = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = h - 1; y >= 0; y--) if (data[(y * w + x) * 4 + 3] > ALPHA) {
    out[x] = y;
    break;
  }
  return out;
}

// Trousers: the bottom edge rises between two legs (the crotch). Returns { notch: [x, y], lobes: [xBack, xFront] } or null.
export function crotch(img, forwardX = 1) {
  const b = bottomProfile(img);
  const xs = [...b.keys()].filter((x) => b[x] >= 0);
  if (xs.length < 8) return null;
  const [y0, y1] = opaqueRows(img);
  const H = y1 - y0;
  const lo = xs[0];
  const hi = xs[xs.length - 1];
  const leftMax = new Int32Array(b.length).fill(-1);
  const rightMax = new Int32Array(b.length).fill(-1);
  for (let x = lo + 1; x <= hi; x++) leftMax[x] = Math.max(leftMax[x - 1], b[x - 1]);
  for (let x = hi - 1; x >= lo; x--) rightMax[x] = Math.max(rightMax[x + 1], b[x + 1]);
  let best = null;
  for (let x = Math.round(lo + (hi - lo) * 0.25); x <= lo + (hi - lo) * 0.75; x++) {
    if (b[x] < 0) continue;
    const depth = Math.min(leftMax[x], rightMax[x]) - b[x];
    if (depth > H * 0.15 && (!best || depth > best.depth)) best = { x, depth };
  }
  if (!best) return null;
  const lobe = (from, to) => {
    let sx = 0;
    let n = 0;
    for (let k = from; k <= to; k++) if (b[k] > b[best.x] + best.depth * 0.5) {
      sx += k;
      n++;
    }
    return n ? sx / n : (from + to) / 2;
  };
  const a = lobe(lo, best.x - 1);
  const c = lobe(best.x + 1, hi);
  return { notch: [best.x, b[best.x]], lobes: forwardX > 0 ? [a, c] : [c, a] };
}

// Anchors to propose for a torso or pelvis picture. ctx (optional): { parts, seat, images, poses } of the fighter the
// picture belongs to (bone: which part it is). Returns { anchors: { child: [x, y] }, z: { bone: z }, notes: [line], openings }.
export function suggestAnchors(img, bone, ctx = null) {
  const res = { anchors: {}, z: {}, notes: [], openings: OPENING_PARTS.includes(bone) ? findOpenings(img) : [] };
  const parts = ctx?.parts;
  const fit = parts && parts[bone] ? ctx : null;
  const fr = fit ? frames(parts, fit.seat) : null;
  const rest = { root: [0, 0], bones: {} };
  const sample = fit ? [rest, ...fit.poses.filter((_, i) => i % Math.max(1, Math.ceil(fit.poses.length / 24)) === 0)] : [];
  const images = fit ? { ...fit.images, [bone]: img } : null;
  const kept = { ...(parts?.[bone]?.anchors || {}) };
  const coverOf = (anchors, op, zs = {}) => {
    const ps = { ...parts, [bone]: { ...parts[bone], anchors } };
    for (const [b, z] of Object.entries(zs)) ps[b] = { ...ps[b], z };
    const c = openingCover(ps, fit.seat, images, sample, bone, op, frames(ps, fit.seat));
    return { rest: c[0], mean: c.reduce((a, b) => a + b, 0) / c.length };
  };
  const ringAt = (child) => ringJointOnPicture({ ...parts, [bone]: { ...parts[bone], anchors: undefined } }, fit.seat, child);
  const units = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) * fr[bone].scale;

  if (bone === 'torso') {
    const holes = [...res.openings].sort((a, b) => b.share - a.share).slice(0, 2);
    const kids = ['upper_arm_front', 'upper_arm_back'];
    holes.forEach((op, i) => {
      const child = kids[i];
      const [x0, y0, x1, y1] = op.box;
      let pt = [op.center[0], Math.round(y0 + (y1 - y0) * 0.35)];
      let why = `${KIND[op.kind]} ${px(op.box.slice(0, 2))}–${px(op.box.slice(2))}: пройма`;
      if (fit && parts[child]) {
        // the near arm goes above the torso to close its armhole, the far one stays behind
        const zs = {};
        const zt = parts.torso.z ?? DEFAULT_Z.torso;
        if (child === 'upper_arm_front') for (const c of ['upper_arm_front', 'forearm_front', 'hand_front']) if (parts[c] && (parts[c].z ?? DEFAULT_Z[c]) <= zt) zs[c] = zt + 1;
        Object.assign(res.z, zs);
        const { [child]: _, ...without } = kept;
        const before = coverOf(without, op, zs);
        const ring = ringAt(child);
        let best = null;
        for (let gy = 0; gy <= 8; gy++) for (let gx = 0; gx <= 8; gx++) {
          const cand = [Math.round(x0 + ((x1 - x0) * gx) / 8), Math.round(y0 + ((y1 - y0) * gy) / 8)];
          if (units(cand, ring) > ANCHOR_MAX) continue;
          const c = coverOf({ ...kept, [child]: cand }, op, zs);
          const score = c.rest * 0.4 + c.mean * 0.6;
          const prefer = Math.hypot(cand[0] - pt[0], cand[1] - pt[1]);
          if (!best || score > best.score + 1e-3 || (Math.abs(score - best.score) <= 1e-3 && prefer < best.prefer)) best = { cand, c, score, prefer };
        }
        if (best) {
          pt = best.cand;
          why += ` — ${child} закрывает её на ${pct(best.c.rest)} в покое и на ${pct(best.c.mean)} в среднем по позам (без якоря ${pct(before.rest)} и ${pct(before.mean)})`;
          if (best.c.mean < OPEN_LIMIT) why += '; рука её целиком не закрывает: пройму на картинке торса стоит закрасить или уменьшить';
        } else why += ` — дальше ${ANCHOR_MAX} ед. от плеча ринга ${px(ring)}, ринг туда не дотянется`;
      }
      res.anchors[child] = pt;
      res.notes.push(`${child} ${px(pt)} — ${why}`);
    });
    if (!holes.length) res.notes.push('пройм не видно: плечи остаются по скелету ринга');
    const neck = neckline(img);
    if (neck) {
      res.anchors.head = neck;
      const ring = fit ? ringAt('head') : null;
      res.notes.push(`head ${px(neck)} — середина выреза шеи${ring ? ` (по скелету ринга ${px(ring)}, в ${Math.round(units(neck, ring))} ед.)` : ''}`);
    }
  }

  if (bone === 'pelvis') {
    const forwardX = fr ? Math.sign(fr.pelvis.toPicture(0, 1)[0] - fr.pelvis.toPicture(0, 0)[0]) || 1 : 1;
    const legs = crotch(img, forwardX);
    const hips = fit ? { thigh_back: ringAt('thigh_back'), thigh_front: ringAt('thigh_front') } : null;
    if (legs) {
      ['thigh_back', 'thigh_front'].forEach((c, i) => {
        // a hip moves only forward or back: its height stays the ring's, or the foot leaves the floor
        const pt = [Math.round(legs.lobes[i]), Math.round(hips ? hips[c][1] : legs.notch[1])];
        res.anchors[c] = pt;
        res.notes.push(`${c} ${px(pt)} — над ${i ? 'передней' : 'задней'} штаниной (развилка ${px(legs.notch)})`);
      });
    } else if (fit) {
      // a skirt or a hem: the picture goes on well below the hips, legs come out from under it
      const b = bottomProfile(img);
      const zp = parts.pelvis.z ?? DEFAULT_Z.pelvis;
      for (const c of ['thigh_front', 'thigh_back']) {
        if (!parts[c]) continue;
        const h = hips[c];
        const th = (fit.seat?.[c]?.ends?.pivot?.thick || 0) * fr[c].scale * (parts[c].width ?? 1) || 20;
        const half = th / 2 / fr.pelvis.scale;
        const cols = [];
        for (let x = Math.max(0, Math.round(h[0] - half)); x <= Math.min(b.length - 1, Math.round(h[0] + half)); x++) if (b[x] >= 0) cols.push(b[x]);
        cols.sort((p, q) => p - q);
        const hem = cols.length ? (cols[cols.length >> 1] - h[1]) * fr.pelvis.scale : 0;
        const zc = parts[c].z ?? DEFAULT_Z[c];
        const skirt = hem > th * DEEP_SHARE;
        if (skirt && zc >= zp) res.z[c] = c === 'thigh_front' ? zp - 0.5 : zp - 1;
        res.notes.push(`${c}: таз опускается на ${Math.round(hem)} ед. ниже бедра — ${skirt ? `подол: бедро рисуй под тазом${res.z[c] != null ? ` (z ${res.z[c]})` : ''}, нога выйдет из-под него` : 'нога выходит у края'}; бедро по скелету ринга ${px(h)}`);
      }
    } else res.notes.push('развилки штанин не видно: бёдра остаются по скелету ринга');
  }
  return res;
}
