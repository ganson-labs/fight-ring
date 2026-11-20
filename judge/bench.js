// The league of ring 3.0 (docs/v3/method.md §2, §3, §6.4): conditions with the start's noise on both sides, a
// Bradley–Terry rating with a weak prior anchored to the reference fighters, a two-level cluster bootstrap, places by
// intervals, the spectacle passport with the strength of the signal, the invariants of the rules on the records and
// the ablation of moves. Names of models are printed: the operator reads the reports, not the contestants.
//   node ring.mjs bench run <name> --ids a,b,ref:shkval,… [--draws 8] [--jobs N]
//   node ring.mjs bench show <name> · bench invariants <name> [--every 1] · bench ablate <name> [--draws 1]
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { RING, KIT, getContestant, registry } from './contestants.js';
import { snapshot, snapshotFilter } from './match.js';
import { loadFighter, expandSteps } from '../kit/arena/tools/load.js';
import { STARTS, RING_VERSION, ABILITY, REACTION_TICKS, TELEGRAPH, noiseDraw, createFight, stepFight, fightHash } from '../kit/arena/engine/index.js';

export const LEAGUES = join(RING, 'leagues');
const SPARRING = join(KIT, 'arena', 'sparring');

// ---------- who plays ----------

// spec: a contestant id (a build of a model), ref:<name> (a sparring partner of the ring, a reference), or
// dir:<folder> (any fighter folder: an exploit, a ported fighter — a probe, never in the table of models)
export function resolveEntry(spec) {
  if (spec.startsWith('ref:')) {
    const name = spec.slice(4);
    return { id: name, kind: 'ref', model: `эталон ${name}`, src: join(SPARRING, name) };
  }
  if (spec.startsWith('dir:')) {
    const src = resolve(spec.slice(4));
    // the name of the folder; <contestant>/fighter takes the contestant's, a version of a published season
    // (seasons/<season>/fighters/<id>/v3) is <id>-v3
    const up = basename(resolve(src, '..'));
    const id = basename(src) === 'fighter' ? up : /^v\d+$/.test(basename(src)) ? `${up}-${basename(src)}` : basename(src);
    return { id, kind: 'probe', model: `проба ${id}`, src };
  }
  const c = getContestant(spec);
  return { id: spec, kind: 'build', model: c.model, agentModel: c.agentModel, effort: c.effort, color: c.color, src: join(c.root, 'fighter') };
}

export function folderHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(dir, p).split(sep).join('/')).update('\0').update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const seed32 = (...parts) => createHash('sha256').update(parts.join('|')).digest().readUInt32LE(0);

// Conditions (method §2.2, §2.6): every start × `draws` draws of the noise, from a seed made of the fighters' hashes.
export function conditions(leagueSeed, draws) {
  const out = [];
  for (const start of Object.keys(STARTS)) {
    for (let k = 0; k < draws; k++) {
      const cluster = `${start}-${k}`;
      out.push({ cluster, start, draw: k, noise: noiseDraw(seed32(leagueSeed, cluster, 'noise')), seed: seed32(leagueSeed, cluster, 'rand') });
    }
  }
  return out;
}

// ---------- the pool of workers ----------

