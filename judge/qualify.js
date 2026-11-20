// The qualification of a fighter sent to the shared roster (docs/roster.md): is it made with care or thrown together.
//   node ring.mjs qualify roster/<id> [--out папка] [--draws 4] [--no-league] [--no-sheet]
// Six checks, each answered in plain words:
//   entry     entry.json says who sent the fighter, and the folder is named after the author and the fighter
//   files     only pictures, sounds, JSON and the brains' .js; no links, no odd names; a limit of size and number
//   rules     the ring's own check of a fighter (kit/arena/cli.mjs check)
//   complete  its own pictures of every part of the body and a portrait, a recorded voice, its own name and story
//   code      the brains do not reach for the network, the page, storage or code from a string (judge/safety.js)
//   strength  a league with the four references of the ring
// The brains are run only after files, rules and code passed: nothing unread is started.
// Writes qualify.json, report.md and sheet.png (the portrait and the figure in three poses) into out/qualify/<id>/.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { RING, KIT } from './contestants.js';
import { checkEntry, plainText, readRoster, ROSTER } from './roster.js';
import { scanFighterCode } from './safety.js';
import { pairLeague, leagueTable, refEntrant, REFS } from './rating.js';
import { publishedData } from './gamedata.js';
import { loadFighter } from '../kit/arena/tools/load.js';
import { BONE_NAMES } from '../kit/arena/engine/skeleton.js';
import { getRuleset, setRuleset } from '../kit/arena/engine/standard.js';
import { RING_VERSION } from '../kit/arena/engine/version.js';

export const LIMITS = { files: 120, bytes: 12 * 1024 * 1024, file: 4 * 1024 * 1024, depth: 3, portrait: 256, story: 80 };
// The bar of strength (docs/roster.md has the numbers it stands on): the share of points in the fights with the four
// references, 4 draws × 5 starts × 2 sides with each.
// Measured on 160 fights each (ring 4.0): the template scores 0 %, the single-habit sparring partners 0–49 %, a copy of
// the strongest reference about 70 %, the fighters of the first season 96–100 %.
export const STRENGTH = { draws: 4, share: 0.8, each: 0.5 };

