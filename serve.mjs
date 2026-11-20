// Viewer server: static files of the ring + lists of fighters and stages. No dependencies.
//   node serve.mjs [--port 4848]
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES } from './kit/arena/tools/serve.js';
import { roundOrder } from './judge/match.js';
import { gameData, stageList } from './judge/gamedata.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 4848;

const readJSON = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
};

const registry = () => readJSON(join(root, 'contestants.json'));

async function listFighters() {
  const out = [];
  for (const [id, c] of Object.entries(registry())) {
    if (!existsSync(join(c.root, 'fighter', 'fighter.json'))) continue;
    out.push({ id: `c/${id}`, dir: `/c/${id}/fighter/`, model: c.model || id, color: c.color || '#e0e0e0', name: readJSON(join(c.root, 'fighter', 'fighter.json')).name || id });
  }
  out.push({ id: 'kit/fighter', dir: '/kit/fighter/', model: 'Шаблон набора', color: '#9aa0a8', name: 'Боец' });
  const sparring = join(root, 'kit', 'arena', 'sparring');
  for (const name of await readdir(sparring)) {
    if (existsSync(join(sparring, name, 'fighter.json'))) out.push({ id: `sparring/${name}`, dir: `/kit/arena/sparring/${name}/`, model: 'Спарринг', color: '#9a7b58', name: readJSON(join(sparring, name, 'fighter.json')).name || name, sparring: name });
  }
  return out;
}

async function listMatches() {
  const dir = join(root, 'matches');
  const out = [];
  if (!existsSync(dir)) return out;
  for (const id of await readdir(dir)) {
    const m = readJSON(join(dir, id, 'match.json'));
    if (!m.id) continue;
    const reg = registry();
    out.push({
      ...m,
      models: { [m.red]: reg[m.red]?.model || m.red, [m.blue]: reg[m.blue]?.model || m.blue },
      rounds: m.rounds.map((r, i) => {
        const before = { [m.red]: 0, [m.blue]: 0 };
        for (const x of m.rounds.slice(0, i)) if (x.winner) before[x.winner]++;
        const base = `/matches/${id}/round-${r.n}/`;
        return { ...r, ...roundOrder(m.rounds, i), wins: [before[r.left], before[r.right]], final: m.over && i === m.rounds.length - 1 && !!m.winner, replay: `${base}replay.json`, dirs: [`${base}${r.left}/fighter/`, `${base}${r.right}/fighter/`] };
      }),
    });
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

const listStages = async () => stageList();

// the tournament console (judge/tournament.js): this machine only — it starts agents and the judge
const local = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const body = (req) => new Promise((r) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => {
    try {
      r(s ? JSON.parse(s) : {});
    } catch {
      r({});
    }
  });
});
async function tournamentApi(req, url) {
  const T = await import('./judge/tournament.js');
  const a = url.pathname.slice('/api/t/'.length);
  if (req.method === 'GET') {
    if (a === 'state') return T.state();
    if (a === 'options') return T.options();
    if (a === 'prompts') return T.prompts(Number(url.searchParams.get('n')) || null);
  }
  if (req.method === 'POST') {
    const b = await body(req);
    if (a === 'new') return T.newTournament(b);
    if (a === 'reset') return T.resetTournament();
    if (a === 'window') {
      if (b.corner === 'both') return { red: await T.openWindow('red'), blue: await T.openWindow('blue') };
      return T.openWindow(b.corner);
    }
    if (a === 'round') return T.startRound();
    if (a === 'locker') return T.startLocker();
    if (a === 'take') return T.takeFighters();
    if (a === 'open') return T.openFolder(b.job);
    if (a === 'retry') return T.retryJob(b.job);
    if (a === 'reel') {
      T.buildReel().catch(() => {});
      return { started: true };
    }
    if (a === 'pack') {
      T.buildPackJob().catch(() => {});
      return { started: true };
    }
  }
  throw Object.assign(new Error('нет такого действия'), { code: 'ENOENT' });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/t/')) {
      if (!local(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('пульт турнира — только на этой машине');
      }
      try {
        const out = await tournamentApi(req, url);
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
        return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(e.code === 'ENOENT' ? 404 : 400, { 'content-type': TYPES['.json'] });
        return res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    }
    const api = { '/api/fighters': listFighters, '/api/stages': listStages, '/api/matches': listMatches, '/api/game': gameData, '/api/game.json': gameData }[url.pathname];
    if (api) {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(await api()));
      return;
    }
    if (url.pathname === '/dev') {
      res.writeHead(302, { location: `/viewer/dev.html${url.search}` });
      res.end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/viewer') {
      res.writeHead(302, { location: `/viewer/${url.search}` });
      res.end();
      return;
    }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    // contestants live outside the ring folder: /c/<id>/… is their root
    let base = root;
    const c = path.match(/^\/c\/([a-z0-9-]+)(\/.*)$/);
    if (c) {
      const entry = registry()[c[1]];
      if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      base = resolve(entry.root);
      path = c[2];
    }
    const file = normalize(join(base, path));
    if (!file.startsWith(base + sep)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    const body = await readFile(file);
    const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    // a part of the file (video and sound): browsers seek in a clip only when the server answers ranges
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start >= body.length || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` });
        return res.end();
      }
      res.writeHead(206, { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(err.code || err.message));
  }
}).listen(port, () => console.log(`Ринг моделей: http://localhost:${port}`));
