// The ring skeleton: one rig for every fighter. Fighters only bind pictures to bones and pose the bones.
// Angles are degrees, 0 points forward (the way the fighter faces), 90 points up. A pose turns each bone
// relative to its parent: positive is counter-clockwise when the fighter faces right, so +90 on an arm
// hanging down lifts it straight forward. Rotations add up along the chain (turn the torso — arms follow).

// name, parent, attach (distance along the parent from its joint; null = at the parent's tip), side (distance across
// the parent, + forward / − back; the far shoulder and hip sit a little behind, the near ones a little ahead, the way
// a body turned three quarters to the camera reads in profile), rest angle, length
export const BONES = [
  { name: 'pelvis', parent: null, attach: null, rest: 90, length: 20 },
  { name: 'torso', parent: 'pelvis', attach: null, rest: 90, length: 85 },
  { name: 'head', parent: 'torso', attach: null, rest: 90, length: 45 },
  { name: 'upper_arm_back', parent: 'torso', attach: 79, side: -11, rest: -90, length: 55 },
  { name: 'forearm_back', parent: 'upper_arm_back', attach: null, rest: -90, length: 50 },
  { name: 'hand_back', parent: 'forearm_back', attach: null, rest: -90, length: 20 },
  { name: 'thigh_back', parent: 'pelvis', attach: 0, side: -7, rest: -90, length: 70 },
  { name: 'shin_back', parent: 'thigh_back', attach: null, rest: -90, length: 68 },
  { name: 'foot_back', parent: 'shin_back', attach: null, rest: 0, length: 28 },
  { name: 'thigh_front', parent: 'pelvis', attach: 0, side: 6, rest: -90, length: 70 },
  { name: 'shin_front', parent: 'thigh_front', attach: null, rest: -90, length: 68 },
  { name: 'foot_front', parent: 'shin_front', attach: null, rest: 0, length: 28 },
  { name: 'upper_arm_front', parent: 'torso', attach: 73, side: 8, rest: -90, length: 55 },
  { name: 'forearm_front', parent: 'upper_arm_front', attach: null, rest: -90, length: 50 },
  { name: 'hand_front', parent: 'forearm_front', attach: null, rest: -90, length: 20 },
];
export const BONE_NAMES = BONES.map((b) => b.name);
export const BONE = Object.fromEntries(BONES.map((b) => [b.name, b]));
// Pelvis joint in the rest pose, measured from the point between the feet.
export const PELVIS_REST = [0, 150];
// Default draw order, back to front: the far arm and leg behind the body, the near ones in front of it.
// A part's own "z" overrides its place.
export const DEFAULT_Z = Object.fromEntries(['upper_arm_back', 'forearm_back', 'hand_back', 'thigh_back', 'shin_back', 'foot_back', 'pelvis', 'torso', 'head', 'thigh_front', 'shin_front', 'foot_front', 'upper_arm_front', 'forearm_front', 'hand_front'].map((n, i) => [n, i]));

export const EASINGS = ['linear', 'in', 'out', 'inout', 'hold'];

// Every state the ring can show, and what plays when the fighter did not animate it.
export const BASE_ANIMS = {
  idle: { required: true, loop: true },
  walk_forward: { required: true, loop: true },
  walk_back: { required: true, loop: true },
  crouch: { required: true, loop: true },
  jump: { required: true },
  block_high: { required: true },
  block_low: { required: true },
  hit: { required: true },
  knockdown: { required: true },
  hit_low: { fallback: 'hit' },
  hit_air: { fallback: 'hit' },
  getup: { fallback: 'crouch' },
  dash_forward: { fallback: 'walk_forward' },
  dash_back: { fallback: 'walk_back' },
  parry: { fallback: 'block_high' },
  throw: { fallback: 'idle' },
  thrown: { fallback: 'hit' },
  dizzy: { fallback: 'hit', loop: true },
  intro: { fallback: 'idle' },
  victory: { fallback: 'idle', loop: true },
  defeat: { fallback: 'knockdown' },
};

