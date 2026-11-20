// Move looks for «Метроном»: names, animations, effects, sounds, commands.
import { key, mix } from './rig.mjs';
import { GUARD, CROUCH } from './states.mjs';

const BRASS = '#c9a13b';
const AMBER = '#ffb02e';
const HOT = '#ffe08a';
const TEAL = '#4fb3a9';
const g = (o) => ({ ...GUARD, ...o });
const c = (o) => ({ ...CROUCH, ...o });
const A = (keys) => ({ keys });

// ---------------- normals ----------------
function jab() {
  const chamber = g({ hip: [-2, -10], tor: -3, af: [-62, 60, 66], needle: 12 });
  const hitP = g({ hip: [8, -11], tor: -10, head: 0, af: [4, 2, 0], ab: [-74, 86, 90], ff: [38], needle: -22 });
  return {
    id: 'jab', name: 'Тик', command: 'LP',
    anim: A([key(0, GUARD, 'out'), key(2, chamber, 'out'), key(4, hitP, 'out'), key(7, hitP, 'inout'), key(15, GUARD)]),
    fx: [{ on: 'active', type: 'trail', bone: 'hand_front', color: BRASS, color2: HOT, size: 0.7, duration: 4 },
      { on: 'hit', type: 'sparks', bone: 'hand_front', color: AMBER, color2: HOT, count: 10, size: 0.7 }],
    sounds: { start: 'whoosh-light', hit: 'hit-light' },
  };
}

function low() {
  const chamber = c({ hip: [-4, -64], tor: -12, lf: [-20, -130], needle: 10 });
  const kick = c({ hip: [6, -62], tor: -6, head: 2, ff: [118, 26], toeF: -10, fb: [-40], needle: -24 });
  return {
    id: 'low', name: 'Нижняя нота', command: '2LK',
    anim: A([key(0, CROUCH, 'out'), key(4, chamber, 'in'), key(7, kick, 'out'), key(10, kick, 'inout'), key(22, CROUCH)]),
    fx: [{ on: 'active', type: 'trail', bone: 'foot_front', color: BRASS, color2: HOT, size: 0.8, duration: 4 },
      { on: 'hit', type: 'sparks', bone: 'foot_front', color: AMBER, count: 12, size: 0.8 }],
    sounds: { start: 'whoosh-light', hit: 'kick' },
  };
}

function knee() {
  const step = g({ hip: [10, -8], tor: -8, ff: [40], fb: [-40, 20], needle: 18 });
  const up = g({ hip: [14, 0], tor: 4, head: -4, lf: [16, -88], fb: [-30], af: [-30, -10, -20], ab: [-40, -20, -30], needle: -30 });
  return {
    id: 'knee', name: 'Синкопа', command: '6LK',
    anim: A([key(0, GUARD, 'out'), key(5, step, 'inout'), key(10, up, 'out'), key(13, up, 'inout'), key(20, mix(up, GUARD, 0.6), 'inout'), key(28, GUARD)]),
    fx: [{ on: 'active', type: 'trail', bone: 'thigh_front', color: BRASS, size: 0.9, duration: 4 },
      { on: 'hit', type: 'sparks', bone: 'thigh_front', color: AMBER, color2: HOT, count: 16, size: 1 }],
    sounds: { start: 'whoosh-light', hit: 'kick-heavy' },
  };
}

function heavy() {
  const wind = g({ hip: [-6, -12], tor: 4, head: 6, ab: [-110, 40, 40], af: [-60, 80, 86], needle: 30 });
  const hitP = g({ hip: [20, -16], tor: -18, head: -4, ab: [6, 3, 0], af: [-84, 92, 96], ff: [58], fb: [-50], needle: -34 });
  return {
    id: 'heavy', name: 'Сильная доля', command: 'HP',
    anim: A([key(0, GUARD, 'out'), key(8, wind, 'inout'), key(13, hitP, 'out'), key(17, hitP, 'inout'), key(27, mix(hitP, GUARD, 0.6), 'inout'), key(39, GUARD)]),
    fx: [{ on: 'active', type: 'trail', bone: 'hand_back', color: AMBER, color2: HOT, size: 1.1, duration: 5 },
      { on: 'hit', type: 'shockwave', color: AMBER, size: 1 },
      { on: 'hit', type: 'sparks', bone: 'hand_back', color: BRASS, color2: HOT, count: 22, size: 1.1 }],
    sounds: { start: 'whoosh-heavy', hit: 'hit-heavy' },
  };
}

