// Fight simulation. Pure and deterministic: no DOM, no Node APIs, no wall clock; randomness only from the fight's seed.
// The same file runs the sandbox, the judge and the viewer, so a fight replays tick for tick from its inputs.
import * as C from './constants.js';
import { initAbilityFighter, newAbilityStats, hasAbilities, seedRng, queueCast, abilityPhase, abilityFighterView, objectsView, abilityHash, pendingView, strikeWalls } from './ability.js';
import { etherCost } from './blocks.js';
import { ARENA } from './standard.js';

const { STAGE, HURTBOX, REACH, ZONE_Y, PROJECTILE, THROW } = C;
const WALL_L = 40;
const WALL_R = STAGE.width - 40;
const BASE_L = WALL_L;
const BASE_R = WALL_R;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const STAGE_BOUNDS = { left: BASE_L, right: BASE_R, width: STAGE.width };

// ---------- setup ----------

function newFighter(side, def) {
  if (hasAbilities(def) && !def.abilities) throw new Error(`${def.card.name}: способности не загружены — бойца со способностями загружает loadFighter (Node) или loadFighterAssets (браузер)`);
  const x = STAGE.width / 2 + (side === 0 ? -1 : 1) * (STAGE.startGap / 2);
  return {
    side,
    def,
    x,
    y: 0,
    vx: 0,
    vy: 0,
    facing: side === 0 ? 1 : -1,
    hp: def.derived.maxHp,
    maxHp: def.derived.maxHp,
    meter: 0,
    stun: 0,
    stunIdle: 0,
    state: 'neutral',
    st: 0,
    len: 0,
    posture: 'stand',
    walk: 0,
    guard: null,
    move: null,
    holding: false,
    jumpDir: 0,
    airMoveUsed: false,
    invuln: 0,
    comboClear: 0,
    combo: 0,
    pressure: 0,
    breather: 0,
    guardAny: 0,
    comboWall: false,
    dizzyPending: false,
    sayCooldown: 0,
    sayCount: {},
    lastLine: null,
    projectile: null,
    grab: null,
    // ring 3.0
    ether: C.ETHER.start, // P3: the pool special abilities cast on
    guardGauge: 0, // B1: fills with blocked hits, breaks the guard at its max
    guardIdle: 0,
    freeAt: -1e9, // B3: the tick this fighter last left blockstun, hitstun or getup
    throwStart: -1e9, // the tick its last throw began (B3 for the thrown, B6 for its own way out)
    wait: 0, // N3: ticks its brains are not asked yet at the start; it cannot be hit or thrown meanwhile
    passive: 0, // C3: ticks of passivity
    stale: [], // S1: the moves of the last attacks that landed clean, the latest first
    staleAttack: null,
    px: x, // x at the start of the tick (walls tell walking into them from being pushed)
    tally: { damageDealt: 0, damageTaken: 0, hits: 0, blocked: 0, parries: 0, throws: 0, throwDamage: 0, techs: 0, maxCombo: 0, supers: 0, armorHits: 0, chip: 0, crushes: 0, whiffs: 0, passives: 0 },
  };
}

// C2: damage taken below a share of health is lower
function gutsOf(V) {
  const share = V.hp / V.maxHp;
  for (const [below, k] of C.GUTS) if (share < below) return k;
  return 1;
}

// S1: how tired a move is (1 — fresh)
function staleMul(A, moveId) {
  let k = 1;
  A.stale.forEach((id, i) => {
    if (id === moveId) k -= C.STALE[i];
  });
  return k;
}

// one entry per attack, not per hit of it
function pushStale(A, moveId, attack) {
  if (attack && A.staleAttack === attack) return;
  A.staleAttack = attack || null;
  A.stale.unshift(moveId);
  if (A.stale.length > C.STALE.length) A.stale.pop();
}

// P3: ether from damage taken (base damage, as the super meter counts it)
function gainEther(V, base) {
  if (V.ether < C.ETHER.max) V.ether = Math.min(C.ETHER.max, V.ether + base * C.ETHER.perDamage);
}

export const RING_SEED = 1;

// N1–N4: a start of the league with its noise. name: a start of STARTS; noise: { centre, gap, delay: [left, right] }
// (offsets in units, delays in ticks) or a number — the seed of a draw (noiseDraw). The type of the start stays: a
// fighter pressed to its wall stays within pressedMax of it, `close` stays close. Returns { x, delay } for createFight.
export function noisyStart(name, noise) {
  const base = C.STARTS[name];
  if (!base) throw new Error(`старт «${name}» не знаю: ${Object.keys(C.STARTS).join(', ')}`);
  const n = typeof noise === 'number' ? noiseDraw(noise) : noise || { centre: 0, gap: 0, delay: [0, 0] };
  const N = C.START_NOISE;
  const [l, r] = base.x;
  const lo = BASE_L + N.wallMargin;
  const hi = BASE_R - N.wallMargin;
  const gap = Math.max(N.minGap, r - l + clamp(n.gap, -N.gap, N.gap));
  let c = (l + r) / 2 + clamp(n.centre, -N.centre, N.centre);
  if (name === 'wall_left') c = clamp(c, lo + gap / 2, BASE_L + N.pressedMax + gap / 2);
  else if (name === 'wall_right') c = clamp(c, BASE_R - N.pressedMax - gap / 2, hi - gap / 2);
  else c = clamp(c, lo + gap / 2, hi - gap / 2);
  const delay = (n.delay || [0, 0]).map((d) => clamp(Math.round(d), 0, N.delayMax));
  return { x: [c - gap / 2, c + gap / 2], delay };
}

// One draw of the league's noise from a seed: offsets of the centre and the gap, the delays of both sides.
export function noiseDraw(seed) {
  let s = (seed >>> 0) ^ 0x5bd1e995;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const N = C.START_NOISE;
  const centre = Math.round((next() * 2 - 1) * N.centre);
  const gap = Math.round((next() * 2 - 1) * N.gap);
  const delay = [Math.floor(next() * (N.delayMax + 1)), Math.floor(next() * (N.delayMax + 1))];
  return { centre, gap, delay };
}

// seed: the ring's seed for api.rand() of abilities (kept in the fight record). clock: optional timer for hook stats only.
// start: optional start positions { x: [left, right], delay: [left, right] } (the league's starts, constants.js → STARTS,
// with the league's noise, startNoise); without it the standard start. reaction: ticks the brains see the opponent late.
export function createFight({ fighters, seed = RING_SEED, clock = null, start = null, reaction = C.REACTION_TICKS, arena = true }) {
  if (!fighters || fighters.length !== 2) throw new Error('createFight: нужны два скомпилированных бойца');
  const fight = {
    tick: 0,
    timer: C.ROUND_TICKS,
    hitstop: 0,
    freeze: 0,
    freezeSide: null,
    over: false,
    winner: null,
    endReason: null,
    f: [newFighter(0, fighters[0]), newFighter(1, fighters[1])],
    projectiles: [],
    nextId: 1,
    seed: seed >>> 0,
    rng: [seedRng(seed, 0), seedRng(seed, 1)],
    hasAbilities: hasAbilities(fighters[0]) || hasAbilities(fighters[1]),
    objects: [],
    casts: [],
    abilityStats: [newAbilityStats(), newAbilityStats()],
    measuring: false,
    clock,
    reaction: Math.max(1, Math.round(reaction)),
  };
  // ring 4: two fighters of the kit fight in the live arena (engine/standard.js → ARENA)
  if (fighters.every((d) => d.ruleset === 'standard') && arena) {
    // mirrored around the centre: the same distance to walk for both sides, whoever starts where
    let r = seedRng(seed, 2);
    r = Math.imul(r ^ (r >>> 15), r | 1);
    const d = Math.round(ARENA.objects.near + (((r ^ (r >>> 14)) >>> 0) / 4294967296) * (ARENA.objects.far - ARENA.objects.near));
    fight.props = [-1, 1].map((k) => ({ id: fight.nextId++, x: STAGE.width / 2 + k * d, used: false }));
  }
  if (start?.x) fight.f.forEach((F, i) => { F.x = F.px = clamp(Number(start.x[i]), BASE_L + 20, BASE_R - 20); });
  if (Array.isArray(start?.delay)) fight.f.forEach((F, i) => { F.wait = clamp(Math.round(Number(start.delay[i]) || 0), 0, 60); });
  fight.start = start?.x ? { x: fight.f.map((F) => F.x), ...(Array.isArray(start.delay) ? { delay: fight.f.map((F) => F.wait) } : {}) } : null;
  if (fight.start && fight.f[0].x === fight.f[1].x) fight.f[1].x = fight.f[1].px = fight.f[0].x + 1;
  fight.f.forEach((F) => { F.facing = fight.f[1 - F.side].x >= F.x ? 1 : -1; });
  fight.f.forEach((F) => initAbilityFighter(F, F.def));
  recordSight(fight);
  return fight;
}