const TYPES = {
  '.json': (b) => { JSON.parse(b.toString('utf8')); return true; },
  '.js': (b) => !b.includes(0),
  '.png': (b) => b.length > 24 && b.readUInt32BE(0) === 0x89504e47,
  '.jpg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  '.mp3': (b) => b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
};
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const readJSON = (f, fb = null) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} МБ`;
const pct = (x) => `${Math.round(x * 100)} %`;

// every file under a folder without following links: [{ rel, file, link, dir }]
function walk(root) {
  const out = [];
  const go = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      const rel = relative(root, p).split(sep).join('/');
      if (st.isSymbolicLink()) out.push({ rel, file: p, link: true });
      else if (st.isDirectory()) go(p);
      else out.push({ rel, file: p, size: st.size, other: !st.isFile() });
    }
  };
  go(root);
  return out;
}

// the pictures and the brains of the kit by their content: the template's and the sparring partners'
let kitOwn = null;
function kitFiles() {
  if (kitOwn) return kitOwn;
  kitOwn = new Map();
  for (const root of [join(KIT, 'fighter'), join(KIT, 'arena', 'sparring')]) for (const f of walk(root)) if (/\.(png|jpe?g|webp|js)$/i.test(f.rel) && !f.link) kitOwn.set(sha(readFileSync(f.file)), relative(RING, f.file).split(sep).join('/'));
  return kitOwn;
}

function checkFiles(dir) {
  const bad = [];
  const all = walk(dir);
  const top = all.map((f) => f.rel.split('/')[0]);
  for (const n of new Set(top)) if (!['entry.json', 'fighter'].includes(n)) bad.push(`${n}: в папке бойца общего набора лежат только entry.json и fighter/`);
  const files = all.filter((f) => f.rel.startsWith('fighter/'));
  let bytes = 0;
  for (const f of files) {
    const rel = f.rel.slice('fighter/'.length);
    if (f.link) {
      bad.push(`${rel}: ссылка на другой файл — в папке бойца лежат только сами файлы`);
      continue;
    }
    if (f.other) {
      bad.push(`${rel}: не обычный файл`);
      continue;
    }
    bytes += f.size;
    const parts = rel.split('/');
    if (!parts.every((s) => SEGMENT.test(s))) bad.push(`${rel}: в именах файлов и папок только латиница, цифры, точка, дефис и подчёркивание, первая — буква или цифра`);
    if (parts.length - 1 > LIMITS.depth) bad.push(`${rel}: вложенность больше ${LIMITS.depth} папок`);
    const ext = extname(rel).toLowerCase();
    if (!TYPES[ext]) {
      bad.push(`${rel}: файлы такого типа в общий набор не принимаются (можно ${Object.keys(TYPES).join(', ')})`);
      continue;
    }
    if (f.size > LIMITS.file) bad.push(`${rel}: ${mb(f.size)}, один файл не больше ${mb(LIMITS.file)}`);
    else {
      let ok = false;
      try {
        ok = TYPES[ext](readFileSync(f.file));
      } catch {}
      if (!ok) bad.push(`${rel}: содержимое не похоже на ${ext}`);
    }
  }
  if (files.length > LIMITS.files) bad.push(`файлов ${files.length}, можно не больше ${LIMITS.files}`);
  if (bytes > LIMITS.bytes) bad.push(`папка бойца весит ${mb(bytes)}, можно не больше ${mb(LIMITS.bytes)}`);
  return { bad, count: files.length, bytes };
}

// every string of the fighter's JSON files goes to a page or a screen: one meaning, no markup
function markupIn(file, label) {
  const bad = [];
  const go = (v, path) => {
    if (typeof v === 'string') {
      if (/[<>]/.test(v) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) bad.push(`${label} → ${path}: в тексте есть < или >, или управляющий знак`);
    } else if (Array.isArray(v)) v.forEach((x, i) => go(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (/[<>]/.test(k)) bad.push(`${label} → ${path}: в имени поля есть < или >`);
      go(x, path ? `${path}.${k}` : k);
    }
  };
  const data = readJSON(file);
  if (data !== null) go(data, '');
  return bad;
}

function pngSize(file) {
  const b = readFileSync(file);
  return b.length > 24 && b.readUInt32BE(0) === 0x89504e47 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
}

function checkComplete(fdir, def, { taken = [] } = {}) {
  const bad = [];
  const tpl = { card: readJSON(join(KIT, 'fighter', 'fighter.json'), {}), voice: readJSON(join(KIT, 'fighter', 'voice.json'), {}) };
  const kit = kitFiles();
  const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

  // the body: every bone of the skeleton is drawn, by its own picture or by the mesh of a neighbour
  const meshed = new Set(Object.values(def.parts).flatMap((p) => p?.mesh?.bones || []));
  const bare = BONE_NAMES.filter((b) => !def.parts[b] && !meshed.has(b));
  if (bare.length) bad.push(`нет картинки у частей тела: ${bare.join(', ')}`);
  const images = [...new Set(Object.values(def.parts).filter(Boolean).flatMap((p) => [p.image, ...Object.values(p.skins || {}).map((s) => s?.image).filter(Boolean)]))];
  const stock = [];
  for (const img of images) {
    const file = join(fdir, img);
    if (!existsSync(file)) continue; // the ring's check names a missing picture
    if (kit.has(sha(readFileSync(file)))) stock.push(img);
  }
  if (stock.length) bad.push(`картинки частей тела взяты из набора ринга, а не нарисованы свои: ${stock.slice(0, 4).join(', ')}${stock.length > 4 ? ` и ещё ${stock.length - 4}` : ''}`);

  const brains = [...walk(fdir)].filter((f) => f.rel.endsWith('.js') && !f.link).map((f) => [f.rel, kit.get(sha(readFileSync(f.file)))]).filter(([, from]) => from);
  if (brains.length) bad.push(`мозги из набора ринга, а не свои: ${brains.map(([rel, from]) => `${rel} (это ${from})`).join(', ')}`);

  // the portrait
  const portrait = def.card.portrait;
  if (!portrait) bad.push('нет портрета: поле portrait в fighter.json и картинка, обычно art/portrait.png');
  else if (existsSync(join(fdir, portrait))) {
    const file = join(fdir, portrait);
    if (!/\.(png|jpe?g|webp)$/i.test(portrait)) bad.push(`портрет ${portrait}: нужна картинка PNG, JPEG или WebP`);
    const from = kit.get(sha(readFileSync(file)));
    if (from) bad.push(`портрет ${portrait} — картинка из набора ринга (${from})`);
    if (images.includes(portrait)) bad.push(`портрет ${portrait} — это часть тела, а нужен портрет бойца`);
    const size = /\.png$/i.test(portrait) ? pngSize(file) : null;
    if (size && Math.min(...size) < LIMITS.portrait) bad.push(`портрет ${portrait}: ${size[0]}×${size[1]}, меньшая сторона должна быть не меньше ${LIMITS.portrait} точек`);
  }

  // the voice
  const voice = readJSON(join(fdir, 'voice.json'), {});
  const lines = def.voice.lines;
  const silent = lines.filter((l) => !existsSync(join(fdir, l.file)) || lstatSync(join(fdir, l.file)).size < 1000).map((l) => l.id);
  if (silent.length) bad.push(`голос не записан для ${silent.length} из ${lines.length} реплик: ${silent.slice(0, 8).join(', ')}${silent.length > 8 ? '…' : ''}`);
  if (same(voice.description, tpl.voice.description)) bad.push('описание голоса в voice.json осталось от шаблона');
  const tplLines = new Set((tpl.voice.lines || []).map((l) => l.text.trim().toLowerCase()));
  if (lines.length && lines.every((l) => tplLines.has(l.text.trim().toLowerCase()))) bad.push('реплики в voice.json остались от шаблона');

  // the card
  if (same(def.card.name, tpl.card.name)) bad.push(`имя «${def.card.name}» осталось от шаблона`);
  if (same(def.card.motto, tpl.card.motto)) bad.push('девиз остался от шаблона');
  if (same(def.card.story, tpl.card.story)) bad.push('предыстория осталась от шаблона');
  else if (String(def.card.story || '').trim().length < LIMITS.story) bad.push(`предыстория короче ${LIMITS.story} знаков`);
  const twin = taken.find((t) => same(t.name, def.card.name));
  if (twin) bad.push(`имя «${def.card.name}» уже носит ${twin.who}`);
  return bad;
}

// who already carries a name: the sparring partners, the fighters of the seasons and of the roster (but not itself)
function takenNames(id, roster) {
  const out = [];
  const sparring = join(KIT, 'arena', 'sparring');
  for (const n of readdirSync(sparring)) {
    const card = readJSON(join(sparring, n, 'fighter.json'));
    if (card?.name) out.push({ name: card.name, who: 'спарринг-партнёр ринга' });
  }
  for (const f of publishedData().fighters) if (f.cid !== id) for (const v of f.versions) out.push({ name: v.name, who: `боец модели ${f.model}` });
  for (const r of readRoster(roster)) if (r.id !== id) out.push({ name: r.card.name, who: `боец общего набора ${r.id}` });
  return out;
}

async function checkStrength(id, fdir, { draws, jobs, cache, log }) {
  const me = { id, kind: 'probe', dir: fdir };
  const refs = REFS.map(refEntrant);
  const league = await pairLeague([...refs, me], { draws, jobs, cache, log });
  if (league.errors.length) return { ok: false, bad: [`бои не сыграны (${league.errors.length}): ${String(league.errors[0].error).split('\n')[0]}`] };
  const mine = league.fights.filter((f) => f.left === id || f.right === id);
  const points = (fs) => fs.reduce((s, f) => s + (f.winner === id ? 1 : f.winner === null ? 0.5 : 0), 0);
  const share = points(mine) / mine.length;
  const per = refs.map((r) => {
    const fs = mine.filter((f) => f.left === r.id || f.right === r.id);
    return { ref: r.id.slice(4), name: readJSON(join(r.dir, 'fighter.json'), {}).name, fights: fs.length, share: points(fs) / fs.length };
  });
  const row = leagueTable([...refs, me], league.fights).find((e) => e.id === id);
  const side = (f) => f.brain[f.left === id ? 0 : 1];
  const skipped = mine.reduce((s, f) => s + side(f).skipped, 0);
  const errors = mine.reduce((s, f) => s + side(f).errors, 0);
  const bad = [];
  if (share < STRENGTH.share) bad.push(`набрано ${pct(share)} очков в боях с четырьмя эталонами, нужно не меньше ${pct(STRENGTH.share)}`);
  for (const p of per) if (p.share < STRENGTH.each) bad.push(`эталону «${p.name}» боец проигрывает: ${pct(p.share)} очков, нужно не меньше ${pct(STRENGTH.each)} с каждым`);
  if (errors) bad.push(`мозги падали с ошибкой в ${errors} ходах`);
  return { ok: !bad.length, bad, share, per, rating: row.rating, range: row.range, fights: mine.length, kos: mine.filter((f) => f.winner === id && f.reason === 'ko').length, skipped, errors };
}

// ---------- the sheet ----------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One picture for the owner's eye: the portrait, the figure in the stance, at the entrance and in the victory pose.
export async function renderQualifySheet({ fdir, card, entry, out }) {
  const { renderFigures } = await import('../kit/arena/tools/preview.js');
  const { launch } = await import('../kit/arena/tools/browser.js');
  const { serveFolders } = await import('../kit/arena/tools/serve.js');
  const tmp = join(out, '..', '.sheet');
  mkdirSync(tmp, { recursive: true });
  const poses = [['stance', 'idle', 0, 'Стойка'], ['intro', 'intro', 'peak', 'Выход'], ['victory', 'victory', 'peak', 'Победа']];
  const made = await renderFigures({ fighterDir: fdir, poses: poses.map(([name, anim, t]) => ({ anim, t, out: join(tmp, `${name}.png`) })) });
  if (!made.some((m) => m.anim === 'idle')) throw new Error('фигура бойца в стойке не нарисовалась');
  const c = card.colors || {};
  const portrait = card.portrait && existsSync(join(fdir, card.portrait)) ? `/f/${card.portrait}` : null;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0b0d13;color:#eef0f6;font:20px/1.35 system-ui,sans-serif}
    .sheet{display:grid;grid-template-columns:440px 1fr;gap:28px;padding:32px;width:1536px;box-sizing:border-box;height:864px}
    .who{display:flex;flex-direction:column;gap:12px;min-width:0}
    .pic{width:440px;height:440px;background:#161a24 center/cover no-repeat;border-bottom:6px solid ${esc(c.accent || '#ffc94a')}}
    h1{margin:8px 0 0;font-size:40px;line-height:1.05}
    .motto{color:${esc(c.accent || '#ffc94a')};font-style:italic}
    dl{margin:6px 0 0;display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:18px}
    dt{color:#8a90a2}dd{margin:0}
    .figs{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;min-width:0}
    figure{margin:0;display:flex;flex-direction:column;background:repeating-conic-gradient(#1a1e29 0 25%,#141720 0 50%) 0 0/32px 32px;min-height:0}
    figure div{flex:1;background:center bottom/contain no-repeat;margin:18px 12px 0}
    figcaption{padding:10px 14px;background:#0b0d13;color:#8a90a2;font-size:17px}
  </style><div class="sheet"><div class="who">
    <div class="pic" style="${portrait ? `background-image:url('${esc(portrait)}')` : ''}"></div>
    <h1>${esc(card.name)}</h1><div class="motto">${esc(card.motto)}</div>
    <dl><dt>Модель</dt><dd>${esc(entry?.model)}</dd><dt>Агент</dt><dd>${esc([entry?.agent, entry?.effort].filter(Boolean).join(', '))}</dd><dt>Автор</dt><dd>${esc(entry?.author?.name)} · ${esc(entry?.author?.github)}</dd></dl>
  </div><div class="figs">${poses.filter(([name]) => existsSync(join(tmp, `${name}.png`))).map(([name, , , what]) => `<figure><div style="background-image:url('/t/${name}.png')"></div><figcaption>${what}</figcaption></figure>`).join('')}</div></div>`;
  writeFileSync(join(tmp, 'sheet.html'), html);
  const server = await serveFolders({ '/t/': tmp, '/f/': fdir });
  const browser = await launch({ width: 1536, height: 864 });
  try {
    const page = await browser.open(`${server.url}/t/sheet.html`, { w: 1536, h: 864 });
    await page.evaluate('Promise.all([...document.querySelectorAll("[style*=background-image]")].map((el) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = el.style.backgroundImage.slice(5, -2); })))');
    writeFileSync(out, await page.screenshot({ format: 'png' }));
  } finally {
    await browser.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

// ---------- the whole qualification ----------

const TITLES = { entry: 'Заявка', files: 'Состав папки', rules: 'Правила ринга', complete: 'Полнота', code: 'Код мозгов', strength: 'Сила' };

export async function qualify(dir, { out = null, league = true, sheet = true, draws = STRENGTH.draws, jobs, cache, roster = ROSTER, log = console.log } = {}) {
  dir = resolve(dir);
  const id = basename(dir);
  const fdir = join(dir, 'fighter');
  out = resolve(out || join(RING, 'out', 'qualify', id));
  mkdirSync(out, { recursive: true });
  const before = getRuleset();
  setRuleset('standard'); // the roster is ring 4: one kit for everyone
  const checks = [];
  const add = (key, bad, facts = {}) => {
    const c = { id: key, title: TITLES[key], ok: bad.length === 0, problems: bad, ...facts };
    checks.push(c);
    log(`${c.ok ? '✓' : '✗'} ${c.title}${c.ok ? '' : `: ${bad[0]}${bad.length > 1 ? ` (и ещё ${bad.length - 1})` : ''}`}`);
    return c;
  };
  const skip = (key, why) => {
    checks.push({ id: key, title: TITLES[key], ok: null, problems: [], skipped: why });
    log(`– ${TITLES[key]}: ${why}`);
  };
  try {
    // a link is not followed anywhere: with one in the folder nothing else of it is read
    const links = existsSync(dir) ? walk(dir).filter((f) => f.link).map((f) => f.rel) : [];
    if (links.length) {
      add('files', links.map((l) => `${l}: ссылка на другой файл — в папке бойца лежат только сами файлы`));
      for (const key of ['entry', 'rules', 'complete', 'code', 'strength']) skip(key, 'не проверялась: в папке есть ссылки на другие файлы');
      const result = { id, passed: false, complete: false, ring: RING_VERSION, at: new Date().toISOString(), fighter: { name: null, motto: null }, entry: null, bar: { strength: STRENGTH, limits: LIMITS }, checks, sheet: null, sheetNote: null };
      writeFileSync(join(out, 'qualify.json'), `${JSON.stringify(result, null, 1)}\n`);
      writeFileSync(join(out, 'report.md'), qualifyMarkdown(result));
      return { ...result, out };
    }
    if (!existsSync(join(fdir, 'fighter.json'))) throw new Error(`в ${dir} нет fighter/fighter.json: это не папка бойца общего набора`);
    const card = readJSON(join(fdir, 'fighter.json'), {});
    const entry = readJSON(join(dir, 'entry.json'));

    const entryBad = entry ? checkEntry(entry, { id, fighterName: typeof card.name === 'string' ? card.name : null }) : ['нет файла entry.json или он не JSON'];
    if (publishedData().fighters.some((f) => f.cid === id)) entryBad.push(`имя папки «${id}» уже занято бойцом сезона`);
    entryBad.push(...markupIn(join(dir, 'entry.json'), 'entry.json'));
    add('entry', entryBad);

    const files = checkFiles(dir);
    add('files', files.bad, { count: files.count, bytes: files.bytes });

    const res = await loadFighter(fdir);
    const rulesBad = [...res.errors];
    if (res.ok && res.fighter.ruleset !== 'standard') rulesBad.push('боец собран не из набора ринга 4');
    if (res.ok && res.fighter.abilityScripts.length) rulesBad.push('способности кодом в общий набор не принимаются');
    const rules = add('rules', rulesBad, { warnings: res.warnings });

    if (rules.ok) add('complete', [...checkComplete(fdir, res.fighter, { taken: takenNames(id, roster) }), ...['fighter', 'moves', 'voice'].flatMap((f) => markupIn(join(fdir, `${f}.json`), `${f}.json`))]);
    else skip('complete', 'не проверялась: сначала боец должен пройти правила ринга');

    const code = scanFighterCode(fdir);
    add('code', code.errors, { scanned: code.files });

    const safe = checks.filter((c) => ['files', 'rules', 'code'].includes(c.id)).every((c) => c.ok);
    if (!league) skip('strength', 'не проверялась: квалификация запущена без лиги');
    else if (!safe) skip('strength', 'не проверялась: мозги запускаются только после проверок папки, правил и кода');
    else {
      const s = await checkStrength(id, fdir, { draws, jobs, cache, log });
      const { ok, bad, ...facts } = s;
      add('strength', bad, facts);
    }

    let sheetFile = null;
    let sheetNote = null;
    if (sheet && rules.ok && checks.find((c) => c.id === 'files').ok) {
      try {
        sheetFile = await renderQualifySheet({ fdir, card, entry, out: join(out, 'sheet.png') });
      } catch (err) {
        sheetNote = String(err.message || err).split('\n')[0];
        log(`! лист с картинками не снят: ${sheetNote}`);
      }
    }
    const passed = checks.every((c) => c.ok === true);
    const result = { id, passed, complete: checks.every((c) => c.ok !== null), ring: RING_VERSION, at: new Date().toISOString(), fighter: { name: card.name ?? null, motto: card.motto ?? null }, entry: entry || null, bar: { strength: STRENGTH, limits: LIMITS }, checks, sheet: sheetFile ? 'sheet.png' : null, sheetNote };
    writeFileSync(join(out, 'qualify.json'), `${JSON.stringify(result, null, 1)}\n`);
    writeFileSync(join(out, 'report.md'), qualifyMarkdown(result));
    log(`${passed ? 'Квалификация пройдена' : 'Квалификация не пройдена'}: ${join(out, 'report.md')}`);
    return { ...result, out };
  } finally {
    setRuleset(before);
  }
}

export function qualifyMarkdown(r) {
  const L = [`# Квалификация бойца «${r.fighter.name ?? r.id}»`, ''];
  const e = r.entry;
  if (e) L.push(`Папка \`roster/${r.id}\`. Автор: ${e.author?.name ?? '—'} (${e.author?.github ?? '—'}). Модель: ${e.model ?? '—'}. Агент: ${[e.agent, e.effort && `уровень рассуждений ${e.effort}`].filter(Boolean).join(', ') || '—'}.`, '');
  const undone = r.checks.filter((c) => c.ok === null);
  L.push(r.passed ? '**Боец прошёл квалификацию.**' : r.checks.some((c) => c.ok === false) ? '**Боец не прошёл квалификацию.** Что исправить, написано ниже.' : `**Квалификация не закончена:** ${undone.map((c) => c.title.toLowerCase()).join(', ')}.`, '');
  L.push('| Проверка | Итог |', '|---|---|');
  for (const c of r.checks) L.push(`| ${c.title} | ${c.ok === true ? 'пройдена' : c.ok === false ? '**не пройдена**' : 'не проверялась'} |`);
  L.push('');
  for (const c of r.checks) {
    L.push(`## ${c.title}`, '');
    if (c.ok === null) L.push(`${c.skipped[0].toUpperCase()}${c.skipped.slice(1)}.`, '');
    if (c.id === 'files' && c.count !== undefined) L.push(`Файлов ${c.count}, вес ${mb(c.bytes)}. Предел: ${r.bar.limits.files} файлов и ${mb(r.bar.limits.bytes)}.`, '');
    if (c.id === 'code' && c.scanned) L.push(`Прочитаны файлы: ${c.scanned.map((f) => `\`${f}\``).join(', ') || 'нет ни одного .js'}.`, '');
    if (c.id === 'strength' && c.share !== undefined) {
      L.push(`Лига с четырьмя эталонами ринга, ${c.fights} боёв бойца: набрано ${pct(c.share)} очков при пороге ${pct(r.bar.strength.share)}; с каждым эталоном нужно не меньше ${pct(r.bar.strength.each)}. Рейтинг ${c.rating} (с вероятностью 95 % от ${c.range[0]} до ${c.range[1]}); средний эталон равен 1000. Побед нокаутом ${c.kos}.`, '');
      L.push('| Эталон | Боёв | Набрано очков |', '|---|---|---|');
      for (const p of c.per) L.push(`| ${p.name} | ${p.fights} | ${pct(p.share)} |`);
      L.push('');
      if (c.skipped) L.push(`Мозги не уложились в предел шагов в ${c.skipped} ходах: такой ход пропускается.`, '');
    }
    if (c.problems.length) L.push(...c.problems.map((p) => `- ${p}`), '');
    else if (c.ok) L.push('Замечаний нет.', '');
    if (c.id === 'rules' && c.warnings?.length) L.push('Сведения от проверки ринга, не ошибки:', '', ...c.warnings.map((w) => `- ${w}`), '');
  }
  if (r.sheet) L.push('## Как боец выглядит', '', `Портрет и фигура в стойке, на выходе и в позе победы: \`${r.sheet}\` рядом с этим отчётом.`, '');
  else if (r.sheetNote) L.push('## Как боец выглядит', '', `Лист с картинками не снят: ${r.sheetNote}.`, '');
  return L.join('\n');
}
