// A cup: a knockout bracket between fighters that are already made — of the shared roster and of the published
// seasons. No agents and no locker rooms: a fighter is the same in every round.
//   node ring.mjs cup <сезон> --ids a,b,c,… [--title "…"] [--order]
// The bracket is seeded by the common rating (--order: in the order of --ids, the first is the top seed); a match
// goes to two wins, the sides swap and the stage changes every round. The cup is written as a season,
// seasons/<сезон>/, in the shape judge/publish.js writes: the game and the site show it as any other tournament.
// A season fighter is not copied: the cup points at its version in its own season, which never changes. A roster
// fighter may be replaced by its author later, so the cup keeps its own copy.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RING } from './contestants.js';
import { analyze, roundOrder } from './match.js';
import { roundStats, pickMoments } from './moments.js';
import { SEASONS, publishedData, rosterFighters, stageList, folderHash } from './gamedata.js';
import { ROSTER, readRoster } from './roster.js';
import { pairLeague, leagueTable, refEntrant, REFS } from './rating.js';
import { loadFighter, runFight } from '../kit/arena/tools/load.js';
import { ROUND_TICKS, RING_VERSION } from '../kit/arena/engine/index.js';
import { getRuleset, setRuleset } from '../kit/arena/engine/standard.js';

const local = (url) => join(RING, ...url.split('/').filter(Boolean));
const seed32 = (...parts) => createHash('sha256').update(parts.join('|')).digest().readUInt32LE(0);

// Where the seeds stand in a bracket of 2, 4, 8, 16: [1, 2] → [1, 4, 2, 3] → [1, 8, 4, 5, 2, 7, 3, 6]: the two best
// can meet only in the final.
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) order = order.flatMap((s) => [s, order.length * 2 + 1 - s]);
  return order;
}
const STAGE_NAME = { 1: 'final', 2: 'semi', 4: 'quarter', 8: 'r16' };

// A participant by its name: a fighter of the roster or the last version of a fighter of a season.
function participant(cid, { roster, published }) {
  const own = readRoster(roster).find((r) => r.id === cid);
  if (own) {
    const game = rosterFighters(roster).find((f) => f.cid === cid);
    return { cid, from: 'roster', dir: own.fighter, game, version: game.versions[0] };
  }
  const f = published.fighters.find((x) => x.cid === cid);
  if (!f) throw new Error(`нет бойца «${cid}»: ни в общем наборе (roster/), ни в сезонах (seasons/)`);
  const version = f.versions[f.versions.length - 1];
  return { cid, from: 'season', dir: local(version.url), game: f, version };
}

