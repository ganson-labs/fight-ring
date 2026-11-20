// The ring measures every ability itself: it casts it against a standard dummy in fixed situations,
// counts what reached the dummy, and prices the ability from that (blocks.js → abilityPrice).
// Pure and deterministic, the same in Node and in the browser, so both sides arrive at the same cooldown.
import { ABILITY, STAGE, METER_MAX, MOVE_BUDGET, ROUND_TICKS, ETHER, STAT_POINTS, STAT_MAX, STAT_KEYS, REACH, deriveStats } from './constants.js';
import { abilityPrice } from './blocks.js';
import { createFight, stepFight, fightHash, recordSight } from './sim.js';

// The ring's dummy for the measurement (ring 3.0: P1). It has a short mid strike and a mid projectile, so it can walk
// up and poke or stand and shoot, and a few moves it never uses. Measured blind (method §2.5): its stats, health,
// meters, side and the moment of the round change from run to run, so an ability cannot tell the measurement from a fight.
const seg = (type, p, startup, active, recovery) => ({ type, p, start: 0, activeStart: startup, activeEnd: startup + active, end: startup + active + recovery });
function dummyMove(id, segment, extra = {}) {
  return { id, name: id, slot: 'normal', posture: 'stand', blocks: [], segments: [segment], duration: segment.end, charge: null, armor: 0, armorUntil: segment.activeStart, firstActive: segment.activeStart, totalDamage: segment.p.damage, hasProjectile: segment.type === 'projectile', stance: null, ability: null, cost: 0, anim: null, fx: [], line: null, director: null, command: null, sounds: {}, ...extra };
}
const DUMMY_MOVES = [
  dummyMove('jab', seg('strike', { damage: 40, hits: 1, reach: 'mid', zone: 'mid', launch: false, push: 'light' }, 8, 3, 14)),
  dummyMove('bolt', seg('projectile', { damage: 60, hits: 1, speed: 'mid', zone: 'mid' }, 12, 1, 20), { slot: 'special' }),
  dummyMove('sweep', seg('strike', { damage: 45, hits: 1, reach: 'mid', zone: 'low', launch: false, push: 'light' }, 10, 3, 20), { posture: 'crouch' }),
  dummyMove('heavy', seg('strike', { damage: 70, hits: 1, reach: 'mid', zone: 'mid', launch: false, push: 'heavy' }, 14, 4, 22)),
  dummyMove('rush', seg('strike', { damage: 60, hits: 1, reach: 'long', zone: 'mid', launch: false, push: 'heavy' }, 12, 4, 22), { slot: 'special' }),
  dummyMove('burst', seg('strike', { damage: 50, hits: 4, reach: 'mid', zone: 'mid', launch: false, push: 'light' }, 6, 8, 30), { slot: 'super' }),
];
const JAB_REACH = 35 + REACH.mid + 35;

function dummyDef(stats) {
  return {
    card: { name: 'Соперник', motto: '', story: '', colors: { primary: '#888888', secondary: '#666666', accent: '#aaaaaa' }, portrait: null },
    stats,
    derived: deriveStats(stats),
    stances: [],
    resources: [],
    abilityScripts: [],
    abilities: {},
    parts: {},
    poses: {},
    anims: {},
    moves: DUMMY_MOVES,
    movesById: Object.fromEntries(DUMMY_MOVES.map((m) => [m.id, m])),
    voice: { description: '', lines: [], byId: {} },
  };
}

// Standard target of 2.8, kept for tools that want a plain opponent: stats 3, the dummy's moves.
export const STANDARD_TARGET = Object.freeze(dummyDef({ health: 3, power: 3, speed: 3, defense: 3 }));

export const MEASURE = {
  gaps: [120, 300, 600, 900], // distance between centres at the start
  // stand, guard high or low, jump in place; approach — walks at the caster and jumps when it has not come closer for
  // stuckJump ticks; shoot — stands and fires its projectile every shootEvery ticks; poke — walks up and strikes
  modes: ['stand', 'guard_high', 'guard_low', 'jump', 'approach', 'shoot', 'poke'],
  seeds: [1, 7], // the first measures the caster on the left, the second on the right
  resources: ['start', 'max'], // own resources as written in fighter.json, and all full
  lead: 2, // ticks before the press
  tail: 30, // ticks after the cast ended
  near: 110, // the walking dummy wants to come closer while farther than this
  stuckJump: 20,
  shootEvery: 90,
  refusalWeight: 0.5, // refusal: ticks the walking dummy wanted to come closer and could not, ×this
};