// The ring picks lines it says on its own (intro, victory, defeat, super) in a fixed rotation.
export function ringLine(def, kind, n = 0) {
  const list = def.voice.lines.filter((l) => l.kind === kind);
  return list.length ? list[n % list.length].id : null;
}

// ---------- input ----------

// ring 3.0 (B6): no `tech` — the way out of a throw is a throw of one's own (resolveThrows)
export const IDLE_ACTION = Object.freeze({ walk: 0, crouch: false, jump: null, dash: null, guard: null, parry: false, attack: null, hold: false, throw: false, use: false, say: null });

export function sanitizeAction(a) {
  if (!a || typeof a !== 'object') return IDLE_ACTION;
  const n = Number(a.walk);
  const j = a.jump === null || a.jump === undefined || a.jump === false ? null : Number(a.jump);
  return {
    walk: Number.isFinite(n) ? sign(Math.round(clamp(n, -1, 1))) : 0,
    crouch: !!a.crouch,
    jump: j === -1 || j === 0 || j === 1 ? j : null,
    dash: a.dash === 'forward' || a.dash === 'back' ? a.dash : null,
    guard: a.guard === 'high' || a.guard === 'low' ? a.guard : null,
    parry: !!a.parry,
    attack: typeof a.attack === 'string' ? a.attack.slice(0, 32) : null,
    hold: !!a.hold,
    throw: !!a.throw,
    use: !!a.use,
    say: typeof a.say === 'string' ? a.say.slice(0, 32) : null,
  };
}

// ---------- helpers ----------

const AIR_STATES = new Set(['air', 'juggle', 'prejump_never']);
function airborne(F) {
  return F.y > 0 || F.vy !== 0 || AIR_STATES.has(F.state) || (F.state === 'move' && F.move.def.posture === 'air');
}

function setState(F, state, len = 0) {
  F.state = state;
  F.st = 0;
  F.len = len;
}

function toNeutral(F) {
  setState(F, 'neutral');
  F.move = null;
  F.holding = false;
  F.vx = 0;
  // the series ends only after the defender has been free for a moment: a hit landing on the tick the stun ends
  // still counts, so a gapless loop reaches COMBO_LIMIT instead of restarting the counter (found in a match, 14.11.2026)
  if (F.combo > 0) F.comboClear = C.COMBO_GRACE_TICKS;
  F.comboWall = false;
  if (F.dizzyPending) {
    F.dizzyPending = false;
    F.stun = 0;
    setState(F, 'dizzy', C.DIZZY_TICKS);
    return 'dizzy';
  }
  return null;
}

const WAKE_GUARD = new Set(['getup', 'knockdown', 'hitstun', 'landing', 'staggered', 'dizzy', 'techBreak', 'throwing', 'throw', 'parry']);

function canAct(F) {
  return F.state === 'neutral';
}

// Pressure: a tick held in hitstun, a juggle or dizzy (and hittable) adds one, PRESSURE_BREATHER ticks in a row out of
// it clear it; at PRESSURE_MAX a fighter on the ground breaks free (a juggle ends in an invulnerable knockdown anyway).
function pressureTick(fight, F, events) {
  if (['hitstun', 'juggle', 'dizzy'].includes(F.state) && !hasNoHurtbox(F)) {
    F.breather = 0;
    F.pressure++;
    if (F.pressure >= C.PRESSURE_MAX && F.state !== 'juggle' && F.hp > 0) breakFree(fight, F, events);
    return;
  }
  if (++F.breather >= C.PRESSURE_BREATHER) F.pressure = 0;
}

function breakFree(fight, F, events) {
  F.pressure = 0;
  F.freeAt = fight.tick;
  F.combo = 0;
  F.comboClear = 0;
  F.stun = 0;
  F.dizzyPending = false;
  toNeutral(F);
  F.invuln = Math.max(F.invuln, C.BREAK_FREE_INVULN);
  events.push({ type: 'breakFree', side: F.side, x: F.x, y: F.y + 150 });
}

function currentSegment(F) {
  if (F.state !== 'move' || !F.move) return null;
  const t = F.move.t;
  for (const s of F.move.def.segments) if (t < s.end) return s;
  return null;
}

function strikeBox(F, seg) {
  const p = seg.p;
  const reach = REACH[p.reach];
  const x0 = F.x + F.facing * 20;
  const x1 = F.x + F.facing * (35 + reach);
  const zy = ZONE_Y[p.zone];
  return [Math.min(x0, x1), F.y + zy[0], Math.max(x0, x1), F.y + zy[1]];
}

function hasNoHurtbox(F) {
  if (F.invuln > 0 || F.wait > 0) return true;
  if (['knockdown', 'getup', 'ko', 'grabbed', 'thrown', 'throwing', 'techBreak'].includes(F.state)) return true;
  if (F.state === 'dash' && F.dashDir < 0 && F.st >= C.BACKDASH_INVULN[0] && F.st <= C.BACKDASH_INVULN[1]) return true;
  if (F.state === 'move') {
    const m = F.move;
    if (m.def.slot === 'super' && m.t < m.def.firstActive) return true;
    for (const s of m.def.segments) {
      if (s.type === 'teleport' && m.t >= s.activeStart - 6 && m.t < s.activeStart) return true;
    }
  }
  return false;
}

function hurtboxes(F) {
  if (hasNoHurtbox(F)) return [];
  const kind = airborne(F) ? 'air' : F.posture === 'crouch' ? 'crouch' : 'stand';
  const h = HURTBOX[kind];
  const a = F.x + F.facing * h[0];
  const b = F.x + F.facing * h[2];
  const boxes = [[Math.min(a, b), F.y + h[1], Math.max(a, b), F.y + h[3]]];
  // An extended limb can be hit while it is out: active frames and the first half of recovery.
  const seg = currentSegment(F);
  if (seg && seg.type === 'strike') {
    const t = F.move.t;
    if (t >= seg.activeStart && t < seg.activeEnd + Math.ceil((seg.end - seg.activeEnd) / 2)) boxes.push(strikeBox(F, seg));
  }
  return boxes;
}

const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function blocks(V, zone) {
  if (airborne(V)) return false;
  if (!(V.state === 'neutral' || V.state === 'blockstun')) return false;
  if (V.guard && V.guardAny > 0) return true; // right after a blocked hit a held block stops every zone
  if (V.guard === 'high') return zone !== 'low';
  if (V.guard === 'low') return zone === 'mid' || zone === 'low';
  return false;
}

function parryActive(V) {
  return V.state === 'parry' && V.st <= C.PARRY_WINDOW;
}

// raw: a fixed reward (a parry), not damage to scale by METER_GAIN
function addMeter(F, v, raw = false) {
  F.meter = Math.min(C.METER_MAX, F.meter + v * (raw ? 1 : F.def.scale ? F.def.scale.meterGain : C.METER_GAIN));
}

function say(fight, F, id, events, forced = false) {
  if (!id || !F.def.voice.byId[id]) return;
  if (!forced && F.sayCooldown > 0) return;
  F.sayCooldown = C.SAY_COOLDOWN;
  F.lastLine = id;
  events.push({ type: 'say', side: F.side, line: id });
}

// ---------- decisions ----------

