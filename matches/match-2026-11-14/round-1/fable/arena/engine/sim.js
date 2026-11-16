// Fight simulation. Pure and deterministic: no DOM, no Node APIs, no wall clock; randomness only from the fight's seed.
// The same file runs the sandbox, the judge and the viewer, so a fight replays tick for tick from its inputs.
import * as C from './constants.js';
import { initAbilityFighter, newAbilityStats, hasAbilities, seedRng, queueCast, abilityPhase, abilityFighterView, objectsView, abilityHash } from './ability.js';

const { STAGE, HURTBOX, REACH, ZONE_Y, PROJECTILE, THROW } = C;
const WALL_L = 40;
const WALL_R = STAGE.width - 40;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const STAGE_BOUNDS = { left: WALL_L, right: WALL_R, width: STAGE.width };

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
    combo: 0,
    comboWall: false,
    dizzyPending: false,
    sayCooldown: 0,
    sayCount: {},
    lastLine: null,
    projectile: null,
    grab: null,
    tally: { damageDealt: 0, damageTaken: 0, hits: 0, blocked: 0, parries: 0, throws: 0, techs: 0, maxCombo: 0, supers: 0, armorHits: 0 },
  };
}

export const RING_SEED = 1;

// seed: the ring's seed for api.rand() of abilities (kept in the fight record). clock: optional timer for hook stats only.
export function createFight({ fighters, seed = RING_SEED, clock = null }) {
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
  };
  fight.f.forEach((F) => initAbilityFighter(F, F.def));
  return fight;
}

// The ring picks lines it says on its own (intro, victory, defeat, super) in a fixed rotation.
export function ringLine(def, kind, n = 0) {
  const list = def.voice.lines.filter((l) => l.kind === kind);
  return list.length ? list[n % list.length].id : null;
}

// ---------- input ----------

export const IDLE_ACTION = Object.freeze({ walk: 0, crouch: false, jump: null, dash: null, guard: null, parry: false, attack: null, hold: false, throw: false, tech: false, say: null });

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
    tech: !!a.tech,
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
  F.combo = 0;
  F.comboWall = false;
  if (F.dizzyPending) {
    F.dizzyPending = false;
    F.stun = 0;
    setState(F, 'dizzy', C.DIZZY_TICKS);
    return 'dizzy';
  }
  return null;
}

function canAct(F) {
  return F.state === 'neutral';
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
  if (F.invuln > 0) return true;
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
  if (V.guard === 'high') return zone !== 'low';
  if (V.guard === 'low') return zone === 'mid' || zone === 'low';
  return false;
}

function parryActive(V) {
  return V.state === 'parry' && V.st <= C.PARRY_WINDOW;
}

// raw: a fixed reward (a parry), not damage to scale by METER_GAIN
function addMeter(F, v, raw = false) {
  F.meter = Math.min(C.METER_MAX, F.meter + v * (raw ? 1 : C.METER_GAIN));
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
  F.move = { def: m, t: 0, held: 0, segHits: m.segments.map(() => ({ done: 0, lastT: -99 })), armorLeft: m.armor, superDealt: 0, started: new Set() };
  setState(F, 'move', m.duration);
  F.holding = false;
  F.guard = null;
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
  return true;
}

function think(fight, F, O, a, events) {
  if (F.mods.stop) a = IDLE_ACTION;
  if (a.say) say(fight, F, a.say, events);
  if (F.state === 'grabbed') {
    if ((a.tech || a.throw) && F.st <= THROW.techWindow) F.techRequest = true;
    return;
  }
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
  if (!canAct(F)) return;

  const m = a.attack ? F.def.movesById[a.attack] : null;
  if (m && m.posture !== 'air' && moveAllowed(F, m)) {
    startMove(fight, F, O, m, events);
    return;
  }
  if (a.throw) {
    setState(F, 'throw', THROW.startup + THROW.active + THROW.whiff);
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
  if (m.t >= d.duration) {
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
  if (F.sayCooldown > 0) F.sayCooldown--;
  const back = () => {
    const r = toNeutral(F);
    if (r) events.push({ type: 'dizzy', side: F.side });
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
        else back();
      }
      break;
    case 'knockdown':
      if (F.st >= F.len) setState(F, 'getup', C.GETUP_TICKS);
      break;
    case 'getup':
      if (F.st >= F.len) back();
      break;
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
        const dmg = damageFor(A, F, THROW.damage * C.THROW_MUL, { cap: false });
        applyDamage(A, F, dmg);
        F.combo = 1;
        addMeter(A, THROW.damage * 0.6);
        addMeter(F, THROW.damage * 0.4);
        A.tally.throws++;
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
  let dmg = base * A.def.derived.damageMul * V.def.derived.takenMul * V.mods.taken * (counter ? C.COUNTER_MUL : 1) * chargeMul * scale * (superMove ? C.SUPER_MUL : 1);
  dmg = Math.round(dmg);
  if (superMove) dmg = Math.min(dmg, Math.floor(C.SUPER_TOTAL_CAP * V.maxHp) - superMove.superDealt);
  else if (cap) dmg = Math.min(dmg, Math.floor(C.NORMAL_HIT_CAP * V.maxHp / C.HP_MUL));
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
  if (parryActive(V)) {
    out.parried = true;
    out.result = 'parry';
    V.tally.parries++;
    addMeter(V, 20, true);
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
    setState(V, 'blockstun', 10 + Math.floor(base / 10));
    V.posture = V.guard === 'low' ? 'crouch' : 'stand';
    V.vx = A.facing * (src.push === 'heavy' ? 7 : 4.5);
    A.tally.blocked++;
    addMeter(A, base * 0.3);
    addMeter(V, base * 0.2);
    fight.hitstop = Math.max(fight.hitstop, 4 + Math.floor(base / 20));
    events.push({ type: 'block', side: V.side, attacker: A.side, move: src.moveId, x: src.x, y: src.y, zone: src.zone });
    return;
  }
  // clean hit
  out.result = 'hit';
  const counter = V.state === 'move' && V.move.t < V.move.def.firstActive;
  const dmg = damageFor(A, V, base, { counter, chargeMul: src.chargeMul, superMove: src.superMove });
  applyDamage(A, V, dmg);
  if (src.superMove) src.superMove.superDealt += dmg;
  V.combo++;
  V.tally.maxCombo = Math.max(V.tally.maxCombo, V.combo);
  A.tally.hits++;
  if (!src.superMove) addMeter(A, base * 0.6);
  addMeter(V, base * 0.4);
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
    V.invuln = C.COMBO_INVULN_TICKS;
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
      zone: seg.p.zone, damage: seg.p.damage, chargeMul, launch: seg.p.launch, push: seg.p.push, moveId: m.def.id,
      superMove: m.def.slot === 'super' ? m : null,
      x: (Math.max(box[0], hb[0]) + Math.min(box[2], hb[2])) / 2,
      y: (Math.max(box[1], hb[1]) + Math.min(box[3], hb[3])) / 2,
    },
  };
}

