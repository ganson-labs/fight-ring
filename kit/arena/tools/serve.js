// Tiny static server: url prefixes mapped to folders. Used by preview and parts to feed the headless browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

// map: url prefix → folder, or a list of folders tried in order (a round's engine snapshot, then the kit for the
// show's own modules the snapshot does not have)
export async function serveFolders(map, port = 0) {
  const entries = Object.entries(map).map(([prefix, dir]) => [prefix, (Array.isArray(dir) ? dir : [dir]).map((d) => resolve(d))]).sort((a, b) => b[0].length - a[0].length);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = decodeURIComponent(url.pathname);
      const hit = entries.find(([p]) => path.startsWith(p));
      if (!hit) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      const [prefix, dirs] = hit;
      let body = null;
      let file = null;
      for (const dir of dirs) {
        const f = normalize(join(dir, path.slice(prefix.length) || 'index.html'));
        if (!(f === dir || f.startsWith(dir + sep))) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
        try {
          body = await readFile(f);
          file = f;
          break;
        } catch (err) {
          if (err.code !== 'ENOENT' || dir === dirs[dirs.length - 1]) throw err;
        }
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(err.code || err.message));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
