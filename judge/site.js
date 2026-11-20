// The site as plain files, built by one command:
//   node ring.mjs site [dist] [--no-pages]
//
//   <out>/                 the pages (site/, Astro): home, tournament/, fighters/, enter/, their assets/
//   <out>/play/            the game (viewer/), a full-screen page of its own
//   <out>/kit, stages, announcer, seasons, api/game.json
//                          what the game reads, laid out as in the repository: the game finds the ring's root as
//                          the parent of its own folder (viewer/data.js), so play/ sits next to them
// No server behind it and no address inside it: any static hosting serves the folder, under any path.
// --no-pages leaves the pages out (no npm needed): the game alone, the root index sends to play/.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { RING } from './contestants.js';
import { gameData } from './gamedata.js';

// folder → [where it goes, what of it goes out (a test of the path inside the folder; nothing — everything)]
const PARTS = [
  ['viewer', 'play', (p) => !/^(dev\.|show\/|show$)/.test(p)],
  ['kit/arena/engine'],
  ['kit/arena/render'],
  ['kit/arena/sounds'],
  ['kit/arena/sparring'],
  ['kit/arena/vendor'],
  ['kit/fighter'],
  ['stages'],
  ['announcer', null, (p) => !/\.mjs$/.test(p)],
  ['seasons'],
];
// top-level names of the game's side of the site: a page of the same name would be overwritten
const TAKEN = [...new Set(PARTS.map(([dir, to]) => (to || dir).split('/')[0])), 'api'];

// the pages: site/ built by Astro straight into the output folder
function buildPages(out, log) {
  const site = join(RING, 'site');
  const npm = (args) => {
    const r = spawnSync('npm', args, { cwd: site, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, RING_ROOT: RING, ASTRO_TELEMETRY_DISABLED: '1' } });
    if (r.status !== 0) throw new Error(`npm ${args.join(' ')} в site/ не прошёл:\n${(r.stdout || '').slice(-3000)}\n${(r.stderr || r.error?.message || '').slice(-3000)}`);
  };
  if (!existsSync(join(site, 'node_modules', 'astro'))) {
    log('Сайт: ставлю зависимости site/ (npm ci)');
    npm(['ci', '--no-audit', '--no-fund']);
  }
  npm(['run', 'build', '--', '--outDir', out]);
  const clash = readdirSync(out).filter((n) => TAKEN.includes(n));
  if (clash.length) throw new Error(`страницы сайта заняли имена игры: ${clash.join(', ')}`);
}

export function buildSite(out, { log = console.log, pages = true } = {}) {
  if (!relative(RING, out) || relative(out, RING) === '') throw new Error('сайт собирается в отдельную папку');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  if (pages) buildPages(out, log);
  else writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Ринг моделей</title><meta http-equiv="refresh" content="0;url=play/"><a href="play/">Ринг моделей</a>\n');
  mkdirSync(join(out, 'api'), { recursive: true });
  for (const [dir, to, keep] of PARTS) {
    const from = join(RING, dir);
    if (!existsSync(from)) continue;
    cpSync(from, join(out, to || dir), { recursive: true, filter: (src) => { const p = relative(from, src).split(sep).join('/'); return !p || !keep || keep(p); } });
  }
  const data = { ...gameData({ live: false }), static: true };
  writeFileSync(join(out, 'api', 'game.json'), JSON.stringify(data));
  // a round without its record cannot be watched: say so at build time, not in the visitor's browser
  const lost = data.matches.flatMap((m) => m.rounds.filter((r) => !r.replay || !existsSync(join(out, r.replay))).map((r) => `${m.id} раунд ${r.n}`));
  if (lost.length) log(`Сайт: нет записи боя — ${lost.join(', ')}. Ссылки «Смотреть раунд» на них не откроют бой.`);
  log(`Сайт: ${out} — ${pages ? 'страницы и игра' : 'только игра'}, бойцов ${data.fighters.filter((f) => f.cid).length}, матчей ${data.matches.length}`);
  return out;
}
