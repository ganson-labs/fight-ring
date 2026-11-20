// Ring constants. Everything the fight depends on lives here, the same for every fighter.
// Units: 1 unit ≈ 1 px of a 1080p frame at default zoom. y grows UP, the floor is y = 0.

export const TICK_RATE = 60;
export const ROUND_SECONDS = 180;
export const ROUND_TICKS = ROUND_SECONDS * TICK_RATE;
export const STAGE = { width: 2200, startGap: 440 };
// Starts of the league (benchmark): the same pair fights from each, on both sides. x of the left and right fighter.
// centre — the standard start of a match; close and far; a fighter pressed to its wall.
export const STARTS = {
  centre: { x: [880, 1320] },
  close: { x: [1020, 1180] },
  far: { x: [600, 1600] },
  wall_left: { x: [160, 600] },
  wall_right: { x: [1600, 2040] },
};
// Ring 3.0 (rules N1–N4): in a league fight the start is shaken, so the repeats of one start are real repeats. The
// centre of the pair moves up to ±centre, the gap between the fighters up to ±gap (never below minGap); a fighter stays
// wallMargin from the ring's wall, and on a wall start the pressed fighter stays within pressedMax of it. Each side's
// brains start delay 0…delayMax ticks late; until its brains are first asked a fighter cannot be hit or thrown.
// The noise belongs to the side, not to the fighter: on the mirror side the other fighter gets it.
export const START_NOISE = { centre: 80, gap: 40, minGap: 120, wallMargin: 20, pressedMax: 200, delayMax: 6 };

// ---------- stats ----------
export const STAT_POINTS = 12;
export const STAT_MAX = 5;
export const STAT_KEYS = ['health', 'power', 'speed', 'defense'];

// scale: the damage scales of ring 4's kit (engine/standard.js); without it — the constants of ring 3 below
export function deriveStats(s, scale = null) {
  return {
    hp: 820 + 60 * s.health, // 0 → 820, 3 → 1000, 5 → 1120: the health move damage is written against
    maxHp: (820 + 60 * s.health) * (scale ? scale.hpMul : HP_MUL), // …and the health in a fight
    damageMul: 0.88 + 0.04 * s.power, // 0 → ×0.88, 5 → ×1.08
    walk: 3.6 + 0.3 * s.speed, // units per tick forward; back is 85 %
    dashDistance: 150 + 16 * s.speed,
    jumpVx: 4.2 + 0.3 * s.speed,
    takenMul: 1.09 - 0.03 * s.defense, // 0 → ×1.09, 5 → ×0.94
  };
}

