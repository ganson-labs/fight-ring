// What a fighter's body can do beyond the ring's 15 bones, all of it optional (the fighter decides, the ring only
// allows): own bones in chains off any bone (a cape, a scarf, a tail, a weapon, hair, wings, more arms) with an
// optional spring that makes them trail the motion; in an animation key — another picture for a part (fist / open
// hand, a face), a bone's scale (squash and stretch) and the draw order; a mesh that bends one picture over several
// bones (a whole arm through the elbow, a whole leg through the knee) with weights, as skeletal 2D animation does;
// feet held on the floor by two-bone IK. None of it touches the fight: hits count on the ring's boxes.
// Pure, no DOM: the checker reads the format, the renderer (render/scene.js Rig) draws with it.
import { BONES, BONE, BONE_NAMES, PELVIS_REST, solvePose } from './skeleton.js';

export const EXTRA_BONES_MAX = 12;
export const MESH_BONES_MAX = 4;
export const SCALE_RANGE = [0.25, 4];
const D2R = Math.PI / 180;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const okPt = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// the ankle's height above the floor in the rest pose: a planted foot keeps its ankle here
export const ANKLE_REST = PELVIS_REST[1] - BONE.thigh_front.length - BONE.shin_front.length;

// ---------- format ----------

// body.json → bones: { name: { parent, attach, side, angle, length, spring } }. Returns the bones in an order where
// a parent comes before its children: [{ name, parent, attach, side, rest, length, spring }].
export function readExtraBones(raw, errors) {
  if (raw === undefined) return [];
  if (!isObj(raw)) {
    errors.push('body.json → bones: объект { имя: { parent, attach, side, angle, length, spring } }');
    return [];
  }
  const names = Object.keys(raw);
  if (names.length > EXTRA_BONES_MAX) errors.push(`body.json → bones: не больше ${EXTRA_BONES_MAX} своих костей`);
  const out = [];
  const known = new Set(BONE_NAMES);
  for (const name of names) {
    const b = raw[name];
    const w = `body.json → bones.${name}`;
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(name)) errors.push(`${w}: имя — латиница в нижнем регистре, цифры и _, до 24 знаков`);
    if (known.has(name)) errors.push(`${w}: так зовут кость ринга`);
    if (!isObj(b)) {
      errors.push(`${w}: объект { parent, attach, side, angle, length }`);
      continue;
    }
    if (typeof b.parent !== 'string' || !(known.has(b.parent) || names.includes(b.parent))) errors.push(`${w}.parent: кость ринга или своя кость`);
    if (b.parent === name) errors.push(`${w}.parent: кость не может быть своим родителем`);
    if (!(b.length >= 1 && b.length <= 300)) errors.push(`${w}.length: длина в единицах, от 1 до 300`);
    if (b.attach !== undefined && b.attach !== null && !(Number.isFinite(b.attach) && Math.abs(b.attach) <= 300)) errors.push(`${w}.attach: расстояние вдоль родителя от его сустава, по модулю до 300 (без поля — конец родителя)`);
    if (b.side !== undefined && !(Number.isFinite(b.side) && Math.abs(b.side) <= 200)) errors.push(`${w}.side: поперёк родителя, + вперёд, по модулю до 200`);
    if (b.angle !== undefined && !(Number.isFinite(b.angle) && Math.abs(b.angle) <= 360)) errors.push(`${w}.angle: угол покоя относительно родителя, градусы`);
    let spring = null;
    if (b.spring !== undefined && b.spring !== null) {
      const s = b.spring;
      if (!isObj(s)) errors.push(`${w}.spring: объект { stiffness, damping, gravity }`);
      else {
        const rng = (k, lo, hi, def) => {
          const v = s[k] ?? def;
          if (!(Number.isFinite(v) && v >= lo && v <= hi)) errors.push(`${w}.spring.${k}: от ${lo} до ${hi}`);
          return v;
        };
        spring = { stiffness: rng('stiffness', 0.01, 1, 0.2), damping: rng('damping', 0, 1, 0.25), gravity: rng('gravity', 0, 1, 0), lag: rng('lag', 0, 180, 70) };
      }
    }
    out.push({ name, parent: b.parent, attach: b.attach ?? null, side: b.side || 0, rest: b.angle || 0, length: b.length, spring, extra: true });
  }
  // parents first; a cycle is an error
  const ordered = [];
  const placed = new Set(BONE_NAMES);
  let left = out.filter((b) => typeof b.parent === 'string');
  for (let guard = 0; left.length && guard <= EXTRA_BONES_MAX + 1; guard++) {
    const ready = left.filter((b) => placed.has(b.parent));
    if (!ready.length) break;
    for (const b of ready) {
      ordered.push(b);
      placed.add(b.name);
    }
    left = left.filter((b) => !placed.has(b.name));
  }
  if (left.length) errors.push(`body.json → bones: цепочка без кости ринга в начале или по кругу (${left.map((b) => b.name).join(', ')})`);
  return ordered;
}