function overhead() {
  const rise = g({ hip: [-4, -2], tor: 10, head: 14, af: [100, 135, 145], ab: [92, 125, 135], ff: [28], fb: [-48], needle: 40 });
  const peak = { ...rise, tor: 16, head: 18, af: [112, 150, 160], ab: [104, 140, 150], needle: 46 };
  const slam = g({ hip: [14, -22], tor: -26, head: -12, af: [8, -35, -45], ab: [-2, -45, -55], ff: [52], fb: [-52], needle: -50 });
  return {
    id: 'overhead', name: 'Маятник', command: '6HP',
    anim: A([key(0, GUARD, 'inout'), key(9, rise, 'inout'), key(17, peak, 'in'), key(20, slam, 'out'), key(24, slam, 'inout'), key(32, mix(slam, GUARD, 0.5), 'inout'), key(39, GUARD)]),
    fx: [{ on: 'start', type: 'glow', color: AMBER, size: 0.6, duration: 18 },
      { on: 'active', type: 'trail', bone: 'hand_front', color: AMBER, color2: HOT, size: 1.2, duration: 5 },
      { on: 'hit', type: 'shockwave', color: BRASS, size: 1.1 },
      { on: 'hit', type: 'sparks', bone: 'hand_front', color: AMBER, color2: HOT, count: 24, size: 1.1 }],
    sounds: { start: 'whoosh-heavy', hit: 'hit-heavy' },
  };
}

function sweep() {
  const drop = c({ hip: [-8, -80], tor: -10, head: 4, ab: [-120, -100, -100], ff: [40], fb: [-40], needle: 30 });
  const out = c({ hip: [-10, -84], tor: 4, head: 8, ab: [-140, -120, -100], af: [-40, 60, 70], ff: [128], toeF: 10, fb: [-44], needle: -45 });
  return {
    id: 'sweep', name: 'Ход маятника', command: '2HK',
    anim: A([key(0, CROUCH, 'out'), key(7, drop, 'in'), key(12, out, 'out'), key(16, out, 'inout'), key(30, mix(out, CROUCH, 0.6), 'inout'), key(42, CROUCH)]),
    fx: [{ on: 'active', type: 'trail', bone: 'foot_front', color: BRASS, color2: AMBER, size: 1.2, duration: 6 },
      { on: 'active', type: 'particles', bone: 'foot_front', color: HOT, count: 60, size: 0.5, duration: 6 },
      { on: 'hit', type: 'sparks', bone: 'foot_front', color: AMBER, count: 20, size: 1 }],
    sounds: { start: 'whoosh-heavy', hit: 'kick-heavy' },
  };
}

function upper() {
  const dip = g({ hip: [2, -24], tor: -14, head: 4, af: [-110, -30, -10], ff: [36], fb: [-50], needle: 30 });
  const top = g({ hip: [8, 0], tor: 8, head: 12, af: [80, 96, 100], ab: [-70, 84, 88], ff: [34], fb: [-44], toeB: -25, needle: -48 });
  return {
    id: 'upper', name: 'Взлёт стрелки', command: '6LP',
    anim: A([key(0, GUARD, 'out'), key(3, dip, 'in'), key(5, top, 'out'), key(10, top, 'inout'), key(22, mix(top, GUARD, 0.5), 'inout'), key(39, GUARD)]),
    fx: [{ on: 'active', type: 'trail', bone: 'hand_front', color: AMBER, color2: HOT, size: 1.2, duration: 7 },
      { on: 'hit', type: 'ring', color: AMBER, size: 0.9 },
      { on: 'hit', type: 'sparks', bone: 'hand_front', color: BRASS, color2: HOT, count: 22, size: 1.1 }],
    sounds: { start: 'whoosh-heavy', hit: 'hit-heavy' },
  };
}