// ---------- balance limits (enforced by the engine, checked by `arena check`) ----------
export const BASE_HP = 1000; // damage numbers in moves are written against this health
// The length of a fight: a round between capable fighters lasts one and a half to three minutes. A fighter's health
// in a fight is its health ×HP_MUL; a super hits ×SUPER_MUL and a throw ×THROW_MUL harder, so they still matter.
// ring 3.0 calibration (docs/v3/calibration.md): ×10, was ×12 — with the holes of 2.8 closed the even fights
// went to time; the ported fighters of the league of 2.8 knocked out in 70–140 s at ×12
export const HP_MUL = 10;
export const SUPER_MUL = 9;
export const THROW_MUL = 6;
export const METER_GAIN = 0.1; // the super meter fills this much slower than the damage it comes from
export const NORMAL_HIT_CAP = 0.08; // any hit outside a super: at most 8 % of the defender's health before ×HP_MUL
export const SUPER_TOTAL_CAP = 0.25; // a whole super: at most 25 % of the defender's max health
export const COMBO_DECAY = 0.8; // every next hit of a combo deals ×0.8 of the previous
export const COMBO_LIMIT = 5; // after the 5th hit of a combo the defender is invulnerable
export const COMBO_INVULN_TICKS = 30; // …through the rest of the stun and half a second after it
export const COMBO_GRACE_TICKS = 4; // a hit within this many ticks after the stun ends still continues the series
// Pressure (undizzy in Skullgirls, burst in Guilty Gear): a fighter held in hitstun, a juggle or dizzy gains a tick of
// pressure per tick; PRESSURE_BREATHER ticks in a row out of it clear the pressure. At PRESSURE_MAX he breaks free:
// the stun ends, he is invulnerable for BREAK_FREE_INVULN ticks. No loop keeps a fighter helpless (found 17.11.2026:
// four hits, a 4-tick gap that ended the series, again, for half a minute).
// brains and abilities see the opponent this many ticks late (sim.js → recordSight): a quarter of a second, the delay
// of the AI fighting-game competition FightingICE
export const REACTION_TICKS = 15;
// Ring 3.0, R2: a hit of an ability (api.hit, a box effect) lands reaction + base + ⌈max(0, d − freeRange) / perUnits⌉
// ticks after the call, d — the distance along x from its source (the fighter or the object) to the centre of the box.
// The defender sees it at least `base` ticks before it lands, however far it comes from.
export const TELEGRAPH = { base: 7, freeRange: 200, perUnits: 30 };
export const telegraphTicks = (dx, reaction = REACTION_TICKS) => reaction + TELEGRAPH.base + Math.ceil(Math.max(0, Math.abs(dx) - TELEGRAPH.freeRange) / TELEGRAPH.perUnits);
// R4: a strike that touched nothing (no hit, block, parry or armor) recovers this much longer
export const WHIFF_RECOVERY = 8;
// B1: guard gauge. A blocked hit adds base + damage × perDamage, a blocked control box controlAdd; after idle ticks
// without a block it drains decay a tick. At max the guard breaks: the defender is staggered crushTicks, the gauge
// empties, the attacker gets crushMeter of the super meter.
// One attack — a move, a projectile or a cast, all its hits together — adds at most perAttack: a guard breaks under
// pressure of several attacks, not under one multi-hit move (pilot 3.0 v1: a 5-hit move of 80 broke a full guard alone).
export const GUARD_GAUGE = { max: 100, base: 8, perDamage: 0.2, controlAdd: 8, perAttack: 34, idle: 60, decay: 0.5, crushTicks: 40, crushMeter: 30 };
// B2: an ability hit, a projectile, a special or super strike in the block wounds this share of its damage; it never
// takes the last point of health
export const CHIP = 0.1;
// B7: a blocked strike leaves the attacker at least this many ticks behind (blockstun is cut to fit)
export const BLOCK_MINUS = 2;
// S1 (pilot 3.0 v3): a tired move — every one of the last 9 attacks that landed clean takes a share off the next hits of
// the same move (stale-move negation of Super Smash Bros.): the latest −9 %, then −8 % … −1 %, at most −45 %.
// One move does not carry a whole fight; in three pilots in a row one move gave 60–70 % of the winner's damage.
export const STALE = [0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01];
// B3: a throw started earlier than this many ticks after the defender left blockstun, hitstun or getup does not grab
export const THROW_PROTECT = 6;
// P3: ether, the shared pool of ability power. A cast of a special ability costs its power (at most max); the pool
// refills regen a tick and perDamage for every unit of base damage taken. A super spends the meter, not ether.
export const ETHER = { max: 150, start: 75, regen: 0.6, perDamage: 0.25 };
// C2: guts — below these shares of health a fighter takes less damage (the lowest threshold that holds counts)
export const GUTS = [[0.15, 0.8], [0.3, 0.9]];
// C3: passivity (Negative Penalty in Guilty Gear). A fighter in neutral farther than `far` from the opponent that does
// not come closer gains a tick of passivity; coming closer takes `forward` a tick off; touching the opponent (a hit,
// a block or a parry of its attack) clears it. At max: a penalty — its ether empties, it loses meterLoss of the super
// meter, the opponent gains meterGain; the count drops to `after`.
export const PASSIVE = { far: 500, forward: 3, max: 360, after: 180, meterLoss: 50, meterGain: 30 };
// D1–D3: the brains are measured in steps like abilities (meter.js), not in milliseconds: a call past its steps is
// dropped and the previous action repeats. The wall clock is only a watchdog: a call longer than wallMs stops the
// fight as a failure of the judge, not of the fighter.
export const BRAIN = { tickSteps: 500000, initSteps: 20000000, depth: 1000, wallMs: 1000 };
export const PRESSURE_MAX = 120;
export const PRESSURE_BREATHER = 30;
export const BREAK_FREE_INVULN = 60;
// After a blocked hit a held block stops every zone this long (unblockable protection of Skullgirls): two sources
// hitting high and low on the same moment are hard to block, not impossible.
export const GUARD_ANY_TICKS = 7;
export const METER_MAX = 300; // three bars of 100; a super needs all three
export const METER_BAR = 100;
export const STUN_MAX = 3000;
export const MOVE_BUDGET = 40;
export const MOVES_MAX = 10;

