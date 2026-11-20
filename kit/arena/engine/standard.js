// Ring 4: one kit for everyone. The ring gives every fighter the same stats and the same moves; a fighter brings only
// its look (names, animations, effects, sounds, lines, the super's direction) and its brains. The fight is decided by
// the brains alone, as in a tank benchmark where every tank is the same machine.
//
// Why: in ring 3 a fighter was built from priced blocks, and every pilot league was won by the build that found the
// cheapest hole in the price list (pilots v1–v4, docs/v3/pilot.md). A hole in a shared kit gives nobody an edge: the
// opponent has the same move.
//
// 'standard' — the kit below (the default); 'free' — the constructor of ring 3 (its tests, old matches, show mode).
let ruleset = 'standard';
export const setRuleset = (r) => {
  if (r !== 'standard' && r !== 'free') throw new Error(`ruleset: standard | free, не ${r}`);
  ruleset = r;
};
export const getRuleset = () => ruleset;

export const STANDARD_STATS = Object.freeze({ health: 3, power: 3, speed: 3, defense: 3 });

// Damage scales of the kit. Move damage is written against a health of 1000; in a fight the health is ×hpMul, a super
// hits ×superMul and a throw ×throwMul. Ring 3 had ×10 / ×9 / ×6: an ordinary hit took at most 0.8 % of the health and
// a fight was decided by throws and supers alone. Here a heavy strike takes 3 %, a throw 4.5 %, a super up to 25 %
// (pilot 4.0: at ×1.7 a throw gave a contestant 37 % of its damage; at a health of ×2 four contestants' fights
// lasted 109 s and 30 % of them went to time, so the health is ×1.8).
export const STANDARD_SCALE = Object.freeze({ hpMul: 1.8, superMul: 1.8, throwMul: 1.3, meterGain: 0.25 });

// Stage objects of ring 4 (a fight of two fighters of the kit): things standing on the stage that a fighter can grab
// and hurl at the opponent, as the interactables of Injustice and Mortal Kombat. Two a round, mirrored around the
// centre of the ring at a distance drawn from the fight's seed, so neither side is closer to its own. A fighter free on
// the ground within `reach` of an object uses it (action `use`): `startup` ticks of the grab — a hit interrupts it and
// the object stays — then the object flies at the opponent as a fast projectile of `damage`; `total` ticks in all.
// It is blocked, parried and jumped like any projectile and does not take the fighter's own projectile slot.
export const ARENA = Object.freeze({
  // from: usable from this tick — on some starts a fighter stands right at an object, and tick 0 would be a coin toss
  objects: { count: 2, from: 300, near: 300, far: 780, reach: 70, startup: 16, total: 30, damage: 80, speed: 13 },
  // a parry pays this much of the super meter (ring 3: 20 — parrying a spammed shot fed a super every 15 parries)
  parryMeter: 12,
});