export async function runCup(season, { ids, title = null, order = false, ratings = null, roster = ROSTER, jobs, cache, seasons = SEASONS, log = console.log } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(season || '')) throw new Error('имя сезона: латиница, цифры и дефис');
  ids = [...new Set(ids || [])];
  if (ids.length < 2 || ids.length > 16) throw new Error('в кубке от 2 до 16 бойцов: --ids a,b,c,…');
  const out = join(seasons, season);
  const old = existsSync(join(out, 'game.json')) ? JSON.parse(readFileSync(join(out, 'game.json'), 'utf8')) : null;
  if (old && !old.season?.cup) throw new Error(`сезон «${season}» уже есть, и это не кубок: возьми другое имя`);
  const before = getRuleset();
  setRuleset('standard');
  try {
    const published = publishedData();
    const taken = published.matches.filter((m) => m.season !== season).map((m) => m.id);
    const people = ids.map((cid) => participant(cid, { roster, published }));
    for (const p of people) {
      const r = await loadFighter(p.dir);
      if (!r.ok) throw new Error(`боец «${p.cid}» не проходит проверку:\n${r.errors.slice(0, 10).join('\n')}`);
      p.def = r.fighter;
    }

    // the seeding
    let seeded = people;
    if (!order) {
      if (!ratings) {
        const entrants = [...REFS.map(refEntrant), ...people.map((p) => ({ id: p.cid, kind: 'probe', dir: p.dir }))];
        log(`Посев: лига ${people.length} бойцов с эталонами`);
        const league = await pairLeague(entrants, { jobs, cache, log });
        if (league.errors.length) throw new Error(`посев: ${league.errors.length} боёв не сыграно — ${String(league.errors[0].error).split('\n')[0]}`);
        ratings = Object.fromEntries(leagueTable(entrants, league.fights).map((e) => [e.id, e.rating]));
      }
      seeded = [...people].sort((a, b) => (ratings[b.cid] ?? 0) - (ratings[a.cid] ?? 0) || ids.indexOf(a.cid) - ids.indexOf(b.cid));
    }
    seeded.forEach((p, i) => (p.seed = i + 1));
    log(`Посев: ${seeded.map((p) => `${p.seed}. ${p.def.card.name}${ratings ? ` (${ratings[p.cid]})` : ''}`).join(', ')}`);

    for (const own of ['fighters', 'matches', 'game.json']) rmSync(join(out, own), { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const url = (...p) => `/seasons/${season}/${p.join('/')}/`;
    // a roster fighter is frozen into the cup; a season fighter stays where it is
    for (const p of people) {
      if (p.from === 'roster') {
        cpSync(p.dir, join(out, 'fighters', p.cid, 'v1'), { recursive: true });
        p.url = url('fighters', p.cid, 'v1');
        p.v = 1;
        p.hash = folderHash(p.dir);
      } else {
        p.url = p.version.url;
        p.v = p.version.v;
        p.hash = p.version.hash;
      }
      p.rounds = [];
    }

    const stages = stageList().map((s) => s.id);
    if (!stages.length) throw new Error('нет ни одной сцены в stages/');
    const size = 2 ** Math.ceil(Math.log2(seeded.length));
    let line = seedOrder(size).map((s) => seeded[s - 1] || null);
    const matches = [];
    const bracket = [];
    let played = 0;
    while (line.length > 1) {
      const name = STAGE_NAME[line.length / 2];
      const next = [];
      for (let i = 0; i < line.length; i += 2) {
        const [a, b] = [line[i], line[i + 1]];
        if (!a || !b) {
          next.push(a || b); // the better seed has no opponent in this round
          continue;
        }
        const [red, blue] = a.seed < b.seed ? [a, b] : [b, a];
        const id = `${season}-${name}${line.length > 2 ? `-${i / 2 + 1}` : ''}`;
        if (taken.includes(id)) throw new Error(`матч «${id}» уже есть в другом сезоне`);
        const m = await playMatch({ id, season, red, blue, stages, shift: played++, out, url, log });
        matches.push(m);
        bracket.push({ stage: name, match: id, red: red.cid, blue: blue.cid, winner: m.winner });
        next.push(m.winner === blue.cid ? blue : red);
      }
      line = next;
    }
    const champion = line[0];

    const fighters = people.map((p) => {
      const { versions, season: _from, ...about } = p.game;
      return { ...about, versions: [{ ...p.version, hash: p.hash, url: p.url, v: p.v, label: `v${p.v}`, rounds: p.rounds, note: null, changes: null, current: undefined }] };
    });
    const game = { season: { title: title || season, ring: RING_VERSION, published: new Date().toISOString().slice(0, 10), cup: true, seeds: seeded.map((p) => ({ cid: p.cid, seed: p.seed, rating: ratings?.[p.cid] ?? null })), bracket, champion: champion.cid }, fighters, matches: [...matches].reverse() };
    writeFileSync(join(out, 'game.json'), `${JSON.stringify(game, null, 1)}\n`);
    log(`Кубок «${game.season.title}»: ${out} — бойцов ${fighters.length}, матчей ${matches.length}, победил ${champion.def.card.name}`);
    return { out, game, champion: champion.cid };
  } finally {
    setRuleset(before);
  }
}

// One match to two wins. A draw is replayed; after five rounds the score decides, and with an even score the better
// seed (red) goes on.
async function playMatch({ id, season, red, blue, stages, shift, out, url, log, firstTo = 2, maxRounds = 5 }) {
  const m = { id, created: new Date().toISOString(), red: red.cid, blue: blue.cid, models: { [red.cid]: red.game.model, [blue.cid]: blue.game.model }, score: { [red.cid]: 0, [blue.cid]: 0 }, over: false, winner: null, firstTo, rounds: [] };
  const stats = [];
  log(`Матч ${id}: ${red.def.card.name} (${red.seed}) против ${blue.def.card.name} (${blue.seed})`);
  while (!m.over) {
    const n = m.rounds.length + 1;
    const sides = n % 2 === 1 ? [red, blue] : [blue, red];
    const fighters = sides.map((p) => p.def);
    const run = await runFight({ dirs: sides.map((p) => p.dir), fighters, options: { round: n }, seed: seed32(season, id, n), start: null, maxTicks: ROUND_TICKS + 900 });
    const cids = sides.map((p) => p.cid);
    const replay = { ...run.replay, fighters: cids.map((cid) => `${cid}/fighter`), round: n, stats: run.stats };
    const dir = join(out, 'matches', id, `round-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'replay.json'), `${JSON.stringify(replay)}\n`);
    const an = analyze(fighters, run.replay);
    const res = an.result;
    const winner = res.winner === null ? null : cids[res.winner];
    const wins = [m.score[cids[0]], m.score[cids[1]]];
    if (winner) m.score[winner]++;
    const st = roundStats(an, fighters);
    stats.push({ ...st, n, sides: cids, names: fighters.map((f) => f.card.name) });
    m.rounds.push({ n, left: cids[0], right: cids[1], stage: stages[(shift + n - 1) % stages.length], winner, reason: res.reason, ticks: res.ticks, hp: res.hp.map((h) => Math.max(0, Math.round(h))), maxHp: res.maxHp, names: Object.fromEntries(sides.map((p) => [p.cid, p.def.card.name])), versions: Object.fromEntries(sides.map((p) => [p.cid, p.v])), wins, final: false, replay: `${url('matches', id, `round-${n}`)}replay.json`, dirs: sides.map((p) => p.url), video: null, comment: false, timing: null });
    for (const p of sides) p.rounds.push({ match: id, round: n });
    const won = Object.entries(m.score).find(([, v]) => v >= firstTo);
    if (won) Object.assign(m, { over: true, winner: won[0] });
    else if (m.rounds.length >= maxRounds) {
      const [a, b] = [m.score[red.cid], m.score[blue.cid]];
      Object.assign(m, { over: true, winner: b > a ? blue.cid : red.cid, ...(a === b ? { decided: 'seed' } : {}) });
    }
    log(`  раунд ${n}: ${winner ? `победил ${fighters[res.winner].card.name}` : 'ничья'}, ${res.reason === 'ko' ? 'нокаут' : 'по времени'}, ${(res.ticks / 60).toFixed(1)} с`);
  }
  m.rounds.forEach((r, i) => Object.assign(r, roundOrder(m.rounds, i), { final: i === m.rounds.length - 1 && !!m.winner }));
  for (const p of [red, blue]) for (const r of p.rounds) if (r.match === id) Object.assign(r, roundOrder(m.rounds, r.round - 1));
  m.stats = { match: id, rounds: stats.map((st) => ({ n: st.n, sides: st.sides, names: st.names, counters: st.counters, result: st.result, juicy: st.juicy, top: pickMoments(st.moments, 4) })), lockers: [] };
  m.roundStats = Object.fromEntries(stats.map((st) => [st.n, { hp: st.hp, counters: st.counters, juicy: st.juicy, result: st.result, moments: (st.moments || []).map(({ kind, side, at, from, to, score, damage, hits, deficit, text }) => ({ kind, side, at, from, to, score, damage, hits, deficit, text })) }]));
  Object.assign(m, { story: null, protocol: null, reel: null });
  return m;
}