function startMove(fight, F, O, m, events) {
  F.move = { def: m, t: 0, held: 0, segHits: m.segments.map(() => ({ done: 0, lastT: -99, walls: null })), armorLeft: m.armor, superDealt: 0, started: new Set(), touched: false, extra: 0 };
  setState(F, 'move', m.duration);
  F.holding = false;
  F.guard = null;
  const ether = etherCost(m);
  if (ether > 0) {
    F.ether -= ether;
    F.move.ether = ether;
  }
  if (m.posture !== 'air') {
    F.posture = m.posture === 'crouch' ? 'crouch' : 'stand';
    F.vx = 0;
  } else F.airMoveUsed = true;
  events.push({ type: 'move', side: F.side, move: m.id, slot: m.slot });
  if (m.ability?.cooldown) F.cooldowns[m.id] = m.ability.cooldown;
  if (m.slot === 'super') {
    F.meter = 0;
    F.tally.supers++;
    fight.freeze = C.SUPER_FREEZE;
    fight.freezeSide = F.side;
    events.push({ type: 'super', side: F.side, move: m.id, director: m.director });
    say(fight, F, m.director?.line || m.line || ringLine(F.def, 'super', F.tally.supers - 1), events, true);
  } else if (m.line) say(fight, F, m.line, events, true);
}

function moveAllowed(F, m) {
  if (!m) return false;
  if (m.slot === 'super' && F.meter < C.METER_MAX) return false;
  if (m.hasProjectile && F.projectile) return false;
  if (F.cooldowns[m.id] > 0) return false;
  if (m.stance && F.stance !== m.stance) return false;
  if (F.ether < etherCost(m)) return false;
  return true;
}

function think(fight, F, O, a, events) {
  if (F.mods.stop || F.wait > 0) a = IDLE_ACTION;
  if (a.say) say(fight, F, a.say, events);
  // B6: once grabbed it is too late — the way out is a throw of one's own begun before the grab (resolveThrows)
  if (F.state === 'grabbed') return;
  if (F.state === 'move') {
    F.holding = a.hold;
    return;
  }
  if (F.state === 'blockstun') {
    if (a.guard) {
      F.guard = a.guard;
      F.posture = a.guard === 'low' ? 'crouch' : 'stand';
    }
    return;
  }
  if (F.state === 'air') {
    const m = a.attack ? F.def.movesById[a.attack] : null;
    if (m && m.posture === 'air' && !F.airMoveUsed && moveAllowed(F, m)) startMove(fight, F, O, m, events);
    return;
  }
  if (!canAct(F)) {
    // B8 (pilot 3.0 v4): a guard the brains hold while the fighter is not free yet holds from its first free tick. The
    // brains decide before the state moves on, so on the tick a getup (or a stun) ended the fighter was in neutral with no
    // guard: a strike active on that tick always landed, and a series ending in a knockdown looped on every wake-up.
    if (WAKE_GUARD.has(F.state)) F.guard = F.mods.stop ? null : a.guard;
    return;
  }

  const m = a.attack ? F.def.movesById[a.attack] : null;
  if (m && m.posture !== 'air' && moveAllowed(F, m)) {
    startMove(fight, F, O, m, events);
    return;
  }
  if (a.use) {
    const prop = propFor(fight, F);
    if (prop) {
      setState(F, 'use', ARENA.objects.total);
      F.useProp = prop.id;
      F.vx = 0;
      F.guard = null;
      F.posture = 'stand';
      F.facing = O.x >= F.x ? 1 : -1;
      events.push({ type: 'use', side: F.side, id: prop.id, x: prop.x });
      return;
    }
  }
  if (a.throw) {
    setState(F, 'throw', THROW.startup + THROW.active + THROW.whiff);
    F.throwStart = fight.tick;
    F.vx = 0;
    F.guard = null;
    F.posture = 'stand';
    return;
  }
  if (a.parry) {
    setState(F, 'parry', C.PARRY_WINDOW + C.PARRY_WHIFF);
    F.vx = 0;
    F.guard = null;
    F.posture = 'stand';
    return;
  }
  if (a.jump !== null) {
    setState(F, 'prejump', C.PREJUMP_TICKS);
    F.jumpDir = a.jump;
    F.guard = null;
    F.posture = 'stand';
    return;
  }
  if (a.dash) {
    F.dashDir = a.dash === 'forward' ? 1 : -1;
    setState(F, 'dash', F.dashDir > 0 ? C.DASH_TICKS : C.BACKDASH_TICKS);
    F.dashFrom = F.x;
    F.guard = null;
    F.posture = 'stand';
    events.push({ type: 'dash', side: F.side, dir: F.dashDir });
    return;
  }
  const crouch = a.crouch || a.guard === 'low';
  F.posture = crouch ? 'crouch' : 'stand';
  F.guard = a.guard;
  let walk = crouch ? 0 : a.walk;
  if (F.guard === 'high' && walk > 0) walk = 0;
  F.walk = walk;
  const pace = F.def.derived.walk * F.mods.speed;
  F.vx = walk > 0 ? walk * pace * F.facing : walk * pace * 0.85 * F.facing;
}

// ---------- advancing ----------

function landing(F, events) {
  F.y = 0;
  F.vy = 0;
  if (F.state === 'juggle') {
    F.vx = 0;
    if (F.hp <= 0) setState(F, 'ko');
    else setState(F, 'knockdown', C.KNOCKDOWN_TICKS);
    events.push({ type: 'knockdown', side: F.side, x: F.x });
    return;
  }
  F.vx = 0;
  F.move = null;
  setState(F, 'landing', C.LANDING_TICKS + (F.state === 'move' ? 1 : 0));
  events.push({ type: 'land', side: F.side, x: F.x });
}

function physicsAir(F, events) {
  F.vy -= C.GRAVITY;
  F.x += F.vx;
  F.y += F.vy;
  if (F.y <= 0) landing(F, events);
}

function teleportTo(F, O, p) {
  if (p.to === 'behind') {
    const dir = sign(O.x - F.x) || F.facing;
    let x = O.x + dir * 90;
    if (x < WALL_L || x > WALL_R) x = O.x - dir * 90;
    F.x = clamp(x, WALL_L, WALL_R);
  } else {
    const dir = p.to === 'forward' ? F.facing : -F.facing;
    let dist = p.distance;
    if (p.to === 'forward') {
      const gap = Math.abs(O.x - F.x) - C.PUSH_WIDTH;
      if (sign(O.x - F.x) === F.facing) dist = Math.min(dist, Math.max(0, gap));
    }
    F.x = clamp(F.x + dir * dist, WALL_L, WALL_R);
  }
  F.facing = O.x >= F.x ? 1 : -1;
}

function spawnProjectile(fight, F, seg, chargeMul, events) {
  const p = seg.p;
  const y = airborne(F) ? F.y + 150 : PROJECTILE.y[p.zone];
  const pr = {
    id: fight.nextId++,
    owner: F.side,
    move: F.move.def.id,
    super: F.move.def.slot === 'super',
    x: F.x + F.facing * 60,
    y,
    vx: F.facing * PROJECTILE.speed[p.speed],
    zone: p.zone,
    damage: p.damage,
    chargeMul,
    hits: p.hits,
    done: 0,
    nextHit: 0,
    life: PROJECTILE.lifetime,
  };
  fight.projectiles.push(pr);
  F.projectile = pr.id;
  // ring 4: a shot tires its move when it is thrown, not only when it lands — the tenth shot in a row is a weak one
  // (pilot 4.0: a contestant threw one shot 53 times a fight; blocked and parried shots never tired it)
  if (F.def.scale && F.move.def.slot !== 'super') pushStale(F, F.move.def.id, pr);
  events.push({ type: 'projectile', side: F.side, id: pr.id, move: pr.move, x: pr.x, y: pr.y });
}