// worker: options of the worker threads (judge/rating.js starts them with the ruleset of ring 4 and its own flags)
export async function playAll(list, { jobs = Math.max(1, cpus().length - 2), log = console.log, label = 'боёв', worker = {} } = {}) {
  const results = [];
  const errors = [];
  const t0 = Date.now();
  let retried = 0;
  await new Promise((done) => {
    let next = 0;
    let busy = 0;
    const queue = [...list];
    const feed = (w) => {
      if (next >= queue.length) {
        w.terminate();
        if (--busy === 0) done();
        return;
      }
      w.postMessage(queue[next++]);
    };
    for (let i = 0; i < Math.min(jobs, queue.length); i++) {
      const w = new Worker(new URL('./bench-worker.js', import.meta.url), worker);
      busy++;
      w.on('message', (m) => {
        if (m.ok) results.push(m.result);
        else if (m.judge && !queue.find((j) => j.id === m.id)?.retried) {
          // D3: a failure of the judge (the watchdog's clock): the fight is played again, once
          const j = queue.find((x) => x.id === m.id);
          queue.push({ ...j, retried: true });
          retried++;
        } else errors.push(m);
        const n = results.length + errors.length;
        if (n % 100 === 0 || n === list.length) log(`  ${n}/${list.length} ${label}, ${Math.round((Date.now() - t0) / 1000)} с`);
        feed(w);
      });
      w.on('error', (e) => {
        errors.push({ id: '?', error: String(e?.stack || e) });
        if (--busy === 0) done();
      });
      feed(w);
    }
  });
  results.sort((a, b) => a.id.localeCompare(b.id));
  return { results, errors, retried, seconds: Math.round((Date.now() - t0) / 1000) };
}

// ---------- the league ----------

export async function runBench(name, { specs, draws = 8, jobs, log = console.log } = {}) {
  if (!specs || specs.length < 2) throw new Error('нужно хотя бы два участника: --ids a,b');
  const dir = join(LEAGUES, name);
  if (existsSync(join(dir, 'league.json'))) throw new Error(`лига «${name}» уже сыграна: leagues/${name}`);
  mkdirSync(join(dir, 'fights'), { recursive: true });
  const people = {};
  for (const spec of specs) {
    const e = resolveEntry(spec);
    if (people[e.id]) throw new Error(`участник «${e.id}» дважды`);
    const into = join(dir, 'fighters', e.id);
    let snap;
    if (e.kind === 'build') snap = snapshot(e.id, into);
    else {
      rmSync(into, { recursive: true, force: true });
      cpSync(e.src, join(into, 'fighter'), { recursive: true, filter: snapshotFilter(e.src) });
      snap = { fighter: join(into, 'fighter'), at: new Date().toISOString() };
    }
    const r = await loadFighter(snap.fighter);
    if (!r.ok) throw new Error(`боец «${e.id}» не проходит проверку:\n${r.errors.slice(0, 10).join('\n')}`);
    people[e.id] = { ...e, src: undefined, name: r.fighter.card.name, motto: r.fighter.card.motto, dir: snap.fighter, at: snap.at, hash: folderHash(snap.fighter), moves: r.fighter.moves.map((m) => ({ id: m.id, slot: m.slot })) };
    log(`  ${e.id}: ${r.fighter.card.name} (${e.model})`);
  }
  const ids = Object.keys(people);
  // method §2.6: the seeds come after every fighter is in, from their hashes
  const leagueSeed = createHash('sha256').update(ids.map((id) => people[id].hash).sort().join('|')).digest('hex');
  const conds = conditions(leagueSeed, draws);
  const list = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = people[ids[i]];
      const b = people[ids[j]];
      if (a.kind === 'build' && b.kind === 'build' && a.model === b.model) continue; // builds of one model do not meet
      for (const c of conds) {
        for (const [left, right] of [[a.id, b.id], [b.id, a.id]]) {
          const id = `${left}-vs-${right}-${c.cluster}`;
          list.push({ id, left, right, start: c.start, draw: c.draw, cluster: c.cluster, noise: c.noise, seed: c.seed, dirs: [people[left].dir, people[right].dir], save: join(dir, 'fights', `${id}.json`) });
        }
      }
    }
  }
  log(`Лига «${name}»: ${ids.length} участников, ${list.length} боёв (${Object.keys(STARTS).length} стартов × ${draws} розыгрышей × 2 стороны на пару)`);
  const played = await playAll(list, { jobs, log });
  const league = { name, ring: RING_VERSION, at: new Date().toISOString(), draws, leagueSeed, starts: Object.keys(STARTS), people, fights: played.results, errors: played.errors, retried: played.retried, seconds: played.seconds };
  league.table = benchTable(league);
  league.passport = passport(league);
  writeFileSync(join(dir, 'league.json'), JSON.stringify(league, null, 1) + '\n');
  writeFileSync(join(dir, 'README.md'), benchMarkdown(league));
  return league;
}