// default poses of the kit's animations: bone angles on the ring's skeleton, so they fit any body
const LEGS = { thigh_front: 28, shin_front: -38, foot_front: 10, thigh_back: -18, shin_back: -14, foot_back: 32 };
const LEGS_LOW = { thigh_front: 80, shin_front: -120, foot_front: 40, thigh_back: 60, shin_back: -125, foot_back: 65 };
const GUARD_ARMS = { upper_arm_front: 55, forearm_front: 105, upper_arm_back: 35, forearm_back: 115 };
const P = {
  stance: { root: [0, -8], bones: { torso: -8, head: 6, ...LEGS, ...GUARD_ARMS } },
  ready: { root: [0, -10], bones: { torso: -4, head: 6, ...LEGS, upper_arm_front: 45, forearm_front: 115, upper_arm_back: 35, forearm_back: 115 } },
  punch: { root: [10, -12], bones: { torso: -16, head: 8, ...LEGS, thigh_back: -26, upper_arm_front: 103, forearm_front: 0, upper_arm_back: 15, forearm_back: 120 } },
  windup: { root: [-8, -16], bones: { torso: 14, head: 0, ...LEGS, upper_arm_front: -20, forearm_front: 90, upper_arm_back: -30, forearm_back: 100 } },
  heavy: { root: [22, -18], bones: { torso: -26, head: 12, ...LEGS, thigh_front: 40, shin_front: -46, thigh_back: -34, upper_arm_front: 50, forearm_front: 110, upper_arm_back: 116, forearm_back: 0 } },
  crouch: { root: [0, -72], bones: { torso: -15, head: 10, ...LEGS_LOW, ...GUARD_ARMS } },
  low: { root: [6, -76], bones: { torso: 6, head: 4, ...LEGS_LOW, thigh_front: 86, shin_front: -4, foot_front: 20, ...GUARD_ARMS } },
  sweep: { root: [14, -86], bones: { torso: 24, head: -6, ...LEGS_LOW, thigh_front: 92, shin_front: 0, foot_front: 10, upper_arm_front: -30, forearm_front: 20, upper_arm_back: -50, forearm_back: 30 } },
  raise: { root: [0, -4], bones: { torso: 4, head: -4, ...LEGS, upper_arm_front: 190, forearm_front: 10, upper_arm_back: 35, forearm_back: 115 } },
  chop: { root: [12, -16], bones: { torso: -24, head: 12, ...LEGS, upper_arm_front: 80, forearm_front: 6, upper_arm_back: 15, forearm_back: 120 } },
  dip: { root: [0, -40], bones: { torso: -18, head: 10, ...LEGS, thigh_front: 55, shin_front: -80, thigh_back: 30, shin_back: -80, upper_arm_front: 10, forearm_front: 100, upper_arm_back: 35, forearm_back: 115 } },
  upper: { root: [8, 14], bones: { torso: 6, head: -10, thigh_front: 10, shin_front: -10, foot_front: 40, thigh_back: -10, shin_back: -6, foot_back: 50, upper_arm_front: 170, forearm_front: 8, upper_arm_back: 0, forearm_back: 110 } },
  kneeup: { root: [14, 0], bones: { torso: -6, head: 4, thigh_front: 95, shin_front: -110, foot_front: 20, thigh_back: -20, shin_back: -8, foot_back: 40, ...GUARD_ARMS } },
  airkick: { root: [0, 0], bones: { torso: 12, head: -4, thigh_front: 60, shin_front: -8, foot_front: 20, thigh_back: 60, shin_back: -110, foot_back: 40, ...GUARD_ARMS } },
  cast: { root: [10, -14], bones: { torso: -14, head: 8, ...LEGS, thigh_back: -26, upper_arm_front: 98, forearm_front: 0, upper_arm_back: 96, forearm_back: 0 } },
  vanish: { root: [0, -30], bones: { torso: -20, head: 14, ...LEGS, thigh_front: 50, shin_front: -70, upper_arm_front: 70, forearm_front: 90, upper_arm_back: 60, forearm_back: 100 } },
};
const keys = (...ks) => ({ keys: ks.map(([t, pose, ease]) => ({ t, pose: P[pose], ...(ease ? { ease } : {}) })) });