function advanceMove(fight, F, O, events) {
  const m = F.move;
  const d = m.def;
  if (d.charge) {
    const seg = d.segments[d.charge.seg];
    if (m.t === seg.activeStart - 1 && F.holding && m.held < d.charge.maxHold) {
      if (m.held === 0) events.push({ type: 'charge', side: F.side, move: d.id });
      m.held++;
      return;
    }
  }
  m.t++;
  // ring 4: a strike with `advance` carries the fighter forward through its startup, evenly; never through the opponent
  for (const s of d.segments) {
    if (s.type !== 'strike' || !s.p.advance || m.t <= s.start || m.t > s.activeStart) continue;
    let step = s.p.advance / (s.activeStart - s.start);
    if (sign(O.x - F.x) === F.facing && !airborne(O)) step = Math.min(step, Math.max(0, Math.abs(O.x - F.x) - C.PUSH_WIDTH));
    F.x = clamp(F.x + F.facing * step, WALL_L, WALL_R);
  }
  for (let i = 0; i < d.segments.length; i++) {
    const s = d.segments[i];
    if (m.t === s.activeStart && !m.started.has(i)) {
      m.started.add(i);
      const chargeMul = d.charge && d.charge.seg === i ? 1 + (d.charge.bonus * m.held) / d.charge.maxHold : 1;
      if (s.type === 'teleport') {
        teleportTo(F, O, s.p);
        events.push({ type: 'teleport', side: F.side, x: F.x });
      } else if (s.type === 'projectile') spawnProjectile(fight, F, s, chargeMul, events);
      else {
        if (s.type === 'ability') queueCast(F, s);
        events.push({ type: 'active', side: F.side, move: d.id, seg: i });
      }
    }
  }
  // R4: a move whose strikes touched nothing recovers WHIFF_RECOVERY ticks longer
  if (m.t === d.duration && !m.extra && !m.touched && d.posture !== 'air' && d.segments.some((s) => s.type === 'strike')) {
    m.extra = C.WHIFF_RECOVERY;
    F.len += m.extra;
    F.tally.whiffs++;
  }
  if (m.t >= d.duration + m.extra) {
    if (d.posture === 'air' && F.y > 0) {
      F.move = null;
      setState(F, 'air');
    } else {
      const r = toNeutral(F);
      if (r) events.push({ type: 'dizzy', side: F.side });
    }
  }
}

function advance(fight, F, O, events) {
  F.st++;
  if (F.invuln > 0) F.invuln--;
  if (F.guardAny > 0) F.guardAny--;
  if (F.comboClear > 0 && --F.comboClear === 0) F.combo = 0;
  if (F.sayCooldown > 0) F.sayCooldown--;
  const back = () => {
    const r = toNeutral(F);
    if (r) events.push({ type: 'dizzy', side: F.side });
  };
  // B3: leaving blockstun, hitstun or getup starts the throw protection
  const free = () => {
    F.freeAt = fight.tick;
    back();
  };
  switch (F.state) {
    case 'neutral':
      F.x += F.vx;
      break;
    case 'prejump':
      if (F.st >= C.PREJUMP_TICKS) {
        setState(F, 'air');
        F.vy = C.JUMP_VY;
        F.vx = F.jumpDir * F.facing * F.def.derived.jumpVx * F.mods.speed;
        F.airMoveUsed = false;
        events.push({ type: 'jump', side: F.side, dir: F.jumpDir });
      }
      break;
    case 'air':
    case 'juggle':
      physicsAir(F, events);
      break;
    case 'landing':
      if (F.st >= F.len) back();
      break;
    case 'dash': {
      const len = F.len;
      const dist = (F.dashDir > 0 ? F.def.derived.dashDistance : C.BACKDASH_DISTANCE) * F.mods.speed;
      const k0 = (F.st - 1) / len;
      const k1 = F.st / len;
      const e = (k) => 1 - (1 - k) * (1 - k);
      F.x += F.facing * F.dashDir * dist * (e(k1) - e(k0));
      if (F.st >= len) back();
      break;
    }
    case 'move':
      if (F.move.def.posture === 'air') {
        physicsAir(F, events);
        if (F.state !== 'move') break;
      }
      advanceMove(fight, F, O, events);
      break;
    case 'hitstun':
    case 'blockstun':
      F.x += F.vx;
      F.vx *= 0.82;
      if (Math.abs(F.vx) < 0.05) F.vx = 0;
      if (F.st >= F.len) {
        if (F.state === 'hitstun' && F.hp <= 0) setState(F, 'ko');
        else free();
      }
      break;
    case 'knockdown':
      if (F.st >= F.len) setState(F, 'getup', C.GETUP_TICKS);
      break;
    case 'getup':
      if (F.st >= F.len) free();
      break;
    case 'use': {
      // the grab is done: the object flies at the opponent as a projectile of the ring's own numbers
      const prop = fight.props?.find((o) => o.id === F.useProp && !o.used);
      if (F.st === ARENA.objects.startup && prop) {
        prop.used = true;
        const P = ARENA.objects;
        const pr = { id: fight.nextId++, owner: F.side, move: 'stage', super: false, stage: true, x: F.x + F.facing * 60, y: PROJECTILE.y.mid, vx: F.facing * P.speed, zone: 'mid', damage: P.damage, chargeMul: 1, hits: 1, done: 0, nextHit: 0, life: PROJECTILE.lifetime };
        fight.projectiles.push(pr);
        events.push({ type: 'projectile', side: F.side, id: pr.id, move: 'stage', x: pr.x, y: pr.y });
      }
      if (F.st >= F.len) back();
      break;
    }
    case 'parry':
    case 'staggered':
    case 'dizzy':
    case 'techBreak':
    case 'throwing':
      if (F.state === 'techBreak') {
        F.x += F.vx;
        F.vx *= 0.8;
      }
      if (F.st >= F.len) back();
      break;
    case 'throw':
      if (F.st >= F.len) back();
      break;
    case 'grabbed':
      if (F.st > THROW.techWindow) {
        const A = O;
        setState(F, 'thrown', 22);
        const dmg = damageFor(A, F, THROW.damage * (A.def.scale ? A.def.scale.throwMul : C.THROW_MUL), { cap: false, chargeMul: staleMul(A, 'throw') });
        pushStale(A, 'throw', null);
        applyDamage(A, F, dmg);
        F.combo = 1;
        addMeter(A, THROW.damage * 0.6);
        addMeter(F, THROW.damage * 0.4);
        gainEther(F, THROW.damage);
        A.tally.throws++;
        A.tally.throwDamage += dmg;
        events.push({ type: 'throw', side: A.side, victim: F.side, damage: dmg, x: F.x, y: 120 });
        if (F.hp <= 0) endFight(fight, A.side, 'ko', events);
      }
      break;
    case 'thrown':
      if (F.st >= F.len) {
        F.x = clamp(O.x + O.facing * 170, WALL_L, WALL_R);
        F.facing = O.x >= F.x ? 1 : -1;
        if (F.hp <= 0) setState(F, 'ko');
        else setState(F, 'knockdown', THROW.knockdownTicks);
        events.push({ type: 'knockdown', side: F.side, x: F.x });
      }
      break;
    default:
      break;
  }
}

// ---------- damage ----------

function damageFor(A, V, base, { counter = false, chargeMul = 1, superMove = null, cap = true } = {}) {
  const scale = Math.pow(C.COMBO_DECAY, Math.max(0, V.combo));
  let dmg = base * A.def.derived.damageMul * V.def.derived.takenMul * V.mods.taken * (counter ? C.COUNTER_MUL : 1) * chargeMul * scale * (superMove ? (A.def.scale ? A.def.scale.superMul : C.SUPER_MUL) : 1) * gutsOf(V);
  dmg = Math.round(dmg);
  if (superMove) dmg = Math.min(dmg, Math.floor(C.SUPER_TOTAL_CAP * V.maxHp) - superMove.superDealt);
  else if (cap) dmg = Math.min(dmg, Math.floor(C.NORMAL_HIT_CAP * V.maxHp / (V.def.scale ? V.def.scale.hpMul : C.HP_MUL)));
  return Math.max(superMove ? 0 : 1, dmg);
}

function applyDamage(A, V, dmg) {
  V.hp = Math.max(0, V.hp - dmg);
  A.tally.damageDealt += dmg;
  V.tally.damageTaken += dmg;
}

