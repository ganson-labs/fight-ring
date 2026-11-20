// Ring state animations for «Метроном».
import { P, key, mix } from './rig.mjs';

// ---- base specs ----
export const GUARD = { hip: [0, -9], tor: -5, head: 2, af: [-56, 74, 80], ab: [-70, 84, 88], ff: [30], fb: [-50], needle: 0, key: 0 };
export const CROUCH = { hip: [-2, -66], tor: -18, head: -2, af: [-40, 70, 78], ab: [-58, 80, 86], ff: [34], fb: [-46], needle: 0, key: 0 };
const g = (o) => ({ ...GUARD, ...o });
const c = (o) => ({ ...CROUCH, ...o });
const cos = (t, T) => Math.cos((2 * Math.PI * t) / T);

// idle: a metronome — the needle swings a full period every 60 ticks (two ticks a second), the body snaps
// a little on every beat, sways with the needle in between
function idle() {
  const keys = [];
  for (const t of [0, 3, 10, 20, 27, 30, 33, 40, 50, 57]) {
    const ph = t % 30;
    const snap = ph === 0 ? -3 : ph === 3 ? -0.6 : ph === 27 ? 0.4 : 0; // the tick: a quick dip, then settle
    const sway = cos(t, 60); // +1 at t0, -1 at t30
    keys.push(key(t, g({
      hip: [1.5 * sway, -9 + snap],
      tor: -5 + 1.2 * sway + (ph === 0 ? -1 : 0),
      head: 2 - 2.5 * sway + (ph === 0 ? -3 : 0),
      af: [-56 + snap * 0.8, 74 - snap, 80],
      ab: [-70 - snap * 0.5, 84, 88],
      needle: 26 * sway,
    }), ph === 0 ? 'out' : 'inout'));
  }
  return { loop: true, length: 60, keys };
}

// walk: mechanical shuffle — front foot steps, back foot follows, a tick on each plant
function walk(dir) {
  const L = 36;
  const f = dir > 0;
  const A = g({});
  const step1 = f ? g({ hip: [5, -6], tor: -7, ff: [52, 30], fb: [-48], needle: 20, head: 0 }) : g({ hip: [-4, -6], tor: -2, ff: [26], fb: [-72, 28], needle: 20, head: 3 });
  const plant1 = f ? g({ hip: [8, -12], tor: -6, ff: [50], fb: [-46], needle: 0, head: 1 }) : g({ hip: [-6, -12], tor: -3, ff: [28], fb: [-74], needle: 0, head: 2 });
  const step2 = f ? g({ hip: [4, -6], tor: -5, ff: [44], fb: [-26, 28], needle: -20, head: 2 }) : g({ hip: [-3, -6], tor: -4, ff: [8, 28], fb: [-62], needle: -20, head: 2 });
  const plant2 = g({ hip: [0, -11], needle: 0 });
  return {
    loop: true, length: L, keys: [
      key(0, plant2, 'inout'),
      key(8, step1, 'in'),
      key(14, plant1, 'out'),
      key(18, mix(plant1, A, 0.4), 'inout'),
      key(26, step2, 'in'),
      key(32, plant2, 'out'),
    ],
  };
}

function crouch() {
  const keys = [];
  for (const t of [0, 3, 30, 33]) {
    const ph = t % 30;
    const sway = cos(t, 60);
    keys.push(key(t, c({ hip: [-2 + 1.2 * sway, -66 + (ph === 0 ? -3 : 0)], head: -2 - 2 * sway, needle: 22 * sway }), ph === 0 ? 'out' : 'inout'));
  }
  return { loop: true, length: 60, keys };
}

function jump() {
  const up = { hip: [0, 0], tor: -6, head: 2, af: [-30, 80, 90], ab: [-50, 90, 95], lf: [-80, -100], lb: [-100, -110], needle: -10 };
  const tuck = { hip: [0, 0], tor: -12, head: -2, af: [-20, 85, 90], ab: [-40, 92, 95], lf: [10, -110], lb: [-25, -140], needle: 25 };
  const fall = { hip: [0, 0], tor: -6, head: 2, af: [-40, 75, 85], ab: [-60, 85, 90], lf: [-60, -95], lb: [-95, -120], needle: -15 };
  return { keys: [key(0, up, 'out'), key(9, tuck, 'inout'), key(26, tuck, 'inout'), key(38, fall, 'in')] };
}