// the bones of a fighter's chains: the ring's own plus its extras (for children lists and checks)
export function childrenOf(name, extra = []) {
  return [...BONES, ...extra].filter((b) => b.parent === name).map((b) => b.name);
}

// pose fields beyond root and bones: scale { bone: k | [along, across] }, images { bone: skin | null }, z { bone: n }
export function readPoseLook(raw, where, errors, names, skins = null) {
  const look = {};
  if (raw.scale !== undefined) {
    if (!isObj(raw.scale)) errors.push(`${where}.scale: объект { кость: множитель или [вдоль, поперёк] }`);
    else {
      look.scale = {};
      for (const [k, v] of Object.entries(raw.scale)) {
        const pair = Array.isArray(v) ? v : [v, v];
        if (!names.has(k)) errors.push(`${where}.scale.${k}: нет такой кости`);
        else if (pair.length !== 2 || !pair.every((x) => Number.isFinite(x) && x >= SCALE_RANGE[0] && x <= SCALE_RANGE[1])) errors.push(`${where}.scale.${k}: число или [вдоль, поперёк] от ${SCALE_RANGE[0]} до ${SCALE_RANGE[1]}`);
        else look.scale[k] = pair;
      }
    }
  }
  if (raw.images !== undefined) {
    if (!isObj(raw.images)) errors.push(`${where}.images: объект { кость: имя картинки из parts.<кость>.skins или null — основная }`);
    else {
      look.images = {};
      for (const [k, v] of Object.entries(raw.images)) {
        if (!names.has(k)) errors.push(`${where}.images.${k}: нет такой кости`);
        else if (v !== null && typeof v !== 'string') errors.push(`${where}.images.${k}: имя из parts.${k}.skins или null`);
        else if (v !== null && skins && !skins[k]?.[v]) errors.push(`${where}.images.${k}: нет картинки «${v}» в parts.${k}.skins`);
        else look.images[k] = v;
      }
    }
  }
  if (raw.z !== undefined) {
    if (!isObj(raw.z)) errors.push(`${where}.z: объект { кость: порядок отрисовки }`);
    else {
      look.z = {};
      for (const [k, v] of Object.entries(raw.z)) {
        if (!names.has(k)) errors.push(`${where}.z.${k}: нет такой кости`);
        else if (!Number.isFinite(v)) errors.push(`${where}.z.${k}: число`);
        else look.z[k] = v;
      }
    }
  }
  return look;
}

// ---------- skeleton with extras, feet, springs ----------

// Two-bone IK of one leg: the hip stays, the ankle goes to `target`, the knee bends forward. Mutates solved.
function legIK(solved, sideName, target) {
  const th = solved[`thigh_${sideName}`];
  const sh = solved[`shin_${sideName}`];
  const ft = solved[`foot_${sideName}`];
  if (!th || !sh) return;
  const L1 = BONE[`thigh_${sideName}`].length;
  const L2 = BONE[`shin_${sideName}`].length;
  const dx = target[0] - th.x;
  const dy = target[1] - th.y;
  const d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 0.5, L1 + L2 - 0.01);
  const a0 = Math.atan2(dy, dx);
  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const ta = a0 + alpha; // knee forward (towards +x for a fighter facing right)
  const kx = th.x + Math.cos(ta) * L1;
  const ky = th.y + Math.sin(ta) * L1;
  const sa = Math.atan2(target[1] - ky, target[0] - kx);
  const ax = kx + Math.cos(sa) * L2;
  const ay = ky + Math.sin(sa) * L2;
  Object.assign(th, { angle: ta / D2R, tipX: kx, tipY: ky });
  Object.assign(sh, { x: kx, y: ky, angle: sa / D2R, tipX: ax, tipY: ay });
  if (ft) {
    const L3 = BONE[`foot_${sideName}`].length;
    Object.assign(ft, { x: ax, y: ay, tipX: ax + Math.cos(ft.angle * D2R) * L3, tipY: ay + Math.sin(ft.angle * D2R) * L3 });
  }
}