// The kit. `blocks`, `slot` and `posture` are the mechanics and belong to the ring; `name` and `anim` here are defaults
// a fighter replaces with its own. Every number below is the same for both fighters of every fight.
//
// How it is meant to play (reaction is 15 ticks; a strike faster than that is blocked only on a read):
//   jab       fast and safe, starts a series, short reach;
//   low       fast low poke, beats a high guard;
//   knee      steps in and strikes: the approach;
//   heavy     long reach and damage, a miss is punished;
//   overhead  beats a low guard; slow enough to be blocked on sight — it lands on a read or on a distracted brain;
//   sweep     long low strike that knocks down; blocked — punished;
//   upper     anti-air and series ender with a launch; misses a crouching opponent, long recovery;
//   air_kick  the jump-in;
//   fireball  controls space, wounds through a block; a blink, a slide or a jump punishes it;
//   wave      slow low projectile to walk behind; blocked low or jumped;
//   rush      crosses 280 units and strikes; visible, punished on block;
//   slide     crosses 200 units low and knocks down; blocked — punished hard;
//   blink     behind the opponent's back; on sight a jab stops it;
//   ram       takes one hit on its armour and strikes through; a throw or two hits stop it;
//   smash     held up to 40 ticks, up to ×1.5: the release time is the attacker's — the answer to a parry on sight;
//   finale    the super: invulnerable startup, a quarter of the health on a clean hit, a gift if blocked.
export const STANDARD_MOVES = [
  { id: 'jab', name: 'Джеб', slot: 'normal', posture: 'stand',
    blocks: [{ type: 'strike', startup: 4, active: 3, recovery: 8, damage: 25, reach: 'short', zone: 'mid' }],
    anim: keys([0, 'stance'], [2, 'ready'], [4, 'punch', 'hold'], [7, 'punch'], [15, 'stance']) },
  { id: 'low', name: 'Подсечка', slot: 'normal', posture: 'crouch',
    blocks: [{ type: 'strike', startup: 7, active: 3, recovery: 12, damage: 35, reach: 'mid', zone: 'low' }],
    anim: keys([0, 'crouch'], [7, 'low', 'hold'], [10, 'low'], [22, 'crouch']) },
  { id: 'knee', name: 'Колено', slot: 'normal', posture: 'stand',
    blocks: [{ type: 'strike', startup: 10, active: 3, recovery: 15, damage: 45, reach: 'short', zone: 'mid', advance: 90 }],
    anim: keys([0, 'stance'], [6, 'dip'], [10, 'kneeup', 'hold'], [13, 'kneeup'], [28, 'stance']) },
  { id: 'heavy', name: 'Прямой', slot: 'normal', posture: 'stand',
    blocks: [{ type: 'strike', startup: 13, active: 4, recovery: 22, damage: 65, reach: 'long', zone: 'mid', push: 'heavy' }],
    anim: keys([0, 'stance'], [9, 'windup'], [13, 'heavy', 'hold'], [17, 'heavy'], [39, 'stance']) },
  { id: 'overhead', name: 'Сверху', slot: 'normal', posture: 'stand',
    blocks: [{ type: 'strike', startup: 20, active: 3, recovery: 16, damage: 60, reach: 'mid', zone: 'overhead' }],
    anim: keys([0, 'stance'], [14, 'raise'], [20, 'chop', 'hold'], [23, 'chop'], [39, 'stance']) },
  { id: 'sweep', name: 'Круговая', slot: 'normal', posture: 'crouch',
    blocks: [{ type: 'strike', startup: 12, active: 4, recovery: 26, damage: 55, reach: 'long', zone: 'low', launch: true }],
    anim: keys([0, 'crouch'], [12, 'sweep', 'hold'], [16, 'sweep'], [42, 'crouch']) },
  { id: 'upper', name: 'Апперкот', slot: 'normal', posture: 'stand',
    blocks: [{ type: 'strike', startup: 5, active: 6, recovery: 28, damage: 70, reach: 'short', zone: 'high', launch: true }],
    anim: keys([0, 'stance'], [3, 'dip'], [5, 'upper', 'hold'], [11, 'upper'], [39, 'stance']) },
  { id: 'air_kick', name: 'Удар в прыжке', slot: 'normal', posture: 'air',
    blocks: [{ type: 'strike', startup: 6, active: 8, recovery: 6, damage: 50, reach: 'mid', zone: 'air' }],
    anim: keys([0, 'airkick'], [6, 'airkick', 'hold'], [20, 'airkick']) },
];