// a small deterministic generator for the blind conditions of one run
function blindRng(seed, salt) {
  let s = (Math.imul(seed ^ 0x2545f491, 0x9e3779b1) + salt * 0x6d2b79f5) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blindStats(rnd) {
  const stats = Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
  for (let p = 0; p < STAT_POINTS; ) {
    const k = STAT_KEYS[Math.floor(rnd() * STAT_KEYS.length)];
    if (stats[k] < STAT_MAX) {
      stats[k]++;
      p++;
    }
  }
  return stats;
}

function dummyAction(mode, F, me, fight, st) {
  if (mode === 'guard_high') return { guard: 'high' };
  if (mode === 'guard_low') return { guard: 'low' };
  if (mode === 'jump') return F.state === 'neutral' ? { jump: 0 } : {};
  if (mode === 'shoot') return F.state === 'neutral' && !F.projectile && fight.tick - st.shot >= MEASURE.shootEvery ? ((st.shot = fight.tick), { attack: 'bolt' }) : {};
  if (mode === 'approach' || mode === 'poke') {
    if (F.state !== 'neutral') return {};
    const dist = Math.abs(me.x - F.x);
    if (mode === 'poke' && dist <= JAB_REACH) return { attack: 'jab' };
    if (dist <= MEASURE.near) return {};
    if (fight.tick - st.progress >= MEASURE.stuckJump) {
      st.progress = fight.tick;
      return { jump: 1 };
    }
    return { walk: 1 };
  }
  return {};
}

const KEYS = ['damage', 'control', 'buff', 'shove', 'objectTicks', 'refusal'];

function runOnce(def, move, { gap, mode, seed, resources, clock }) {
  const probe = { ...def }; // own identity: the brains' view cache of the real def stays clean
  const rnd = blindRng(seed, gap * 31 + MEASURE.modes.indexOf(mode));
  const side = MEASURE.seeds.indexOf(seed) % 2 === 1 ? 1 : 0;
  const target = dummyDef(blindStats(rnd));
  const fight = createFight({ fighters: side === 0 ? [probe, target] : [target, probe], seed, clock });
  fight.measuring = true;
  fight.castLog = [];
  const me = fight.f[side];
  const dummy = fight.f[1 - side];
  const dir = side === 0 ? -1 : 1;
  me.x = me.px = STAGE.width / 2 + dir * (gap / 2);
  dummy.x = dummy.px = STAGE.width / 2 - dir * (gap / 2);
  me.facing = dummy.x > me.x ? 1 : -1;
  dummy.facing = -me.facing;
  // blind: somewhere in a round, with the dummy hurt and its meters as in a fight
  fight.tick = 300 + Math.floor(rnd() * 6000);
  fight.timer = ROUND_TICKS - fight.tick;
  dummy.hp = Math.round(dummy.maxHp * (0.5 + 0.5 * rnd()));
  dummy.meter = Math.floor(rnd() * METER_MAX);
  dummy.ether = Math.floor(rnd() * ETHER.max);
  me.ether = ETHER.max;
  const t0 = fight.tick;
  if (move.slot === 'super') me.meter = METER_MAX;
  if (move.stance) me.stance = move.stance;
  if (resources === 'max') for (const r of def.resources) me.res[r.id] = r.max;
  // the fighters stand where the measurement put them from the first tick: the late sight of abilities starts here too
  fight.sight = [];
  fight.sightTick = -1;
  recordSight(fight);
  const air = move.posture === 'air';
  const limit = t0 + MEASURE.lead + move.duration + ABILITY.castTicks + (air ? 60 : 0) + MEASURE.tail;
  const st = { shot: -999, progress: t0, refusal: 0 };
  let pressed = false;
  let started = false;
  let quiet = 0;
  for (let i = 0; i < (limit - t0) * 2 && fight.tick < limit; i++) {
    let acts = null;
    const before = Math.abs(me.x - dummy.x);
    let wants = false;
    if (!fight.freeze && !fight.hitstop && !fight.over) {
      let a = {};
      if (fight.tick >= t0 + MEASURE.lead && !pressed) {
        if (air) {
          if (me.state === 'neutral') a = { jump: 0 };
          else if (me.state === 'air' && me.vy < 4) {
            a = { attack: move.id };
            pressed = true;
          }
        } else if (me.state === 'neutral') {
          a = { attack: move.id, crouch: move.posture === 'crouch' };
          pressed = true;
        }
      }
      const d = dummyAction(mode, dummy, me, fight, st);
      // P2: the walking dummy wants to come closer: it is in neutral, able to act and farther than MEASURE.near
      wants = (mode === 'approach' || mode === 'poke') && d.walk === 1 && !dummy.mods.stop;
      acts = side === 0 ? [a, d] : [d, a];
    }
    stepFight(fight, acts);
    const after = Math.abs(me.x - dummy.x);
    if (after < before - 0.5) st.progress = fight.tick;
    else if (wants) st.refusal++;
    if (fight.castLog.length) started = true;
    if (started) {
      const busy = fight.casts.length || fight.objects.some((o) => o.side === side) || fight.f.some((F) => F.effects.some((e) => e.from === side)) || me.state === 'move';
      quiet = busy ? 0 : quiet + 1;
      if (quiet > MEASURE.tail) break;
    }
    if (fight.over) break;
  }
  const got = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const c of fight.castLog) for (const k of KEYS) if (k in c.used) got[k] += c.used[k];
  // P2: refusal only while the ability was at work (it started), and the damage of the dummy's projectiles its walls stopped
  got.refusal = started ? st.refusal * MEASURE.refusalWeight + (fight.refused || 0) : 0;
  const stats = fight.abilityStats[side];
  return { got, started, hash: fightHash(fight), errors: stats.errors, cuts: stats.cuts, images: [...stats.images], ms: stats.ms, hooks: stats.hooks };
}