export function loadBench(name) {
  const p = join(LEAGUES, name, 'league.json');
  if (!existsSync(p)) throw new Error(`нет лиги «${name}» (leagues/${name}/league.json)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ---------- rating ----------

const LN10 = Math.log(10);
const S = LN10 / 400;
const sig = (x) => 1 / (1 + Math.exp(-x));

// Bradley–Terry on the Elo scale, MAP with a prior N(1000, tau²) (method §3.2): finite at 80:0, nearly no pull on
// pairs with mixed results. fights: [{ left, right, winner }]. Returns { id: rating } before anchoring.
export function fitBT(ids, fights, { tau = 400, iters = 200 } = {}) {
  const idx = Object.fromEntries(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const N = Array.from({ length: n }, () => Array(n).fill(0));
  const W = Array.from({ length: n }, () => Array(n).fill(0));
  for (const f of fights) {
    const a = idx[f.left];
    const b = idx[f.right];
    if (a === undefined || b === undefined) continue;
    N[a][b]++;
    N[b][a]++;
    if (f.winner === null) {
      W[a][b] += 0.5;
      W[b][a] += 0.5;
    } else if (f.winner === f.left) W[a][b] += 1;
    else W[b][a] += 1;
  }
  const r = Array(n).fill(1000);
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let g = -(r[i] - 1000) / (tau * tau);
      let h = -1 / (tau * tau);
      for (let j = 0; j < n; j++) {
        if (!N[i][j]) continue;
        const p = sig(S * (r[i] - r[j]));
        g += S * (W[i][j] - N[i][j] * p);
        h -= S * S * N[i][j] * p * (1 - p);
      }
      const step = g / h;
      r[i] -= Math.max(-200, Math.min(200, step));
      moved = Math.max(moved, Math.abs(step));
    }
    if (moved < 1e-6) break;
  }
  return Object.fromEntries(ids.map((id, i) => [id, r[i]]));
}

// the reference fighters' mean is 1000 (method §3.2), without references the mean of all
function anchor(ratings, refs) {
  const base = refs.length ? refs : Object.keys(ratings);
  const mean = base.reduce((s, id) => s + ratings[id], 0) / base.length;
  return Object.fromEntries(Object.entries(ratings).map(([id, v]) => [id, v - mean + 1000]));
}

export const expected = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quant = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const p = (s.length - 1) * q;
  const lo = Math.floor(p);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (p - lo);
};

// The table (method §3): ratings of entries and of models, 95 % intervals from a two-level cluster bootstrap
// (models' builds, then the conditions of every pair with both sides), places by intervals.
export function benchTable(league, { boot = 1000 } = {}) {
  const P = league.people;
  const ids = Object.keys(P);
  const refs = ids.filter((id) => P[id].kind === 'ref');
  const fights = league.fights.filter((f) => !f.off);
  const rating = anchor(fitBT(ids, fights), refs);
  // groups: a model and its builds; every reference and probe is its own group of one
  const groupOf = (id) => (P[id].kind === 'build' ? `m:${P[id].model}` : `e:${id}`);
  const groups = {};
  for (const id of ids) (groups[groupOf(id)] ||= []).push(id);
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const byPair = {};
  for (const f of fights) {
    const k = pairKey(f.left, f.right);
    ((byPair[k] ||= {})[f.cluster] ||= []).push(f);
  }
  const rnd = mulberry(20261118);
  const gKeys = Object.keys(groups);
  const samples = Object.fromEntries(gKeys.map((g) => [g, []]));
  const firsts = Object.fromEntries(gKeys.map((g) => [g, 0]));
  const entrySamples = Object.fromEntries(ids.map((id) => [id, []]));
  for (let b = 0; b < boot; b++) {
    // level 1: K builds of every model with replacement
    const chosen = [];
    for (const g of gKeys) {
      const list = groups[g];
      for (let k = 0; k < list.length; k++) chosen.push({ g, id: list[Math.floor(rnd() * list.length)], slot: `${g}#${k}` });
    }
    // level 2: the conditions of every pair with replacement, both sides of a condition together
    const res = [];
    for (let x = 0; x < chosen.length; x++) {
      for (let y = x + 1; y < chosen.length; y++) {
        const A = chosen[x];
        const B = chosen[y];
        if (A.g === B.g) continue;
        const cl = byPair[pairKey(A.id, B.id)];
        if (!cl) continue;
        const keys = Object.keys(cl);
        for (let k = 0; k < keys.length; k++) {
          for (const f of cl[keys[Math.floor(rnd() * keys.length)]]) {
            const left = f.left === A.id ? A.slot : B.slot;
            const right = left === A.slot ? B.slot : A.slot;
            res.push({ left, right, winner: f.winner === null ? null : f.winner === f.left ? left : right });
          }
        }
      }
    }
    const slots = chosen.map((c) => c.slot);
    const refSlots = chosen.filter((c) => P[c.id].kind === 'ref').map((c) => c.slot);
    const r = anchor(fitBT(slots, res, { iters: 60 }), refSlots);
    const gm = {};
    for (const c of chosen) {
      (gm[c.g] ||= []).push(r[c.slot]);
      entrySamples[c.id].push(r[c.slot]);
    }
    let top = null;
    for (const g of gKeys) {
      const v = gm[g].reduce((s, x) => s + x, 0) / gm[g].length;
      samples[g].push(v);
      if (g.startsWith('m:') && (top === null || v > gm[top].reduce((s, x) => s + x, 0) / gm[top].length)) top = g;
    }
    if (top) firsts[top]++;
  }
  const entries = ids.map((id) => {
    const mine = fights.filter((f) => f.left === id || f.right === id);
    const pts = mine.reduce((s, f) => s + (f.winner === id ? 1 : f.winner === null ? 0.5 : 0), 0);
    return { id, kind: P[id].kind, model: P[id].model, name: P[id].name, rating: Math.round(rating[id]), range: [Math.round(quant(entrySamples[id], 0.025)), Math.round(quant(entrySamples[id], 0.975))], fights: mine.length, share: mine.length ? pts / mine.length : 0, kos: mine.filter((f) => f.winner === id && f.reason === 'ko').length };
  }).sort((a, b) => b.rating - a.rating);
  const models = gKeys.map((g) => {
    const list = groups[g];
    const v = list.reduce((s, id) => s + rating[id], 0) / list.length;
    return { group: g, kind: P[list[0]].kind, model: P[list[0]].model, builds: list, rating: Math.round(v), range: [Math.round(quant(samples[g], 0.025)), Math.round(quant(samples[g], 0.975))], firstChance: g.startsWith('m:') ? Math.min(0.99, firsts[g] / boot) : null, points: list.map((id) => Math.round(rating[id])) };
  }).sort((a, b) => b.rating - a.rating);
  // method §3.4: the place is 1 + the number of models surely above
  for (const m of models) m.place = 1 + models.filter((o) => o !== m && o.kind === m.kind && o.range[0] > m.range[1]).length;
  return { entries, models, boot };
}

