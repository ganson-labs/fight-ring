// A season: a finished tournament frozen into the repository. Every distinct version of each fighter once, the
// record of every round and one game.json in the shape of judge/gamedata.js, so the game, the site and the next
// judge read it without the contestants' folders and without the judge's working files.
//   node ring.mjs publish <season> --matches a,b,c [--title "…"]
//   seasons/<season>/game.json                 fighters with versions, matches, the season's card
//   seasons/<season>/fighters/<id>/v<N>/       the fighter as it stood in those rounds
//   seasons/<season>/matches/<match>/round-N/replay.json
// A fight is replayed from its record by the engine, so the videos stay with the judge.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { RING, registry } from './contestants.js';
import { MATCHES } from './match.js';
import { SEASONS, liveData } from './gamedata.js';
import { RING_VERSION } from '../kit/arena/engine/version.js';

// what a model left beside its fighter while building it: drafts, renders of its own checks, raw generations
const DRAFTS = [/^work$/, /^out$/, /^parts[\\/]raw$/, /^\./, /\.paint\.json$/];

export function publishSeason(season, { matches, title = null, log = console.log } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(season || '')) throw new Error('имя сезона: латиница, цифры и дефис');
  const live = liveData({ dirs: true });
  const reg = registry();
  const chosen = live.matches.filter((m) => matches.includes(m.id));
  const missing = matches.filter((id) => !chosen.some((m) => m.id === id));
  if (missing.length) throw new Error(`нет матчей: ${missing.join(', ')}`);
  const out = join(SEASONS, season);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const url = (...p) => `/${relative(RING, join(out, ...p)).split(sep).join('/')}/`;

  const cids = new Set(chosen.flatMap((m) => [m.red, m.blue]));
  const fighters = [];
  for (const f of live.fighters.filter((x) => cids.has(x.cid))) {
    const versions = [];
    for (const v of f.versions) {
      const rounds = v.rounds.filter((r) => matches.includes(r.match));
      if (!rounds.length) continue;
      const to = join(out, 'fighters', f.cid, `v${versions.length + 1}`);
      cpSync(v.dir, to, { recursive: true, filter: (src) => !DRAFTS.some((re) => re.test(relative(v.dir, src)) || re.test(basename(src))) });
      const { dir, ...rest } = v;
      versions.push({ ...rest, v: versions.length + 1, label: `v${versions.length + 1}`, rounds, url: url('fighters', f.cid, `v${versions.length + 1}`), current: undefined });
    }
    if (versions.length && versions[0].changes) versions[0].changes = null; // its earlier version is not in the season
    const c = reg[f.cid] || {};
    fighters.push({ ...f, versions, agent: c.agent || null, agentModel: c.agentModel || null, effort: c.effort || null });
    log(`  ${f.cid}: ${f.name}, версий ${versions.length}`);
  }

  const versionOf = (cid, match, round) => fighters.find((f) => f.cid === cid)?.versions.find((v) => v.rounds.some((r) => r.match === match && r.round === round));
  const list = chosen.map((m) => ({
    ...m,
    reel: null,
    rounds: m.rounds.map((r) => {
      const from = join(MATCHES, m.id, `round-${r.n}`, 'replay.json');
      const dir = join(out, 'matches', m.id, `round-${r.n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'replay.json'), readFileSync(from));
      return { ...r, versions: Object.fromEntries([r.left, r.right].map((cid) => [cid, versionOf(cid, m.id, r.n)?.v ?? null])), replay: `${url('matches', m.id, `round-${r.n}`)}replay.json`, dirs: [r.left, r.right].map((cid) => versionOf(cid, m.id, r.n)?.url), video: null, comment: false, timing: null };
    }),
  }));

  const game = { season: { title: title || season, ring: RING_VERSION, published: new Date().toISOString().slice(0, 10) }, fighters, matches: list };
  writeFileSync(join(out, 'game.json'), `${JSON.stringify(game, null, 1)}\n`);
  log(`Сезон «${game.season.title}»: ${out} — бойцов ${fighters.length}, матчей ${list.length}`);
  return out;
}