// ---------- movement ----------
export const GRAVITY = 0.85; // units / tick²
export const JUMP_VY = 17;
export const PREJUMP_TICKS = 3;
export const LANDING_TICKS = 3;
export const DASH_TICKS = 16;
export const BACKDASH_TICKS = 18;
export const BACKDASH_DISTANCE = 140;
export const BACKDASH_INVULN = [1, 7]; // tick range, inclusive
export const PUSH_WIDTH = 70; // two fighters never stand closer than this, centre to centre

// ---------- defence ----------
export const PARRY_WINDOW = 6;
export const PARRY_WHIFF = 18;
export const PARRY_STAGGER = 24; // attacker cannot act after being parried
export const PARRY_HITSTOP = 10;
export const THROW = { startup: 5, active: 2, whiff: 28, range: 60, damage: 70, techWindow: 12, techPush: 110, knockdownTicks: 44 };
export const KNOCKDOWN_TICKS = 44;
export const GETUP_TICKS = 20;
export const DIZZY_TICKS = 100;
export const STUN_DECAY_DELAY = 45;
export const STUN_DECAY = 4;
export const COUNTER_MUL = 1.15;
export const SUPER_FREEZE = 45; // ticks of frozen time when a super starts

// ---------- boxes (relative to the fighter's feet; x points the way the fighter faces) ----------
// [x0, y0, x1, y1]
export const HURTBOX = {
  stand: [-35, 0, 35, 290],
  crouch: [-40, 0, 40, 185],
  air: [-35, 20, 35, 250],
};
export const REACH = { short: 55, mid: 95, long: 150 };
export const ZONE_Y = {
  high: [200, 270],
  mid: [110, 230],
  low: [0, 70],
  overhead: [150, 285],
  air: [-30, 120],
};
export const PROJECTILE = { size: 50, speed: { slow: 6, mid: 9, fast: 13 }, y: { high: 235, mid: 170, low: 35 }, lifetime: 150 };
export const SAY_COOLDOWN = 3 * TICK_RATE;