function throwable(V) {
  if (airborne(V) || V.invuln > 0) return false;
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
  const ta = throwActive(a) && inThrowRange(a, b) && throwable(b);
  const tb = throwActive(b) && inThrowRange(b, a) && throwable(a);
  if (ta && tb) {
    techBreak(a, b, events);
    return;
  }
  for (const [A, V, ok] of [[a, b, ta], [b, a, tb]]) {
    if (!ok) continue;
    if (V.state === 'move' && V.move.def.slot === 'super' && V.move.t < V.move.def.firstActive) continue;
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

  if (!finished) {
    for (const F of fight.f) if (F.state === 'grabbed' && F.techRequest) {
      techBreak(F, fight.f[1 - F.side], events);
      F.techRequest = false;
    }
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
      connect(fight, owner, V, { zone: p.zone, damage: p.damage, chargeMul: p.chargeMul, launch: false, push: 'light', moveId: p.move, superMove, x: p.x, y: p.y }, events, out);
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

    if (fight.over && fight.endReason === 'ko' && A.hp <= 0 && B.hp <= 0 && fight.tick === fight.endTick) {
      fight.winner = null;
      fight.endEvent.winner = null;
      fight.endEvent.double = true;
    }
    for (const F of fight.f) {
      F.stunIdle++;
      if (F.stunIdle > C.STUN_DECAY_DELAY && F.stun > 0 && !F.dizzyPending) F.stun = Math.max(0, F.stun - C.STUN_DECAY);
    }
    if (!fight.over && fight.timer <= 0) {
      const ra = A.hp / A.maxHp;
      const rb = B.hp / B.maxHp;
      endFight(fight, ra > rb ? 0 : rb > ra ? 1 : null, 'time', events);
    }
  }
  return events;
}

// Internals the ability runtime (ability.js) works through, so ability hits and moves follow the common rules.
const RING = { connect, hurtboxes, overlap, setState, applyDamage, endFight, brainView: (fight, side) => brainView(fight, side) };

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
      duration: F.move.def.duration,
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
    projectileOut: !!F.projectile,
    move,
    lastLine: F.lastLine,
    stats: F.def.stats,
    derived: F.def.derived,
    moves: summaries.get(F.def),
    ...abilityFighterView(F),
  };
}

export function brainView(fight, side) {
  const me = fight.f[side];
  const op = fight.f[1 - side];
  return {
    tick: fight.tick,
    timeLeft: fight.timer,
    tickRate: C.TICK_RATE,
    side,
    stage: { left: WALL_L, right: WALL_R },
    me: fighterView(fight, me),
    opponent: fighterView(fight, op),
    distance: Math.abs(op.x - me.x),
    projectiles: fight.projectiles.map((p) => ({ x: p.x, y: p.y, vx: p.vx, zone: p.zone, damage: p.damage, mine: p.owner === side, hitsLeft: p.hits - p.done })),
    objects: objectsView(fight, side),
    lines: me.def.voice.lines.map((l) => ({ id: l.id, kind: l.kind })),
  };
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
  for (const F of fight.f) {
    for (const k of ['x', 'y', 'vx', 'vy', 'facing', 'hp', 'meter', 'stun', 'state', 'st', 'posture', 'combo', 'invuln']) mix(F[k]);
    mix(F.move ? `${F.move.def.id}:${F.move.t}:${F.move.held}` : '-');
  }
  for (const p of fight.projectiles) for (const k of ['x', 'y', 'done', 'life']) mix(p[k]);
  abilityHash(fight, mix);
  return (h >>> 0).toString(16);
}