// The pool of specials: a fighter takes LOADOUT.specials of them. The same numbers for whoever takes a move.
//   spike    fast high projectile: stops jumps and standing opponents, a crouch ducks it;
//   retreat  300 units back: out of pressure, into range for projectiles;
//   flurry   four hits in a row: builds the guard gauge and the meter, low damage;
//   dive     in a jump: a heavy strike down that knocks down;
//   cross    behind the back and a strike at once; visible, punished on block;
//   twin     a mid strike, then a low one: the second beats a high guard held after the first;
//   breaker  two hits of armour and a slow overhead of 80: beats a low guard and trades through pokes; a throw stops it;
//   cyclone  spins forward 120 units, three hits, launches;
//   lance    a quick weak shot: interrupts at range.
export const SPECIAL_POOL = [
  { id: 'fireball', name: 'Снаряд', slot: 'special', posture: 'stand',
    blocks: [{ type: 'projectile', startup: 13, recovery: 24, damage: 50, speed: 'mid', zone: 'mid' }],
    anim: keys([0, 'stance'], [10, 'windup'], [13, 'cast', 'hold'], [20, 'cast'], [38, 'stance']) },
  { id: 'wave', name: 'Волна', slot: 'special', posture: 'crouch',
    blocks: [{ type: 'projectile', startup: 16, recovery: 26, damage: 40, speed: 'slow', zone: 'low' }],
    anim: keys([0, 'crouch'], [16, 'low', 'hold'], [24, 'low'], [43, 'crouch']) },
  { id: 'rush', name: 'Рывок с ударом', slot: 'special', posture: 'stand',
    blocks: [{ type: 'strike', startup: 18, active: 4, recovery: 24, damage: 60, reach: 'mid', zone: 'mid', push: 'heavy', advance: 280 }],
    anim: keys([0, 'stance'], [5, 'windup'], [18, 'heavy', 'hold'], [22, 'heavy'], [46, 'stance']) },
  { id: 'slide', name: 'Подкат', slot: 'special', posture: 'crouch',
    blocks: [{ type: 'strike', startup: 14, active: 5, recovery: 28, damage: 50, reach: 'mid', zone: 'low', launch: true, advance: 200 }],
    anim: keys([0, 'crouch'], [4, 'sweep', 'hold'], [19, 'sweep'], [47, 'crouch']) },
  { id: 'blink', name: 'За спину', slot: 'special', posture: 'stand',
    blocks: [{ type: 'teleport', startup: 16, recovery: 8, to: 'behind' }],
    anim: keys([0, 'stance'], [10, 'vanish'], [16, 'vanish'], [24, 'stance']) },
  { id: 'ram', name: 'Таран', slot: 'special', posture: 'stand',
    blocks: [{ type: 'armor', hits: 1 }, { type: 'strike', startup: 18, active: 4, recovery: 26, damage: 70, reach: 'mid', zone: 'mid', push: 'heavy', advance: 60 }],
    anim: keys([0, 'stance'], [10, 'vanish'], [18, 'heavy', 'hold'], [22, 'heavy'], [48, 'stance']) },
  { id: 'smash', name: 'Замах', slot: 'special', posture: 'stand',
    blocks: [{ type: 'charge', maxHold: 40, bonus: 0.5 }, { type: 'strike', startup: 12, active: 4, recovery: 24, damage: 53, reach: 'long', zone: 'mid', push: 'heavy' }],
    anim: keys([0, 'stance'], [11, 'raise', 'hold'], [12, 'chop', 'hold'], [16, 'chop'], [40, 'stance']) },
  { id: 'spike', name: 'Верхний снаряд', slot: 'special', posture: 'stand',
    blocks: [{ type: 'projectile', startup: 12, recovery: 22, damage: 55, speed: 'fast', zone: 'high' }],
    anim: keys([0, 'stance'], [9, 'raise'], [12, 'cast', 'hold'], [18, 'cast'], [35, 'stance']) },
  { id: 'retreat', name: 'Отход', slot: 'special', posture: 'stand',
    blocks: [{ type: 'teleport', startup: 10, recovery: 8, to: 'back', distance: 300 }],
    anim: keys([0, 'stance'], [6, 'vanish'], [10, 'vanish'], [18, 'stance']) },
  { id: 'flurry', name: 'Серия', slot: 'special', posture: 'stand',
    blocks: [{ type: 'strike', startup: 9, active: 12, recovery: 20, damage: 20, hits: 4, reach: 'mid', zone: 'mid' }],
    anim: keys([0, 'stance'], [9, 'punch'], [12, 'ready'], [15, 'punch'], [18, 'ready'], [21, 'punch', 'hold'], [24, 'punch'], [41, 'stance']) },
  { id: 'dive', name: 'Пике', slot: 'special', posture: 'air',
    blocks: [{ type: 'strike', startup: 5, active: 10, recovery: 8, damage: 70, reach: 'mid', zone: 'air', launch: true }],
    anim: keys([0, 'airkick'], [5, 'airkick', 'hold'], [23, 'airkick']) },
  { id: 'cross', name: 'Удар со спины', slot: 'special', posture: 'stand',
    blocks: [{ type: 'teleport', startup: 14, recovery: 4, to: 'behind' }, { type: 'strike', startup: 8, active: 4, recovery: 24, damage: 55, reach: 'mid', zone: 'mid' }],
    anim: keys([0, 'stance'], [8, 'vanish'], [18, 'windup'], [26, 'punch', 'hold'], [30, 'punch'], [54, 'stance']) },
  { id: 'twin', name: 'Двойка', slot: 'special', posture: 'stand',
    blocks: [{ type: 'strike', startup: 8, active: 3, recovery: 6, damage: 30, reach: 'mid', zone: 'mid' }, { type: 'strike', startup: 6, active: 3, recovery: 22, damage: 40, reach: 'mid', zone: 'low' }],
    anim: keys([0, 'stance'], [8, 'punch', 'hold'], [11, 'punch'], [17, 'crouch'], [23, 'low', 'hold'], [26, 'low'], [48, 'stance']) },
  { id: 'breaker', name: 'Пролом', slot: 'special', posture: 'stand',
    blocks: [{ type: 'armor', hits: 2 }, { type: 'strike', startup: 24, active: 4, recovery: 26, damage: 80, reach: 'mid', zone: 'overhead' }],
    anim: keys([0, 'stance'], [16, 'raise', 'hold'], [24, 'chop', 'hold'], [28, 'chop'], [54, 'stance']) },
  { id: 'cyclone', name: 'Вихрь', slot: 'special', posture: 'stand',
    blocks: [{ type: 'strike', startup: 12, active: 9, recovery: 26, damage: 25, hits: 3, reach: 'mid', zone: 'mid', launch: true, advance: 120 }],
    anim: keys([0, 'stance'], [6, 'windup'], [12, 'heavy'], [15, 'windup'], [18, 'heavy'], [21, 'heavy', 'hold'], [47, 'stance']) },
  { id: 'lance', name: 'Быстрый снаряд', slot: 'special', posture: 'stand',
    blocks: [{ type: 'projectile', startup: 9, recovery: 20, damage: 30, speed: 'fast', zone: 'mid' }],
    anim: keys([0, 'stance'], [6, 'ready'], [9, 'punch', 'hold'], [14, 'punch'], [30, 'stance']) },
];