function airKick() {
  const tuck = { hip: [0, 0], tor: -10, head: 0, af: [-20, 85, 90], ab: [-40, 92, 95], lf: [20, -100], lb: [-30, -140], needle: 25 };
  const kick = { hip: [0, 0], tor: 6, head: 4, af: [-50, 70, 80], ab: [-70, 80, 85], lf: [-30, -32], toeF: -40, lb: [-10, -150], needle: -30 };
  return {
    id: 'air_kick', name: 'Затакт', command: 'HK',
    anim: A([key(0, tuck, 'out'), key(6, kick, 'out'), key(13, kick, 'inout'), key(20, tuck)]),
    fx: [{ on: 'active', type: 'trail', bone: 'foot_front', color: BRASS, color2: HOT, size: 1, duration: 8 },
      { on: 'hit', type: 'sparks', bone: 'foot_front', color: AMBER, count: 16, size: 1 }],
    sounds: { start: 'whoosh-light', hit: 'kick' },
  };
}

// ---------------- specials ----------------
function fireball() {
  const wind = g({ hip: [-6, -14], tor: 6, head: 6, af: [-120, -40, -30], ab: [-130, -50, -40], ff: [30], fb: [-54], needle: 40 });
  const push = g({ hip: [12, -14], tor: -12, head: -2, af: [8, 10, 20], ab: [2, 6, 16], ff: [48], fb: [-52], needle: -40 });
  return {
    id: 'fireball', name: 'Шестерня темпа', command: '236P',
    anim: A([key(0, GUARD, 'inout'), key(9, wind, 'in'), key(13, push, 'out'), key(20, push, 'inout'), key(30, mix(push, GUARD, 0.6), 'inout'), key(37, GUARD)]),
    fx: [{ on: 'start', type: 'particles', bone: 'hand_front', color: AMBER, color2: HOT, count: 50, size: 0.6, duration: 13 },
      { on: 'active', type: 'ring', color: AMBER, size: 0.6 },
      { on: 'projectile', type: 'glow', image: 'art/shot.png', color: AMBER, color2: HOT, size: 1.1 },
      { on: 'hit', type: 'sparks', color: BRASS, color2: HOT, count: 24, size: 1 }],
    sounds: { start: 'whoosh-light', projectile: 'projectile', hit: 'projectile-hit' },
  };
}

function rush() {
  const crouchRun = g({ hip: [4, -26], tor: -30, head: 10, af: [-40, 60, 70], ab: [-140, -60, -50], ff: [48, 30], fb: [-52], needle: 40 });
  const stride = g({ hip: [8, -22], tor: -28, head: 10, af: [-120, -40, -30], ab: [-40, 60, 70], ff: [56], fb: [-30, 30], needle: -40 });
  const hitP = g({ hip: [24, -20], tor: -20, head: -2, af: [8, 4, 0], ab: [-84, 90, 94], ff: [62], fb: [-56], needle: -45 });
  return {
    id: 'rush', name: 'Крещендо', command: '[4]6P',
    anim: A([key(0, GUARD, 'out'), key(4, crouchRun, 'linear'), key(9, stride, 'linear'), key(14, crouchRun, 'in'), key(18, hitP, 'out'), key(22, hitP, 'inout'), key(34, mix(hitP, GUARD, 0.6), 'inout'), key(46, GUARD)]),
    fx: [{ on: 'start', type: 'afterimage', color: AMBER, count: 4, duration: 18 },
      { on: 'active', type: 'trail', bone: 'hand_front', color: AMBER, color2: HOT, size: 1.2, duration: 5 },
      { on: 'hit', type: 'shockwave', color: AMBER, size: 1.2 },
      { on: 'hit', type: 'sparks', bone: 'hand_front', color: BRASS, color2: HOT, count: 26, size: 1.2 }],
    sounds: { start: 'dash', active: 'whoosh-heavy', hit: 'hit-heavy' },
  };
}