// One ability move: every situation, the best of each measure. opts.clock — optional timer for the hook stats.
export function measureAbility(def, move, { clock = null } = {}) {
  const best = Object.fromEntries(KEYS.map((k) => [k, 0]));
  const where = {};
  const errors = [];
  const cuts = {};
  const images = new Set();
  const hashes = [];
  const ms = { n: 0, sum: 0, max: 0 };
  let runs = 0;
  let started = 0;
  const resModes = def.resources.length ? MEASURE.resources : ['start'];
  for (const gap of MEASURE.gaps) {
    for (const mode of MEASURE.modes) {
      for (const resources of resModes) {
        for (const seed of MEASURE.seeds) {
          const r = runOnce(def, move, { gap, mode, seed, resources, clock });
          runs++;
          if (r.started) started++;
          hashes.push(r.hash);
          for (const k of KEYS) {
            if (r.got[k] > best[k]) {
              best[k] = r.got[k];
              where[k] = { gap, mode, resources, seed };
            }
          }
          for (const e of r.errors) if (!errors.some((x) => x.message === e.message)) errors.push(e);
          for (const [m, n] of Object.entries(r.cuts)) cuts[m] = (cuts[m] || 0) + n;
          for (const i of r.images) images.add(i);
          ms.n += r.ms.n;
          ms.sum += r.ms.sum;
          ms.max = Math.max(ms.max, r.ms.max);
        }
      }
    }
  }
  for (const k of KEYS) best[k] = Math.round(best[k] * 100) / 100;
  return { best, where, runs, started, errors, cuts, images: [...images], hashes, ms };
}

function readModule(mod) {
  const src = mod && typeof mod === 'object' && mod.default && typeof mod.default === 'object' ? { ...mod, ...mod.default } : mod;
  const hooks = {};
  const errors = [];
  if (!src || typeof src !== 'object') return { hooks, errors: ['модуль ничего не экспортирует'] };
  for (const k of ['start', 'tick', 'passive']) {
    if (src[k] === undefined) continue;
    if (typeof src[k] !== 'function') errors.push(`${k}: хук — функция (api) => {}`);
    else hooks[k] = src[k];
  }
  if (!hooks.start && !hooks.tick && !hooks.passive) errors.push('нужен хотя бы один хук: export function start(api), tick(api) или passive(api)');
  return { hooks: Object.freeze(hooks), errors };
}