// ---------- the spectacle passport (rules §10, method §6.4) ----------

const median = (a) => quant(a, 0.5);

function sliceMetrics(fights) {
  const decided = fights.filter((f) => f.winner !== null);
  const loser = decided.map((f) => {
    const w = f.winner === f.left ? 0 : 1;
    return f.dealt[w] > 0 ? f.dealt[1 - w] / f.dealt[w] : 0;
  });
  let hits = 0;
  let blocks = 0;
  for (const f of fights) {
    hits += f.stats.hits[0] + f.stats.hits[1];
    blocks += f.stats.blocks[0] + f.stats.blocks[1];
  }
  return {
    fights: fights.length,
    loserRatio: median(loser),
    leadChange: fights.filter((f) => f.stats.leadChanges > 0).length / Math.max(1, fights.length),
    duration: median(fights.map((f) => f.ticks / 60)),
    timeouts: fights.filter((f) => f.reason === 'time').length / Math.max(1, fights.length),
    far: fights.reduce((s, f) => s + f.far, 0) / Math.max(1, fights.length),
    blockShare: blocks / Math.max(1, hits + blocks),
  };
}

// Spearman's rank correlation
function spearman(a, b) {
  const rank = (v) => {
    const order = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = Array(v.length);
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const d2 = ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0);
  return n > 1 ? 1 - (6 * d2) / (n * (n * n - 1)) : 1;
}