function slide() {
  const drop = c({ hip: [0, -84], tor: -4, needle: 20 });
  const slideP = { hip: [10, -112], pel: 22, tor: 28, head: 24, af: [-30, 40, 50], ab: [-150, -140, -130], ff: [130], toeF: 30, fb: [10, 30], needle: -45 };
  return {
    id: 'slide', name: 'Глиссандо', command: '236K',
    anim: A([key(0, CROUCH, 'out'), key(6, drop, 'in'), key(12, slideP, 'out'), key(19, slideP, 'linear'), key(30, { ...slideP, needle: 30 }, 'inout'), key(40, mix(slideP, CROUCH, 0.7), 'inout'), key(47, CROUCH)]),
    fx: [{ on: 'start', type: 'afterimage', color: BRASS, count: 3, duration: 20 },
      { on: 'active', type: 'particles', bone: 'foot_back', color: HOT, color2: AMBER, count: 90, size: 0.5, duration: 14 },
      { on: 'active', type: 'trail', bone: 'foot_front', color: AMBER, size: 1, duration: 6 },
      { on: 'hit', type: 'sparks', bone: 'foot_front', color: AMBER, count: 20, size: 1 }],
    sounds: { start: 'dash', hit: 'kick-heavy' },
  };
}

function blink() {
  const coil = g({ hip: [-2, -22], tor: -14, head: -16, af: [-70, 100, 110], ab: [-80, 104, 110], needle: 50 });
  const gone = g({ hip: [0, -26], tor: -16, head: -20, af: [-74, 104, 112], ab: [-84, 108, 112], needle: -50, scale: { torso: [1, 0.9] } });
  const back = g({ hip: [0, -16], tor: -8, head: 4, needle: 30 });
  return {
    id: 'blink', name: 'Пропущенный такт', command: '214K',
    anim: A([key(0, GUARD, 'out'), key(8, coil, 'inout'), key(15, gone, 'in'), key(16, back, 'out'), key(24, GUARD)]),
    fx: [{ on: 'start', type: 'glow', color: AMBER, size: 0.8, duration: 16 },
      { on: 'start', type: 'particles', bone: 'torso', color: AMBER, color2: TEAL, count: 80, size: 0.6, duration: 16 },
      { on: 'active', type: 'ring', color: AMBER, size: 1 },
      { on: 'active', type: 'afterimage', color: AMBER, count: 3, duration: 8 }],
    sounds: { start: 'glitch', active: 'teleport-magic' },
  };
}

function flurry() {
  const F = g({ hip: [12, -12], tor: -12, af: [4, 2, 0], ab: [-80, 88, 92], ff: [44], needle: -30 });
  const B = g({ hip: [14, -13], tor: -16, af: [-70, 80, 86], ab: [4, 2, 0], ff: [44], needle: 30 });
  const chamber = g({ hip: [2, -12], tor: -4, af: [-64, 62, 68], ab: [-74, 70, 76], needle: 20 });
  return {
    id: 'flurry', name: 'Трель', command: '214P',
    anim: A([key(0, GUARD, 'out'), key(5, chamber, 'in'), key(9, F, 'out'), key(12, B, 'out'), key(15, F, 'out'), key(18, B, 'out'), key(21, F, 'out'), key(28, mix(F, GUARD, 0.5), 'inout'), key(41, GUARD)]),
    fx: [{ on: 'active', type: 'trail', bone: 'hand_front', color: BRASS, color2: HOT, size: 0.8, duration: 12 },
      { on: 'active', type: 'trail', bone: 'hand_back', color: AMBER, color2: HOT, size: 0.8, duration: 12 },
      { on: 'hit', type: 'sparks', color: AMBER, color2: HOT, count: 10, size: 0.7 }],
    sounds: { start: 'whoosh-light', hit: 'hit-light' },
  };
}