const D2R = Math.PI / 180;

// pose: { root: [dx, dy], bones: { name: degrees } } — missing bones are 0.
export function emptyPose() {
  return { root: [0, 0], bones: {} };
}

// Between two poses: angles of every bone of either (the ring's and a fighter's own), bone scale smoothly; the
// picture of a part and the draw order change at once, at the next key (engine/body.js).
export function lerpPose(a, b, k) {
  const out = { root: [a.root[0] + (b.root[0] - a.root[0]) * k, a.root[1] + (b.root[1] - a.root[1]) * k], bones: {} };
  for (const n of BONE_NAMES) {
    const x = a.bones[n] || 0;
    const y = b.bones[n] || 0;
    out.bones[n] = x + (y - x) * k;
  }
  for (const n of Object.keys(a.bones)) if (!(n in out.bones)) out.bones[n] = (a.bones[n] || 0) + ((b.bones[n] || 0) - (a.bones[n] || 0)) * k;
  for (const n of Object.keys(b.bones)) if (!(n in out.bones)) out.bones[n] = (b.bones[n] || 0) * k;
  if (a.scale || b.scale) {
    out.scale = {};
    for (const n of new Set([...Object.keys(a.scale || {}), ...Object.keys(b.scale || {})])) {
      const x = a.scale?.[n] || [1, 1];
      const y = b.scale?.[n] || [1, 1];
      out.scale[n] = [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k];
    }
  }
  const step = k >= 1 ? b : a;
  if (step.images) out.images = step.images;
  if (step.z) out.z = step.z;
  return out;
}

function ease(kind, k) {
  switch (kind) {
    case 'in': return k * k;
    case 'out': return 1 - (1 - k) * (1 - k);
    case 'inout': return k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
    case 'hold': return 0;
    default: return k;
  }
}

// anim: compiled { keys: [{ t, pose, ease }], length, loop }. t in ticks (fractional allowed for smooth render).
export function sampleAnim(anim, t) {
  const keys = anim.keys;
  if (!keys.length) return emptyPose();
  if (anim.loop && anim.length > 0) t = ((t % anim.length) + anim.length) % anim.length;
  if (t <= keys[0].t) return keys[0].pose;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t <= b.t) {
      const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return lerpPose(a.pose, b.pose, ease(a.ease, k));
    }
  }
  const last = keys[keys.length - 1];
  if (anim.loop) {
    const k = anim.length === last.t ? 1 : (t - last.t) / (anim.length - last.t);
    return lerpPose(last.pose, keys[0].pose, ease(last.ease, k));
  }
  return last.pose;
}

// Forward kinematics, facing right, y up. Returns { name: { x, y, angle, tipX, tipY } } (angle in degrees).
export function solvePose(pose) {
  const out = {};
  // the pose it came from, for the renderer: a fighter's own bones, picture swaps and scale (engine/body.js)
  Object.defineProperty(out, '__pose', { value: pose, enumerable: false });
  for (const b of BONES) {
    const delta = pose.bones[b.name] || 0;
    let x;
    let y;
    let angle;
    if (!b.parent) {
      x = PELVIS_REST[0] + pose.root[0];
      y = PELVIS_REST[1] + pose.root[1];
      angle = b.rest + delta;
    } else {
      const p = out[b.parent];
      const along = b.attach == null ? BONE[b.parent].length : b.attach;
      const side = b.side || 0;
      x = p.x + Math.cos(p.angle * D2R) * along + Math.sin(p.angle * D2R) * side;
      y = p.y + Math.sin(p.angle * D2R) * along - Math.cos(p.angle * D2R) * side;
      angle = p.angle + (b.rest - BONE[b.parent].rest) + delta;
    }
    out[b.name] = {
      x,
      y,
      angle,
      tipX: x + Math.cos(angle * D2R) * b.length,
      tipY: y + Math.sin(angle * D2R) * b.length,
    };
  }
  return out;
}