export const PASSPORT = {
  loserRatio: { min: 0.3, text: 'урон проигравшего к урону победителя (медиана)' },
  leadChange: { min: 0.4, text: 'бои со сменой лидера' },
  duration: { min: 45, max: 150, text: 'длительность, медиана, с' },
  timeouts: { max: 0.3, text: 'бои по времени' },
  far: { max: 0.2, text: 'время на дистанции > 900' },
  blockShare: { min: 0.1, max: 0.4, text: 'доля ударов в блок' },
  topMove: { max: 0.5, share: 0.8, text: 'самый частый приём ≤ 50 % урона сборки' },
  throws: { share: 0.5, text: 'урон бросками > 0' },
  spearman: { min: 0.9, text: 'Спирмен рейтингов половин розыгрышей' },
  spread: { min: 0.85, text: 'ожидаемый счёт лучшей сборки против худшей' },
};

// The spectacle is measured on the fights the show is made of: at least one side is a build (or a probe in a
// calibration); the fights of two references only anchor the scale.
export function passport(league, table = league.table) {
  const P = league.people;
  const fights = league.fights.filter((f) => !f.off && (P[f.left].kind !== 'ref' || P[f.right].kind !== 'ref'));
  const rating = Object.fromEntries(table.entries.map((e) => [e.id, e.rating]));
  const close = fights.filter((f) => {
    const e = expected(rating[f.left], rating[f.right]);
    return e >= 0.25 && e <= 0.75;
  });
  const closePairs = new Set(close.map((f) => [f.left, f.right].sort().join('|'))).size;
  const all = sliceMetrics(fights);
  const near = sliceMetrics(close);
  const builds = Object.keys(P).filter((id) => P[id].kind !== 'ref');
  const per = builds.map((id) => {
    const dmg = {};
    let total = 0;
    let throwDmg = 0;
    for (const f of fights) {
      const s = f.left === id ? 0 : f.right === id ? 1 : -1;
      if (s < 0) continue;
      for (const [m, d] of Object.entries(f.stats.dmg[s])) {
        dmg[m] = (dmg[m] || 0) + d;
        total += d;
      }
      throwDmg += f.stats.throwDmg[s];
    }
    const top = Object.entries(dmg).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
    return { id, topMove: top[0], topShare: total ? top[1] / total : 0, throwDmg, moves: Object.fromEntries(Object.entries(dmg).map(([m, d]) => [m, Math.round((1000 * d) / Math.max(1, total)) / 1000])) };
  });
  // the strength of the signal: the ratings of the even and the odd draws
  const ids = Object.keys(P);
  const refs = ids.filter((id) => P[id].kind === 'ref');
  const every = league.fights.filter((f) => !f.off);
  const even = anchor(fitBT(ids, every.filter((f) => f.draw % 2 === 0)), refs);
  const odd = anchor(fitBT(ids, every.filter((f) => f.draw % 2 === 1)), refs);
  const rho = spearman(ids.map((id) => even[id]), ids.map((id) => odd[id]));
  const br = builds.map((id) => rating[id]).sort((a, b) => b - a);
  const spread = br.length >= 2 ? expected(br[0], br[br.length - 1]) : null;
  const slice = closePairs >= 3 ? near : all;
  const checks = {
    loserRatio: slice.loserRatio >= PASSPORT.loserRatio.min,
    leadChange: slice.leadChange >= PASSPORT.leadChange.min,
    duration: slice.duration >= PASSPORT.duration.min && slice.duration <= PASSPORT.duration.max,
    timeouts: slice.timeouts <= PASSPORT.timeouts.max,
    far: slice.far <= PASSPORT.far.max,
    blockShare: all.blockShare >= PASSPORT.blockShare.min && all.blockShare <= PASSPORT.blockShare.max,
    topMove: per.length ? per.filter((p) => p.topShare <= PASSPORT.topMove.max).length / per.length >= PASSPORT.topMove.share : true,
    throws: per.length ? per.filter((p) => p.throwDmg > 0).length / per.length >= PASSPORT.throws.share : true,
    spearman: rho >= PASSPORT.spearman.min,
    spread: spread === null ? true : spread >= PASSPORT.spread.min,
  };
  return { all, close: near, closePairs, slice: closePairs >= 3 ? 'близкие пары' : 'все бои (близких пар меньше трёх)', builds: per, spearman: rho, spread, checks, pass: Object.values(checks).every(Boolean) };
}

