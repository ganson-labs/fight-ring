// Pose helpers for «Метроном»: poses written in absolute angles, legs by ankle targets (IK), feet kept flat.
import { solvePose } from '../../../arena/engine/skeleton.js';

const D = Math.PI / 180;
const L1 = 70, L2 = 68;
const ANKLE = 12; // ankle height when the boot stands on the floor
const r1 = (v) => Math.round(v * 10) / 10;

// spec:
//   hip: [dx, dy]  pelvis joint offset from rest (0, 150)
//   pel: pelvis tilt (deg, + = back), tor: torso absolute tilt from vertical (- = lean forward), head: absolute tilt
//   af / ab: front / back arm [upper, fore, hand] absolute angles (0 = forward, 90 = up, -90 = down)
//   ff / fb: front / back ankle target [x, y] (y omitted = on the floor); or lf / lb: [thigh, shin] absolute angles
//   toeF / toeB: foot absolute angle (default flat when the ankle is on the floor, else follows the shin)
//   needle, key: own bones (relative); extra: raw bone deltas merged at the end; scale, images, z: passed through
export function P(spec) {
  const s = { hip: [0, 0], pel: 0, tor: 0, head: 0, ...spec };
  const bones = {};
  const pelA = 90 + s.pel; // pelvis absolute
  bones.pelvis = s.pel;
  const torA = 90 + s.tor;
  bones.torso = torA - pelA;
  bones.head = s.head - s.tor;
  const arm = (side, a) => {
    if (!a) return;
    const [u, f, h] = a;
    // upper arm absolute = torso absolute - 180 + delta
    bones[`upper_arm_${side}`] = normArm(u - (torA - 180));
    bones[`forearm_${side}`] = norm(f - u);
    bones[`hand_${side}`] = norm((h ?? f) - f);
  };
  arm('front', s.af);
  arm('back', s.ab);
  const P0 = [s.hip[0], 150 + s.hip[1]];
  const leg = (side, sideOff, target, angles, toe) => {
    // hip joint of this leg: pelvis start, `sideOff` across (forward = +)
    const hx = P0[0] + Math.sin(pelA * D) * sideOff;
    const hy = P0[1] - Math.cos(pelA * D) * sideOff;
    let ta, sa, ay;
    if (angles) {
      [ta, sa] = angles;
      ay = hy + Math.sin(ta * D) * L1 + Math.sin(sa * D) * L2;
    } else {
      const [tx, ty0] = target;
      const ty = ty0 ?? ANKLE;
      const dx = tx - hx, dy = ty - hy;
      const d = Math.min(Math.max(Math.hypot(dx, dy), 4), L1 + L2 - 0.05);
      const a0 = Math.atan2(dy, dx);
      const al = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
      ta = (a0 + al) / D;
      const kx = hx + Math.cos(ta * D) * L1, ky = hy + Math.sin(ta * D) * L1;
      sa = Math.atan2(ty - ky, tx - kx) / D;
      ay = ty;
    }
    // thigh absolute = pelvis absolute - 180 + delta
    bones[`thigh_${side}`] = norm(ta - (pelA - 180));
    bones[`shin_${side}`] = norm(sa - ta);
    const onFloor = ay <= ANKLE + 3;
    // on the floor: flat; in the air: hangs off the shin, toe a little down
    bones[`foot_${side}`] = toe !== undefined ? norm(toe - (sa + 90)) : onFloor ? norm(-(sa + 90)) : -12;
  };
  leg('front', 6, s.ff ? s.ff : null, s.lf, s.toeF);
  leg('back', -7, s.fb ? s.fb : null, s.lb, s.toeB);
  if (s.needle !== undefined) bones.needle = s.needle;
  if (s.key !== undefined) bones.key = s.key;
  Object.assign(bones, s.extra || {});
  for (const k of Object.keys(bones)) bones[k] = r1(bones[k]);
  const pose = { root: [r1(s.hip[0]), r1(s.hip[1])], bones };
  if (s.scale) pose.scale = s.scale;
  if (s.images) pose.images = s.images;
  if (s.z) pose.z = s.z;
  return pose;
}

// upper arms swing up and over the head (rest is down): keep raised arms positive so they pass in front
function normArm(a) {
  while (a > 240) a -= 360;
  while (a <= -120) a += 360;
  return a;
}

function norm(a) {
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

// where things end up (for sanity checks): ankles, fists, head top
export function probe(pose) {
  const s = solvePose(pose);
  const p = (n) => [r1(s[n].tipX), r1(s[n].tipY)];
  return { ankleF: p('shin_front'), ankleB: p('shin_back'), fistF: p('hand_front'), fistB: p('hand_back'), head: p('head') };
}

// mix two specs (numbers and arrays lerped) — for in-between keys
export function mix(a, b, k) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key], y = b[key];
    if (x === undefined) out[key] = y;
    else if (y === undefined) out[key] = x;
    else if (typeof x === 'number' && typeof y === 'number') out[key] = x + (y - x) * k;
    else if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v) => typeof v === 'number' || v === undefined)) out[key] = x.map((v, i) => (v === undefined ? y[i] : v + ((y[i] ?? v) - v) * k));
    else out[key] = k < 0.5 ? x : y;
  }
  return out;
}

export const key = (t, spec, ease) => ({ t, pose: P(spec), ...(ease ? { ease } : {}) });
