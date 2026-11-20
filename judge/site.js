// The site as plain files, built by one command:
//   node ring.mjs site [dist] [--no-pages] [--no-rating]
//
//   <out>/                 the pages (site/, Astro): home, tournament/, fighters/, enter/, their assets/
//   <out>/play/            the game (viewer/), a full-screen page of its own
//   <out>/kit, stages, announcer, seasons, roster, api/game.json, api/rating.json
//                          what the game reads, laid out as in the repository: the game finds the ring's root as
//                          the parent of its own folder (viewer/data.js), so play/ sits next to them
// No server behind it and no address inside it: any static hosting serves the folder, under any path.
// --no-pages leaves the pages out (no npm needed): the game alone, the root index sends to play/.
// --no-rating skips the common rating (judge/rating.js): the page «Рейтинг» is built without the table.
//   <out>/_headers         what the pages and the workers of the site may load and talk to (Cloudflare Pages)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { RING } from './contestants.js';
import { gameData } from './gamedata.js';
import { commonRating, RATING_FILE } from './rating.js';

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
  ['roster', null, (p) => !/\.md$/.test(p)],
];
// top-level names of the game's side of the site: a page of the same name would be overwritten
const TAKEN = [...new Set(PARTS.map(([dir, to]) => (to || dir).split('/')[0])), 'api'];

// the pages: site/ built by Astro straight into the output folder
function buildPages(out, log, rating) {
  const site = join(RING, 'site');
  const npm = (args) => {
    // NODE_OPTIONS is dropped: the judge's own flags (no code from strings) are not Astro's
    const r = spawnSync('npm', args, { cwd: site, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, NODE_OPTIONS: '', RING_ROOT: RING, RING_RATING: rating || '', ASTRO_TELEMETRY_DISABLED: '1' } });
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

// ---------- the visitor's protection ----------

// The brains of fighters sent by strangers run in the visitor's browser, so the site says in its headers what its
// pages and workers may do (Cloudflare Pages reads _headers from the root of the site).
//   every address   nothing is loaded from and nothing is sent to another site, but the fonts of the pages;
//                   'unsafe-eval' is there for PixiJS, which builds its shader code from strings
//   the brain's worker   one more policy on top (a browser applies both): nothing but scripts of the site itself,
//                   no address to talk to at all, no code from a string, no workers of its own
// Inline scripts (the game's import map) are allowed by the hash of their text.
export const WORKER_POLICY = "default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'";
export function sitePolicy(hashes = []) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval'${hashes.map((h) => ` '${h}'`).join('')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

// the hashes of the inline scripts of every page under a folder
export function inlineScriptHashes(dir) {
  const out = new Set();
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.html')) for (const m of readFileSync(p, 'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc\s*=/.test(m[1]) && m[2].trim()) out.add(`sha256-${createHash('sha256').update(m[2]).digest('base64')}`);
    }
  };
  walk(dir);
  return [...out].sort();
}

// Cache-Control: no-cache — the browser keeps every file but asks whether it changed (an answer without a body when it
// did not). Cloudflare's default lets a browser keep a script for four hours: a fix does not reach the viewer.
export function siteHeaders(out) {
  return `/*
  Content-Security-Policy: ${sitePolicy(inlineScriptHashes(out))}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Cache-Control: no-cache

/play/brain-worker.js
  Content-Security-Policy: ${WORKER_POLICY}
`;
}

// _headers as a list of rules: [{ path, headers: [[name, value]] }]. A rule's path ends with * or names one file.
// The same header from two rules is joined with a comma, as Cloudflare Pages does (scripts/serve-site.mjs, tests).
export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ path: line.trim(), headers: [] });
    else if (rules.length) {
      const i = line.indexOf(':');
      rules[rules.length - 1].headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}
export function headersFor(rules, path) {
  const out = {};
  for (const r of rules) {
    const hit = r.path.endsWith('*') ? path.startsWith(r.path.slice(0, -1)) : path === r.path;
    if (hit) for (const [k, v] of r.headers) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

export async function buildSite(out, { log = console.log, pages = true, rating = true } = {}) {
  if (!relative(RING, out) || relative(out, RING) === '') throw new Error('сайт собирается в отдельную папку');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // the common rating is played before the pages are built: the page «Рейтинг» is made of it
  const table = rating ? await commonRating({ log }) : null;
  if (pages) buildPages(out, log, table ? RATING_FILE : null);
  else writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Ринг моделей</title><meta http-equiv="refresh" content="0;url=play/"><a href="play/">Ринг моделей</a>\n');
  mkdirSync(join(out, 'api'), { recursive: true });
  for (const [dir, to, keep] of PARTS) {
    const from = join(RING, dir);
    if (!existsSync(from)) continue;
    cpSync(from, join(out, to || dir), { recursive: true, filter: (src) => { const p = relative(from, src).split(sep).join('/'); return !p || !keep || keep(p); } });
  }
  const data = { ...gameData({ live: false }), static: true };
  writeFileSync(join(out, 'api', 'game.json'), JSON.stringify(data));
  if (table) writeFileSync(join(out, 'api', 'rating.json'), JSON.stringify(table));
  writeFileSync(join(out, '_headers'), siteHeaders(out));
  // a round without its record cannot be watched: say so at build time, not in the visitor's browser
  const lost = data.matches.flatMap((m) => m.rounds.filter((r) => !r.replay || !existsSync(join(out, r.replay))).map((r) => `${m.id} раунд ${r.n}`));
  if (lost.length) log(`Сайт: нет записи боя — ${lost.join(', ')}. Ссылки «Смотреть раунд» на них не откроют бой.`);
  log(`Сайт: ${out} — ${pages ? 'страницы и игра' : 'только игра'}, бойцов ${data.fighters.filter((f) => f.cid).length}, матчей ${data.matches.length}`);
  return out;
}