// block: forearms snap up into a tight shell, chin down
const BLOCK_H = g({ hip: [-3, -12], tor: -2, head: -6, af: [-40, 92, 96], ab: [-52, 96, 100], needle: -8 });
const BLOCK_L = c({ hip: [-4, -70], tor: -14, head: -8, af: [-62, 40, 50], ab: [-80, 55, 60], needle: -8 });
function block(p) {
  return { keys: [key(0, mix(p, p === BLOCK_H ? GUARD : CROUCH, 0.5), 'out'), key(3, { ...p, needle: 14 }, 'out'), key(8, p, 'inout')] };
}

// hit: the head snaps back, the body rattles, the needle flails
const HURT = g({ hip: [-8, -12], tor: 14, head: 26, af: [-80, 20, 10], ab: [-100, 30, 20], needle: -40 });
function hit() {
  return { keys: [key(0, HURT, 'out'), key(5, { ...HURT, tor: 18, head: 30, needle: 30 }, 'inout'), key(11, mix(HURT, GUARD, 0.5), 'inout'), key(18, GUARD)] };
}
const HURT_L = c({ hip: [-8, -66], tor: 4, head: 20, af: [-70, 10, 0], ab: [-95, 20, 10], needle: -40 });
function hitLow() {
  return { keys: [key(0, HURT_L, 'out'), key(5, { ...HURT_L, tor: 8, needle: 30 }, 'inout'), key(16, CROUCH)] };
}
function hitAir() {
  const a = { hip: [0, 0], pel: 25, tor: 35, head: 50, af: [60, 100, 110], ab: [80, 130, 140], lf: [-50, -80], lb: [-70, -110], needle: -45 };
  const b = { ...a, pel: 40, tor: 55, head: 70, af: [90, 130, 140], ab: [110, 150, 160], lf: [-40, -60], lb: [-55, -95], needle: 40 };
  return { keys: [key(0, a, 'out'), key(10, b, 'inout'), key(30, { ...b, pel: 55, tor: 70, head: 80 })] };
}

// knockdown: topples like a wound-down toy, bounces once on the floor, lies there ticking
const LYING = { hip: [-30, -128], pel: 88, tor: 90, head: 96, af: [168, 178, 182], ab: [130, 150, 160], lf: [-4, -2], lb: [-8, -6], toeF: 80, toeB: 70, needle: -60, key: -100 };
function knockdown() {
  const fall = { hip: [-16, -60], pel: 40, tor: 52, head: 64, af: [40, 80, 90], ab: [70, 110, 120], lf: [-40, -60], lb: [-60, -80], needle: 40 };
  const bounce = { ...LYING, hip: [-30, -112], pel: 80, tor: 80, head: 84, lf: [8, 4], lb: [2, 0], needle: 50 };
  return {
    keys: [
      key(0, fall, 'in'),
      key(9, LYING, 'out'),
      key(14, bounce, 'in'),
      key(19, LYING, 'out'),
      key(30, { ...LYING, needle: -30 }, 'inout'),
      key(44, { ...LYING, needle: -55 }),
    ],
  };
}
function getup() {
  const sit = { hip: [-24, -90], pel: 40, tor: 10, head: 10, af: [-120, -100, -90], ab: [-130, -110, -100], ff: [30], fb: [-20], needle: 20 };
  const kneel = c({ hip: [-6, -60], tor: -20, needle: -15 });
  return { keys: [key(0, LYING, 'out'), key(7, sit, 'inout'), key(13, kneel, 'out'), key(20, GUARD)] };
}