// Feet on the floor: a grounded fighter's ankle that sinks below the floor or hovers just above it (the stance bob,
// steps of a walk) is set on the floor and the knee bends to reach it. reach: how far above the floor still counts.
export function plantFeet(solved, { reach = 24 } = {}) {
  for (const s of ['back', 'front']) {
    const sh = solved[`shin_${s}`];
    if (!sh) continue;
    if (sh.tipY < ANKLE_REST + reach) legIK(solved, s, [sh.tipX, ANKLE_REST]);
  }
  return solved;
}

// Forward kinematics of a fighter's own bones on top of the ring's solved bones; `springs` (a Map kept by the
// renderer between frames) lets bones with a spring trail the motion. dt in seconds.
export function solveExtras(solved, pose, extra, springs = null, dt = 1 / 60) {
  for (const b of extra) {
    const p = solved[b.parent];
    if (!p) continue;
    const parentLen = BONE[b.parent]?.length ?? extra.find((x) => x.name === b.parent)?.length ?? 0;
    const along = b.attach == null ? parentLen : b.attach;
    const pa = p.angle * D2R;
    const x = p.x + Math.cos(pa) * along + Math.sin(pa) * b.side;
    const y = p.y + Math.sin(pa) * along - Math.cos(pa) * b.side;
    let angle = p.angle + b.rest + (pose.bones?.[b.name] || 0);
    if (b.spring && springs) {
      const st = springs.get(b.name);
      if (!st) springs.set(b.name, { angle, vel: 0 });
      else {
        const n = Math.max(1, Math.round(dt * 60));
        for (let i = 0; i < n; i++) {
          // towards where the bone is posed, and down with gravity, with some damping
          const down = -90 - st.angle;
          const pull = (angle - st.angle) * b.spring.stiffness + ((((down + 540) % 360) - 180) * b.spring.gravity) * 0.05;
          st.vel = (st.vel + pull) * (1 - b.spring.damping);
          st.angle += st.vel;
        }
        st.angle = clamp(st.angle, angle - b.spring.lag, angle + b.spring.lag);
        angle = st.angle;
      }
    }
    const a = angle * D2R;
    solved[b.name] = { x, y, angle, tipX: x + Math.cos(a) * b.length, tipY: y + Math.sin(a) * b.length };
  }
  return solved;
}

// The whole body of a fighter for a pose: ring bones, feet on the floor when asked and grounded, own bones.
export function solveBody(pose, def, { grounded = true, springs = null, dt = 1 / 60 } = {}) {
  const solved = solvePose(pose);
  if (def?.ik?.feet && grounded) plantFeet(solved);
  if (def?.bones?.length) solveExtras(solved, pose, def.bones, springs, dt);
  return solved;
}

// ---------- mesh: one picture bent over a chain of bones ----------

