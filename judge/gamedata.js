// What the game (viewer/) shows, found on its own: contestants from the registry and from the judge's match
// snapshots, every distinct version of each fighter (v1 before the first locker room, v2 after it, …, and the
// current folder if it moved on), what changed between versions, the model's locker-room reply, and the matches.
// Only URLs under the ring's server go out: no absolute paths, no contestant roots, nothing from .ring/.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { RING, registry } from './contestants.js';
import { MATCHES, diffFighters, roundOrder } from './match.js';
import { ROSTER, readRoster } from './roster.js';

const readJSON = (f, fb = null) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};

// one hash for a fighter folder (raw parts are not part of the fighter). The server asks on every refresh of the
// game and a roster of 300 fighters is 2 GB of pictures, so a folder whose files did not change (names, sizes, times)
// is not read again.
const hashCache = new Map();
export function folderHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (n === 'raw' && d.endsWith('parts')) continue;
        walk(p);
      } else files.push([p, st]);
    }
  };
  walk(dir);
  const stamp = files.map(([p, st]) => `${p}|${st.size}|${st.mtimeMs}`).join('\n');
  const have = hashCache.get(dir);
  if (have?.stamp === stamp) return have.hash;
  const h = createHash('sha1');
  for (const [p] of files) h.update(relative(dir, p).split(sep).join('/')).update(readFileSync(p));
  const hash = h.digest('hex').slice(0, 12);
  hashCache.set(dir, { stamp, hash });
  return hash;
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

// The published seasons (seasons/<id>/game.json, written by judge/publish.js and judge/cup.js): tournaments that are
// over, kept in the repository in the same shape as the answer of this module. Their addresses are already under the
// ring's root. A fighter that fought in two seasons (a cup takes fighters as they are) is one fighter here: a version
// with the same hash gets the rounds of both, another one becomes the next version.
export const SEASONS = join(RING, 'seasons');
export function publishedData() {
  const out = { fighters: [], matches: [], seasons: [] };
  if (!existsSync(SEASONS)) return out;
  const byId = new Map();
  for (const id of readdirSync(SEASONS).sort()) {
    const d = readJSON(join(SEASONS, id, 'game.json'));
    if (!d) continue;
    out.seasons.push({ id, ...d.season });
    const renumber = {};
    for (const f of d.fighters) {
      const have = byId.get(f.id);
      if (!have) {
        const first = { ...f, season: id, versions: f.versions.map((v) => ({ ...v, rounds: [...v.rounds] })) };
        byId.set(f.id, first);
        out.fighters.push(first);
        continue;
      }
      renumber[f.cid] = {};
      for (const v of f.versions) {
        let to = have.versions.find((x) => x.hash && x.hash === v.hash);
        if (to) to.rounds.push(...v.rounds);
        else {
          to = { ...v, v: have.versions.length + 1, label: `v${have.versions.length + 1}`, changes: null };
          have.versions.push(to);
          Object.assign(have, { name: v.name || have.name, colors: v.colors || have.colors });
        }
        renumber[f.cid][v.v] = to.v;
      }
    }
    out.matches.push(...d.matches.map((m) => ({ ...m, season: id, rounds: m.rounds.map((r) => ({ ...r, versions: Object.fromEntries(Object.entries(r.versions || {}).map(([cid, v]) => [cid, renumber[cid]?.[v] ?? v])) })) })));
  }
  return out;
}

// The fighters of the shared roster (roster/<id>/, docs/roster.md) as the game shows them: one version, the folder
// as it lies, with the author, the model and the agent from entry.json.
export function rosterFighters(root = ROSTER) {
  return readRoster(root).map((r) => {
    const colors = r.card.colors || null;
    const about = { model: r.entry.model, author: r.entry.author?.name || r.entry.author?.github || null, authorGithub: r.entry.author?.github || null, agent: r.entry.agent || null, agentModel: null, effort: r.entry.effort || null };
    return { id: `c/${r.id}`, cid: r.id, roster: true, ...about, color: colors?.accent || '#ffc94a', colors, name: r.card.name || r.id, versions: [{ hash: folderHash(r.fighter), url: `/roster/${r.id}/fighter/`, rounds: [], note: null, at: r.entry.date || null, v: 1, label: 'v1', name: r.card.name || r.id, colors, abilities: [], changes: null, current: true }] };
  });
}

// The stages of the ring.
export function stageList() {
  const dir = join(RING, 'stages');
  const out = [];
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    const d = readJSON(join(dir, name, 'stage.json'));
    if (!d) continue;
    const far = (d.layers || []).find((l) => l.image)?.image;
    // thumb.jpg: the far layer 640 points wide (the layer itself is 2.4 MB, four of them on the fight select)
    const thumb = existsSync(join(dir, name, 'thumb.jpg')) ? 'thumb.jpg' : far;
    out.push({ id: name, dir: `/stages/${name}/`, name: d.name || name, thumb: thumb ? `/stages/${name}/${thumb}` : null });
  }
  return out;
}