// The supers: a fighter takes one. Each needs the full meter and takes at most a quarter of the health.
//   finale   one long strike, launches;
//   barrage  a fast projectile of three hits across the ring;
//   storm    five hits up close, the fastest startup;
//   ambush   behind the back and a strike;
//   rampage  crosses 300 units with five hits;
//   meteor   from a jump: one strike down.
export const SUPER_POOL = [
  { id: 'finale', name: 'Финал', slot: 'super', posture: 'stand',
    blocks: [{ type: 'strike', startup: 8, active: 6, recovery: 34, damage: 250, reach: 'long', zone: 'mid', launch: true }],
    anim: keys([0, 'stance'], [5, 'windup'], [8, 'heavy', 'hold'], [14, 'heavy'], [48, 'stance']) },
  { id: 'barrage', name: 'Залп', slot: 'super', posture: 'stand',
    blocks: [{ type: 'projectile', startup: 10, recovery: 30, damage: 83, hits: 3, speed: 'fast', zone: 'mid' }],
    anim: keys([0, 'stance'], [7, 'windup'], [10, 'cast', 'hold'], [22, 'cast'], [41, 'stance']) },
  { id: 'storm', name: 'Шторм', slot: 'super', posture: 'stand',
    blocks: [{ type: 'strike', startup: 5, active: 10, recovery: 30, damage: 50, hits: 5, reach: 'mid', zone: 'mid' }],
    anim: keys([0, 'stance'], [5, 'punch'], [7, 'ready'], [9, 'punch'], [11, 'ready'], [13, 'heavy', 'hold'], [15, 'heavy'], [45, 'stance']) },
  { id: 'ambush', name: 'Засада', slot: 'super', posture: 'stand',
    blocks: [{ type: 'teleport', startup: 10, recovery: 4, to: 'behind' }, { type: 'strike', startup: 6, active: 5, recovery: 34, damage: 250, reach: 'mid', zone: 'mid', launch: true }],
    anim: keys([0, 'stance'], [6, 'vanish'], [14, 'windup'], [20, 'heavy', 'hold'], [25, 'heavy'], [59, 'stance']) },
  { id: 'rampage', name: 'Напролом', slot: 'super', posture: 'stand',
    blocks: [{ type: 'strike', startup: 10, active: 10, recovery: 34, damage: 50, hits: 5, reach: 'mid', zone: 'mid', advance: 300 }],
    anim: keys([0, 'stance'], [4, 'windup'], [10, 'heavy'], [13, 'punch'], [16, 'heavy'], [19, 'heavy', 'hold'], [54, 'stance']) },
  { id: 'meteor', name: 'Метеор', slot: 'super', posture: 'air',
    blocks: [{ type: 'strike', startup: 6, active: 10, recovery: 10, damage: 250, reach: 'mid', zone: 'air', launch: true }],
    anim: keys([0, 'airkick'], [6, 'airkick', 'hold'], [26, 'airkick']) },
];