const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// A grid over the picture (w × h px) with weights to the chain's bones. points: pixel of each joint along the chain
// and of its end (bones.length + 1 points). blend: the bend zone at a joint, as a share of the shorter segment.
// Returns { vertices, uvs, indices, weights: [[i, w], …] per vertex }.
export function buildMesh(w, h, points, { blend = 0.25, cols = 10, rowsPerSegment = 10 } = {}) {
  const segs = points.length - 1;
  const lens = [];
  for (let i = 0; i < segs; i++) lens.push(Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]) || 1);
  const total = lens.reduce((a, b) => a + b, 0);
  // the grid follows the picture's long side
  const along = h >= w;
  const nx = along ? cols : Math.max(4, Math.round(segs * rowsPerSegment * (w / total)));
  const ny = along ? Math.max(4, Math.round(segs * rowsPerSegment * (h / total))) : cols;
  const vertices = [];
  const uvs = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    vertices.push((i / nx) * w, (j / ny) * h);
    uvs.push(i / nx, j / ny);
  }
  const indices = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i;
    indices.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1);
  }
  const weights = [];
  for (let v = 0; v < vertices.length; v += 2) {
    const px = vertices[v];
    const py = vertices[v + 1];
    // the nearest segment and where along it
    let best = 0;
    let bu = 0;
    let bd = Infinity;
    for (let s = 0; s < segs; s++) {
      const [ax, ay] = points[s];
      const dx = points[s + 1][0] - ax;
      const dy = points[s + 1][1] - ay;
      const u = ((px - ax) * dx + (py - ay) * dy) / (lens[s] * lens[s]);
      const cu = clamp(u, 0, 1);
      const d = Math.hypot(px - (ax + cu * dx), py - (ay + cu * dy));
      if (d < bd - 1e-6) {
        bd = d;
        best = s;
        bu = u;
      }
    }
    // in the bend zone around a joint the vertex follows both bones
    const wts = new Map([[best, 1]]);
    const band = (s) => (blend * Math.min(lens[s], lens[s + 1] ?? lens[s])) / lens[s];
    if (best < segs - 1) {
      const b = band(best);
      const t = smooth(1 - b, 1 + b, bu);
      if (t > 0) {
        wts.set(best, 1 - t * 0.5);
        wts.set(best + 1, t * 0.5);
      }
    }
    if (best > 0) {
      const b = (blend * Math.min(lens[best], lens[best - 1])) / lens[best];
      const t = 1 - smooth(-b, b, bu);
      if (t > 0) {
        wts.set(best, (wts.get(best) || 1) - t * 0.5);
        wts.set(best - 1, (wts.get(best - 1) || 0) + t * 0.5);
      }
    }
    const sum = [...wts.values()].reduce((a, b) => a + b, 0) || 1;
    weights.push([...wts.entries()].map(([i, x]) => [i, x / sum]));
  }
  return { vertices: new Float32Array(vertices), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), weights };
}

// Picture pixels of the mesh into fighter space (y up) for the placed bones of its chain: linear blend skinning.
// placed: [{ x, y, angle, length }] per bone of the chain; points: the joints in the picture; width: across scale.
export function skinMesh(mesh, points, placed, width = 1, out = new Float32Array(mesh.vertices.length)) {
  const frames = placed.map((j, i) => {
    const [ax, ay] = points[i];
    const dx = points[i + 1][0] - ax;
    const dy = points[i + 1][1] - ay;
    const L = Math.hypot(dx, dy) || 1;
    const s = j.length / L;
    const a = j.angle * D2R;
    return { ax, ay, ux: dx / L, uy: dy / L, s, ca: Math.cos(a), sa: Math.sin(a), x: j.x, y: j.y };
  });
  const v = mesh.vertices;
  for (let k = 0; k < v.length; k += 2) {
    let X = 0;
    let Y = 0;
    for (const [i, w] of mesh.weights[k >> 1]) {
      const f = frames[i];
      const px = v[k] - f.ax;
      const py = v[k + 1] - f.ay;
      // picture → bone frame: along the joint segment, and across it (+ to the picture's right of the segment)
      const along = (px * f.ux + py * f.uy) * f.s;
      const side = (-px * f.uy + py * f.ux) * f.s * width;
      // bone frame → fighter space: along the bone's angle; across is the bone's clockwise normal (render/fit.js)
      X += w * (f.x + f.ca * along + f.sa * side);
      Y += w * (f.y + f.sa * along - f.ca * side);
    }
    out[k] = X;
    out[k + 1] = Y;
  }
  return out;
}

// a mesh's chain of bones: from its first bone down through children, each the parent of the next
export function meshChainOk(chain, extra = []) {
  const all = Object.fromEntries([...BONES, ...extra].map((b) => [b.name, b]));
  for (let i = 1; i < chain.length; i++) if (all[chain[i]]?.parent !== chain[i - 1]) return false;
  return chain.every((n) => all[n]);
}