// ---------- the report ----------

const pct = (x) => (x === null || Number.isNaN(x) ? '—' : `${Math.round(x * 100)} %`);
const num = (x, d = 2) => (x === null || Number.isNaN(x) ? '—' : (Math.round(x * 10 ** d) / 10 ** d).toString());

export function benchMarkdown(league) {
  const P = league.people;
  const t = league.table;
  const p = league.passport;
  const lines = [`# Лига «${league.name}»`, ''];
  lines.push(`Ринг ${league.ring.ring}. ${Object.keys(P).length} участников, ${league.fights.length} боёв: ${league.starts.length} стартов × ${league.draws} розыгрышей шума × 2 стороны на пару. Зерно лиги — SHA-256 хэшей бойцов: ${league.leagueSeed.slice(0, 16)}…`, '');
  lines.push('## Модели', '', '| Место | Модель | Рейтинг (95 %) | Сборки | Шанс быть первым |', '|---|---|---|---|---|');
  for (const m of t.models.filter((x) => x.kind === 'build')) lines.push(`| ${m.place} | ${m.model} | ${m.rating} (${m.range[0]}–${m.range[1]}) | ${m.points.join(', ')} | ${m.firstChance === null ? '—' : m.firstChance >= 0.99 ? '> 99 %' : pct(m.firstChance)} |`);
  lines.push('', '## Все участники', '', '| Участник | Боец | Вид | Рейтинг (95 %) | Очки | Нокауты |', '|---|---|---|---|---|---|');
  for (const e of t.entries) lines.push(`| ${e.id} | ${e.name} | ${e.kind === 'build' ? e.model : e.kind === 'ref' ? 'эталон' : 'проба'} | ${e.rating} (${e.range[0]}–${e.range[1]}) | ${pct(e.share)} | ${e.kos} |`);
  lines.push('', '## Паспорт зрелищности', '', `Бои, где хотя бы одна сторона — сборка (бои эталонов между собой только держат шкалу). Цели считаются по срезу: ${p.slice}. Близких пар (ожидаемый счёт 25–75 %): ${p.closePairs}.`, '');
  lines.push('| Мера | Все бои | Близкие пары | Цель | Прошло |', '|---|---|---|---|---|');
  const row = (k, a, c, goal) => lines.push(`| ${PASSPORT[k].text} | ${a} | ${c} | ${goal} | ${p.checks[k] ? 'да' : '**нет**'} |`);
  row('loserRatio', num(p.all.loserRatio), num(p.close.loserRatio), '≥ 0,3');
  row('leadChange', pct(p.all.leadChange), pct(p.close.leadChange), '≥ 40 %');
  row('duration', num(p.all.duration, 0), num(p.close.duration, 0), '45–150');
  row('timeouts', pct(p.all.timeouts), pct(p.close.timeouts), '≤ 30 %');
  row('far', pct(p.all.far), pct(p.close.far), '≤ 20 %');
  row('blockShare', pct(p.all.blockShare), pct(p.close.blockShare), '10–40 % (все бои)');
  row('topMove', p.builds.map((b) => pct(b.topShare)).join(', ') || '—', '', '≤ 50 % у ≥ 80 % сборок');
  row('throws', p.builds.map((b) => b.throwDmg).join(', ') || '—', '', '> 0 у ≥ 50 % сборок');
  row('spearman', num(p.spearman), '', '≥ 0,9');
  row('spread', p.spread === null ? '—' : pct(p.spread), '', '≥ 85 %');
  lines.push('', `Паспорт ${p.pass ? 'пройден' : '**не пройден**'}.`);
  const brain = [];
  for (const f of league.fights) f.brain.forEach((b, s) => { if (b.skipped || b.errors) brain.push(`${f.id}: ${s === 0 ? f.left : f.right} — пропусков ${b.skipped}, ошибок ${b.errors}`); });
  if (brain.length) lines.push('', '## Мозги пропускали ходы или падали', '', ...brain.slice(0, 40).map((s) => `- ${s}`), brain.length > 40 ? `- … всего ${brain.length}` : '');
  if (league.errors?.length) lines.push('', '## Ошибки судьи', '', ...league.errors.map((e) => `- ${e.id}: ${String(e.error).split('\n')[0]}`));
  lines.push('', `Рейтинг — Брэдли — Терри со слабым априором N(1000, 400²), средний эталон = 1000; 95 % — двухуровневый кластерный бутстрэп (${t.boot} повторов: сборки модели, затем условия пары с обеими сторонами). Место = 1 + число моделей, чей интервал целиком выше.`, '');
  return lines.join('\n');
}