export const LOADOUT = Object.freeze({ specials: 6, supers: 1 });
export const KIT_MOVES = [...STANDARD_MOVES, ...SPECIAL_POOL, ...SUPER_POOL];


const LOOK_KEYS = ['name', 'anim', 'fx', 'line', 'director', 'command', 'sounds'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// moves.json of a fighter in ring 4 holds its choice and its look: the specials and the super it takes from the pools,
// and names, animations, effects, sounds of every move it has. The basic moves (STANDARD_MOVES) every fighter has.
// Returns the raw moves the checker reads: the kit's mechanics with the fighter's look on top. A fighter cannot change a
// number of a move or invent one: `blocks`, `slot` and `posture` may be present only as an exact copy of the kit's.
export function standardMoves(mv, errors) {
  const own = new Map();
  const list = mv && Array.isArray(mv.moves) ? mv.moves : null;
  if (!list) errors.push('moves.json: нужен объект { moves: [...] } — приёмы набора ринга по их id');
  for (const [i, raw] of (list || []).entries()) {
    const where = `moves.json → moves[${i}]${raw?.id ? ` ("${raw.id}")` : ''}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where}: приём — объект`);
      continue;
    }
    const std = KIT_MOVES.find((m) => m.id === raw.id);
    if (!std) {
      errors.push(`${where}: в наборе ринга нет приёма "${raw.id}". Основные: ${STANDARD_MOVES.map((m) => m.id).join(', ')}; спецприёмы: ${SPECIAL_POOL.map((m) => m.id).join(', ')}; суперприёмы: ${SUPER_POOL.map((m) => m.id).join(', ')}`);
      continue;
    }
    if (own.has(raw.id)) errors.push(`${where}: id "${raw.id}" повторяется`);
    for (const k of ['blocks', 'slot', 'posture']) if (raw[k] !== undefined && !same(raw[k], std[k])) errors.push(`${where}.${k}: механику приёма задаёт ринг, она одинакова у всех, кто взял приём, — убери поле или оставь как в наборе`);
    if (raw.stance !== undefined) errors.push(`${where}.stance: стоек в наборе ринга нет`);
    for (const k of Object.keys(raw)) if (!['id', 'blocks', 'slot', 'posture', 'stance', ...LOOK_KEYS].includes(k)) errors.push(`${where}.${k}: у приёма нет такого поля`);
    own.set(raw.id, raw);
  }
  const specials = SPECIAL_POOL.filter((m) => own.has(m.id));
  const supers = SUPER_POOL.filter((m) => own.has(m.id));
  if (list && specials.length !== LOADOUT.specials) errors.push(`moves.json: спецприёмов из пула нужно ровно ${LOADOUT.specials}, сейчас ${specials.length} (${specials.map((m) => m.id).join(', ') || 'нет'}). Пул: ${SPECIAL_POOL.map((m) => m.id).join(', ')}`);
  if (list && supers.length !== LOADOUT.supers) errors.push(`moves.json: суперприём нужен ровно один, сейчас ${supers.length}. На выбор: ${SUPER_POOL.map((m) => m.id).join(', ')}`);
  return [...STANDARD_MOVES, ...specials, ...supers.slice(0, 1)].map((std) => {
    const raw = own.get(std.id) || {};
    const out = { id: std.id, name: std.name, slot: std.slot, posture: std.posture, blocks: std.blocks.map((b) => ({ ...b })), anim: std.anim };
    for (const k of LOOK_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
    return out;
  });
}