function endFight(fight, winner, reason, events) {
  if (fight.over) return;
  fight.over = true;
  fight.endTick = fight.tick;
  fight.winner = winner;
  fight.endReason = reason;
  fight.endEvent = { type: 'end', winner, reason };
  events.push(fight.endEvent);
  // the round is decided: projectiles fade out instead of hanging in the air
  for (const p of fight.projectiles) events.push({ type: 'projectileEnd', id: p.id, x: p.x, y: p.y });
  for (const F of fight.f) F.projectile = null;
  fight.projectiles = [];
}

// After the end the winner stops at once: a move in progress is dropped and the fighter goes to the victory pose
// (from the air — after landing). The result is already fixed; this only shapes what the viewer sees.
function settleWinner(fight) {
  const W = fight.winner === null ? null : fight.f[fight.winner];
  if (!W || W.settled) return;
  if (airborne(W)) {
    if (W.state === 'move') {
      W.move = null;
      setState(W, 'air');
    }
    return;
  }
  if (!['neutral', 'landing'].includes(W.state) && !['grabbed', 'thrown', 'knockdown', 'getup'].includes(W.state)) {
    W.dizzyPending = false;
    toNeutral(W);
    W.walk = 0;
    W.guard = null;
    W.posture = 'stand';
  }
  if (W.state === 'neutral') {
    W.vx = 0;
    W.walk = 0;
    W.settled = true;
  }
}

// One connection of a strike or projectile. src: { zone, damage, chargeMul, launch, push, super, moveId, x, y }
function connect(fight, A, V, src, events, out) {
  const base = src.damage;
  A.passive = 0; // C3: the attack touched the opponent
  if (parryActive(V)) {
    out.parried = true;
    out.result = 'parry';
    V.tally.parries++;
    addMeter(V, V.def.scale ? ARENA.parryMeter : 20, true);
    const r = toNeutral(V);
    if (r) events.push({ type: 'dizzy', side: V.side });
    fight.hitstop = Math.max(fight.hitstop, C.PARRY_HITSTOP);
    events.push({ type: 'parry', side: V.side, attacker: A.side, x: src.x, y: src.y });
    return;
  }
  if (V.state === 'move' && V.move.armorLeft > 0 && V.move.t < V.move.def.armorUntil) {
    V.move.armorLeft--;
    out.result = 'armor';
    const dmg = Math.max(1, Math.round(damageFor(A, V, base, { chargeMul: src.chargeMul, superMove: src.superMove }) * 0.5));
    applyDamage(A, V, dmg);
    if (src.superMove) src.superMove.superDealt += dmg;
    V.tally.armorHits++;
    gainEther(V, base * 0.5);
    fight.hitstop = Math.max(fight.hitstop, 6);
    events.push({ type: 'armor', side: V.side, attacker: A.side, damage: dmg, x: src.x, y: src.y });
    if (V.hp <= 0) {
      V.move = null;
      setState(V, 'juggle');
      V.vy = 10;
      V.vx = A.facing * 3;
      endFight(fight, A.side, 'ko', events);
    }
    return;
  }
  if (blocks(V, src.zone)) {
    out.result = 'block';
    // B7 (pilot 3.0 v2): a blocked strike never leaves the attacker ahead — the blockstun ends at least
    // BLOCK_MINUS ticks before the attacker's move does, so after a block the turn is the defender's
    let stun = 10 + Math.floor(base / 10);
    const m = src.attack;
    if (m && m.def && A.move === m) stun = Math.max(1, Math.min(stun, m.def.duration + (m.extra || 0) - m.t - C.BLOCK_MINUS));
    setState(V, 'blockstun', stun);
    V.guardAny = C.GUARD_ANY_TICKS;
    V.posture = V.guard === 'low' ? 'crouch' : 'stand';
    V.vx = A.facing * (src.push === 'heavy' ? 7 : 4.5);
    A.tally.blocked++;
    addMeter(A, base * 0.3);
    addMeter(V, base * 0.2);
    fight.hitstop = Math.max(fight.hitstop, 4 + Math.floor(base / 20));
    // B2: an ability hit, a projectile, a special or super strike wounds through the block, never to the last point
    let chip = 0;
    if (src.ability || src.projectile || src.special) {
      chip = Math.min(damageFor(A, V, base * C.CHIP, { chargeMul: src.chargeMul, superMove: src.superMove }), Math.max(0, Math.ceil(V.hp) - 1));
      if (chip > 0) {
        applyDamage(A, V, chip);
        if (src.superMove) src.superMove.superDealt += chip;
        A.tally.chip += chip;
        gainEther(V, base * C.CHIP);
      }
    }
    events.push({ type: 'block', side: V.side, attacker: A.side, move: src.moveId, x: src.x, y: src.y, zone: src.zone, chip, ability: !!src.ability });
    addGuard(fight, A, V, C.GUARD_GAUGE.base + base * C.GUARD_GAUGE.perDamage, events, src.attack);
    return;
  }
  // clean hit
  out.result = 'hit';
  const counter = V.state === 'move' && V.move.t < V.move.def.firstActive;
  const tired = src.superMove ? 1 : staleMul(A, src.moveId);
  const dmg = damageFor(A, V, base, { counter, chargeMul: (src.chargeMul ?? 1) * tired, superMove: src.superMove });
  if (!src.superMove) pushStale(A, src.moveId, src.attack);
  applyDamage(A, V, dmg);
  if (src.superMove) src.superMove.superDealt += dmg;
  V.combo++;
  V.comboClear = 0;
  V.tally.maxCombo = Math.max(V.tally.maxCombo, V.combo);
  A.tally.hits++;
  if (!src.superMove) addMeter(A, base * 0.6);
  addMeter(V, base * 0.4);
  gainEther(V, base);
  V.stun += base * 1.5;
  V.stunIdle = 0;
  const wasDizzy = V.state === 'dizzy';
  if (V.stun >= C.STUN_MAX && !wasDizzy) V.dizzyPending = true;
  const wasAir = airborne(V);
  V.move = null;
  V.guard = null;
  V.holding = false;
  if (wasAir || src.launch || V.hp <= 0) {
    setState(V, 'juggle');
    V.vy = src.launch ? 15 : wasAir ? 7 : 9;
    V.vx = A.facing * (src.launch ? 2.5 : src.push === 'heavy' ? 7 : 3);
    if (V.y === 0) V.y = 1;
  } else {
    setState(V, 'hitstun', 14 + Math.floor(base / 6) + (counter ? 4 : 0));
    V.vx = A.facing * (src.push === 'heavy' ? 9 : 5);
  }
  const stop = src.superMove ? 12 : 6 + Math.floor(base / 12);
  fight.hitstop = Math.max(fight.hitstop, Math.min(16, stop));
  events.push({
    type: 'hit', side: V.side, attacker: A.side, move: src.moveId, damage: dmg, combo: V.combo, counter, ability: !!src.ability,
    launch: !!src.launch, super: !!src.superMove, zone: src.zone, x: src.x, y: src.y, heavy: base >= 60 || src.push === 'heavy',
  });
  if (V.combo >= C.COMBO_LIMIT) {
    // invulnerable through the rest of the stun and half a second after it: a free window to block, move or hit back
    V.invuln = (V.state === 'hitstun' || V.state === 'blockstun' ? V.len : 0) + C.COMBO_INVULN_TICKS;
    events.push({ type: 'comboLimit', side: V.side });
    V.combo = 0;
  }
  if (V.hp <= 0) endFight(fight, A.side, 'ko', events);
}