// Attach the loaded modules to a compiled fighter (checkFighter → fighter), measure every ability and price it.
// modules: { "abilities/x.js": module namespace }. opts.verify: measure twice and require the same result
// (catches state kept outside api.mem, and any other source of difference); opts.clock: timer for the hook stats.
export function prepareAbilities(def, modules, { verify = false, clock = null } = {}) {
  const errors = [];
  const warnings = [];
  const report = [];
  const hooks = {};
  for (const script of def.abilityScripts) {
    const r = readModule(modules?.[script]);
    if (!modules?.[script]) {
      errors.push(`${script}: модуль не загружен`);
      continue;
    }
    r.errors.forEach((e) => errors.push(`${script}: ${e}`));
    hooks[script] = r.hooks;
  }
  def.abilities = hooks;
  if (errors.length) return { ok: false, errors, warnings, report, budgetUsed: null };
  for (const move of def.moves) {
    if (!move.ability) continue;
    const m = measureAbility(def, move, { clock });
    if (verify) {
      const again = measureAbility(def, move, {});
      if (JSON.stringify(again.best) !== JSON.stringify(m.best) || again.hashes.join() !== m.hashes.join()) {
        errors.push(`${move.id} (${move.ability.script}): два одинаковых замера дали разный бой — способность недетерминирована (состояние вне api.mem и данных объекта, Math.random, время?)`);
      }
    }
    for (const e of m.errors) errors.push(`${move.id} (${move.ability.script}): ошибка на манекене на тике ${e.tick}: ${e.message}`);
    if (!m.started) errors.push(`${move.id}: приём ни разу не дошёл до способности на манекене`);
    const price = abilityPrice(m.best, move.slot);
    const before = move.ability.cost;
    move.ability.measured = Object.freeze({ ...m.best });
    move.ability.power = Math.round(price.power * 100) / 100;
    move.ability.cooldown = price.cooldown;
    move.ability.cost = price.cost;
    move.ability.scale = price.scale;
    if (price.scale < 1) warnings.push(`${move.id}: сила ${Math.round(price.measured)} больше ${move.slot === "super" ? `потолка цены ${price.top}` : `запаса эфира ${ETHER.max}`}: в бою каст делает не больше ×${price.scale.toFixed(3)} замеренного`);
    const blk = move.blocks.find((b) => b.type === 'ability');
    if (blk) blk.measuredCost = price.cost;
    move.cost += price.cost - before;
    const avg = m.ms.n ? m.ms.sum / m.ms.n : 0;
    // ring 3.0: a clock is not a rule (it depends on the machine's load): the step budget of a hook is; this is advice
    if (clock && avg > ABILITY.hookMsAvg) warnings.push(`${move.id}: хуки способности в среднем ${avg.toFixed(2)} мс за вызов (ориентир до ${ABILITY.hookMsAvg} мс; предел — ${ABILITY.hookSteps} шагов на вызов)`);
    if (clock && m.ms.max > ABILITY.hookMsMax) warnings.push(`${move.id}: самый долгий вызов хука ${m.ms.max.toFixed(1)} мс (ориентир до ${ABILITY.hookMsMax} мс)`);
    report.push({ id: move.id, slot: move.slot, script: move.ability.script, measured: m.best, where: m.where, runs: m.runs, power: move.ability.power, cooldown: price.cooldown, cost: price.cost, top: price.top, scale: price.scale, cuts: m.cuts, images: m.images, ms: { avg, max: m.ms.max, calls: m.ms.n } });
  }
  def.abilityImages = [...new Set(report.flatMap((r) => r.images))];
  const budgetUsed = def.moves.reduce((s, m) => s + m.cost, 0);
  if (budgetUsed > MOVE_BUDGET) errors.push(`moves.json: приёмы стоят ${budgetUsed} очков с замеренной ценой способностей, бюджет ${MOVE_BUDGET}`);
  return { ok: errors.length === 0, errors, warnings, report, budgetUsed };
}
