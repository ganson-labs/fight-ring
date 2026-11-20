// The repository as a stranger gets it: pages that need no network, no paths of anyone's machine in the files,
// a sample of the sponsor pieces without brands, and an origin written down for every sound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADS } from '../judge/render.js';
import { SOUNDS } from '../kit/arena/sounds/catalog.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// the judge's working folders (not in git) and what holds other people's words as they are
const SKIP = new Set(['.git', 'node_modules', 'out', 'dist', 'matches', 'leagues', 'ledger', 'launch', 'contestants', 'seasons', 'roster', 'vendor']);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(root);
const rel = (f) => relative(root, f).split(sep).join('/');
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.yml', '.sh', '.cmd', '.txt']);
const texts = files.filter((f) => TEXT.has(extname(f)) && rel(f) !== 'contestants.json');

test('страницы игры и лаборатории ничего не берут из сети', () => {
  const pages = files.filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 4);
  for (const f of pages) {
    const outside = readFileSync(f, 'utf8').match(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]+/gi) || [];
    assert.deepEqual(outside, [], `${rel(f)} ходит в сеть`);
  }
  // the font of every text on the screen is in the kit, file by file
  const dir = join(root, 'kit', 'arena', 'vendor', 'oswald');
  for (const css of ['oswald.css', 'oswald-500-700.css']) {
    const urls = [...readFileSync(join(dir, css), 'utf8').matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(urls.length >= 10);
    for (const u of urls) assert.ok(!/^https?:/.test(u) && existsSync(join(dir, u)), `${css}: ${u}`);
  }
});

test('в файлах нет путей чьей-то домашней папки', () => {
  // C:\Users\Op in a test of the audit is a made-up operator
  // (a home folder starts a path: leagues/home/… is a folder of the ring, not anyone's home)
  const home = /(?:[A-Za-z]:[\\/]+Users[\\/]+(?!Op\b)|(?<![A-Za-z0-9._~>-])\/(?:Users|home)\/)[A-Za-z0-9._-]+/g;
  const found = [];
  for (const f of texts) for (const m of readFileSync(f, 'utf8').match(home) || []) found.push(`${rel(f)}: ${m}`);
  assert.deepEqual(found, []);
});

test('образец рекламных заготовок без брендов и чужих картинок', () => {
  assert.ok(existsSync(join(ADS, 'ad.json')), 'папка, которую судья отдаёт роликам с --ads');
  const ad = JSON.parse(readFileSync(join(ADS, 'ad.json'), 'utf8'));
  assert.equal(ad.enabled, false, 'по умолчанию реклама выключена');
  for (const part of ['costPlate', 'cardFlip', 'billboard']) assert.ok(ad[part], part);
  // a picture named in the sample must be there; without a name the ring draws a marked empty slot
  for (const part of ['cardFlip', 'billboard']) if (ad[part].image) assert.ok(existsSync(join(ADS, ad[part].image)), ad[part].image);
  assert.deepEqual(readdirSync(join(root, 'ads')), ['demo'], 'материалы спонсоров в репозитории не лежат');
});

test('у каждого звука ринга записаны источник и лицензия, сторонние перечислены в ASSETS.md', () => {
  const dir = join(root, 'kit', 'arena', 'sounds');
  const onDisk = readdirSync(dir).filter((n) => n.endsWith('.ogg')).sort();
  const inCatalog = Object.values(SOUNDS).flatMap((s) => s.files).sort();
  assert.deepEqual(onDisk, inCatalog, 'каталог и папка совпадают');
  const rows = readFileSync(join(dir, 'README.md'), 'utf8').split('\n').filter((l) => /^\| \S+\.ogg \|/.test(l)).map((l) => l.split(' | ').map((x) => x.replace(/^\| | \|$/g, '')));
  assert.deepEqual(rows.map((r) => r[0]).sort(), onDisk, 'в таблице происхождения каждый файл');
  for (const r of rows) assert.ok(r[2] && r[3], `${r[0]}: источник и лицензия`);
  const assets = readFileSync(join(root, 'ASSETS.md'), 'utf8');
  const third = rows.filter((r) => !r[2].startsWith('ElevenLabs')).map((r) => r[0]);
  const listed = [...assets.matchAll(/^- `([a-z0-9-]+\.ogg)`$/gm)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), third.sort(), 'список сторонних звуков в ASSETS.md совпадает с таблицей');
});
