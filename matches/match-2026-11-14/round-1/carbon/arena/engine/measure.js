// The ring measures every ability itself: it casts it against a standard dummy in fixed situations,
// counts what reached the dummy, and prices the ability from that (blocks.js → abilityPrice).
// Pure and deterministic, the same in Node and in the browser, so both sides arrive at the same cooldown.
import { ABILITY, STAGE, METER_MAX, MOVE_BUDGET, deriveStats } from './constants.js';
import { abilityPrice } from './blocks.js';
import { createFight, stepFight, fightHash } from './sim.js';

// Standard target: health, power, speed and defense 3, no moves. It only stands, guards, crouches or jumps.
export const STANDARD_TARGET = Object.freeze({
  card: { name: 'Манекен ринга', motto: '', story: '', colors: { primary: '#888888', secondary: '#666666', accent: '#aaaaaa' }, portrait: null },
  stats: { health: 3, power: 3, speed: 3, defense: 3 },
  derived: deriveStats({ health: 3, power: 3, speed: 3, defense: 3 }),
  stances: [],
  resources: [],
  abilityScripts: [],
  abilities: {},
  parts: {},
  poses: {},
  anims: {},
  moves: [],
  movesById: {},
  voice: { description: '', lines: [], byId: {} },
});

export const MEASURE = {
  gaps: [120, 300, 600], // distance between centres at the start
  modes: ['stand', 'guard_high', 'guard_low', 'jump'],
  seeds: [1, 7],
  resources: ['start', 'max'], // own resources as written in fighter.json, and all full
  lead: 2, // ticks before the press
  tail: 30, // ticks after the cast ended
};

function dummyAction(mode, F) {
  if (mode === 'guard_high') return { guard: 'high' };
  if (mode === 'guard_low') return { guard: 'low' };
  if (mode === 'jump') return F.state === 'neutral' ? { jump: 0 } : {};
  return {};
}

const KEYS = ['damage', 'control', 'buff', 'shove', 'objectTicks'];

function runOnce(def, move, { gap, mode, seed, resources, clock }) {
  const probe = { ...def }; // own identity: the brains' view cache of the real def stays clean
  const fight = createFight({ fighters: [probe, STANDARD_TARGET], seed, clock });
  fight.measuring = true;
  fight.castLog = [];
  const [me, dummy] = fight.f;
  me.x = STAGE.width / 2 - gap / 2;
  dummy.x = STAGE.width / 2 + gap / 2;
  if (move.slot === 'super') me.meter = METER_MAX;
  if (move.stance) me.stance = move.stance;
  if (resources === 'max') for (const r of def.resources) me.res[r.id] = r.max;
  const air = move.posture === 'air';
  const limit = MEASURE.lead + move.duration + ABILITY.castTicks + (air ? 60 : 0) + MEASURE.tail;
  let pressed = false;
  let started = false;
  let quiet = 0;
  for (let i = 0; i < limit * 2 && fight.tick < limit; i++) {
    let acts = null;
    if (!fight.freeze && !fight.hitstop && !fight.over) {
      let a = {};
      if (fight.tick >= MEASURE.lead && !pressed) {
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
      acts = [a, dummyAction(mode, dummy)];
    }
    stepFight(fight, acts);
    if (fight.castLog.length) started = true;
    if (started) {
      const busy = fight.casts.length || fight.objects.some((o) => o.side === 0) || fight.f.some((F) => F.effects.some((e) => e.from === 0)) || me.state === 'move';
      quiet = busy ? 0 : quiet + 1;
      if (quiet > MEASURE.tail) break;
    }
    if (fight.over) break;
  }
  const got = Object.fromEntries(KEYS.map((k) => [k, 0]));
  for (const c of fight.castLog) for (const k of KEYS) got[k] += c.used[k];
  const st = fight.abilityStats[0];
  return { got, started, hash: fightHash(fight), errors: st.errors, cuts: st.cuts, images: [...st.images], ms: st.ms, hooks: st.hooks };
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
    const blk = move.blocks.find((b) => b.type === 'ability');
    if (blk) blk.measuredCost = price.cost;
    move.cost += price.cost - before;
    const avg = m.ms.n ? m.ms.sum / m.ms.n : 0;
    if (clock && avg > ABILITY.hookMsAvg) errors.push(`${move.id}: хуки способности в среднем ${avg.toFixed(2)} мс за вызов, предел ${ABILITY.hookMsAvg} мс`);
    if (clock && m.ms.max > ABILITY.hookMsMax) warnings.push(`${move.id}: самый долгий вызов хука ${m.ms.max.toFixed(1)} мс (ориентир до ${ABILITY.hookMsMax} мс)`);
    report.push({ id: move.id, slot: move.slot, script: move.ability.script, measured: m.best, where: m.where, runs: m.runs, power: move.ability.power, cooldown: price.cooldown, cost: price.cost, cuts: m.cuts, images: m.images, ms: { avg, max: m.ms.max, calls: m.ms.n } });
  }
  def.abilityImages = [...new Set(report.flatMap((r) => r.images))];
  const budgetUsed = def.moves.reduce((s, m) => s + m.cost, 0);
  if (budgetUsed > MOVE_BUDGET) errors.push(`moves.json: приёмы стоят ${budgetUsed} очков с замеренной ценой способностей, бюджет ${MOVE_BUDGET}`);
  return { ok: errors.length === 0, errors, warnings, report, budgetUsed };
}
