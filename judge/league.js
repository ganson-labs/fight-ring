// The league: every fighter against every other, from every start of the ring (STARTS), on both sides,
// with several fight seeds. It is the benchmark of the tournament: a table, ratings with an error range and tiers.
// node ring.mjs league run <name> --ids a,b,c [--seeds 3] [--jobs 8]   ·   node ring.mjs league show <name>
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { RING, getContestant } from './contestants.js';
import { snapshot } from './match.js';
import { loadFighter } from '../kit/arena/tools/load.js';
import { STARTS, RING_SEED, RING_VERSION } from '../kit/arena/engine/index.js';

export const LEAGUES = join(RING, 'leagues');
export const leagueDir = (name) => join(LEAGUES, name);

// tiers by the share of points over all league fights
export const TIERS = [
  { tier: 'S', min: 0.8 },
  { tier: 'A', min: 0.6 },
  { tier: 'B', min: 0.4 },
  { tier: 'C', min: 0.2 },
  { tier: 'D', min: 0 },
];
const tierOf = (share) => TIERS.find((t) => share >= t.min).tier;

export function leagueJobs(ids, { seeds = 3 } = {}) {
  const jobs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const start of Object.keys(STARTS)) {
        for (let k = 0; k < seeds; k++) {
          const seed = (RING_SEED + k) >>> 0;
          for (const [left, right] of [[ids[i], ids[j]], [ids[j], ids[i]]]) jobs.push({ id: `${left}-vs-${right}-${start}-${k + 1}`, left, right, start, seed });
        }
      }
    }
  }
  return jobs;
}

// jobs: one by default — parallel workers load the CPU, a brain may miss its 5 ms and the fight changes
export async function runLeague(name, { ids, seeds = 3, jobs: nJobs = 1, log = console.log, sources = {} } = {}) {
  if (!ids || ids.length < 2) throw new Error('нужно хотя бы два участника: --ids a,b');
  const dir = leagueDir(name);
  if (existsSync(join(dir, 'league.json'))) throw new Error(`лига «${name}» уже сыграна: leagues/${name}`);
  mkdirSync(join(dir, 'fights'), { recursive: true });
  // snapshot every fighter with the judge's engine, check it
  const people = {};
  for (const id of ids) {
    const c = getContestant(id);
    const snap = snapshot(id, join(dir, 'fighters', id), sources[id] || null);
    const r = await loadFighter(snap.fighter);
    if (!r.ok) throw new Error(`боец «${id}» не проходит проверку:\n${r.errors.slice(0, 10).join('\n')}`);
    people[id] = { id, model: c.model, agentModel: c.agentModel, effort: c.effort, color: c.color, name: r.fighter.card.name, motto: r.fighter.card.motto, dir: snap.fighter, git: snap.git, at: snap.at };
    log(`  ${id}: ${r.fighter.card.name} (${c.model})`);
  }
  const list = leagueJobs(ids, { seeds }).map((j) => ({ ...j, dirs: [people[j.left].dir, people[j.right].dir], save: join(dir, 'fights', `${j.id}.json`) }));
  log(`Лига «${name}»: ${ids.length} бойцов, ${list.length} боёв, потоков ${nJobs}`);
  const results = [];
  const errors = [];
  const t0 = Date.now();
  await new Promise((resolveAll) => {
    let next = 0;
    let busy = 0;
    const workers = [];
    const feed = (w) => {
      if (next >= list.length) {
        w.terminate();
        if (--busy === 0) resolveAll();
        return;
      }
      w.postMessage(list[next++]);
    };
    for (let i = 0; i < Math.min(nJobs, list.length); i++) {
      const w = new Worker(new URL('./league-worker.js', import.meta.url));
      workers.push(w);
      busy++;
      w.on('message', (m) => {
        if (m.ok) results.push(m.result);
        else errors.push(m);
        const done = results.length + errors.length;
        if (done % 25 === 0 || done === list.length) log(`  ${done}/${list.length} боёв, ${Math.round((Date.now() - t0) / 1000)} с`);
        feed(w);
      });
      w.on('error', (e) => {
        errors.push({ id: '?', error: String(e?.stack || e) });
        if (--busy === 0) resolveAll();
      });
      feed(w);
    }
  });
  if (errors.length) log(`  ! ошибок: ${errors.length}; первая: ${errors[0].error.split('\n')[0]}`);
  results.sort((a, b) => a.id.localeCompare(b.id));
  const league = { name, ring: RING_VERSION, at: new Date().toISOString(), seeds, starts: Object.keys(STARTS), people, fights: results, errors };
  league.table = leagueTable(league);
  writeFileSync(join(dir, 'league.json'), JSON.stringify(league, null, 1) + '\n');
  writeFileSync(join(dir, 'README.md'), leagueMarkdown(league));
  return league;
}

// ---------- the table ----------

// Bradley–Terry strengths by the MM algorithm; a draw is half a win each way; every pair gets one virtual draw
// (keeps a fighter with no wins at a finite rating). Rating on the Elo scale: 1000 + 400·log10(strength / mean).
export function bradleyTerry(ids, fights, iters = 400) {
  const idx = Object.fromEntries(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const W = Array(n).fill(0);
  const N = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) N[i][j] += 1;
  for (let i = 0; i < n; i++) W[i] += 0.5 * (n - 1);
  for (const f of fights) {
    const a = idx[f.left];
    const b = idx[f.right];
    N[a][b]++;
    N[b][a]++;
    if (f.winner === null) {
      W[a] += 0.5;
      W[b] += 0.5;
    } else W[idx[f.winner]] += 1;
  }
  let p = Array(n).fill(1);
  for (let it = 0; it < iters; it++) {
    const q = p.map((pi, i) => {
      let den = 0;
      for (let j = 0; j < n; j++) if (j !== i && N[i][j]) den += N[i][j] / (pi + p[j]);
      return W[i] / den;
    });
    const g = Math.exp(q.reduce((s, v) => s + Math.log(v), 0) / n);
    p = q.map((v) => v / g);
  }
  return Object.fromEntries(ids.map((id, i) => [id, 1000 + 400 * Math.log10(p[i])]));
}

