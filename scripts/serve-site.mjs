#!/usr/bin/env node
// The built site served the way Cloudflare Pages serves it: plain files with the headers of its _headers file.
//   node scripts/serve-site.mjs [dist] [port]
// For checking the Content-Security-Policy of the site in a real browser before it goes out (docs/roster.md).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { TYPES } from '../kit/arena/tools/serve.js';
import { parseHeaders, headersFor } from '../judge/site.js';

export function serveSite(dir, port = 0) {
  dir = resolve(dir);
  const rules = existsSync(join(dir, '_headers')) ? parseHeaders(readFileSync(join(dir, '_headers'), 'utf8')) : [];
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (file !== dir && !file.startsWith(dir + sep)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) return void res.writeHead(308, { location: `${path}/` }).end();
      file = join(file, 'index.html');
    }
    if (!existsSync(file) || path === '/_headers') return void res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('нет такого файла');
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', ...headersFor(rules, path) });
    res.end(readFileSync(file));
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const s = await serveSite(process.argv[2] || 'dist', Number(process.argv[3] || 4870));
  console.log(`Сайт с заголовками из _headers: ${s.url}`);
}
