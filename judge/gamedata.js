// What the game (viewer/) shows, found on its own: contestants from the registry and from the judge's match
// snapshots, every distinct version of each fighter (v1 before the first locker room, v2 after it, …, and the
// current folder if it moved on), what changed between versions, the model's locker-room reply, and the matches.
// Only URLs under the ring's server go out: no absolute paths, no contestant roots, nothing from .ring/.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { RING, registry } from './contestants.js';
import { MATCHES, diffFighters, roundOrder } from './match.js';

const readJSON = (f, fb = null) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};

// one hash for a fighter folder (raw parts are not part of the fighter)
export function folderHash(dir) {
  const h = createHash('sha1');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (n === 'raw' && d.endsWith('parts')) continue;
        walk(p);
      } else h.update(relative(dir, p).split(sep).join('/')).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}

// the ability's own words: the leading comment of its module
function aboutScript(file) {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const block = src.match(/^\s*\/\*([\s\S]*?)\*\//);
  if (block) return block[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean).join(' ').slice(0, 400) || null;
  const lines = [];
  for (const l of src.split('\n')) {
    const m = l.match(/^\s*\/\/\s?(.*)$/);
    if (!m) break;
    if (m[1].trim()) lines.push(m[1].trim());
  }
  return lines.join(' ').slice(0, 400) || null;
}

function abilitiesOf(dir) {
  const moves = readJSON(join(dir, 'moves.json'), {})?.moves || [];
  const out = [];
  for (const mv of moves) {
    const b = (mv.blocks || []).find((x) => x.type === 'ability');
    if (b?.script) out.push({ move: mv.id, name: mv.name, slot: mv.slot, about: aboutScript(join(dir, b.script)) });
  }
  return out;
}

// an address under the ring's server; a folder outside the ring has none (its disk path never goes out)
const urlOf = (p) => {
  const rel = relative(RING, p);
  return rel.startsWith('..') || isAbsolute(rel) ? null : `/${rel.split(sep).join('/')}/`;
};

// what changed between two versions, once per pair of folder hashes (the server asks again on every refresh)
const diffCache = new Map();
function diffOf(a, b) {
  const k = `${a.hash}|${b.hash}`;
  if (!diffCache.has(k)) diffCache.set(k, diffFighters(a.dir, b.dir));
  return diffCache.get(k);
}

// Distinct versions in order; an unchanged snapshot only adds another round to the same version. live: the
// contestant's own folder, a version of its own when it moved on after the last snapshot.
export function buildVersions(snaps, live = null, liveUrl = null, { dirs = false } = {}) {
  const versions = [];
  for (const s of snaps) {
    const hash = folderHash(s.dir);
    const last = versions[versions.length - 1];
    if (last && last.hash === hash) {
      last.rounds.push({ match: s.match, round: s.round, num: s.num, rerun: s.rerun });
      continue;
    }
    versions.push({ hash, dir: s.dir, url: urlOf(s.dir), rounds: [{ match: s.match, round: s.round, num: s.num, rerun: s.rerun }], note: s.note, at: s.at });
  }
  if (live && existsSync(join(live, 'fighter.json'))) {
    const hash = folderHash(live);
    if (!versions.length || versions[versions.length - 1].hash !== hash) versions.push({ hash, dir: live, url: liveUrl, rounds: [], note: null, current: true, at: null });
    else versions[versions.length - 1].current = true;
  }
  versions.forEach((v, i) => {
    v.v = i + 1;
    v.label = `v${i + 1}`;
    const card = readJSON(join(v.dir, 'fighter.json'), {});
    v.name = card.name || null;
    v.colors = card.colors || null;
    v.abilities = abilitiesOf(v.dir);
    // the judge's measurement of the snapshot (round-N/<id>/abilities.json): damage of an ability move for the card
    const measured = readJSON(join(v.dir, '..', 'abilities.json'), null);
    if (Array.isArray(measured)) for (const a of v.abilities) a.measured = measured.find((x) => x.id === a.move)?.measured || null;
    v.changes = i > 0 ? diffOf(versions[i - 1], v) : null;
  });
  if (!dirs) for (const v of versions) delete v.dir;
  return versions;
}

export function listMatchesRaw() {
  if (!existsSync(MATCHES)) return [];
  return readdirSync(MATCHES)
    .map((id) => readJSON(join(MATCHES, id, 'match.json')))
    .filter((m) => m?.id)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

// The published seasons (seasons/<id>/game.json, written by judge/publish.js): tournaments that are over, kept in
// the repository in the same shape as the answer of this module. Their addresses are already under the ring's root.
export const SEASONS = join(RING, 'seasons');
export function publishedData() {
  const out = { fighters: [], matches: [], seasons: [] };
  if (!existsSync(SEASONS)) return out;
  for (const id of readdirSync(SEASONS).sort()) {
    const d = readJSON(join(SEASONS, id, 'game.json'));
    if (!d) continue;
    out.seasons.push({ id, ...d.season });
    out.fighters.push(...d.fighters.map((f) => ({ ...f, season: id })));
    out.matches.push(...d.matches.map((m) => ({ ...m, season: id })));
  }
  return out;
}

// The stages of the ring.
export function stageList() {
  const dir = join(RING, 'stages');
  const out = [];
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    const d = readJSON(join(dir, name, 'stage.json'));
    if (!d) continue;
    const far = (d.layers || []).find((l) => l.image)?.image;
    out.push({ id: name, dir: `/stages/${name}/`, name: d.name || name, thumb: far ? `/stages/${name}/${far}` : null });
  }
  return out;
}

// Everything the game shows: the judge's own work (liveData) first, then the published seasons; a contestant or a
// match that is still on the judge's disk is not repeated from its published copy. live: false — the published only.
export function gameData({ live = true } = {}) {
  const pub = publishedData();
  const own = live ? liveData() : { fighters: trainingPartners(), matches: [] };
  const ids = new Set(own.fighters.map((f) => f.id));
  const mids = new Set(own.matches.map((m) => m.id));
  return {
    fighters: [...own.fighters.filter((f) => f.cid), ...pub.fighters.filter((f) => !ids.has(f.id)), ...own.fighters.filter((f) => !f.cid)],
    matches: [...own.matches, ...pub.matches.filter((m) => !mids.has(m.id))],
    seasons: pub.seasons,
    stages: stageList(),
  };
}

// training partners from the kit: the template and the sparring dummies
function trainingPartners() {
  const fighters = [];
  fighters.push({ id: 'kit/fighter', cid: null, training: true, model: 'Шаблон набора', name: 'Боец', versions: [{ v: 1, label: 'v1', name: 'Боец', colors: readJSON(join(RING, 'kit', 'fighter', 'fighter.json'), {}).colors || null, url: '/kit/fighter/', rounds: [], abilities: abilitiesOf(join(RING, 'kit', 'fighter')), changes: null, current: true }] });
  const sparring = join(RING, 'kit', 'arena', 'sparring');
  if (existsSync(sparring)) for (const n of readdirSync(sparring)) {
    const f = join(sparring, n, 'fighter.json');
    if (!existsSync(f)) continue;
    fighters.push({ id: `sparring/${n}`, cid: null, training: true, sparring: n, model: 'Спарринг', name: readJSON(f, {}).name || n, versions: [{ v: 1, label: 'v1', name: readJSON(f, {}).name || n, colors: readJSON(f, {}).colors || null, url: `/kit/arena/sparring/${n}/`, rounds: [], abilities: [], changes: null, current: true }] });
  }
  return fighters;
}

// The judge's own work: contestants of the registry and the matches on disk. dirs: true keeps the folder of every
// version (for judge/publish.js); nothing with a disk path leaves through gameData().
export function liveData({ dirs = false } = {}) {
  const reg = registry();
  const matches = listMatchesRaw();
  const people = new Map();
  const person = (cid) => {
    if (!people.has(cid)) people.set(cid, { id: cid, model: reg[cid]?.model || null, color: reg[cid]?.color || null, snaps: [] });
    return people.get(cid);
  };
  for (const m of matches) {
    for (const r of m.rounds) {
      for (const cid of [r.left, r.right]) {
        const dir = join(MATCHES, m.id, `round-${r.n}`, cid, 'fighter');
        if (!existsSync(join(dir, 'fighter.json'))) continue;
        const p = person(cid);
        p.model ||= m.models?.[cid] || null;
        p.snaps.push({ dir, match: m.id, round: r.n, num: roundOrder(m.rounds, m.rounds.indexOf(r)).num, rerun: roundOrder(m.rounds, m.rounds.indexOf(r)).rerun, note: readJSON(join(MATCHES, m.id, `round-${r.n}`, cid, 'locker.json')), at: r.snapshot?.[cid]?.at || m.created });
      }
    }
  }
  for (const [cid, c] of Object.entries(reg)) if (c.root && existsSync(join(c.root, 'fighter', 'fighter.json'))) person(cid);

  const fighters = [];
  for (const p of people.values()) {
    const versions = buildVersions(p.snaps, reg[p.id]?.root ? join(reg[p.id].root, 'fighter') : null, `/c/${p.id}/fighter/`, { dirs });
    for (const v of versions) v.name ||= p.id;
    const top = versions[versions.length - 1];
    fighters.push({ id: `c/${p.id}`, cid: p.id, model: p.model || p.id, color: p.color, colors: top?.colors || null, name: top?.name || p.id, versions });
  }

  fighters.push(...trainingPartners());

  const byCid = new Map(fighters.filter((f) => f.cid).map((f) => [f.cid, f]));
  const versionFor = (cid, match, round) => byCid.get(cid)?.versions.find((v) => v.rounds.some((r) => r.match === match && r.round === round))?.v ?? null;
  const matchList = matches.reverse().map((m) => ({
    id: m.id,
    created: m.created,
    red: m.red,
    blue: m.blue,
    models: { [m.red]: byCid.get(m.red)?.model || m.models?.[m.red] || m.red, [m.blue]: byCid.get(m.blue)?.model || m.models?.[m.blue] || m.blue },
    score: m.score,
    over: m.over,
    winner: m.winner,
    firstTo: m.firstTo,
    rounds: m.rounds.map((r, i) => {
      const before = { [m.red]: 0, [m.blue]: 0 };
      for (const x of m.rounds.slice(0, i)) if (x.winner) before[x.winner]++;
      const base = `/matches/${m.id}/round-${r.n}/`;
      return {
        n: r.n, ...roundOrder(m.rounds, i), left: r.left, right: r.right, stage: r.stage, winner: r.winner, reason: r.reason, ticks: r.ticks, hp: r.hp, maxHp: r.maxHp,
        names: Object.fromEntries([r.left, r.right].map((cid) => [cid, r.snapshot?.[cid]?.name || cid])),
        versions: Object.fromEntries([r.left, r.right].map((cid) => [cid, versionFor(cid, m.id, r.n)])),
        wins: [before[r.left], before[r.right]],
        final: m.over && i === m.rounds.length - 1 && !!m.winner,
        replay: `${base}replay.json`,
        dirs: [`${base}${r.left}/fighter/`, `${base}${r.right}/fighter/`],
        // the game shows the round with its own sound; the voiced commentary stays in fight-16x9-comment.mp4
        video: existsSync(join(MATCHES, m.id, `round-${r.n}`, 'fight-16x9.mp4')) ? `${base}fight-16x9.mp4` : existsSync(join(MATCHES, m.id, `round-${r.n}`, 'fight-16x9-comment.mp4')) ? `${base}fight-16x9-comment.mp4` : null,
        comment: existsSync(join(MATCHES, m.id, `round-${r.n}`, 'comment', 'lines.json')),
        timing: existsSync(join(MATCHES, m.id, `round-${r.n}`, 'fight-16x9.timing.json')) ? `${base}fight-16x9.timing.json` : null,
      };
    }),
    // the judge's numbers of the match and its protocol (judge/moments.js, judge/protocol.js)
    stats: readJSON(join(MATCHES, m.id, 'stats.json')),
    roundStats: Object.fromEntries(m.rounds.map((r) => [r.n, (({ hp, counters, juicy, result, moments }) => ({ hp, counters, juicy, result, moments: (moments || []).map(({ kind, side, at, from, to, score, damage, hits, deficit, text }) => ({ kind, side, at, from, to, score, damage, hits, deficit, text })) }))(readJSON(join(MATCHES, m.id, `round-${r.n}`, 'stats.json'), {}))])),
    // the match told for the viewer: judge/captions.js → matchStory, written with the reel
    story: readJSON(join(MATCHES, m.id, 'story.json')),
    protocol: readJSON(join(MATCHES, m.id, 'protocol.json')),
    reel: existsSync(join(MATCHES, m.id, 'reel', 'match-16x9.mp4')) ? `/matches/${m.id}/reel/match-16x9.mp4` : null,
  }));
  // the operator can narrow the game to one tournament: ring.config.json → "showOnly": ["id", …]
  const only = readJSON(join(RING, 'ring.config.json'), {}).showOnly;
  if (Array.isArray(only) && only.length) {
    return { fighters: fighters.filter((f) => !f.cid || only.includes(f.cid)), matches: matchList.filter((m) => only.includes(m.red) && only.includes(m.blue)) };
  }
  return { fighters, matches: matchList };
}