// Everything the game shows: the judge's own work (liveData) first, then the published seasons and the shared roster;
// a contestant or a match that is still on the judge's disk is not repeated from its published copy. live: false —
// the published only. roster: the roster's folder (null — without it).
export function gameData({ live = true, roster = ROSTER } = {}) {
  const pub = publishedData();
  const own = live ? liveData() : { fighters: trainingPartners(), matches: [] };
  const ids = new Set(own.fighters.map((f) => f.id));
  const mids = new Set(own.matches.map((m) => m.id));
  const shared = [];
  for (const r of roster ? rosterFighters(roster) : []) {
    if (ids.has(r.id)) continue;
    // a roster fighter that fought in a cup: the cup keeps its copy, the roster says who made it and what it is now
    const have = pub.fighters.find((f) => f.id === r.id);
    if (!have) {
      shared.push(r);
      continue;
    }
    const now = r.versions[0];
    const same = have.versions.find((v) => v.hash === now.hash);
    if (same) same.current = true;
    else have.versions.push({ ...now, v: have.versions.length + 1, label: `v${have.versions.length + 1}` });
    Object.assign(have, { roster: true, model: r.model, author: r.author, authorGithub: r.authorGithub, agent: r.agent, effort: r.effort, name: r.name, colors: r.colors, color: have.color || r.color });
  }
  return {
    fighters: [...own.fighters.filter((f) => f.cid), ...pub.fighters.filter((f) => !ids.has(f.id)), ...shared, ...own.fighters.filter((f) => !f.cid)],
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

// ---------- the light list and the details ----------
// The game opens with a list it can show a fighter select and a match list from; what only one page needs is asked
// for when that page opens: a fighter's locker-room replies, the breakdown of its changes and its abilities
// (api/fighter/<cid>.json), a match's numbers, story and protocol (api/match/<id>.json). With hundreds of fighters
// and seasons the list stays about half a kilobyte a fighter.
const FIGHTER_HEAVY = ['note', 'changes', 'abilities'];
const MATCH_HEAVY = ['stats', 'roundStats', 'story', 'protocol'];
const heavyVersion = (v) => !!v.note || !!v.changes || (v.abilities || []).length > 0;

// rating: rows of the common rating (out/rating.json), when it has been played: the game sorts by it
export function gameIndex(full, { rating = null } = {}) {
  const rate = new Map((rating || []).filter((r) => r.origin !== 'ref').map((r) => [r.id, r.rating]));
  return {
    ...full,
    fighters: full.fighters.map((f) => {
      // a fighter with nothing heavy (one version, no abilities in code) is whole in the list and has no file
      const heavy = !!f.cid && f.versions.some(heavyVersion);
      return {
        ...f,
        ...(f.cid && rate.has(f.cid) ? { rating: rate.get(f.cid) } : {}),
        ...(heavy ? { detail: `/api/fighter/${f.cid}.json` } : {}),
        versions: f.versions.map((v) => {
          const light = Object.fromEntries(Object.entries(v).filter(([k]) => !FIGHTER_HEAVY.includes(k)));
          return heavy ? { ...light, hasChanges: !!v.changes } : { ...light, note: null, changes: null, abilities: v.abilities || [] };
        }),
      };
    }),
    matches: full.matches.map((m) => ({ ...Object.fromEntries(Object.entries(m).filter(([k]) => !MATCH_HEAVY.includes(k))), detail: `/api/match/${m.id}.json` })),
  };
}

export function fighterDetail(full, cid) {
  const f = full.fighters.find((x) => x.cid === cid);
  return f ? { id: f.id, versions: f.versions.map((v) => ({ v: v.v, note: v.note ?? null, changes: v.changes ?? null, abilities: v.abilities || [] })) } : null;
}

export function matchDetail(full, id) {
  const m = full.matches.find((x) => x.id === id);
  return m ? { id: m.id, ...Object.fromEntries(MATCH_HEAVY.map((k) => [k, m[k] ?? null])) } : null;
}

// every file of the split, for a site of plain files: [[path under the root, data]]
export function gameFiles(full, opts = {}) {
  const index = gameIndex(full, opts);
  return [
    ['api/game.json', index],
    ...index.fighters.filter((f) => f.detail).map((f) => [f.detail.slice(1), fighterDetail(full, f.cid)]),
    ...index.matches.map((m) => [m.detail.slice(1), matchDetail(full, m.id)]),
  ];
}
