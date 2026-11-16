// Draws the neutral capsule parts of the kit template fighter and of the sparring dummy.
//   node scripts/make-template-parts.mjs
// Each part is a horizontal capsule: the joint (pivot) on the left, the end of the bone (tip) on the right.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../kit/arena/tools/png.js';
import { BONES } from '../kit/arena/engine/skeleton.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PX = 2; // pixels per ring unit
const PAD = 4;

// radius and how far the round body sits inside the bone ends (units)
const SHAPE = {
  pelvis: { r: 32, in0: 0, in1: 0 },
  torso: { r: 34, in0: 6, in1: 6 },
  head: { r: 25, in0: 22, in1: 23 },
  upper_arm_back: { r: 13 }, forearm_back: { r: 11 }, hand_back: { r: 10, in0: 4, in1: 4 },
  upper_arm_front: { r: 13 }, forearm_front: { r: 11 }, hand_front: { r: 10, in0: 4, in1: 4 },
  thigh_back: { r: 17 }, shin_back: { r: 13 }, foot_back: { r: 9, in0: 0, in1: 0 },
  thigh_front: { r: 17 }, shin_front: { r: 13 }, foot_front: { r: 9, in0: 0, in1: 0 },
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function capsule(len, { r, in0 = 0, in1 = 0 }, color) {
  const w = Math.ceil((len + 2 * r) * PX) + 2 * PAD;
  const h = Math.ceil(2 * r * PX) + 2 * PAD;
  const px = PAD + r * PX; // pivot x in pixels
  const cy = h / 2;
  const a = px + in0 * PX;
  const b = px + Math.max(in0, len - in1) * PX;
  const R = r * PX;
  const [cr, cg, cb] = hex(color);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.max(a, Math.min(b, x + 0.5));
      const dx = x + 0.5 - sx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d > R + 1) continue;
      const alpha = Math.max(0, Math.min(1, R + 0.5 - d));
      const ny = dy / R; // -1 top, 1 bottom
      const nx = dx / R;
      let light = 0.62 + 0.38 * Math.max(0, 1 - (ny + 0.45) * (ny + 0.45)) - 0.1 * Math.abs(nx);
      if (d > R - 2.2) light *= 0.55; // outline
      const i = (y * w + x) * 4;
      data[i] = Math.min(255, cr * light);
      data[i + 1] = Math.min(255, cg * light);
      data[i + 2] = Math.min(255, cb * light);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return { png: encodePNG(w, h, data), pivot: [Math.round(px), Math.round(cy)], tip: [Math.round(px + len * PX), Math.round(cy)] };
}

// one colour for the near and the far side: the ring itself shades the far arm and leg (render/scene.js FAR_SHADE)
function make(dir, front, back) {
  mkdirSync(dir, { recursive: true });
  const parts = {};
  for (const bone of BONES) {
    const isBack = bone.name.endsWith('_back');
    const c = capsule(bone.length, SHAPE[bone.name], isBack ? back : front);
    writeFileSync(join(dir, `${bone.name}.png`), c.png);
    parts[bone.name] = { image: `parts/${bone.name}.png`, pivot: c.pivot, tip: c.tip };
  }
  return parts;
}

const out = {
  template: make(join(root, 'kit', 'fighter', 'parts'), '#8d9199', '#8d9199'),
  dummy: make(join(root, 'kit', 'arena', 'sparring', 'dummy', 'parts'), '#9a7b58', '#9a7b58'),
};
console.log(JSON.stringify(out.template));
