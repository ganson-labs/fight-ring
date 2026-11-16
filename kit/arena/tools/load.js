// Node side: read a fighter folder, check it, run brains and fights without a browser.
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { checkFighter, createFight, stepFight, brainView, sanitizeAction, IDLE_ACTION, fightHash, ringLine, prepareAbilities, RING_SEED } from '../engine/index.js';
import { abilityLoader } from '../engine/instrument.js';
import { seatPart } from '../render/seat.js';
import { bodyFit, fitWarnings, fighterPoses } from '../render/fit.js';
import { decodeImage } from './png.js';

export const ARENA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KIT_DIR = resolve(ARENA_DIR, '..');
export const BRAIN_TICK_MS = 5; // per tick; slower answers are dropped and the previous action repeats
export const BRAIN_INIT_MS = 1000;
export const FIGHTER_FILES = ['fighter.json', 'body.json', 'moves.json', 'voice.json', 'brain.js'];

export function listFiles(dir) {
  const out = new Set();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.add(relative(dir, p).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function pngSize(file) {
  try {
    const fd = openSync(file, 'r');
    const b = Buffer.alloc(24);
    readSync(fd, b, 0, 24, 0);
    closeSync(fd);
    if (b.readUInt32BE(0) !== 0x89504e47) return null;
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch {
    return null;
  }
}

// quick: without the warnings that decode the part pictures (joints, fit): for reading a fighter, not checking it
export function readFighterDir(dir, { strict = false, quick = false } = {}) {
  const errors = [];
  const input = {};
  for (const f of ['fighter', 'body', 'moves', 'voice']) {
    const p = join(dir, `${f}.json`);
    if (!existsSync(p)) {
      errors.push(`нет файла ${f}.json в ${dir}`);
      continue;
    }
    try {
      input[f] = JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      errors.push(`${f}.json: не JSON — ${err.message}`);
    }
  }
  if (!existsSync(join(dir, 'brain.js'))) errors.push(`нет файла brain.js в ${dir}`);
  const files = listFiles(dir);
  const imageSizes = {};
  for (const f of files) if (f.toLowerCase().endsWith('.png')) imageSizes[f] = pngSize(join(dir, f));
  if (errors.length) return { ok: false, errors, warnings: [], fighter: null, budget: null };
  const res = checkFighter(input, { files, imageSizes, strict });
  for (const [f, s] of Object.entries(imageSizes)) if (f.startsWith('parts/') && s && (s[0] > 2048 || s[1] > 2048)) res.warnings.push(`${f}: ${s[0]}×${s[1]} — части больше 2048 px тяжелы для рендера, уменьши`);
  if (res.fighter && !quick) res.warnings.push(...jointWarnings(dir, res.fighter.parts), ...fitWarnings(fighterFit(dir, res.fighter), res.fighter.parts));
  return res;
}

// Pictures of the drawn parts (bone → pixels) and how each sits on its bone (render/seat.js).
export function fighterParts(dir, parts) {
  const images = {};
  const cache = new Map();
  for (const [bone, p] of Object.entries(parts || {})) {
    if (!p) continue;
    if (!cache.has(p.image)) {
      try {
        cache.set(p.image, decodeImage(join(dir, p.image)));
      } catch {
        cache.set(p.image, null);
      }
    }
    if (cache.get(p.image)) images[bone] = cache.get(p.image);
  }
  const seat = Object.fromEntries(Object.entries(images).map(([bone, img]) => [bone, parts[bone]?.seat === false ? { pivot: parts[bone].pivot, tip: parts[bone].tip, ends: {}, moved: false } : seatPart(img, parts[bone], bone)]));
  return { images, seat };
}

// How children sit on their parents' pictures: open armholes, children growing from the middle (render/fit.js).
export function fighterFit(dir, fighter) {
  const { images, seat } = fighterParts(dir, fighter.parts);
  return bodyFit(fighter.parts, seat, images, fighterPoses(fighter));
}

// Joints where a picture barely reaches past its pivot or tip: on a bend the neighbour shows a notch there.
// The ring sinks such joints into the picture itself (render/seat.js); the warning says where and by how much.
export function jointWarnings(dir, parts) {
  const out = [];
  const END = { pivot: 'pivot (сустав с родителем)', tip: 'tip (сустав со следующей костью)' };
  const cache = new Map();
  for (const [bone, p] of Object.entries(parts || {})) {
    if (!p || !String(p.image).toLowerCase().endsWith('.png')) continue;
    let img = cache.get(p.image);
    if (img === undefined) {
      try {
        img = decodeImage(join(dir, p.image));
      } catch {
        img = null;
      }
      cache.set(p.image, img);
    }
    if (!img || p.seat === false || p.mesh) continue;
    const s = seatPart(img, p, bone);
    if (!s.moved) continue;
    const L0 = Math.hypot(p.tip[0] - p.pivot[0], p.tip[1] - p.pivot[1]);
    const L1 = Math.hypot(s.tip[0] - s.pivot[0], s.tip[1] - s.pivot[1]);
    const ends = Object.entries(s.sunk).filter(([, v]) => v >= 1).map(([k, v]) => `${END[k]}: картинка заходит за сустав на ${Math.round(s.ends[k].margin)} px при толщине ${Math.round(s.ends[k].thick)} px, ринг утапливает сустав на ${Math.round(v)} px`);
    if (!ends.length) continue;
    const at = (pt) => `[${pt.map((v) => Math.round(v)).join(', ')}]`;
    out.push(`body.json → parts.${bone}: ${ends.join('; ')} — часть рисуется на ${Math.round((L0 / L1 - 1) * 100)} % крупнее. Без подгонки: "seat": false, или pivot ${at(s.pivot)}, tip ${at(s.tip)}`);
  }
  return out;
}

// ---------- abilities ----------

// Ability code may import only its own files from fighter/ and ../arena/engine/index.js, and must not reach for
// time, randomness, timers, the network or the host. The fight also switches Math.random, Date and performance off
// while a hook runs; this scan just says it early and clearly.
const BANNED = [
  [/\bMath\.random\b/, 'Math.random (случайность — api.rand())'],
  [/\bDate\b/, 'Date (время — api.tick и api.t)'],
  [/\bperformance\b/, 'performance'],
  [/\b(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame)\b/, 'таймеры'],
  [/\b(async|await|Promise)\b/, 'async, await и Promise (хуки синхронные)'],
  [/\b(fetch|XMLHttpRequest|WebSocket|Worker|importScripts)\b/, 'сеть и потоки'],
  [/\b(process|require|globalThis|window|document|eval|crypto)\b/, 'окружение (process, require, globalThis, window, document, eval, crypto)'],
  [/\bFunction\s*\(/, 'Function()'],
];
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

export function scanAbilityModule(dir, script) {
  const errors = [];
  const engine = resolve(dir, '..', 'arena', 'engine', 'index.js');
  const seen = new Set();
  const visit = (file, label) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!existsSync(file)) return errors.push(`${label}: нет файла`);
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const [re, what] of BANNED) if (re.test(src)) errors.push(`${label}: способности недоступно ${what}`);
    const specs = [...src.matchAll(/\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g), ...src.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
    if (/\bimport\s*\(\s*[^'"`\s]/.test(src)) errors.push(`${label}: import() только с путём строкой`);
    for (const spec of specs) {
      const target = resolve(dirname(file), spec);
      if (target === engine) continue;
      const inside = (spec.startsWith('./') || spec.startsWith('../')) && (target === dir || target.startsWith(dir + sep));
      if (!inside) {
        errors.push(`${label}: импорт «${spec}» недоступен способности — только свои файлы из fighter/ и ../arena/engine/index.js`);
        continue;
      }
      visit(target, relative(dir, target).split(sep).join('/'));
    }
  };
  visit(join(dir, script), script);
  return errors;
}

let abilitySeq = 0;
// Check a fighter folder completely: formats (checkFighter), then load the ability modules, measure every ability twice
// on the ring's dummy (two equal results are required) and price it. Returns what readFighterDir returns plus `abilities`.
export async function loadFighter(dir, { strict = false, verify = true } = {}) {
  const res = readFighterDir(dir, { strict });
  res.abilities = [];
  if (!res.ok) return res;
  const def = res.fighter;
  if (!def.abilityScripts.length) {
    def.abilities = {};
    return res;
  }
  const errors = [];
  const modules = {};
  // the step meter is built into the code (engine/instrument.js); a fresh copy of the modules for every load
  const tag = ++abilitySeq;
  const load = abilityLoader({
    base: pathToFileURL(dir).href.replace(/\/?$/, '/'),
    read: async (u) => readFileSync(fileURLToPath(u), 'utf8'),
    toUrl: (src, u) => `data:text/javascript;charset=utf-8,${encodeURIComponent(src + '\n//# ' + u + '#' + tag)}`,
  });
  for (const script of def.abilityScripts) {
    const scan = scanAbilityModule(dir, script);
    errors.push(...scan);
    if (scan.length) continue;
    try {
      modules[script] = await load(script);
    } catch (err) {
      errors.push(`${script}: модуль не загрузился — ${String(err?.message || err).split('\n')[0]}`);
    }
  }
  if (!errors.length) {
    const prep = prepareAbilities(def, modules, { verify, clock: performance.now.bind(performance) }); // bound before the guard swaps performance.now
    errors.push(...prep.errors);
    res.warnings.push(...prep.warnings);
    res.abilities = prep.report;
    if (prep.budgetUsed !== null) {
      res.budget.used = prep.budgetUsed;
      res.budget.moves = def.moves.map((m) => ({ id: m.id, slot: m.slot, cost: m.cost, duration: m.duration }));
    }
    const files = listFiles(dir);
    for (const img of def.abilityImages || []) if (!files.has(img)) errors.push(`способность ссылается на картинку ${img}, её нет в папке бойца`);
  }
  if (errors.length) {
    res.errors.push(...errors);
    res.ok = false;
    res.fighter = null;
  }
  return res;
}

export function resolveFighterDir(spec, cwd = process.cwd()) {
  const candidates = [
    resolve(cwd, spec),
    resolve(cwd, spec, 'fighter'),
    resolve(KIT_DIR, spec),
    join(ARENA_DIR, 'sparring', spec),
  ];
  for (const c of candidates) if (existsSync(join(c, 'fighter.json'))) return c;
  throw new Error(`Не нашёл бойца «${spec}». Искал fighter.json в: ${candidates.join(', ')}`);
}

let instanceSeq = 0;
export async function loadBrain(dir) {
  const url = pathToFileURL(join(dir, 'brain.js')).href + `?instance=${++instanceSeq}`;
  const mod = await import(url);
  const brain = mod.default ?? mod;
  if (!brain || typeof brain.tick !== 'function') throw new Error(`${dir}/brain.js: нужен export default { tick(state) { ... } }`);
  return brain;
}

function timed(fn) {
  const t0 = performance.now();
  let value;
  let error = null;
  try {
    value = fn();
  } catch (err) {
    error = err;
  }
  return { value, error, ms: performance.now() - t0 };
}

// Runs a fight in-process. Returns { fight, replay, stats }.
// replay.steps: one entry per stepFight call: null when the brains were not asked (freeze, hitstop),
// otherwise [action0, action1] already sanitized. Re-simulating the steps reproduces the fight exactly.
export async function runFight({ dirs, fighters, options = {}, seed = options.seed ?? RING_SEED, maxTicks = 99 * 60, tail = 120, log = null }) {
  const brains = [];
  for (const d of dirs) brains.push(await loadBrain(d));
  const fight = createFight({ fighters, seed });
  const stats = [0, 1].map(() => ({ calls: 0, msSum: 0, msMax: 0, slow: 0, errors: 0, lastError: '' }));
  const last = [IDLE_ACTION, IDLE_ACTION];
  for (let s = 0; s < 2; s++) {
    const r = timed(() => brains[s].init?.({ side: s, opponent: { name: fighters[1 - s].card.name }, options, view: brainView(fight, s) }));
    if (r.error) {
      stats[s].errors++;
      stats[s].lastError = String(r.error?.stack || r.error);
    }
    if (r.ms > BRAIN_INIT_MS) stats[s].lastError = `init длился ${r.ms.toFixed(0)} мс (предел ${BRAIN_INIT_MS})`;
  }
  const steps = [];
  const events = [];
  const intro = [0, 1].map((s) => ringLine(fighters[s], 'intro'));
  let after = 0;
  while (fight.tick < maxTicks && after < tail) {
    let acts = null;
    if (!fight.over && fight.freeze === 0 && fight.hitstop === 0) {
      acts = [0, 1].map((s) => {
        const view = brainView(fight, s);
        const r = timed(() => brains[s].tick(view));
        const st = stats[s];
        st.calls++;
        st.msSum += r.ms;
        st.msMax = Math.max(st.msMax, r.ms);
        if (r.error) {
          st.errors++;
          if (st.errors <= 3) {
            st.lastError = String(r.error?.stack || r.error);
            log?.(`  ! мозги ${fighters[s].card.name}: ${r.error?.message || r.error}`);
          }
          return (last[s] = IDLE_ACTION);
        }
        if (r.ms > BRAIN_TICK_MS) {
          st.slow++;
          return last[s];
        }
        return (last[s] = sanitizeAction(r.value));
      });
    }
    steps.push(acts);
    const ev = stepFight(fight, acts);
    for (const e of ev) events.push({ step: steps.length - 1, tick: fight.tick, ...e });
    if (fight.over) after++;
  }
  if (!fight.over) fight.endReason = 'limit';
  return {
    fight,
    events,
    stats,
    replay: { ring: 1, seed, intro, options, steps: compressSteps(steps), hash: fightHash(fight), result: { winner: fight.winner, reason: fight.endReason, hp: fight.f.map((f) => f.hp), ticks: fight.tick } },
  };
}

export function compressSteps(steps) {
  // [n, actions] runs: n identical consecutive entries
  const out = [];
  let prev;
  for (const s of steps) {
    const key = JSON.stringify(s);
    if (out.length && key === prev) out[out.length - 1][0]++;
    else {
      out.push([1, s]);
      prev = key;
    }
  }
  return out;
}

export function expandSteps(runs) {
  const out = [];
  for (const [n, s] of runs) for (let i = 0; i < n; i++) out.push(s);
  return out;
}

export function replayFight(fighters, replay) {
  const fight = createFight({ fighters, seed: replay.seed ?? RING_SEED });
  for (const acts of expandSteps(replay.steps)) stepFight(fight, acts);
  return fight;
}