function strikeConnections(F, O) {
  const seg = currentSegment(F);
  if (!seg || seg.type !== 'strike') return null;
  const m = F.move;
  const t = m.t;
  if (t < seg.activeStart || t >= seg.activeEnd) return null;
  const idx = m.def.segments.indexOf(seg);
  const sh = m.segHits[idx];
  if (sh.done >= seg.p.hits) return null;
  const interval = Math.max(1, Math.floor((seg.activeEnd - seg.activeStart) / seg.p.hits));
  if (t < sh.lastT + interval) return null;
  const box = strikeBox(F, seg);
  const hurt = hurtboxes(O);
  if (!hurt.some((h) => overlap(box, h))) return null;
  const hb = hurt.find((h) => overlap(box, h));
  const chargeMul = m.def.charge && m.def.charge.seg === idx ? 1 + (m.def.charge.bonus * m.held) / m.def.charge.maxHold : 1;
  return {
    seg: idx,
    src: {
      zone: seg.p.zone, damage: seg.p.damage, chargeMul, launch: seg.p.launch, push: seg.p.push, moveId: m.def.id, special: m.def.slot !== 'normal', attack: m,
      superMove: m.def.slot === 'super' ? m : null,
      x: (Math.max(box[0], hb[0]) + Math.min(box[2], hb[2])) / 2,
      y: (Math.max(box[1], hb[1]) + Math.min(box[3], hb[3])) / 2,
    },
  };
}

// A: the thrower. B3: a throw begun less than THROW_PROTECT ticks after V left a stun (or before it) does not grab.
function throwable(V, A) {
  if (airborne(V) || V.invuln > 0 || V.wait > 0) return false;
  if (A && A.throwStart - V.freeAt < C.THROW_PROTECT) return false;
  return ['neutral', 'move', 'parry', 'staggered', 'landing', 'dizzy', 'throw', 'dash'].includes(V.state) && !(V.state === 'dash' && V.dashDir < 0 && V.st <= C.BACKDASH_INVULN[1]);
}

function throwActive(F) {
  return F.state === 'throw' && F.st > THROW.startup && F.st <= THROW.startup + THROW.active;
}

function inThrowRange(F, O) {
  const dx = O.x - F.x;
  return sign(dx) === F.facing && Math.abs(dx) <= C.PUSH_WIDTH + THROW.range;
}

function resolveThrows(fight, events) {
  const [a, b] = fight.f;
  const ta = throwActive(a) && inThrowRange(a, b) && throwable(b, a);
  const tb = throwActive(b) && inThrowRange(b, a) && throwable(a, b);
  if (ta && tb) {
    techBreak(a, b, events);
    return;
  }
  for (const [A, V, ok] of [[a, b, ta], [b, a, tb]]) {
    if (!ok) continue;
    if (V.state === 'move' && V.move.def.slot === 'super' && V.move.t < V.move.def.firstActive) continue;
    // B6: the only way out is a throw of one's own begun at most techWindow ticks before the grab — the same input
    // that whiffs for THROW.whiff ticks when no grab comes. The brains see their own grab at once, so the way out
    // cannot wait for it: it is a guess, like a tech in a fighting game whose window is shorter than a reaction.
    if (V.state === 'throw' && fight.tick - V.throwStart <= THROW.techWindow) {
      A.passive = 0;
      techBreak(a, b, events);
      return;
    }
    A.passive = 0;
    setState(A, 'throwing', THROW.techWindow + 24);
    V.move = null;
    V.guard = null;
    V.techRequest = false;
    setState(V, 'grabbed');
    V.x = clamp(A.x + A.facing * 80, WALL_L, WALL_R);
    events.push({ type: 'grab', side: A.side, victim: V.side, x: V.x });
  }
}

function techBreak(a, b, events) {
  for (const [F, O] of [[a, b], [b, a]]) {
    setState(F, 'techBreak', 16);
    F.move = null;
    F.vx = -sign(O.x - F.x || F.facing) * 8;
  }
  a.tally.techs++;
  b.tally.techs++;
  events.push({ type: 'tech', x: (a.x + b.x) / 2 });
}

// ---------- step ----------

// ---------- stage objects (ring 4) ----------

// the stage object a fighter can use now: free on the ground within reach of one not used yet
function propFor(fight, F) {
  if (!fight.props || F.y !== 0 || fight.tick < ARENA.objects.from) return null;
  return fight.props.find((o) => !o.used && Math.abs(o.x - F.x) <= ARENA.objects.reach) || null;
}

// what the brains see of the stage, both sides the same and without delay: it is the ground, not the opponent
function arenaView(fight) {
  if (!fight.props) return {};
  const P = ARENA.objects;
  return { props: fight.props.filter((o) => !o.used).map((o) => ({ id: o.id, x: o.x, in: Math.max(0, P.from - fight.tick), reach: P.reach, startup: P.startup, total: P.total, damage: P.damage, speed: P.speed })) };
}

