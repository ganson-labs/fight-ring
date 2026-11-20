// A league that grows: every pair of fighters plays under conditions drawn from the two fighters alone, so a new
// fighter adds only its own pairs and the fights of the others are taken from the cache as they were played.
// (The league of a tournament, judge/bench.js, draws its conditions from all the participants at once: there the
// table is one experiment and nobody joins later.) The same code plays the qualification of a fighter against the
// four references (judge/qualify.js) and the common rating of the site (judge/site.js).
//   node ring.mjs rating [--draws 8] [--jobs N]   the common rating → out/rating.json
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RING, KIT } from './contestants.js';
import { engineHash } from './match.js';
import { conditions, playAll, benchTable, folderHash } from './bench.js';
import { publishedData } from './gamedata.js';
import { readRoster, ROSTER } from './roster.js';
import { RING_VERSION } from '../kit/arena/engine/version.js';

export const REFS = ['shkval', 'strelok', 'skala', 'mekhanik'];
export const PAIR_CACHE = join(RING, 'leagues', '.pairs');
export const RATING_FILE = join(RING, 'out', 'rating.json');
// Workers of this league: the ruleset of ring 4 whatever the caller runs with (the tests of rings 2–3 start Node with
// tests/free.mjs, and a worker would inherit it). The ban on code from strings is the process's own flag
// (ring.mjs → guarded): a worker keeps it whatever its execArgv.
const WORKER = { execArgv: [] };

export const refEntrant = (name) => ({ id: `ref:${name}`, kind: 'ref', dir: join(KIT, 'arena', 'sparring', name) });

// entrants: [{ id, dir, kind: 'ref' | 'probe', … }]. pairs: [[idA, idB]], by default everyone with everyone.
// Returns { fights, errors, played, cached }: fights in the shape of judge/bench.js, with the entrants' ids.
export async function pairLeague(entrants, { pairs = null, draws = 4, jobs, cache = PAIR_CACHE, log = console.log } = {}) {
  const by = new Map(entrants.map((e) => [e.id, { ...e, hash: folderHash(e.dir) }]));
  if (by.size !== entrants.length) throw new Error('в лиге два участника с одним именем');
  const ids = [...by.keys()];
  pairs ||= ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b]));
  const engine = engineHash();
  const fights = [];
  const todo = [];
  let cached = 0;
  for (const [x, y] of pairs) {
    // the pair's own name: the same two folders give the same conditions on any machine and in any company
    const [a, b] = by.get(x).hash < by.get(y).hash ? [by.get(x), by.get(y)] : [by.get(y), by.get(x)];
    if (a.hash === b.hash) continue; // a fighter does not play its own copy
    const seed = createHash('sha256').update([engine, a.hash, b.hash].join('|')).digest('hex');
    const file = cache ? join(cache, `${seed.slice(0, 40)}-d${draws}.json`) : null;
    const name = (side) => (side === 'A' ? a.id : side === 'B' ? b.id : null);
    const stored = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (stored) {
      cached += stored.length;
      fights.push(...stored.map((f) => ({ ...f, id: `${name(f.left)}-vs-${name(f.right)}-${f.cluster}`, left: name(f.left), right: name(f.right), winner: name(f.winner) })));
      continue;
    }
    const pair = { a, b, file, n: 0, got: [] };
    for (const c of conditions(seed, draws)) {
      for (const [left, right] of [[a, b], [b, a]]) {
        pair.n++;
        todo.push({ id: `${left.id}-vs-${right.id}-${c.cluster}`, left: left.id, right: right.id, start: c.start, draw: c.draw, cluster: c.cluster, noise: c.noise, seed: c.seed, dirs: [left.dir, right.dir], pair });
      }
    }
  }
  const pairOf = new Map(todo.map((j) => [j.id, j.pair]));
  const played = todo.length ? await playAll(todo.map(({ pair, ...job }) => job), { jobs, log, worker: WORKER }) : { results: [], errors: [], seconds: 0 };
  for (const f of played.results) {
    fights.push(f);
    pairOf.get(f.id).got.push(f);
  }
  if (cache) for (const p of new Set(pairOf.values())) {
    if (p.got.length !== p.n) continue; // a pair with a failed fight is played again next time
    const side = (id) => (id === p.a.id ? 'A' : id === p.b.id ? 'B' : null);
    mkdirSync(cache, { recursive: true });
    writeFileSync(p.file, JSON.stringify(p.got.map((f) => ({ ...f, id: undefined, left: side(f.left), right: side(f.right), winner: side(f.winner) }))));
  }
  return { fights, errors: played.errors, played: played.results.length, cached, seconds: played.seconds, hashes: Object.fromEntries([...by].map(([id, e]) => [id, e.hash])) };
}

// The table of judge/bench.js over these fights: Bradley–Terry, the mean of the references is 1000.
export function leagueTable(entrants, fights, { boot = 400 } = {}) {
  const people = Object.fromEntries(entrants.map((e) => [e.id, { kind: e.kind === 'ref' ? 'ref' : 'probe', model: e.model || e.id, name: e.name || e.id }]));
  return benchTable({ people, fights }, { boot }).entries;
}

// Who is in the common rating: the last version of every fighter of the published seasons, every fighter of the
// roster and the four references.
export function ratingEntrants({ roster = ROSTER } = {}) {
  const out = REFS.map((n) => ({ ...refEntrant(n), name: JSON.parse(readFileSync(join(KIT, 'arena', 'sparring', n, 'fighter.json'), 'utf8')).name, model: null, origin: 'ref' }));
  const local = (url) => join(RING, ...url.split('/').filter(Boolean));
  const inRoster = readRoster(roster);
  for (const f of publishedData().fighters) {
    if (inRoster.some((r) => r.id === f.cid)) continue; // a roster fighter in a cup: the roster holds its last version
    const top = f.versions[f.versions.length - 1];
    out.push({ id: f.cid, kind: 'probe', dir: local(top.url), name: top.name || f.name, model: f.model, author: f.author || null, origin: 'season', version: top.v });
  }
  for (const r of inRoster) out.push({ id: r.id, kind: 'probe', dir: r.fighter, name: r.card.name, model: r.entry.model, author: r.entry.author?.name || r.entry.author?.github || null, origin: 'roster', version: null });
  return out;
}

export async function commonRating({ roster = ROSTER, draws = 8, jobs, cache = PAIR_CACHE, log = console.log, out = RATING_FILE } = {}) {
  const entrants = ratingEntrants({ roster });
  log(`Общий рейтинг: ${entrants.length} бойцов, каждая пара — ${draws * 10} боёв`);
  const league = await pairLeague(entrants, { draws, jobs, cache, log });
  if (league.errors.length) throw new Error(`общий рейтинг: ${league.errors.length} боёв не сыграно — ${String(league.errors[0].error).split('\n')[0]}`);
  const rows = leagueTable(entrants, league.fights).map((e) => {
    const who = entrants.find((x) => x.id === e.id);
    return { id: who.origin === 'ref' ? e.id.slice(4) : e.id, origin: who.origin, name: who.name, model: who.model, author: who.author || null, version: who.version ?? null, rating: e.rating, range: e.range, fights: e.fights, share: e.share, kos: e.kos };
  });
  const rating = { ring: RING_VERSION, at: new Date().toISOString().slice(0, 10), draws, fights: league.fights.length, rows };
  if (out) {
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, `${JSON.stringify(rating, null, 1)}\n`);
  }
  log(`Общий рейтинг: ${league.fights.length} боёв (сыграно ${league.played}, из запаса ${league.cached})${out ? ` → ${out}` : ''}`);
  return rating;
}
