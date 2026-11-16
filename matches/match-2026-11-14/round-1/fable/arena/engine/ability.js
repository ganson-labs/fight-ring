// Ability runtime: code a fighter writes itself, run synchronously inside stepFight on the ring's primitives.
// Deterministic: hooks see only `api`; randomness comes from the ring's seeded generator; Math.random, Date and
// performance are switched off while a hook runs. Every primitive is limited (constants.js → ABILITY): the fight
// cuts what goes beyond, the stats remember it for `arena check`. sim.js hands its internals in as `ring`.
import * as C from './constants.js';
import { meterOpen, meterClose, meterTripped, meterMessage } from './meter.js';

const L = C.ABILITY;
const WALL_L = 40; // the same walls as sim.js
const WALL_R = C.STAGE.width - 40;
const ZONES = ['high', 'mid', 'low', 'overhead'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const num = (v, d) => (v === undefined || v === null ? d : typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---------- seeded randomness ----------

export function seedRng(seed, side) {
  let h = (Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) + side * 0x632be5ab) >>> 0;
  h ^= h >>> 13;
  return h >>> 0 || 1;
}

function nextRand(fight, side) {
  let s = (fight.rng[side] = (fight.rng[side] + 0x6d2b79f5) >>> 0);
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

// ---------- state ----------

export function newAbilityStats() {
  return { calls: 0, hooks: 0, ms: { n: 0, sum: 0, max: 0 }, cuts: {}, errors: [], images: new Set() };
}

export function initAbilityFighter(F, def) {
  F.stance = null;
  F.res = Object.fromEntries((def.resources || []).map((r) => [r.id, r.start]));
  F.effects = [];
  F.cooldowns = {};
  F.mem = Object.fromEntries((def.abilityScripts || []).map((s) => [s, {}]));
  F.cc = [];
  F.stopUsed = 0; // ticks of stop this fighter took this round (L.stopRound)
  F.abilityOff = {};
  F.pendingCasts = [];
  F.abCalls = 0;
  F.shoveLeft = [L.shovePerTick, L.shovePerTick];
  F.mods = { speed: 1, taken: 1, stop: false };
}

export function hasAbilities(def) {
  return !!(def.abilityScripts && def.abilityScripts.length);
}

function cut(fight, side, msg) {
  const c = fight.abilityStats[side].cuts;
  c[msg] = (c[msg] || 0) + 1;
}

function recomputeMods(V) {
  let speed = 1;
  let taken = 1;
  let stop = false;
  for (const e of V.effects) {
    speed *= e.speed;
    taken *= e.taken;
    stop = stop || e.stop;
  }
  V.mods = { speed: clamp(speed, L.speed[0], L.speed[1]), taken: clamp(taken, L.taken[0], L.taken[1]), stop };
}

// ---------- the guard: no clock and no Math.random while ability code runs ----------

const banned = (what) => () => {
  throw new Error(`${what} недоступен способности: случайность — api.rand(), время — api.tick и api.t`);
};
let guardDepth = 0;
let saved = null;
function enterGuard() {
  if (guardDepth++ > 0) return;
  const g = globalThis;
  saved = { random: Math.random, Date: g.Date, perfNow: g.performance ? g.performance.now : undefined };
  Math.random = banned('Math.random');
  const NoDate = function () {
    throw new Error('Date недоступен способности: время — api.tick и api.t');
  };
  NoDate.now = banned('Date.now');
  g.Date = NoDate;
  if (g.performance) {
    try {
      g.performance.now = banned('performance.now');
    } catch {}
  }
}
function exitGuard() {
  if (--guardDepth > 0) return;
  const g = globalThis;
  Math.random = saved.random;
  g.Date = saved.Date;
  if (g.performance) {
    try {
      delete g.performance.now;
      if (g.performance.now !== saved.perfNow) g.performance.now = saved.perfNow;
    } catch {}
  }
  saved = null;
}

// ---------- hooks ----------

function disable(fight, F, script, err, events) {
  if (F.abilityOff[script]) return;
  const reason = String(err?.message || err).split('\n')[0].slice(0, 300);
  F.abilityOff[script] = reason;
  fight.abilityStats[F.side].errors.push({ script, tick: fight.tick, message: reason });
  events.push({ type: 'abilityOff', side: F.side, script, reason });
  for (const o of fight.objects) if (o.side === F.side && o.script === script && !o.dead) killObject(fight, o, events);
  for (const c of fight.casts) if (c.side === F.side && c.script === script) c.ended = true;
}

// hook: its name for the participant (start, tick, passive, tick объекта). Rewritten ability code counts its steps
// (meter.js): past the budget the hook stops, and the ability is switched off even if its own code caught that.
function callHook(ctx, fn, args, hook) {
  const { fight, F, script, events } = ctx;
  if (F.abilityOff[script]) return;
  const st = fight.abilityStats[F.side];
  st.hooks++;
  const t0 = fight.clock ? fight.clock.call(null) : 0;
  const { api, close } = makeApi(ctx);
  const over = () => `хук ${hook}: ${meterMessage(meterTripped())}`;
  meterOpen();
  try {
    const r = fn(api, ...args);
    if (r && typeof r.then === 'function') throw new Error('хук вернул Promise: хуки способности синхронные, без async и await');
  } catch (err) {
    disable(fight, F, script, meterTripped() ? over() : err, events);
  } finally {
    if (meterTripped()) disable(fight, F, script, over(), events);
    meterClose();
    close();
    if (fight.clock) {
      const ms = fight.clock.call(null) - t0;
      st.ms.n++;
      st.ms.sum += ms;
      if (ms > st.ms.max) st.ms.max = ms;
    }
  }
}

// ---------- primitives ----------

function makeApi(ctx) {
  const { fight, F, O, cast, obj, script, passive } = ctx;
  let live = true;
  const st = fight.abilityStats[F.side];
  const call = (name) => {
    if (!live) throw new Error(`api.${name}: примитив вызван вне хука способности`);
    if (passive && !['rand', 'view', 'objects', 'resource', 'addResource', 'setStance'].includes(name)) throw new Error(`api.${name} недоступен в passive: там чтение, api.rand, api.mem, ресурс и стойка`);
    st.calls++;
    if (++F.abCalls > L.hookCallsPerTick) {
      cut(fight, F.side, `больше ${L.hookCallsPerTick} вызовов примитивов за тик: лишние не выполнены`);
      return false;
    }
    return true;
  };
  const api = {
    side: F.side,
    tick: fight.tick,
    t: cast ? cast.t : fight.tick,
    move: cast ? cast.moveId : null,
    mem: F.mem[script],
    rand: () => (call('rand') ? nextRand(fight, F.side) : 0),
    view: () => (call('view') ? ctx.ring.brainView(fight, F.side) : null),
    hit: (spec) => (call('hit') ? apiHit(ctx, spec) : 'cut'),
    effect: (target, spec) => (call('effect') ? applyEffect(ctx, target, spec, 'effect') : false),
    spawn: (spec) => (call('spawn') ? spawn(ctx, spec) : null),
    remove: (id) => {
      if (!call('remove')) return false;
      const o = id === undefined ? obj : fight.objects.find((x) => x.id === id && x.side === F.side && !x.dead);
      if (!o) return false;
      o.removeAsked = true;
      return true;
    },
    objects: () => (call('objects') ? fight.objects.filter((o) => o.side === F.side && !o.dead).map(objectView) : []),
    shove: (target, dx) => (call('shove') ? apiShove(ctx, target, dx) : 0),
    resource: (id) => (call('resource') ? (id in F.res ? F.res[id] : null) : null),
    addResource: (id, delta) => {
      if (!call('addResource')) return null;
      const r = F.def.resources.find((x) => x.id === id);
      if (!r) throw new Error(`api.addResource: нет ресурса "${id}" в fighter.json → resources`);
      const d = num(delta, 0);
      if (Number.isNaN(d)) throw new Error('api.addResource: delta — число');
      F.res[id] = clamp(F.res[id] + d, 0, r.max);
      return F.res[id];
    },
    setStance: (id) => {
      if (!call('setStance')) return false;
      const sid = id === undefined ? null : id;
      if (sid !== null && !F.def.stances.some((x) => x.id === sid)) throw new Error(`api.setStance: нет стойки "${sid}" в fighter.json → stances`);
      if (F.stance !== sid) {
        F.stance = sid;
        ctx.events.push({ type: 'stance', side: F.side, stance: sid, name: F.def.stances.find((x) => x.id === sid)?.name ?? null });
      }
      return true;
    },
    fx: (at) => {
      if (!call('fx') || !cast) return false;
      const src = source(ctx);
      const p = Array.isArray(at) ? at : [0, obj ? 0 : 150];
      const x = src.x + src.facing * num(p[0], 0);
      const y = src.y + num(p[1], 0);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('api.fx: точка [x, y] из чисел');
      ctx.events.push({ type: 'abilityFx', side: F.side, move: cast.moveId, x, y });
      return true;
    },
    end: () => {
      if (cast) cast.ended = true;
    },
  };
  return { api, close: () => (live = false) };
}

// Where boxes and spawns of this hook are measured from: the fighter's feet, or the centre of the object.
function source(ctx) {
  if (ctx.obj) return { x: ctx.obj.x, y: ctx.obj.y, facing: ctx.obj.facing };
  return { x: ctx.F.x, y: ctx.F.y, facing: ctx.F.facing };
}

function readBox(fight, side, raw, src) {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('api.hit: box — [x0, y0, x1, y1] из чисел');
  let [x0, y0, x1, y1] = raw;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  const r = L.boxReach;
  const c = [clamp(x0, -r, r), clamp(y0, -r, r), clamp(x1, -r, r), clamp(y1, -r, r)];
  if (c[2] - c[0] > L.boxMax) c[2] = c[0] + L.boxMax;
  if (c[3] - c[1] > L.boxMax) c[3] = c[1] + L.boxMax;
  if (c.some((v, i) => v !== [x0, y0, x1, y1][i])) cut(fight, side, `коробка удара больше ${L.boxMax} или дальше ${L.boxReach} от источника: обрезана`);
  const a = src.x + src.facing * c[0];
  const b = src.x + src.facing * c[2];
  return [Math.min(a, b), src.y + c[1], Math.max(a, b), src.y + c[3]];
}

function readHitSpec(fight, side, spec, superMove) {
  if (!isObj(spec)) throw new Error('api.hit: нужен объект { box, damage, zone, launch, push, effect }');
  let damage = num(spec.damage, NaN);
  if (!(damage >= 0)) throw new Error('api.hit: damage — число от 0');
  damage = Math.round(damage);
  const max = superMove ? L.hitDamageMaxSuper : L.hitDamageMax;
  if (damage > max) {
    cut(fight, side, `урон попадания ${damage} → ${max} (предел ${superMove ? 'попадания в супере' : 'попадания вне супера'})`);
    damage = max;
  }
  const zone = spec.zone ?? 'mid';
  if (!ZONES.includes(zone)) throw new Error(`api.hit: zone — одна из ${ZONES.join(', ')}`);
  const push = spec.push ?? 'light';
  if (push !== 'light' && push !== 'heavy') throw new Error('api.hit: push — "light" или "heavy"');
  if (spec.effect !== undefined && !isObj(spec.effect)) throw new Error('api.hit: effect — объект эффекта, как у api.effect');
  return { damage, zone, push, launch: !!spec.launch, effect: spec.effect };
}

// One hit through the ring's common path (block, parry, armor, combo, caps, meters, stun).
function hitCore(ctx, from, box, h) {
  const { fight, F, O, cast, events } = ctx;
  if (fight.tick - from.lastHit < L.hitEvery) return 'wait';
  const hurt = ctx.ring.hurtboxes(O);
  const hb = hurt.find((x) => ctx.ring.overlap(box, x));
  if (!hb) return 'miss';
  let damage = h.damage;
  if (cast.cap) {
    const left = Math.floor(cast.cap.damage - cast.used.damage);
    if (damage > left) {
      cut(fight, F.side, 'урон каста больше замеренного ринга: лишнее срезано');
      if (left < 1) return 'cut';
      damage = left;
    }
  }
  from.lastHit = fight.tick;
  const out = {};
  const x = (Math.max(box[0], hb[0]) + Math.min(box[2], hb[2])) / 2;
  const y = (Math.max(box[1], hb[1]) + Math.min(box[3], hb[3])) / 2;
  ctx.ring.connect(fight, F, O, { zone: h.zone, damage, chargeMul: 1, launch: h.launch, push: h.push, moveId: cast.moveId, superMove: cast.superMove, x, y, ability: true }, events, out);
  const result = out.result || 'hit';
  if (result === 'parry') {
    if (!ctx.obj && F.state === 'move' && F.move === cast.moveInst) {
      F.move = null;
      ctx.ring.setState(F, 'staggered', C.PARRY_STAGGER);
    }
    if (ctx.obj) ctx.obj.removeAsked = true;
    return result;
  }
  cast.used.damage += damage;
  if (result === 'hit' && h.effect) applyEffect(ctx, 'opponent', h.effect, 'hit');
  return result;
}

function apiHit(ctx, spec) {
  const h = readHitSpec(ctx.fight, ctx.F.side, spec, ctx.cast.superMove);
  const box = readBox(ctx.fight, ctx.F.side, spec.box, source(ctx));
  return hitCore(ctx, ctx.obj || ctx.cast, box, h);
}

// ---------- effects ----------

function effectWorth(e, onOpponent) {
  if (onOpponent) {
    return {
      damage: (e.ticks * e.dot) / C.TICK_RATE,
      control: e.ticks * ((e.stop ? 1 : 0) + Math.max(0, 1 - e.speed) + Math.abs(e.drift) / 6 + Math.max(0, e.taken - 1) * 4),
      buff: 0,
    };
  }
  return { damage: 0, control: 0, buff: e.ticks * (Math.max(0, e.speed - 1) + Math.max(0, 1 - e.taken) * 4) };
}

// A box of api.effect: [x0, y0, x1, y1] from its source like api.hit's, at most L.controlReach ahead or behind
function controlBox(ctx, raw) {
  const { fight, F } = ctx;
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('api.effect: box — [x0, y0, x1, y1] из чисел');
  const r = L.controlReach;
  const c = raw.map((v, i) => (i % 2 === 0 ? clamp(v, -r, r) : v));
  if (c.some((v, i) => v !== raw[i])) cut(fight, F.side, `коробка эффекта дальше ${r} ед. от источника: обрезана`);
  return readBox(fight, F.side, c, source(ctx));
}

const isControl = (e) => e.stop || e.speed < 1;

function dropControl(fight, side, e, why) {
  cut(fight, side, why);
  e.stop = false;
  e.speed = Math.max(1, e.speed);
}

function applyEffect(ctx, target, spec, via = 'effect') {
  const { fight, F, O, cast, events } = ctx;
  const side = F.side;
  if (target !== 'opponent' && target !== 'me') throw new Error('api.effect: цель — "opponent" или "me"');
  if (!isObj(spec)) throw new Error('api.effect: нужен объект { id, ticks, speed, taken, dot, stop, drift, label, color, icon, particles }');
  const onOpp = target === 'opponent';
  const V = onOpp ? O : F;
  let ticks = num(spec.ticks, NaN);
  if (!(ticks >= 1)) throw new Error('api.effect: ticks — число тиков от 1');
  ticks = Math.floor(ticks);
  const e = {
    id: spec.id === undefined ? 'effect' : String(spec.id).slice(0, 24),
    speed: num(spec.speed, 1),
    taken: num(spec.taken, 1),
    dot: num(spec.dot, 0),
    drift: num(spec.drift, 0),
    stop: !!spec.stop,
  };
  for (const k of ['speed', 'taken', 'dot', 'drift']) if (Number.isNaN(e[k])) throw new Error(`api.effect: ${k} — число`);
  const rail = (k, lo, hi, what) => {
    const v = clamp(e[k], lo, hi);
    if (v !== e[k]) cut(fight, side, `${what} ${e[k]} → ${v} (рамки ${lo}…${hi})`);
    e[k] = v;
  };
  rail('speed', L.speed[0], L.speed[1], 'множитель скорости');
  rail('taken', L.taken[0], L.taken[1], 'множитель получаемого урона');
  rail('dot', 0, L.dotMax, 'урон за секунду');
  rail('drift', -L.driftMax, L.driftMax, 'толчок эффекта');
  // control on the opponent: through a hit, or a box touching the opponent within reach; not at the very start of
  // a round (the measurement on the dummy is not a round start); a target stopped at most L.stopRound a round
  if (onOpp && spec.box !== undefined && via !== 'hit') {
    const box = controlBox(ctx, spec.box);
    if (!ctx.ring.hurtboxes(O).some((x) => ctx.ring.overlap(box, x))) return false;
    via = 'box';
  }
  if (onOpp && isControl(e) && via === 'effect') dropControl(fight, side, e, `контроль на соперника (stop, замедление) — только через попадание api.hit или с box в пределах ${L.controlReach} ед.: снят`);
  if (onOpp && isControl(e) && !fight.measuring && fight.tick < L.controlStart) dropControl(fight, side, e, `контроль на соперника в первые ${L.controlStart} тиков раунда: снят`);
  if (onOpp && e.stop && V.stopUsed >= L.stopRound) dropControl(fight, side, e, `соперник уже простоял ${L.stopRound} тиков за раунд: stop снят`);
  // damage over time on the opponent: like control, through a clean hit or a touching box
  if (onOpp && e.dot > 0 && via === 'effect') {
    cut(fight, side, `урон по времени на соперника — только через попадание api.hit или с box в пределах ${L.controlReach} ед.: снят`);
    e.dot = 0;
  }
  if (onOpp && !isControl(e) && e.dot === 0 && e.taken === 1 && e.drift === 0) return false;
  let maxTicks = L.effectTicks;
  if (onOpp && e.stop && L.stopRound - V.stopUsed < maxTicks) maxTicks = Math.min(maxTicks, L.stopRound - V.stopUsed);
  if (e.stop) maxTicks = Math.min(maxTicks, L.stopTicks);
  if (e.speed < 1) maxTicks = Math.min(maxTicks, L.slowTicks);
  if (ticks > maxTicks) {
    cut(fight, side, `эффект ${ticks} тиков → ${maxTicks} (предел ${onOpp && e.stop && maxTicks === L.stopRound - V.stopUsed ? `запрета действий: ${L.stopRound} тиков на соперника за раунд` : e.stop ? 'запрета действий' : e.speed < 1 ? 'замедления' : 'эффекта'})`);
    ticks = maxTicks;
  }
  if (onOpp && (e.stop || e.speed < 1)) {
    V.cc = V.cc.filter((t) => fight.tick - t < L.controlWindow);
    const k = L.controlDecay[Math.min(V.cc.length, L.controlDecay.length - 1)];
    V.cc.push(fight.tick);
    if (k < 1) {
      const t2 = Math.floor(ticks * k);
      cut(fight, side, `повторный контроль за ${L.controlWindow} тиков: ×${k}`);
      ticks = t2;
    }
    if (ticks < 1) return false;
  }
  e.ticks = ticks;
  if (cast.cap) {
    const w = effectWorth(e, onOpp);
    let scale = 1;
    for (const kind of ['damage', 'control', 'buff']) {
      if (w[kind] > 0) scale = Math.min(scale, Math.max(0, cast.cap[kind] - cast.used[kind]) / w[kind]);
    }
    if (scale < 1) {
      cut(fight, side, 'эффект каста сильнее замеренного ринга: укорочен');
      e.ticks = Math.floor(e.ticks * scale);
      if (e.ticks < 1) return false;
    }
  }
  const w = effectWorth(e, onOpp);
  for (const kind of ['damage', 'control', 'buff']) cast.used[kind] += w[kind];
  if (onOpp && e.stop) V.stopUsed += e.ticks;
  const old = V.effects.findIndex((x) => x.from === side && x.id === e.id);
  if (old >= 0) {
    events.push({ type: 'effectEnd', side: V.side, from: side, id: e.id, refresh: true });
    V.effects.splice(old, 1);
  }
  if (V.effects.filter((x) => x.from === side).length >= L.effectsMax) {
    cut(fight, side, `больше ${L.effectsMax} эффектов на одной цели: новый не наложен`);
    return false;
  }
  const label = typeof spec.label === 'string' ? spec.label.slice(0, L.labelMax) : null;
  if (typeof spec.label === 'string' && spec.label.length > L.labelMax) cut(fight, side, `подпись эффекта длиннее ${L.labelMax} знаков: обрезана`);
  const icon = typeof spec.icon === 'string' ? spec.icon : null;
  if (icon) fight.abilityStats[side].images.add(icon);
  V.effects.push({
    ...e,
    from: side,
    script: ctx.script,
    cast,
    left: e.ticks,
    dotAcc: 0,
    label,
    color: HEX.test(spec.color || '') ? spec.color : F.def.card.colors.accent,
    icon,
    particles: clamp(Math.round(num(spec.particles, 0) || 0), 0, 120),
    move: cast.moveId,
  });
  recomputeMods(V);
  events.push({ type: 'effect', side: V.side, from: side, id: e.id, move: cast.moveId, ticks: e.ticks, stop: e.stop, speed: e.speed, label, color: V.effects[V.effects.length - 1].color, icon });
  return true;
}

// ---------- moving fighters ----------

function shoveRaw(fight, A, V, dx) {
  const budget = A.shoveLeft;
  const left = budget[V.side];
  let d = clamp(dx, -left, left);
  if (d !== dx) cut(fight, A.side, `сдвиг больше ${L.shovePerTick} ед. на цель за тик: срезан`);
  if (['grabbed', 'thrown', 'throwing'].includes(V.state)) return 0;
  const before = V.x;
  V.x = clamp(V.x + d, WALL_L, WALL_R);
  const moved = V.x - before;
  budget[V.side] = left - Math.abs(d);
  return moved;
}

function apiShove(ctx, target, dx) {
  const { fight, F, O, cast } = ctx;
  if (target !== 'opponent' && target !== 'me') throw new Error('api.shove: цель — "opponent" или "me"');
  let d = num(dx, NaN);
  if (Number.isNaN(d)) throw new Error('api.shove: dx — число');
  const V = target === 'me' ? F : O;
  if (V === O && cast.cap) {
    const left = Math.max(0, cast.cap.shove - cast.used.shove);
    if (Math.abs(d) > left) {
      cut(fight, F.side, 'сдвиг соперника за каст больше замеренного: срезан');
      d = sign(d) * left;
    }
  }
  const moved = shoveRaw(fight, F, V, F.facing * d);
  if (V === O) cast.used.shove += Math.abs(moved);
  return F.facing * moved;
}

// ---------- objects ----------

function objectView(o) {
  return { id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, vx: o.vx, vy: o.vy, age: o.age, life: o.life, facing: o.facing, label: o.label, solid: o.solid, data: o.data };
}

function spawn(ctx, spec) {
  const { fight, F, cast, events } = ctx;
  if (!isObj(spec)) throw new Error('api.spawn: нужен объект { x, y, w, h, vx, vy, life, tick, touch, solid, image, color, particles, label, data }');
  if (fight.objects.filter((o) => o.side === F.side && !o.dead).length >= L.objectsMax) {
    cut(fight, F.side, `больше ${L.objectsMax} своих объектов на поле: новый не появился`);
    return null;
  }
  const src = source(ctx);
  const n = (k, d) => {
    const v = num(spec[k], d);
    if (Number.isNaN(v)) throw new Error(`api.spawn: ${k} — число`);
    return v;
  };
  const rx = clamp(n('x', 60), -L.boxReach, L.boxReach);
  const ry = clamp(n('y', ctx.obj ? 0 : 150), -L.boxReach, L.boxReach);
  const solid = !!spec.solid;
  let w = clamp(n('w', 60), 4, solid ? L.solidWidthMax : L.boxMax);
  let h = clamp(n('h', 60), 4, L.boxMax);
  if (w !== n('w', 60) || h !== n('h', 60)) cut(fight, F.side, `размер объекта вне 4…${L.boxMax} (стена до ${L.solidWidthMax} в ширину): срезан`);
  const sp = (v) => {
    const c = clamp(v, -L.objectSpeed, L.objectSpeed);
    if (c !== v) cut(fight, F.side, `скорость объекта больше ${L.objectSpeed} ед./тик: срезана`);
    return c;
  };
  let life = Math.floor(n('life', 120));
  if (life > L.objectLife) {
    cut(fight, F.side, `объект живёт ${life} тиков → ${L.objectLife}`);
    life = L.objectLife;
  }
  if (life < 1) life = 1;
  if (spec.tick !== undefined && typeof spec.tick !== 'function') throw new Error('api.spawn: tick — функция (api, o) => {}');
  let touch = null;
  if (spec.touch !== undefined) {
    touch = { ...readHitSpec(fight, F.side, spec.touch, cast.superMove), once: spec.touch.once !== false };
  }
  let data = {};
  if (spec.data !== undefined) {
    try {
      data = JSON.parse(JSON.stringify(spec.data));
    } catch {
      throw new Error('api.spawn: data — простые данные (числа, строки, списки, объекты)');
    }
  }
  const image = typeof spec.image === 'string' ? spec.image : null;
  if (image) fight.abilityStats[F.side].images.add(image);
  const o = {
    id: fight.nextId++,
    side: F.side,
    script: ctx.script,
    cast,
    move: cast.moveId,
    x: src.x + src.facing * rx,
    y: Math.max(0, src.y + ry),
    w,
    h,
    vx: sp(src.facing * n('vx', 0)),
    vy: sp(n('vy', 0)),
    life,
    age: 0,
    facing: src.facing,
    tick: spec.tick || null,
    touch,
    solid,
    image,
    color: HEX.test(spec.color || '') ? spec.color : F.def.card.colors.accent,
    glow: spec.glow !== false,
    particles: clamp(Math.round(num(spec.particles, 0) || 0), 0, 120),
    label: typeof spec.label === 'string' ? spec.label.slice(0, L.labelMax) : null,
    data,
    lastHit: -99,
    dead: false,
    removeAsked: false,
  };
  fight.objects.push(o);
  events.push({ type: 'object', side: F.side, id: o.id, move: o.move, x: o.x, y: o.y, w, h, image, color: o.color, glow: o.glow, particles: o.particles, label: o.label, solid });
  return o.id;
}

function killObject(fight, o, events) {
  if (o.dead) return;
  o.dead = true;
  events.push({ type: 'objectEnd', side: o.side, id: o.id, x: o.x, y: o.y, color: o.color });
}

function stepObject(fight, o, ring, events) {
  const F = fight.f[o.side];
  const O = fight.f[1 - o.side];
  const ctx = { fight, F, O, cast: o.cast, obj: o, script: o.script, events, ring, passive: false };
  o.age++;
  if (o.tick && !F.abilityOff[o.script]) {
    const view = objectView(o);
    callHook(ctx, o.tick, [view], 'tick объекта');
    if (o.dead) return;
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    o.x = n(view.x, o.x);
    o.y = n(view.y, o.y);
    const vx = n(view.vx, o.vx);
    const vy = n(view.vy, o.vy);
    o.vx = clamp(vx, -L.objectSpeed, L.objectSpeed);
    o.vy = clamp(vy, -L.objectSpeed, L.objectSpeed);
    if (o.vx !== vx || o.vy !== vy) cut(fight, o.side, `скорость объекта больше ${L.objectSpeed} ед./тик: срезана`);
    const maxLife = L.objectLife - o.age;
    const life = Math.floor(n(view.life, o.life));
    if (life > maxLife) cut(fight, o.side, `объект живёт дольше ${L.objectLife} тиков: срезано`);
    o.life = clamp(life, 0, maxLife);
    if (isObj(view.data)) o.data = view.data;
    if (view.facing === 1 || view.facing === -1) o.facing = view.facing;
  }
  o.x += o.vx;
  o.y = clamp(o.y + o.vy, 0, 1200);
  o.life--;
  o.cast.used.objectTicks++;
  if (o.touch && !o.removeAsked) {
    const box = [o.x - o.w / 2, o.y - o.h / 2, o.x + o.w / 2, o.y + o.h / 2];
    const r = hitCore(ctx, o, box, o.touch);
    if (o.touch.once && (r === 'hit' || r === 'block' || r === 'armor' || r === 'parry')) o.removeAsked = true;
  }
  if (o.removeAsked || o.life <= 0 || o.x < WALL_L - 300 || o.x > WALL_R + 300) killObject(fight, o, events);
}

function solidPass(fight, events) {
  for (const o of fight.objects) {
    if (o.dead || !o.solid) continue;
    const O = fight.f[1 - o.side];
    const half = o.w / 2 + 35;
    if (O.y < o.y + o.h / 2 && Math.abs(O.x - o.x) < half && !['grabbed', 'thrown'].includes(O.state)) {
      const dir = sign(O.x - o.x) || -o.facing;
      O.x = clamp(o.x + dir * half, WALL_L, WALL_R);
    }
    for (const p of fight.projectiles) {
      if (p.owner === o.side || p.dead) continue;
      if (Math.abs(p.x - o.x) < o.w / 2 + 25 && Math.abs(p.y - o.y) < o.h / 2 + 25) {
        p.dead = true;
        const owner = fight.f[p.owner];
        if (owner.projectile === p.id) owner.projectile = null;
        events.push({ type: 'clash', x: p.x, y: p.y });
        events.push({ type: 'projectileEnd', id: p.id, x: p.x, y: p.y });
      }
    }
  }
  if (fight.projectiles.some((p) => p.dead)) fight.projectiles = fight.projectiles.filter((p) => !p.dead);
}

// ---------- effects over time ----------

function stepEffects(fight, V, ring, events) {
  if (!V.effects.length) return;
  // damage over time this target took in the last second, all effects together: the rest of the cap is the room
  const dotCap = (L.dotCapShare * V.maxHp) / C.HP_MUL;
  V.dotLog = (V.dotLog || []).filter((x) => fight.tick - x[0] < C.TICK_RATE);
  V.dotRoom = Math.max(0, dotCap - V.dotLog.reduce((a, x) => a + x[1], 0));
  for (const e of V.effects) {
    e.left--;
    const A = fight.f[e.from];
    if (e.dot > 0 && !fight.over) {
      e.dotAcc += e.dot / C.TICK_RATE;
      if ((e.ticks - e.left) % L.dotEvery === 0 || e.left <= 0) {
        const base = Math.floor(e.dotAcc);
        if (base >= 1) {
          e.dotAcc -= base;
          let dmg = Math.round(base * A.def.derived.damageMul * V.def.derived.takenMul * V.mods.taken);
          const sm = e.cast.superMove;
          if (sm) dmg = Math.min(dmg, Math.floor(C.SUPER_TOTAL_CAP * V.maxHp) - sm.superDealt);
          dmg = Math.max(0, dmg);
          // a target in its block takes nothing from it, like a hit in the block
          if (dmg > 0 && (V.guard || V.state === 'blockstun')) dmg = 0;
          // all damage over time on one target together, per second
          if (dmg > V.dotRoom) {
            cut(fight, e.from, `урон по времени на одной цели сверх ${(L.dotCapShare * 100).toFixed(1)} % здоровья в секунду (все эффекты вместе): срезан`);
            dmg = Math.max(0, Math.floor(V.dotRoom));
          }
          V.dotRoom -= dmg;
          if (dmg > 0) V.dotLog.push([fight.tick, dmg]);
          if (dmg > 0) {
            ring.applyDamage(A, V, dmg);
            if (sm) sm.superDealt += dmg;
            events.push({ type: 'dot', side: V.side, from: e.from, move: e.move, id: e.id, damage: dmg, x: V.x, y: V.y + 160 });
            if (V.hp <= 0 && !['juggle', 'ko', 'knockdown'].includes(V.state)) {
              V.move = null;
              ring.setState(V, 'juggle');
              V.vy = 6;
              V.vx = 0;
              if (V.y === 0) V.y = 1;
              ring.endFight(fight, A.side, 'ko', events);
            } else if (V.hp <= 0) ring.endFight(fight, A.side, 'ko', events);
          }
        }
      }
    }
    if (e.drift && !fight.over) {
      const dir = sign(V.x - A.x) || A.facing;
      shoveRaw(fight, A, V, dir * e.drift);
    }
  }
  const before = V.effects.length;
  V.effects = V.effects.filter((e) => {
    if (e.left > 0) return true;
    events.push({ type: 'effectEnd', side: V.side, from: e.from, id: e.id });
    return false;
  });
  if (V.effects.length !== before) recomputeMods(V);
}

// ---------- the phase ----------

export function queueCast(F, seg) {
  F.pendingCasts.push({ seg, moveInst: F.move });
}

function castAlive(fight, c) {
  if (c.ended || c.t > L.castTicks) return false;
  const F = fight.f[c.side];
  if (F.state === 'move' && F.move === c.moveInst) return true;
  if (fight.objects.some((o) => o.cast === c && !o.dead)) return true;
  return fight.f.some((V) => V.effects.some((e) => e.cast === c));
}

// Runs every simulated tick after strikes and projectiles. ring: internals of sim.js.
export function abilityPhase(fight, events, ring) {
  if (!fight.hasAbilities) return;
  enterGuard();
  try {
    for (const F of fight.f) {
      F.abCalls = 0;
      F.shoveLeft = [L.shovePerTick, L.shovePerTick];
      for (const k in F.cooldowns) if (F.cooldowns[k] > 0) F.cooldowns[k]--;
    }
    const order = fight.tick % 2 ? [1, 0] : [0, 1];
    for (const s of order) {
      const F = fight.f[s];
      const O = fight.f[1 - s];
      const mods = F.def.abilities || {};
      for (const script of F.def.abilityScripts || []) {
        const m = mods[script];
        if (m?.passive) callHook({ fight, F, O, cast: null, obj: null, script, events, ring, passive: true }, m.passive, [], 'passive');
      }
      // new casts: start(api)
      const pending = F.pendingCasts;
      F.pendingCasts = [];
      for (const p of pending) {
        const d = p.moveInst.def;
        const script = d.ability.script;
        if (F.abilityOff[script]) continue;
        const c = {
          id: fight.nextId++,
          side: s,
          script,
          moveId: d.id,
          slot: d.slot,
          moveInst: p.moveInst,
          superMove: d.slot === 'super' ? p.moveInst : null,
          t: 0,
          ended: false,
          lastHit: -99,
          used: { damage: 0, control: 0, buff: 0, shove: 0, objectTicks: 0 },
          cap: fight.measuring || !d.ability.measured ? null : capOf(d.ability.measured),
          fresh: true,
        };
        fight.casts.push(c);
        if (fight.castLog) fight.castLog.push(c);
        events.push({ type: 'ability', side: s, move: d.id, cast: c.id, x: F.x, y: F.y + 150 });
        const fn = mods[script]?.start;
        if (fn) callHook({ fight, F, O, cast: c, obj: null, script, events, ring, passive: false }, fn, [], 'start');
      }
      for (const c of fight.casts) {
        if (c.side !== s) continue;
        if (c.fresh) {
          c.fresh = false;
          continue;
        }
        c.t++;
        if (!castAlive(fight, c)) {
          c.ended = true;
          continue;
        }
        const fn = mods[c.script]?.tick;
        if (fn) callHook({ fight, F, O, cast: c, obj: null, script: c.script, events, ring, passive: false }, fn, [], 'tick');
      }
    }
    for (const s of order) for (const o of fight.objects) if (o.side === s && !o.dead) stepObject(fight, o, ring, events);
    if (fight.objects.some((o) => o.dead)) fight.objects = fight.objects.filter((o) => !o.dead);
    solidPass(fight, events);
    for (const s of order) stepEffects(fight, fight.f[s], ring, events);
    fight.casts = fight.casts.filter((c) => !c.ended);
  } finally {
    exitGuard();
  }
}

function capOf(m) {
  const a = L.capAdd;
  return {
    damage: m.damage * L.capMul + a.damage,
    control: m.control * L.capMul + a.control,
    buff: m.buff * L.capMul + a.buff,
    shove: m.shove * L.capMul + a.shove,
  };
}

// ---------- what the brains see ----------

export function abilityFighterView(F) {
  return {
    stance: F.stance,
    resources: Object.fromEntries((F.def.resources || []).map((r) => [r.id, { value: F.res[r.id], max: r.max, name: r.name }])),
    effects: F.effects.map((e) => ({ id: e.id, from: e.from === F.side ? 'me' : 'opponent', move: e.move, ticks: e.ticks, left: e.left, speed: e.speed, taken: e.taken, dot: e.dot, stop: e.stop, drift: e.drift, label: e.label })),
    mods: { ...F.mods },
    cooldowns: { ...F.cooldowns },
    abilitiesOff: Object.keys(F.abilityOff),
  };
}

export function objectsView(fight, side) {
  return fight.objects.filter((o) => !o.dead).map((o) => ({ id: o.id, mine: o.side === side, move: o.move, x: o.x, y: o.y, w: o.w, h: o.h, vx: o.vx, vy: o.vy, life: o.life, solid: o.solid, label: o.label, touch: o.touch ? { damage: o.touch.damage, zone: o.touch.zone } : null }));
}

export function abilityHash(fight, mix) {
  if (!fight.hasAbilities) return;
  mix(fight.rng[0]);
  mix(fight.rng[1]);
  for (const F of fight.f) {
    mix(F.stance ?? '-');
    for (const k in F.res) mix(F.res[k]);
    for (const k in F.cooldowns) mix(`${k}:${F.cooldowns[k]}`);
    for (const e of F.effects) mix(`${e.from}:${e.id}:${e.left}`);
    for (const k in F.mem) {
      let s;
      try {
        s = JSON.stringify(F.mem[k]);
      } catch {
        s = '?';
      }
      mix(s);
    }
  }
  for (const o of fight.objects) for (const k of ['x', 'y', 'vx', 'vy', 'life']) mix(o[k]);
}