export function stepFight(fight, rawActions) {
  const events = [];
  const finished = fight.over;
  if (fight.freeze > 0) {
    fight.freeze--;
    if (fight.freeze === 0) events.push({ type: 'superGo', side: fight.freezeSide });
    return events;
  }
  if (fight.hitstop > 0) {
    fight.hitstop--;
    return events;
  }
  fight.tick++;
  if (!finished) fight.timer--;

  const acts = finished ? [IDLE_ACTION, IDLE_ACTION] : [sanitizeAction(rawActions?.[0]), sanitizeAction(rawActions?.[1])];
  const [A, B] = fight.f;
  // the state at the start of this tick, kept for C.REACTION_TICKS: brains and abilities see the opponent that late
  recordSight(fight);
  for (const F of fight.f) F.px = F.x;

  if (!finished) {
    think(fight, A, B, acts[0], events);
    think(fight, B, A, acts[1], events);
    if (fight.freeze > 0) return events;
  }
  if (finished) settleWinner(fight);
  advance(fight, A, B, events);
  advance(fight, B, A, events);

  // walls and push boxes
  for (const F of fight.f) {
    const before = F.x;
    F.x = clamp(F.x, WALL_L, WALL_R);
    if (F.state === 'juggle' && before !== F.x && Math.abs(F.vx) > 6 && !F.comboWall) {
      F.comboWall = true;
      F.vx = -F.vx * 0.5;
      F.vy = Math.max(F.vy, 9);
      events.push({ type: 'wall', side: F.side, x: F.x, y: F.y + 150 });
    } else if (before !== F.x && (F.state === 'hitstun' || F.state === 'blockstun')) {
      // cornered: the attacker takes the push-back instead
      const O = fight.f[1 - F.side];
      if (Math.abs(O.x - F.x) < 300 && !airborne(O)) O.x = clamp(O.x - (before - F.x), WALL_L, WALL_R);
      F.vx = 0;
    }
  }
  if (A.y < 120 && B.y < 120 && !['grabbed', 'thrown'].includes(A.state) && !['grabbed', 'thrown'].includes(B.state)) {
    const dx = B.x - A.x;
    const gap = Math.abs(dx);
    if (gap < C.PUSH_WIDTH) {
      const dir = dx === 0 ? A.facing : sign(dx);
      const need = C.PUSH_WIDTH - gap;
      let pa = need / 2;
      let pb = need / 2;
      if (A.x - dir * pa < WALL_L || A.x - dir * pa > WALL_R) {
        pb += pa;
        pa = 0;
      }
      if (B.x + dir * pb < WALL_L || B.x + dir * pb > WALL_R) {
        pa += pb;
        pb = 0;
      }
      A.x = clamp(A.x - dir * pa, WALL_L, WALL_R);
      B.x = clamp(B.x + dir * pb, WALL_L, WALL_R);
    }
  }
  for (const F of fight.f) {
    const O = fight.f[1 - F.side];
    if (!airborne(F) && ['neutral', 'landing', 'blockstun', 'getup', 'dizzy', 'prejump'].includes(F.state) && O.x !== F.x) F.facing = O.x > F.x ? 1 : -1;
  }

  if (!finished) {
    // throws first: a throw that connects this tick beats strikes that would land on the same tick
    resolveThrows(fight, events);
    // strikes: compute both sides, then apply (trades are possible)
    const conns = [strikeConnections(A, B), strikeConnections(B, A)];
    for (let s = 0; s < 2; s++) {
      if (!conns[s]) continue;
      const sh = fight.f[s].move.segHits[conns[s].seg];
      sh.done++;
      sh.lastT = fight.f[s].move.t;
      fight.f[s].move.touched = true; // R4: not a whiff (marked before the trade can drop the move)
    }
    // W5: an active strike that reaches the opponent's wall breaks into it, once a hit of the segment
    for (const F of fight.f) {
      const seg = currentSegment(F);
      if (!seg || seg.type !== 'strike' || F.move.t < seg.activeStart || F.move.t >= seg.activeEnd) continue;
      const sh = F.move.segHits[F.move.def.segments.indexOf(seg)];
      sh.walls ||= new Set();
      strikeWalls(fight, F, strikeBox(F, seg), seg.p.damage, sh.walls, events);
    }
    for (let s = 0; s < 2; s++) {
      const c = conns[s];
      if (!c) continue;
      const F = fight.f[s];
      const O = fight.f[1 - s];
      const out = {};
      connect(fight, F, O, c.src, events, out);
      if (out.parried && F.state === 'move') {
        F.move = null;
        setState(F, 'staggered', C.PARRY_STAGGER);
      }
    }
    // projectiles
    for (const p of fight.projectiles) {
      if (p.dead) continue;
      p.x += p.vx;
      p.life--;
      if (p.life <= 0 || p.x < WALL_L - 100 || p.x > WALL_R + 100) p.dead = true;
    }
    const live = fight.projectiles.filter((p) => !p.dead);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const p = live[i];
        const q = live[j];
        if (p.owner !== q.owner && !p.dead && !q.dead && Math.abs(p.x - q.x) < PROJECTILE.size && Math.abs(p.y - q.y) < PROJECTILE.size) {
          p.dead = true;
          q.dead = true;
          events.push({ type: 'clash', x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        }
      }
    }
    for (const p of live) {
      if (p.dead || fight.tick < p.nextHit) continue;
      const owner = fight.f[p.owner];
      const V = fight.f[1 - p.owner];
      const h = PROJECTILE.size / 2;
      const box = [p.x - h, p.y - h, p.x + h, p.y + h];
      if (!hurtboxes(V).some((hb) => overlap(box, hb))) continue;
      const out = {};
      const superMove = p.super ? { superDealt: p.superDealt || 0 } : null;
      connect(fight, owner, V, { zone: p.zone, damage: p.damage, chargeMul: p.chargeMul, launch: !!p.stage, push: p.stage ? 'heavy' : 'light', moveId: p.move, superMove, x: p.x, y: p.y, projectile: true, attack: p }, events, out);
      if (superMove) p.superDealt = superMove.superDealt;
      p.done++;
      p.nextHit = fight.tick + 6;
      if (out.parried || p.done >= p.hits) p.dead = true;
    }
    for (const p of fight.projectiles) {
      if (p.dead) {
        const owner = fight.f[p.owner];
        if (owner.projectile === p.id) owner.projectile = null;
        events.push({ type: 'projectileEnd', id: p.id, x: p.x, y: p.y });
      }
    }
    fight.projectiles = fight.projectiles.filter((p) => !p.dead);

    // abilities: passive hooks, new casts, running casts, objects, effects
    abilityPhase(fight, events, RING);
    for (const F of fight.f) pressureTick(fight, F, events);

    if (fight.over && fight.endReason === 'ko' && A.hp <= 0 && B.hp <= 0 && fight.tick === fight.endTick) {
      fight.winner = null;
      fight.endEvent.winner = null;
      fight.endEvent.double = true;
    }
    for (const F of fight.f) {
      F.stunIdle++;
      if (F.stunIdle > C.STUN_DECAY_DELAY && F.stun > 0 && !F.dizzyPending) F.stun = Math.max(0, F.stun - C.STUN_DECAY);
      // P3: ether refills; B1: the guard gauge drains after a while without a block
      if (F.ether < C.ETHER.max) F.ether = Math.min(C.ETHER.max, F.ether + C.ETHER.regen);
      if (++F.guardIdle > C.GUARD_GAUGE.idle) F.guardGauge = Math.max(0, F.guardGauge - C.GUARD_GAUGE.decay);
    }
    if (!fight.over) passivity(fight, events);
    for (const F of fight.f) if (F.wait > 0) F.wait--;
    if (!fight.over && fight.timer <= 0) {
      const ra = A.hp / A.maxHp;
      const rb = B.hp / B.maxHp;
      endFight(fight, ra > rb ? 0 : rb > ra ? 1 : null, 'time', events);
    }
  }
  return events;
}

// B1: the guard gauge of a defender grows; at its max the guard breaks. attack: the move, projectile or cast the
// block came from — one attack adds at most GUARD_GAUGE.perAttack
function addGuard(fight, A, V, amount, events, attack = null) {
  V.guardIdle = 0;
  if (attack) {
    fight.gaugeFrom ||= new WeakMap();
    const had = fight.gaugeFrom.get(attack) || 0;
    amount = Math.max(0, Math.min(amount, C.GUARD_GAUGE.perAttack - had));
    fight.gaugeFrom.set(attack, had + amount);
  }
  V.guardGauge = Math.min(C.GUARD_GAUGE.max, V.guardGauge + amount);
  if (V.guardGauge < C.GUARD_GAUGE.max) return;
  V.guardGauge = 0;
  V.guard = null;
  V.move = null;
  setState(V, 'staggered', C.GUARD_GAUGE.crushTicks);
  V.posture = 'stand';
  V.vx = 0;
  addMeter(A, C.GUARD_GAUGE.crushMeter, true);
  V.tally.crushes++;
  events.push({ type: 'guardCrush', side: V.side, attacker: A.side, x: V.x, y: V.y + 150 });
}

// B4: is the fighter holding a block against a box with control (any guard, on the ground, able to block)
function guarding(V) {
  return !airborne(V) && (V.state === 'neutral' || V.state === 'blockstun') && !!V.guard;
}

// B4: a parry of a control box: the parry's reward, no effect
function parryBox(fight, A, V, events, x, y) {
  V.tally.parries++;
  addMeter(V, 20, true);
  const r = toNeutral(V);
  if (r) events.push({ type: 'dizzy', side: V.side });
  fight.hitstop = Math.max(fight.hitstop, C.PARRY_HITSTOP);
  events.push({ type: 'parry', side: V.side, attacker: A.side, x, y });
}

// C3: passivity — far from the opponent, in neutral, not coming closer
function passivity(fight, events) {
  const P = C.PASSIVE;
  for (const F of fight.f) {
    const O = fight.f[1 - F.side];
    if (F.wait > 0) continue;
    const toward = (F.x - F.px) * (sign(O.px - F.px) || F.facing);
    if (toward > 0.5) F.passive = Math.max(0, F.passive - P.forward);
    else if (Math.abs(O.x - F.x) > P.far && ['neutral', 'dash', 'landing', 'prejump', 'air'].includes(F.state)) F.passive++;
    if (F.passive < P.max) continue;
    F.passive = P.after;
    F.ether = 0;
    F.meter = Math.max(0, F.meter - P.meterLoss);
    addMeter(O, P.meterGain, true);
    F.tally.passives++;
    events.push({ type: 'passive', side: F.side, x: F.x, y: F.y + 150 });
  }
}

// Internals the ability runtime (ability.js) works through, so ability hits and moves follow the common rules.
const RING = { connect, hurtboxes, overlap, setState, applyDamage, endFight, airborne, guarding, parryActive, parryBox, addGuard, brainView: (fight, side) => abilityView(fight, side) };

// ---------- what the brains see ----------

function movesSummary(def) {
  return Object.freeze(def.moves.map((m) => Object.freeze({
    id: m.id,
    name: m.name,
    slot: m.slot,
    posture: m.posture,
    duration: m.duration,
    firstActive: m.firstActive,
    totalDamage: m.totalDamage,
    armor: m.armor,
    charge: m.charge ? Object.freeze({ maxHold: m.charge.maxHold, bonus: m.charge.bonus }) : null,
    stance: m.stance,
    cooldown: m.ability?.cooldown ?? 0,
    ability: m.ability ? Object.freeze({ cooldown: m.ability.cooldown, cost: m.ability.cost, power: m.ability.power, measured: m.ability.measured ? Object.freeze({ ...m.ability.measured }) : null }) : null,
    segments: Object.freeze(m.segments.map((s) => Object.freeze({ type: s.type, start: s.start, activeStart: s.activeStart, activeEnd: s.activeEnd, end: s.end, ...s.p }))),
  })));
}
const summaries = new WeakMap();