// ---------- the invariants of the rules on the records (rules §11.2) ----------

export async function verifyInvariants(name, { every = 1, log = console.log } = {}) {
  const league = loadBench(name);
  const dir = join(LEAGUES, name);
  const defs = {};
  for (const id of Object.keys(league.people)) defs[id] = (await loadFighter(league.people[id].dir, { verify: false })).fighter;
  const bad = { R2: [], M1: [], O1: [], W3: [], W1: [], B8: [], hash: [] };
  let n = 0;
  const fights = league.fights.filter((_, i) => i % every === 0);
  for (const f of fights) {
    const rep = JSON.parse(readFileSync(join(dir, 'fights', `${f.id}.json`), 'utf8'));
    const fight = createFight({ fighters: [defs[f.left], defs[f.right]], seed: rep.seed, start: rep.start, reaction: rep.reaction ?? REACTION_TICKS });
    fight.audit = [];
    const reaction = fight.reaction;
    for (const acts of expandSteps(rep.steps)) {
      const before = fight.f.map((F) => F.state);
      const dizzy = fight.f.map((F) => F.dizzyPending);
      const ending = fight.f.map((F) => F.st + 1 >= F.len);
      const ev = stepFight(fight, acts);
      // B8: a fighter that got up holding a guard of the right height is not hit on the first free tick
      for (const e of ev) {
        if (e.type !== 'hit' || !['getup', 'hitstun', 'landing'].includes(before[e.side]) || dizzy[e.side] || !ending[e.side]) continue; // (getting up dizzy: no guard, by the rules)
        const g = acts?.[e.side]?.guard;
        const holds = g === 'high' ? e.zone !== 'low' && e.zone !== 'air' : g === 'low' ? e.zone === 'mid' || e.zone === 'low' : false;
        if (holds && !fight.f[e.side].airborne && fight.f[e.side].y === 0) bad.B8.push(`${f.id} тик ${fight.tick}: удар ${e.zone} в тик выхода из ${before[e.side]} при блоке ${g}`);
      }
      // after the end the record only shows the winner settling: no rule runs there
      if (fight.over && !ev.some((e) => e.type === 'end')) {
        fight.audit = [];
        continue;
      }
      for (const e of ev) if (e.type === 'strikeWarn' && e.ticks < reaction + TELEGRAPH.base) bad.R2.push(`${f.id} тик ${fight.tick}: удар через ${e.ticks}`);
      for (const o of fight.objects) if (!o.dead && fight.tick - o.cast.startTick > ABILITY.castLife) bad.O1.push(`${f.id} тик ${fight.tick}: объект ${o.id} живёт ${fight.tick - o.cast.startTick} от каста`);
      for (const s of [0, 1]) if (fight.objects.filter((o) => !o.dead && o.solid && o.side === s).length > ABILITY.solidsMax) bad.W1.push(`${f.id} тик ${fight.tick}: стен у стороны ${s} больше одной`);
      if (fight.audit.length) {
        const per = {};
        for (const a of fight.audit) {
          if (a.kind === 'selfShove' && !['neutral', 'move'].includes(a.state)) bad.M1.push(`${f.id} тик ${a.tick}: сдвиг себя в ${a.state}`);
          if (a.kind !== 'selfShove') per[`${a.side}>${a.target}`] = (per[`${a.side}>${a.target}`] || 0) + Math.abs(a.moved);
        }
        for (const [k, v] of Object.entries(per)) if (v > ABILITY.shovePerTick + 1e-6) bad.W3.push(`${f.id} тик ${fight.tick}: сдвиг ${k} ${v.toFixed(1)} за тик`);
        fight.audit = [];
      }
    }
    if (rep.hash && fightHash(fight) !== rep.hash) bad.hash.push(f.id);
    n++;
    if (n % 200 === 0) log(`  проверено ${n}/${fights.length}`);
  }
  return { fights: n, bad, ok: Object.values(bad).every((v) => !v.length) };
}