function cyclone() {
  // a flywheel spin: arms out like spokes, the torso narrows as it turns (faked with across-scale)
  const wind = g({ hip: [-4, -18], tor: 6, head: 8, af: [-150, -120, -110], ab: [20, 10, 0], needle: 40 });
  const s = (t, frontOut, narrow) => key(t, g({
    hip: [10 + t * 0.4, -14], tor: frontOut ? -8 : 0, head: frontOut ? 0 : 6,
    af: frontOut ? [6, 4, 0] : [-170, -175, -180], ab: frontOut ? [-170, -175, -180] : [4, 2, 0],
    ff: [40], fb: [-44], needle: frontOut ? -45 : 45,
    scale: { torso: [1, narrow], pelvis: [1, narrow], head: [1, 0.8 + narrow * 0.2] },
  }), 'linear');
  return {
    id: 'cyclone', name: 'Маховик', command: '623K',
    anim: A([key(0, GUARD, 'out'), key(8, wind, 'in'), s(12, true, 1), s(14, false, 0.45), s(16, true, 1), s(18, false, 0.45), s(20, true, 1), s(23, false, 0.6),
      key(32, mix(GUARD, wind, 0.2), 'inout'), key(47, GUARD)]),
    fx: [{ on: 'active', type: 'trail', bone: 'hand_front', color: AMBER, color2: HOT, size: 1.2, duration: 9 },
      { on: 'active', type: 'trail', bone: 'hand_back', color: BRASS, color2: HOT, size: 1.2, duration: 9 },
      { on: 'active', type: 'afterimage', color: AMBER, count: 3, duration: 10 },
      { on: 'hit', type: 'ring', color: AMBER, size: 0.8 },
      { on: 'hit', type: 'sparks', color: BRASS, color2: HOT, count: 14, size: 0.9 }],
    sounds: { start: 'whoosh-heavy', active: 'whip', hit: 'hit-heavy' },
  };
}

// ---------------- super ----------------
function finale() {
  // the conductor's last gesture: baton up — downbeat strike with both fists — cut-off with arms spread
  const baton = g({ hip: [-6, -8], tor: 8, head: 14, af: [92, 108, 112], ab: [140, 165, 170], ff: [28], fb: [-50], needle: 50, scale: { key: [1, 0.25] } });
  const strike = g({ hip: [28, -22], tor: -24, head: -6, af: [4, 0, 0], ab: [0, -4, -4], ff: [66], fb: [-56], needle: -50, scale: { key: [1, 1] } });
  const cutoff = g({ hip: [18, -8], tor: 6, head: 18, af: [60, 110, 120], ab: [140, 110, 100], ff: [56], fb: [-52], needle: 0, scale: { key: [1, 0.25] } });
  return {
    id: 'finale', name: 'Финальный аккорд', command: '236236P',
    anim: A([key(0, baton, 'inout'), key(5, { ...baton, tor: 12, af: [110, 135, 140] }, 'in'), key(8, strike, 'out'), key(13, strike, 'inout'),
      key(22, cutoff, 'out'), key(34, { ...cutoff, scale: { key: [1, 1] } }, 'inout'), key(48, GUARD)]),
    fx: [{ on: 'start', type: 'glow', color: AMBER, color2: HOT, size: 1.4, duration: 14 },
      { on: 'start', type: 'particles', bone: 'torso', color: HOT, color2: AMBER, count: 120, size: 0.8, duration: 14 },
      { on: 'active', type: 'trail', bone: 'hand_front', color: AMBER, color2: HOT, size: 1.6, duration: 6 },
      { on: 'active', type: 'trail', bone: 'hand_back', color: BRASS, color2: HOT, size: 1.4, duration: 6 },
      { on: 'active', type: 'afterimage', color: AMBER, count: 4, duration: 8 },
      { on: 'hit', type: 'flash', color: '#ffd27a', duration: 6 },
      { on: 'hit', type: 'shockwave', color: AMBER, size: 2.2 },
      { on: 'hit', type: 'ring', color: HOT, size: 2 },
      { on: 'hit', type: 'sparks', color: BRASS, color2: HOT, count: 60, size: 1.6 }],
    sounds: { start: 'riser', active: 'whoosh-heavy', hit: 'impact-epic' },
    director: { title: 'ФИНАЛЬНЫЙ АККОРД', titleColor: '#ffb02e', line: 'super_1', zoom: 1.6, angle: 'high', flash: '#ffd27a', background: 'color', backgroundColor: '#1a0f06', slowmo: 0.5 },
  };
}

export const moves = () => [jab(), low(), knee(), heavy(), overhead(), sweep(), upper(), airKick(), fireball(), slide(), rush(), flurry(), cyclone(), blink(), finale()];