// ---------- ability (code a fighter writes on top of the ring's primitives) ----------
// Every limit below is enforced by the engine: the fight cuts anything beyond it silently, `arena check` says what was cut.
export const ABILITY = {
  hookCallsPerTick: 40, // primitive calls (reads included) per fighter per tick, over all its hooks and objects
  castTicks: 600, // one cast runs its tick hook at most this long
  hitDamageMax: 80, // base damage of one hit outside a super (the 8 % cap of the defender still applies)
  hitDamageMaxSuper: 250, // …inside a super (the 25 % cap of the whole super still applies)
  hitEvery: 6, // one source (the cast itself or one object) hits the same target at most once per this many ticks
  // ring 3.0 (R2): a hit of an ability lands telegraphTicks() after the call (reaction + 7 and more with distance), and
  // an object touches only from the age reaction + 7: the defender sees where and in which zone (brains: strikes,
  // objects) at least 7 ticks before it lands and can block, parry or step away. In 2.8 it landed 8 ticks after the
  // call while the brains saw it 15 ticks late, so no ability hit could be blocked on sight.
  castLife: 600, // O1: everything a cast made (objects, their objects, effects) is gone this many ticks after the cast began
  boxMax: 600, // a hit box or an object is at most this wide and tall
  boxReach: 900, // …and at most this far from its source
  objectsMax: 3, // own objects on the field at once
  objectLife: 360, // ticks
  objectSpeed: 24, // units per tick on each axis
  // walls (W1–W5): a solid object is terrain, not armour. One wall per fighter (a new one takes the old one away); it
  // stands on the floor, at most solidWidthMax wide and solidHeightMax tall, so any jump clears it; it moves at most
  // solidSpeed a tick along x and pushes fighters only through the shove budget; it holds both fighters on the ground
  // and stops low projectiles of both sides; strikes, projectiles and ability hits of the opponent break it (solidHp)
  solidWidthMax: 80,
  solidHeightMax: 160,
  solidsMax: 1,
  solidSpeed: 6,
  solidHp: 120,
  effectsMax: 4, // active effects one fighter keeps on one target
  effectTicks: 300, // any effect
  stopTicks: 60, // no actions
  slowTicks: 240, // speed below 1
  speed: [0.5, 1.5], // speed multiplier of walking, dashing and jumping, after all effects multiply
  taken: [0.8, 1.25], // damage-taken multiplier, after all effects multiply
  dotMax: 20, // damage per second of one effect
  dotEvery: 15, // damage over time lands every this many ticks
  // all damage over time on one target together: at most this share of its health before ×HP_MUL a second; on the
  // opponent it lands only like control (through a clean hit or a touching box), and not through a block
  dotCapShare: 0.015,
  driftMax: 3, // units per tick an effect pushes its target
  shovePerTick: 12, // units one fighter moves one target per tick (shoves and drift together)
  controlWindow: 360, // repeated control (stop or slow) on the same target inside this window…
  controlDecay: [1, 0.5, 0.25, 0], // …lasts ×1, ×0.5, ×0.25, then not at all
  // control on the opponent (stop, speed below 1) lands only through a hit (api.hit came through, not blocked or
  // parried) or with a box (api.effect … { box }) that touches the opponent within this reach of its source…
  controlReach: 200,
  controlStart: 60, // …never in the first ticks of a round…
  stopRound: 90, // …and one target is stopped for at most this many ticks a round, all effects together
  labelMax: 14,
  resourcesMax: 2,
  resourceMax: 1000,
  stancesMax: 4,
  // the per-cast cap in a fight: what the measurement saw × capMul + capAdd
  capMul: 1.25,
  capAdd: { damage: 10, control: 10, buff: 10, shove: 40, objectTicks: 60 },
  // compute: the fight counts calls (above); `check` also times the hooks on the dummy
  hookSteps: 100000, // steps per hook call: a loop turn or a call of an own function (meter.js); deterministic, unlike time
  hookDepth: 256, // nested calls of own functions inside one hook call
  hookMsAvg: 0.3,
  hookMsMax: 50, // a single slow call is usually the garbage collector; the average is the limit
};

// How the ring prices an ability from its measurement (see measureAbility in engine/measure.js).
// power = damage·1 + control·1.5 + buff·0.75 + shove·0.1 + objectTicks·0.02 + refusal·1.5
//   damage — base damage that reached the dummy (hit, block or armor) plus damage over time it was given;
//   control — ticks of control on the dummy: stop 1 per tick, slow (1 − speed) per tick, drift |drift|/6 per tick,
//             vulnerability (taken − 1)·4 per tick;
//   buff — ticks of self help: (speed − 1) + (1 − taken)·4 per tick;
//   shove — units the dummy and the caster itself were moved; objectTicks — ticks own objects lived;
//   refusal — ticks the walking dummy wanted to come closer and could not, ×0.5, plus the damage of the dummy's
//             projectiles the ability's walls stopped.
// The best of all measured situations counts.
export const ABILITY_PRICE = {
  weights: { damage: 1, control: 1.5, buff: 0.75, shove: 0.1, objectTicks: 0.02, refusal: 1.5 },
  cooldown: { base: 60, perPower: 2.5, min: 60, max: 1500 }, // ticks; a super has no cooldown (the meter gates it)
  cost: { base: 2, perPower: 25, perPowerSuper: 50, max: 24 }, // budget points
};