function fighterView(fight, F) {
  if (!summaries.has(F.def)) summaries.set(F.def, movesSummary(F.def));
  let move = null;
  if (F.state === 'move' && F.move) {
    const seg = currentSegment(F);
    const t = F.move.t;
    move = {
      id: F.move.def.id,
      slot: F.move.def.slot,
      t,
      duration: F.move.def.duration + (F.move.extra || 0),
      held: F.move.held,
      phase: !seg ? 'recovery' : t < seg.activeStart ? 'startup' : t < seg.activeEnd ? 'active' : 'recovery',
      segment: seg ? F.move.def.segments.indexOf(seg) : -1,
      armorLeft: F.move.armorLeft,
    };
  }
  return {
    x: F.x,
    y: F.y,
    vx: F.vx,
    vy: F.vy,
    facing: F.facing,
    hp: F.hp,
    maxHp: F.maxHp,
    meter: F.meter,
    bars: Math.floor(F.meter / C.METER_BAR),
    stun: F.stun,
    stunMax: C.STUN_MAX,
    state: F.state,
    stateTicks: F.st,
    stateLength: F.len,
    posture: F.posture,
    airborne: airborne(F),
    canAct: F.state === 'neutral' && !F.mods.stop,
    canAirMove: F.state === 'air' && !F.airMoveUsed,
    guard: F.guard,
    invulnerable: hasNoHurtbox(F),
    combo: F.combo,
    pressure: F.pressure,
    pressureMax: C.PRESSURE_MAX,
    projectileOut: !!F.projectile,
    move,
    // ring 3.0
    ether: F.ether,
    etherMax: C.ETHER.max,
    guardGauge: F.guardGauge,
    guardGaugeMax: C.GUARD_GAUGE.max,
    passive: F.passive,
    passiveMax: C.PASSIVE.max,
    waiting: F.wait > 0,
    stale: Object.fromEntries([...new Set(F.stale)].map((id) => [id, Math.round(staleMul(F, id) * 100) / 100])), // S1: id → share of damage left
    lastLine: F.lastLine,
    stats: F.def.stats,
    derived: F.def.derived,
    moves: summaries.get(F.def),
    ...abilityFighterView(F),
  };
}

// Reaction (ring 2.8). A brain sees itself as it is, and the opponent — his fighter, projectiles, objects and the hits
// of his abilities — as they were C.REACTION_TICKS ago, like a player who reacts in a quarter of a second (the AI
// fighting-game competition FightingICE gives its bots the same 15-frame delay). A move faster than that cannot be
// blocked on sight, only read in advance: high or low, throw or block. Without it a brain blocked everything on sight
// and the only way through was a hole in the rules (the league of 17.11.2026).
export function recordSight(fight) {
  if (fight.sightTick === fight.tick) return;
  fight.sightTick = fight.tick;
  fight.sight ||= [];
  fight.sight.push({
    tick: fight.tick,
    f: fight.f.map((F) => fighterView(fight, F)),
    projectiles: fight.projectiles.map((p) => ({ x: p.x, y: p.y, vx: p.vx, zone: p.zone, damage: p.damage, owner: p.owner, hitsLeft: p.hits - p.done })),
    objects: [0, 1].map((s) => objectsView(fight, s).filter((o) => !o.mine)),
    strikes: [0, 1].map((s) => pendingView(fight, s).filter((o) => !o.mine)),
  });
  while (fight.sight.length > fight.reaction + 2) fight.sight.shift();
}

function sightOf(fight) {
  const at = fight.tick - fight.reaction;
  let best = fight.sight?.[0] ?? null;
  for (const s of fight.sight || []) if (s.tick <= at) best = s;
  return best;
}

// live: true — without the delay (a human player at the keyboard has his own reaction; the judge's tools)
export function brainView(fight, side, { live = false } = {}) {
  const me = fight.f[side];
  const op = fight.f[1 - side];
  const late = live ? null : sightOf(fight);
  if (late) {
    const meView = fighterView(fight, me);
    const opView = late.f[1 - side];
    return {
      tick: fight.tick,
      timeLeft: fight.timer,
      tickRate: C.TICK_RATE,
      side,
      stage: { left: WALL_L, right: WALL_R },
    ...arenaView(fight),
      ...arenaView(fight),
      reaction: fight.reaction,
      me: meView,
      opponent: opView,
      distance: Math.abs(opView.x - me.x),
      projectiles: [
        ...fight.projectiles.filter((p) => p.owner === side).map((p) => ({ x: p.x, y: p.y, vx: p.vx, zone: p.zone, damage: p.damage, mine: true, hitsLeft: p.hits - p.done })),
        ...late.projectiles.filter((p) => p.owner !== side).map(({ owner, ...p }) => ({ ...p, mine: false })),
      ],
      objects: [...objectsView(fight, side).filter((o) => o.mine), ...late.objects[side]],
      strikes: [...pendingView(fight, side).filter((p) => p.mine), ...late.strikes[side].map((p) => ({ ...p, in: p.in - (fight.tick - late.tick) }))],
      lines: me.def.voice.lines.map((l) => ({ id: l.id, kind: l.kind })),
    };
  }
  return {
    tick: fight.tick,
    timeLeft: fight.timer,
    tickRate: C.TICK_RATE,
    side,
    stage: { left: WALL_L, right: WALL_R },
    ...arenaView(fight),
    reaction: fight.reaction,
    me: fighterView(fight, me),
    opponent: fighterView(fight, op),
    distance: Math.abs(op.x - me.x),
    projectiles: fight.projectiles.map((p) => ({ x: p.x, y: p.y, vx: p.vx, zone: p.zone, damage: p.damage, mine: p.owner === side, hitsLeft: p.hits - p.done })),
    objects: objectsView(fight, side),
    strikes: pendingView(fight, side),
    lines: me.def.voice.lines.map((l) => ({ id: l.id, kind: l.kind })),
  };
}

// What api.view() gives an ability: the brain's view with the opponent as the brains saw him at the start of the tick.
export function abilityView(fight, side) {
  return brainView(fight, side);
}

// For the renderer and tests: boxes of the current tick.
export function debugBoxes(fight) {
  return fight.f.map((F) => {
    const seg = currentSegment(F);
    const t = F.move?.t;
    return {
      hurt: hurtboxes(F),
      hit: seg && seg.type === 'strike' && t >= seg.activeStart && t < seg.activeEnd ? [strikeBox(F, seg)] : [],
    };
  });
}

// Cheap fingerprint of the full state, for replay checks.
// what the renderer draws of the stage objects: records shaped like ability objects
export function arenaObjects(fight) {
  return (fight.props || []).filter((o) => !o.used).map((o) => ({ id: `prop${o.id}`, side: 0, x: o.x, y: 55, w: 70, h: 90, vx: 0, vy: 0, facing: 1, glow: true, particles: 0, color: '#ffb347', label: 'ПРЕДМЕТ', age: 9, life: 99 }));
}

export function fightHash(fight) {
  let h = 2166136261;
  const mix = (v) => {
    const s = typeof v === 'number' ? v.toFixed(6) : String(v);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  };
  mix(fight.tick);
  mix(fight.timer);
  mix(fight.hitstop);
  mix(fight.freeze);
  for (const o of fight.props || []) mix(`${o.id}:${o.x}:${o.used}`);
  for (const F of fight.f) {
    for (const k of ['x', 'y', 'vx', 'vy', 'facing', 'hp', 'meter', 'stun', 'state', 'st', 'posture', 'combo', 'invuln', 'pressure', 'guardAny', 'ether', 'guardGauge', 'passive', 'wait']) mix(F[k]);
    mix(F.stale.join(','));
    mix(F.move ? `${F.move.def.id}:${F.move.t}:${F.move.held}` : '-');
  }
  for (const p of fight.projectiles) for (const k of ['x', 'y', 'done', 'life']) mix(p[k]);
  abilityHash(fight, mix);
  return (h >>> 0).toString(16);
}