// a small deterministic generator for the bootstrap
function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function leagueTable(league, { boot = 400 } = {}) {
  const ids = Object.keys(league.people);
  const fights = league.fights;
  const row = Object.fromEntries(ids.map((id) => [id, { id, fights: 0, wins: 0, draws: 0, losses: 0, kos: 0, points: 0, hpLeft: 0, vs: {} }]));
  for (const f of fights) {
    for (const [me, op, side] of [[f.left, f.right, 0], [f.right, f.left, 1]]) {
      const r = row[me];
      r.fights++;
      const vs = (r.vs[op] ||= { fights: 0, points: 0, wins: 0, losses: 0, draws: 0 });
      vs.fights++;
      r.hpLeft += f.hp[side] / f.maxHp[side];
      if (f.winner === null) {
        r.draws++;
        r.points += 0.5;
        vs.draws++;
        vs.points += 0.5;
      } else if (f.winner === me) {
        r.wins++;
        r.points++;
        vs.wins++;
        vs.points++;
        if (f.reason === 'ko') r.kos++;
      } else {
        r.losses++;
        vs.losses++;
      }
    }
  }
  const rating = bradleyTerry(ids, fights);
  // bootstrap: resample the fights of every pair with replacement
  const byPair = {};
  for (const f of fights) (byPair[[f.left, f.right].sort().join('|')] ||= []).push(f);
  const rnd = mulberry(20261117);
  const samples = Object.fromEntries(ids.map((id) => [id, []]));
  const firsts = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let b = 0; b < boot; b++) {
    const res = [];
    for (const list of Object.values(byPair)) for (let k = 0; k < list.length; k++) res.push(list[Math.floor(rnd() * list.length)]);
    const r = bradleyTerry(ids, res, 150);
    for (const id of ids) samples[id].push(r[id]);
    const top = ids.reduce((a, c) => (r[c] > r[a] ? c : a), ids[0]);
    firsts[top]++;
  }
  const q = (arr, x) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(x * (s.length - 1))))];
  };
  const out = ids.map((id) => {
    const r = row[id];
    const share = r.fights ? r.points / r.fights : 0;
    return {
      ...r,
      share,
      tier: tierOf(share),
      rating: Math.round(rating[id]),
      range: [Math.round(q(samples[id], 0.05)), Math.round(q(samples[id], 0.95))],
      firstChance: firsts[id] / boot,
      hpLeft: r.fights ? r.hpLeft / r.fights : 0,
    };
  });
  out.sort((a, b) => b.rating - a.rating || b.share - a.share);
  out.forEach((r, i) => (r.place = i + 1));
  return out;
}

const pct = (x) => `${Math.round(x * 100)} %`;

export function leagueMarkdown(league) {
  const t = league.table;
  const P = league.people;
  const lines = [];
  lines.push(`# Лига «${league.name}»`, '');
  lines.push(`Ринг ${league.ring.ring}. Каждый с каждым: ${league.starts.length} стартов (${league.starts.join(', ')}) × 2 стороны × ${league.seeds} зерна = ${league.starts.length * 2 * league.seeds} боёв на пару, всего ${league.fights.length}.`, '');
  lines.push('| Место | Тир | Боец | Модель | Очки | Победы / ничьи / поражения | Нокауты | Рейтинг (90 %) | Шанс быть первым |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of t) lines.push(`| ${r.place} | ${r.tier} | ${P[r.id].name} | ${P[r.id].model} | ${pct(r.share)} | ${r.wins} / ${r.draws} / ${r.losses} | ${r.kos} | ${r.rating} (${r.range[0]}–${r.range[1]}) | ${pct(r.firstChance)} |`);
  lines.push('', '## Кто кого (доля очков строки против столбца)', '');
  lines.push(`| | ${t.map((r) => P[r.id].name).join(' | ')} |`, `|---|${t.map(() => '---').join('|')}|`);
  for (const a of t) lines.push(`| ${P[a.id].name} | ${t.map((b) => (a.id === b.id ? '—' : a.vs[b.id] ? pct(a.vs[b.id].points / a.vs[b.id].fights) : '')).join(' | ')} |`);
  const slow = [];
  for (const f of league.fights) f.brain.forEach((b, s) => { if (b.slow || b.errors) slow.push(`${f.id}: ${s === 0 ? f.left : f.right} — пропусков ${b.slow}, ошибок ${b.errors}`); });
  if (slow.length) lines.push('', '## Мозги не успели или упали', '', ...slow.slice(0, 40).map((s) => `- ${s}`));
  if (league.errors?.length) lines.push('', '## Ошибки судьи', '', ...league.errors.map((e) => `- ${e.id}: ${e.error.split('\n')[0]}`));
  lines.push('', `Тиры по доле очков: ${TIERS.map((x) => `${x.tier} от ${pct(x.min)}`).join(', ')}. Рейтинг — модель Брэдли — Терри по всем боям, в скобках 90 % бутстрепа по боям каждой пары.`, '');
  return lines.join('\n');
}

export function loadLeague(name) {
  const p = join(leagueDir(name), 'league.json');
  if (!existsSync(p)) throw new Error(`нет лиги «${name}» (leagues/${name}/league.json)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function listLeagues() {
  return existsSync(LEAGUES) ? readdirSync(LEAGUES).filter((n) => existsSync(join(LEAGUES, n, 'league.json'))) : [];
}