function dash(dir) {
  if (dir > 0) {
    const low = g({ hip: [6, -24], tor: -26, head: 6, ff: [56, 30], fb: [-60], af: [-40, 70, 80], ab: [-60, 80, 85], needle: 30 });
    const glide = g({ hip: [10, -20], tor: -24, head: 6, ff: [62], fb: [-40, 26], needle: -25 });
    return { keys: [key(0, mix(GUARD, low, 0.5), 'out'), key(4, low, 'linear'), key(11, glide, 'out'), key(16, GUARD)] };
  }
  const hop = g({ hip: [-10, -2], tor: 6, head: 6, ff: [20, 34], fb: [-62, 30], af: [-50, 82, 88], ab: [-62, 90, 92], needle: -30 });
  const land = g({ hip: [-6, -16], tor: -2, head: 0, ff: [32], fb: [-58], needle: 20 });
  return { keys: [key(0, mix(GUARD, hop, 0.5), 'out'), key(5, hop, 'inout'), key(13, land, 'out'), key(18, GUARD)] };
}

// parry: a crisp outward flick of the lead forearm, like a conductor cutting off the orchestra
function parry() {
  const flick = g({ hip: [-2, -11], tor: 2, head: -2, af: [8, 96, 110], ab: [-66, 86, 90], needle: -30 });
  return { keys: [key(0, GUARD, 'out'), key(2, flick, 'out'), key(8, flick, 'inout'), key(14, { ...GUARD, needle: 26 }, 'inout'), key(20, GUARD)] };
}

function throwAnim() {
  const reach = g({ hip: [8, -12], tor: -14, head: 4, af: [-2, 4, 0], ab: [-8, 6, 0], needle: 15 });
  const lift = g({ hip: [2, -6], tor: 12, head: 14, af: [70, 100, 100], ab: [60, 95, 95], ff: [30], fb: [-56], needle: -30 });
  const slam = g({ hip: [12, -26], tor: -34, head: -18, af: [-20, -30, -40], ab: [-30, -40, -50], ff: [46], fb: [-50], needle: 45 });
  return { keys: [key(0, GUARD, 'out'), key(5, reach, 'out'), key(14, reach), key(24, lift, 'in'), key(32, slam, 'out'), key(42, slam, 'inout'), key(56, GUARD)] };
}
function thrown() {
  const grabbed = g({ hip: [-4, -10], tor: 10, head: 16, af: [-30, 40, 30], ab: [-20, 50, 40], needle: -30 });
  const up = { hip: [10, 30], pel: 30, tor: 40, head: 60, af: [100, 140, 150], ab: [120, 160, 170], lf: [-40, -70], lb: [-60, -100], needle: 40 };
  const over = { hip: [30, 10], pel: 120, tor: 130, head: 140, af: [160, 200, 200], ab: [150, 190, 190], lf: [20, 0], lb: [0, -20], needle: -40 };
  return { keys: [key(0, grabbed, 'out'), key(10, grabbed), key(18, up, 'inout'), key(26, over, 'in'), key(32, LYING)] };
}

// dizzy: the mainspring has slipped — head lolls, the needle swings wild and slow, arms hang
function dizzy() {
  const base = g({ hip: [0, -16], tor: -10, head: -14, af: [-80, -60, -60], ab: [-95, -70, -70], ff: [26], fb: [-44] });
  return {
    loop: true, length: 80, keys: [
      key(0, { ...base, hip: [4, -16], tor: -4, head: 12, needle: 55 }, 'inout'),
      key(20, { ...base, hip: [0, -20], tor: -14, head: -18, needle: 0 }, 'inout'),
      key(40, { ...base, hip: [-5, -16], tor: -6, head: 16, needle: -55 }, 'inout'),
      key(60, { ...base, hip: [0, -22], tor: -16, head: -20, needle: 0 }, 'inout'),
    ],
  };
}