// ---------- the ablation of moves (method §2.4.5, rules §11.4) ----------

// Every move of every build switched off in turn; the build plays every other entry on the draws < `draws` of every
// start, both sides. A change of the share of points by more than `flag` against the same conditions of the league marks
// the move for a look by hand: a find of the model or a hole of the ring.
export async function ablateMoves(name, { draws = 1, flag = 0.3, jobs, log = console.log } = {}) {
  const league = loadBench(name);
  const P = league.people;
  const conds = conditions(league.leagueSeed, league.draws).filter((c) => c.draw < draws);
  const builds = Object.keys(P).filter((id) => P[id].kind !== 'ref');
  const list = [];
  for (const id of builds) {
    for (const m of P[id].moves) {
      for (const op of Object.keys(P)) {
        if (op === id || (P[op].kind === 'build' && P[op].model === P[id].model)) continue;
        for (const c of conds) {
          for (const [left, right] of [[id, op], [op, id]]) {
            list.push({ id: `${id}~${m.id}|${left}-vs-${right}-${c.cluster}`, left, right, start: c.start, draw: c.draw, cluster: c.cluster, noise: c.noise, seed: c.seed, dirs: [P[left].dir, P[right].dir], off: [left === id ? m.id : null, right === id ? m.id : null] });
          }
        }
      }
    }
  }
  log(`Абляция приёмов «${name}»: ${list.length} боёв`);
  const played = await playAll(list, { jobs, log });
  const share = (fs, id) => fs.reduce((s, f) => s + (f.winner === id ? 1 : f.winner === null ? 0.5 : 0), 0) / Math.max(1, fs.length);
  const out = [];
  for (const id of builds) {
    const base = league.fights.filter((f) => (f.left === id || f.right === id) && f.draw < draws);
    const b = share(base, id);
    for (const m of P[id].moves) {
      const fs = played.results.filter((f) => f.id.startsWith(`${id}~${m.id}|`));
      const s = share(fs, id);
      out.push({ id, move: m.id, slot: m.slot, base: b, off: s, delta: s - b, flagged: Math.abs(s - b) > flag });
    }
  }
  const res = { name, draws, flag, rows: out, errors: played.errors };
  writeFileSync(join(LEAGUES, name, 'ablation.json'), JSON.stringify(res, null, 1) + '\n');
  return res;
}