// ---------------- spare specials (for anims-spare.json) ----------------
function retreat() {
  const lean = g({ hip: [-12, -14], tor: 8, head: 8, ff: [20], fb: [-64], needle: -40 });
  return {
    id: 'retreat', name: 'Ритардандо', command: '[6]4P',
    anim: A([key(0, GUARD, 'out'), key(6, lean, 'in'), key(10, { ...lean, needle: 40 }, 'out'), key(18, GUARD)]),
    fx: [{ on: 'start', type: 'afterimage', color: AMBER, count: 3, duration: 10 }, { on: 'active', type: 'ring', color: AMBER, size: 0.8 }],
    sounds: { start: 'glitch', active: 'teleport' },
  };
}
function twin() {
  const jabP = g({ hip: [10, -12], tor: -10, af: [4, 2, 0], ab: [-74, 86, 90], ff: [40], needle: -26 });
  const lowP = g({ hip: [6, -30], tor: -10, ff: [112, 30], toeF: -10, fb: [-46], needle: 26 });
  return {
    id: 'twin', name: 'Двудольник', command: '623P',
    anim: A([key(0, GUARD, 'out'), key(5, mix(GUARD, jabP, 0.3), 'in'), key(8, jabP, 'out'), key(12, jabP, 'inout'), key(19, mix(GUARD, lowP, 0.4), 'in'), key(23, lowP, 'out'), key(27, lowP, 'inout'), key(40, mix(lowP, GUARD, 0.7), 'inout'), key(48, GUARD)]),
    fx: [{ on: 'active', type: 'trail', bone: 'hand_front', color: BRASS, size: 0.8, duration: 4 }, { on: 'hit', type: 'sparks', color: AMBER, count: 12, size: 0.8 }],
    sounds: { start: 'whoosh-light', hit: 'hit-light' },
  };
}
function lance() {
  const cock = g({ hip: [-2, -10], tor: 2, af: [-40, 120, 130], needle: 30 });
  const flick = g({ hip: [8, -12], tor: -10, af: [10, 6, 0], ab: [-74, 86, 90], needle: -40 });
  return {
    id: 'lance', name: 'Стрелка', command: '41236P',
    anim: A([key(0, GUARD, 'out'), key(6, cock, 'in'), key(9, flick, 'out'), key(14, flick, 'inout'), key(29, GUARD)]),
    fx: [{ on: 'projectile', type: 'glow', image: 'art/shot.png', color: AMBER, size: 0.7 }, { on: 'active', type: 'ring', color: AMBER, size: 0.4 }, { on: 'hit', type: 'sparks', color: AMBER, count: 12 }],
    sounds: { start: 'whoosh-light', projectile: 'projectile', hit: 'projectile-hit' },
  };
}
function spike() {
  const up = g({ hip: [-4, -6], tor: 8, head: 10, af: [120, 150, 160], needle: 40 });
  const hurl = g({ hip: [10, -14], tor: -12, af: [20, 20, 20], ab: [-74, 86, 90], ff: [44], needle: -40 });
  return {
    id: 'spike', name: 'Высокая нота', command: '22P',
    anim: A([key(0, GUARD, 'out'), key(8, up, 'in'), key(12, hurl, 'out'), key(18, hurl, 'inout'), key(34, GUARD)]),
    fx: [{ on: 'projectile', type: 'glow', image: 'art/shot.png', color: HOT, size: 0.9 }, { on: 'active', type: 'ring', color: HOT, size: 0.5 }, { on: 'hit', type: 'sparks', color: AMBER, count: 18 }],
    sounds: { start: 'whoosh-light', projectile: 'projectile', hit: 'projectile-hit' },
  };
}
function dive() {
  const tuck = { hip: [0, 0], tor: -14, head: -4, af: [-20, 85, 90], ab: [-40, 92, 95], lf: [20, -100], lb: [-30, -140], needle: 30 };
  const stomp = { hip: [0, 0], tor: -4, head: -8, af: [60, 100, 110], ab: [40, 90, 100], lf: [-50, -60], toeF: -60, lb: [-20, -140], needle: -45 };
  return {
    id: 'dive', name: 'Падение гири', command: '22K',
    anim: A([key(0, tuck, 'out'), key(5, stomp, 'out'), key(14, stomp, 'inout'), key(23, tuck)]),
    fx: [{ on: 'active', type: 'trail', bone: 'foot_front', color: AMBER, color2: HOT, size: 1.2, duration: 10 }, { on: 'hit', type: 'shockwave', color: BRASS, size: 1 }, { on: 'hit', type: 'sparks', color: AMBER, count: 18 }],
    sounds: { start: 'whoosh-heavy', hit: 'kick-heavy' },
  };
}
function smash() {
  const coil = g({ hip: [-8, -16], tor: 10, head: 6, ab: [-150, -60, -50], af: [-60, 80, 86], needle: 45, scale: { key: [1, 0.25] } });
  const hitP = g({ hip: [22, -18], tor: -20, head: -4, ab: [6, 3, 0], af: [-84, 92, 96], ff: [60], fb: [-52], needle: -45, scale: { key: [1, 1] } });
  return {
    id: 'smash', name: 'Бой курантов', command: '[2]8P',
    anim: A([key(0, GUARD, 'out'), key(8, coil, 'inout'), key(12, hitP, 'out'), key(16, hitP, 'inout'), key(28, mix(hitP, GUARD, 0.6), 'inout'), key(40, GUARD)]),
    fx: [{ on: 'start', type: 'glow', color: AMBER, size: 0.9 }, { on: 'active', type: 'trail', bone: 'hand_back', color: AMBER, color2: HOT, size: 1.3, duration: 5 }, { on: 'hit', type: 'shockwave', color: AMBER, size: 1.4 }, { on: 'hit', type: 'sparks', color: BRASS, color2: HOT, count: 30, size: 1.2 }],
    sounds: { start: 'bass-hit', hit: 'hit-heavy' },
  };
}
function ram() {
  const brace = g({ hip: [-4, -22], tor: -24, head: -10, af: [-20, 60, 70], ab: [-40, 70, 80], ff: [36], fb: [-60], needle: 40 });
  const hitP = g({ hip: [24, -20], tor: -30, head: -12, af: [0, 50, 60], ab: [-20, 60, 70], ff: [62], fb: [-58], needle: -45 });
  return {
    id: 'ram', name: 'Таран маховика', command: '[4]6K',
    anim: A([key(0, GUARD, 'out'), key(10, brace, 'inout'), key(18, hitP, 'out'), key(22, hitP, 'inout'), key(36, mix(hitP, GUARD, 0.6), 'inout'), key(48, GUARD)]),
    fx: [{ on: 'start', type: 'glow', color: TEAL, color2: BRASS, size: 1, duration: 18 }, { on: 'hit', type: 'shockwave', color: BRASS, size: 1.3 }, { on: 'hit', type: 'sparks', color: AMBER, count: 26 }],
    sounds: { start: 'bass-hit', hit: 'hit-heavy' },
  };
}
function breaker() {
  const lift = g({ hip: [-6, -4], tor: 14, head: 16, af: [130, 170, 175], ab: [120, 160, 170], needle: 50 });
  const slam = g({ hip: [16, -28], tor: -36, head: -16, af: [-30, -55, -65], ab: [-40, -65, -75], ff: [54], fb: [-54], needle: -50 });
  return {
    id: 'breaker', name: 'Молот часовщика', command: 'KK',
    anim: A([key(0, GUARD, 'out'), key(10, lift, 'inout'), key(20, { ...lift, tor: 18, af: [140, 185, 190] }, 'in'), key(24, slam, 'out'), key(28, slam, 'inout'), key(42, mix(slam, GUARD, 0.6), 'inout'), key(54, GUARD)]),
    fx: [{ on: 'start', type: 'glow', color: TEAL, color2: BRASS, size: 1.1, duration: 24 }, { on: 'active', type: 'trail', bone: 'hand_front', color: AMBER, size: 1.3, duration: 5 }, { on: 'hit', type: 'shockwave', color: AMBER, size: 1.6 }, { on: 'hit', type: 'sparks', color: BRASS, color2: HOT, count: 34, size: 1.3 }],
    sounds: { start: 'whoosh-heavy', hit: 'kick-heavy' },
  };
}
export const spare = () => [retreat(), twin(), lance(), spike(), dive(), smash(), ram(), breaker()];