// intro: stands unwound, the key in his back turns, the needle comes alive, he snaps into guard
const SLUMP = g({ hip: [0, -24], tor: -24, head: -40, af: [-92, -88, -88], ab: [-98, -94, -94], ff: [24], fb: [-40], needle: -55 });
function spin(t0, n, step, spec, keys) {
  // the wind-up key turns: across-scale 1 → 0.25 → 1 every `step` ticks
  for (let i = 0; i <= n; i++) keys.push(key(t0 + i * step, { ...spec, scale: { key: [1, i % 2 ? 0.25 : 1] } }, 'inout'));
}
function intro() {
  const keys = [key(0, SLUMP, 'hold')];
  spin(16, 8, 4, SLUMP, keys);
  keys.pop();
  const rise = g({ hip: [0, -14], tor: -10, head: -10, af: [-80, -30, -20], ab: [-90, -40, -30], needle: -20 });
  keys.push(key(48, { ...mix(SLUMP, rise, 0.4), scale: { key: [1, 1] } }, 'out'));
  keys.push(key(60, { ...rise, needle: 30 }, 'inout'));
  keys.push(key(70, { ...rise, head: 6, tor: -2, needle: -30 }, 'out'));
  keys.push(key(78, { ...GUARD, hip: [0, -12], needle: 26 }, 'out'));
  keys.push(key(90, { ...GUARD, needle: -26 }, 'inout'));
  keys.push(key(102, { ...GUARD, hip: [0, -12], needle: 26 }, 'out'));
  keys.push(key(114, { ...GUARD, needle: -26 }, 'inout'));
  keys.push(key(120, { ...GUARD, needle: 0 }));
  return { keys };
}

// victory: conducts — the lead hand beats a 4/4 pattern, the key spins, the needle keeps time
function victory() {
  const base = g({ hip: [0, -6], tor: 4, head: 10, ab: [-60, 30, 40], ff: [24], fb: [-40] });
  const beats = [
    { af: [40, 100, 110], head: 12 }, // up
    { af: [-20, 10, 0], head: 4 }, // down (beat 1)
    { af: [10, 60, 60], head: 8 },
    { af: [-10, 150, 160], head: 8 }, // in (beat 2)
    { af: [20, 70, 70], head: 8 },
    { af: [30, 10, 10], head: 8 }, // out (beat 3)
    { af: [50, 80, 90], head: 10 },
    { af: [60, 110, 120], head: 14 }, // up (beat 4)
  ];
  const keys = [];
  beats.forEach((b, i) => keys.push(key(i * 12, { ...base, ...b, needle: i % 4 < 2 ? 26 : -26, scale: { key: [1, i % 2 ? 0.25 : 1] } }, i % 2 ? 'out' : 'in')));
  return { loop: true, length: 96, keys };
}

// defeat: winds down — slower, lower, the needle stops, and he slumps to his knees like a run-down toy
function defeat() {
  const kneel = { hip: [-6, -92], pel: 0, tor: -30, head: -50, af: [-100, -95, -95], ab: [-105, -100, -100], ff: [40], fb: [-30, 12], toeB: -60, needle: -60 };
  const keys = [
    key(0, { ...HURT, needle: 30 }, 'out'),
    key(14, { ...GUARD, hip: [0, -16], head: -6, needle: -24 }, 'inout'),
    key(34, { ...SLUMP, hip: [0, -20], head: -20, needle: 18 }, 'inout'),
    key(60, { ...SLUMP, hip: [0, -34], tor: -28, needle: -12 }, 'inout'),
    key(84, { ...kneel, hip: [-6, -80], head: -40, needle: 6 }, 'in'),
    key(96, kneel, 'out'),
    key(104, { ...kneel, hip: [-6, -95], head: -56, needle: -64 }, 'inout'),
    key(120, kneel),
  ];
  return { keys };
}

export const states = () => ({
  idle: idle(),
  walk_forward: walk(1),
  walk_back: walk(-1),
  crouch: crouch(),
  jump: jump(),
  block_high: block(BLOCK_H),
  block_low: block(BLOCK_L),
  hit: hit(),
  hit_low: hitLow(),
  hit_air: hitAir(),
  knockdown: knockdown(),
  getup: getup(),
  dash_forward: dash(1),
  dash_back: dash(-1),
  parry: parry(),
  throw: throwAnim(),
  thrown: thrown(),
  dizzy: dizzy(),
  intro: intro(),
  victory: victory(),
  defeat: defeat(),
});
