// The montage pack of a match (node ring.mjs match pack <match> [--studio <video>]): everything an editor needs, in
// one folder with plain names, built from the match folder alone (the contestants may be gone from the registry):
//   01-rounds    every round clean in 1080p60 and with the judge's captions
//   02-screens   VS, the result of every round, every locker room, the final — each a clip of its own
//   03-fighters  every version of every fighter: PNG figures with alpha in the poses of the entrance, stance,
//                victory and defeat in the pictures' own resolution, the pose sheet, the parts and their sheet, art
//   04-lockers   what each model changed in each locker room: the diff of its fighter's files and its own words
//   05-stats     time, tokens, money, pictures and voice per model and period; health over time; round counters
//   06-thoughts  what each fighter decided moment by moment, in short words, for pop-ups (JSON, CSV, SRT)
//   07-reel      the match reel, its shorts and the moments list, when `match reel` made them
// With --studio <video> the files go into that video of the author's own montage program as its materials (vagent video
// add; the program is not part of this repository).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RING } from './contestants.js';
import { loadMatch, matchDir, roundInfo, changes } from './match.js';
import { renderRound } from './render.js';
import { readTiming, clipTime } from './moments.js';
import { withServer, screenClip, frameAt, cutClip, dur } from './reel.js';
import { captionCandidates, scheduleCaptions, burnCaptions } from './captions.js';
import { folderHash } from './gamedata.js';
import { roundThoughts, keyThoughts, thoughtsSrt } from './thoughts.js';
import { launch } from '../kit/arena/tools/browser.js';
import { renderFigures, renderSheet } from '../kit/arena/tools/preview.js';
import { decodeImage, encodePNG } from '../kit/arena/tools/png.js';

const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb);
const writeJSON = (f, v) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '');

// the poses of the figures: the entrance at its most telling key, the stance, the victory, the defeat on the floor
export const FIGURE_POSES = [
  { name: 'intro', anim: 'intro', t: 'peak', what: 'выход' },
  { name: 'stance', anim: 'idle', t: 0, what: 'стойка' },
  { name: 'victory', anim: 'victory', t: 'peak', what: 'победа' },
  { name: 'defeat', anim: 'defeat', t: 'end', what: 'поражение' },
];

// CSV with a header from the keys of the first row; values with a comma, quote or line break quoted
export function toCsv(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\n') + '\n';
}

// Distinct versions of each contestant over the match's rounds: { cid: [{ v, dir, rounds: [n] }] }
export function matchVersions(id) {
  const m = loadMatch(id);
  const out = {};
  for (const r of m.rounds) {
    for (const cid of [r.left, r.right]) {
      const dir = join(matchDir(id), `round-${r.n}`, cid, 'fighter');
      if (!existsSync(join(dir, 'fighter.json'))) continue;
      const list = (out[cid] ||= []);
      const hash = folderHash(dir);
      const last = list[list.length - 1];
      if (last && last.hash === hash) last.rounds.push(r.n);
      else list.push({ v: list.length + 1, hash, dir, rounds: [r.n] });
    }
  }
  return out;
}

// money of an agent's run when its journal says it: Claude Code `-p` runs of the judge (ledger/runs.json) end with
// the session's total cost so far; a period gets the growth of its session's total inside [from, to)
export function runsCost(cid, from, to) {
  const all = readJSON(join(RING, 'ledger', 'runs.json'), {})[cid] || [];
  const last = {};
  let sum = 0;
  let any = false;
  for (const run of [...all].sort((a, b) => a.started.localeCompare(b.started))) {
    let total = null;
    if (existsSync(run.log)) for (const line of readFileSync(run.log, 'utf8').split('\n')) {
      if (!line.includes('"total_cost_usd"')) continue;
      try {
        total = JSON.parse(line).total_cost_usd ?? total;
      } catch {}
    }
    if (total === null) continue;
    const prev = last[run.session] || 0;
    last[run.session] = total;
    const at = Date.parse(run.started);
    if (at >= Date.parse(from) && at < Date.parse(to)) {
      sum += total - prev;
      any = true;
    }
  }
  return any ? +sum.toFixed(4) : null;
}

// one picture of all the parts of a fighter, side by side on a transparent background, in their own size
function partsSheet(partsDir, out) {
  const files = existsSync(partsDir) ? readdirSync(partsDir).filter((f) => f.toLowerCase().endsWith('.png')).sort() : [];
  if (!files.length) return null;
  const imgs = files.map((f) => decodeImage(join(partsDir, f)));
  const pad = 24;
  const cols = Math.min(5, imgs.length);
  const cw = Math.max(...imgs.map((i) => i.width)) + pad;
  const ch = Math.max(...imgs.map((i) => i.height)) + pad;
  const rows = Math.ceil(imgs.length / cols);
  const W = cw * cols + pad;
  const H = ch * rows + pad;
  const data = new Uint8Array(W * H * 4);
  imgs.forEach((im, i) => {
    const ox = pad + (i % cols) * cw + Math.floor((cw - pad - im.width) / 2);
    const oy = pad + Math.floor(i / cols) * ch + Math.floor((ch - pad - im.height) / 2);
    for (let y = 0; y < im.height; y++) data.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), ((oy + y) * W + ox) * 4);
  });
  writeFileSync(out, encodePNG(W, H, data));
  return { out, parts: files.map((f) => basename(f, '.png')) };
}

function gitDiff(cwd, a, b) {
  try {
    return execFileSync('git', ['diff', '--no-index', '--no-color', '--stat', '--patch', '--', a, b], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch (e) {
    // git diff --no-index exits with 1 when the folders differ: the answer is still on stdout
    if (e.stdout) return e.stdout;
    throw e;
  }
}

const phaseAt = (t, k, last = false) => {
  const i = t?.phases?.indexOf(k) ?? -1;
  if (i < 0 || !t.phase) return null;
  const at = last ? t.phase.lastIndexOf(i) : t.phase.indexOf(i);
  return at < 0 ? null : (last ? at + 1 : at) / t.fps;
};

export async function buildPack(id, { studio = null, log = console.log, render = true } = {}) {
  const m = loadMatch(id);
  if (!m.rounds.length) throw new Error(`в матче «${id}» ещё нет раундов`);
  const md = matchDir(id);
  const dir = join(md, 'pack');
  const D = (sub) => {
    const p = join(dir, sub);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const files = []; // { file, as, what } for the README and the Studio
  const add = (file, as, what) => files.push({ file, as, what });
  const versions = matchVersions(id);
  const name = (cid, n) => readJSON(join(md, `round-${n}`, cid, 'fighter', 'fighter.json'), {}).name || cid;
  const last = m.rounds[m.rounds.length - 1];

  // ---------- 01: rounds in 1080p60, clean and with captions ----------
  const clean = {};
  const rounds = D('01-rounds');
  for (const r of m.rounds) {
    const f = join(rounds, `round-${r.n}-clean-1080p60.mp4`);
    const replayAt = statSync(join(md, `round-${r.n}`, 'replay.json')).mtimeMs;
    if (render && (!existsSync(f) || statSync(f).mtimeMs < replayAt)) {
      // the round's own clip is this very clip when it was made in 1080p60 after its fight: taken, not filmed again
      const own = join(md, `round-${r.n}`, 'fight-16x9.mp4');
      const ownTiming = readJSON(own.replace(/\.mp4$/, '.timing.json'), null);
      if (existsSync(own) && statSync(own).mtimeMs >= replayAt && ownTiming?.fps === 60) {
        for (const [a, b] of [[own, f], [own.replace(/\.mp4$/, '.timing.json'), f.replace(/\.mp4$/, '.timing.json')]]) copyFileSync(a, b);
        log(`Раунд ${r.n}: ролик раунда уже 1080p60, беру его`);
      } else await renderRound(id, r.n, { fps: 60, out: f, log });
    }
    if (!existsSync(f)) throw new Error(`нет ${f}: пакет без --no-render берёт уже снятые раунды`);
    clean[r.n] = { file: f, timing: readTiming(f.replace(/\.mp4$/, '.timing.json')) };
    add(f, 'recording', `Раунд ${r.n} целиком, чистый, 1080p 60 к/с: ${name(r.left, r.n)} (${m.models[r.left]}) против ${name(r.right, r.n)} (${m.models[r.right]}), ${r.winner ? `победа ${m.models[r.winner]} ${r.reason === 'ko' ? 'нокаутом' : 'по времени'}` : 'ничья'}`);
  }

  await withServer(async (base) => {
    const browser = await launch({ width: 1920, height: 1080 });
    const tmp = D('.tmp');
    try {
      for (const r of m.rounds) {
        const c = clean[r.n];
        const total = dur(c.file);
        const st = readJSON(join(md, `round-${r.n}`, 'stats.json'));
        const boardAt = phaseAt(c.timing, 'board') ?? 0;
        const fightAt = phaseAt(c.timing, 'fight') ?? 0;
        const pieces = [
          ...(r.n > 1 ? [{ kind: 'board', round: r.n, at: boardAt, from: boardAt, seconds: fightAt + 1 - boardAt }] : []),
          ...(st?.moments || []).map((x) => ({ kind: x.kind, round: r.n, at: 0, from: 0, seconds: total, moment: x })),
        ];
        const caps = scheduleCaptions(captionCandidates(id, pieces, (n, tick) => clipTime(clean[n].timing, tick)), total);
        const f = join(rounds, `round-${r.n}-captions-1080p60.mp4`);
        await burnCaptions(c.file, caps, f, { base, browser, dir: tmp });
        add(f, 'recording', `Раунд ${r.n} с подписями судьи (${caps.length}): ${caps.map((x) => x.text).join(' · ') || 'без подписей'}`);
      }

      // ---------- 02: the screens between rounds, each a clip ----------
      const screens = D('02-screens');
      const r1 = clean[1];
      const vsEnd = (phaseAt(r1.timing, 'fight') ?? 6) + 0.2;
      const vs = join(screens, 'vs-16x9.mp4');
      cutClip(r1.file, 0, vsEnd, vs, '16:9', { fps: 60 });
      add(vs, 'recording', 'Экран VS и табло первого раунда до начала боя');
      const bg = (n, k) => {
        const c = clean[n];
        const f0 = phaseAt(c.timing, 'fight') ?? 0;
        const f1 = phaseAt(c.timing, 'fight', true) ?? dur(c.file);
        const name2 = `bg-${k}-${n}.jpg`;
        frameAt(c.file, f0 + (f1 - f0) * (k === 'locker' ? 0.3 : 0.6), join(md, 'pack', '.tmp', name2));
        return `/matches/${id}/pack/.tmp/${name2}`;
      };
      for (const r of m.rounds) {
        const kinds = [{ kind: 'round', round: r.n, file: `round-${r.n}-result`, what: `Итог раунда ${r.n}`, seconds: 6 }];
        if (r.n > 1) for (const cid of [r.left, r.right]) kinds.unshift({ kind: 'locker', round: r.n, cid, file: `locker-before-round-${r.n}-${cid}`, what: `Раздевалка перед раундом ${r.n}: ${m.models[cid]}`, seconds: 7 });
        for (const k of kinds) {
          for (const aspect of ['16:9', '9:16']) {
            const out = join(screens, `${k.file}-${aspect === '9:16' ? '9x16' : '16x9'}.mp4`);
            const query = { match: id, kind: k.kind, round: k.round, ...(k.cid ? { cid: k.cid } : {}), bg: bg(r.n, k.kind) };
            await screenClip(base, browser, query, out, out.replace(/\.mp4$/, '.png'), k.seconds, aspect, tmp, 60);
            add(out, 'recording', `${k.what}, ${aspect}`);
            add(out.replace(/\.mp4$/, '.png'), 'image', `${k.what}, кадр экрана, ${aspect}`);
          }
        }
      }
      if (m.over) {
        const c = clean[last.n];
        const a = (phaseAt(c.timing, 'after') ?? phaseAt(c.timing, 'replay') ?? dur(c.file) - 8) - 1.5;
        const fin = join(screens, 'final-16x9.mp4');
        cutClip(c.file, a, dur(c.file), fin, '16:9', { fps: 60 });
        add(fin, 'recording', 'Последний удар, повтор нокаута и победитель матча');
      }
    } finally {
      await browser.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 03: fighters, every version ----------
  for (const [cid, list] of Object.entries(versions)) {
    for (const v of list) {
      const fname = readJSON(join(v.dir, 'fighter.json'), {}).name || cid;
      const vd = D(join('03-fighters', `${cid}-${slug(fname) || 'fighter'}`, `v${v.v}`));
      // names unique across the pack: the Studio keeps a video's materials by file name
      const tag = `${cid}-v${v.v}`;
      const made = await renderFigures({ fighterDir: v.dir, poses: FIGURE_POSES.map((p) => ({ anim: p.anim, t: p.t, out: join(vd, `${tag}-${p.name}.png`) })) });
      for (const x of made) add(x.out, 'image', `${fname} (${m.models[cid]}), v${v.v}: ${FIGURE_POSES.find((p) => p.anim === x.anim).what}, PNG с прозрачным фоном ${x.width}×${x.height}`);
      const sheet = join(vd, `${tag}-pose-sheet.png`);
      await renderSheet({ fighterDir: v.dir, out: sheet });
      add(sheet, 'image', `${fname}, v${v.v}: лист поз (все ключи анимаций и приёмов)`);
      const ps = partsSheet(join(v.dir, 'parts'), join(vd, `${tag}-parts.png`));
      if (ps) add(ps.out, 'image', `${fname}, v${v.v}: все ${ps.parts.length} частей тела рядом, прозрачный фон`);
      const pd = join(vd, 'parts');
      mkdirSync(pd, { recursive: true });
      for (const f of existsSync(join(v.dir, 'parts')) ? readdirSync(join(v.dir, 'parts')).filter((x) => x.endsWith('.png')) : []) copyFileSync(join(v.dir, 'parts', f), join(pd, f));
      const art = join(v.dir, 'art');
      for (const f of existsSync(art) ? readdirSync(art).filter((x) => /\.(png|jpe?g|webp)$/i.test(x)) : []) {
        mkdirSync(join(vd, 'art'), { recursive: true });
        const out = join(vd, 'art', `${tag}-${f}`);
        copyFileSync(join(art, f), out);
        add(out, 'image', `${fname}, v${v.v}: картинка модели ${f}`);
      }
      writeJSON(join(vd, 'about.json'), { cid, model: m.models[cid], version: v.v, rounds: v.rounds, name: fname, card: readJSON(join(v.dir, 'fighter.json')), moves: (readJSON(join(v.dir, 'moves.json'), {}).moves || []).map((x) => ({ id: x.id, name: x.name, slot: x.slot })) });
    }
  }

  // ---------- 04: locker rooms ----------
  const lockers = D('04-lockers');
  for (const cid of [m.red, m.blue]) {
    for (const c of changes(id, cid)) {
      const base = `before-round-${c.to}-${cid}`;
      const L = [`# Раздевалка перед раундом ${c.to}: ${m.models[cid]} (${cid})`, ''];
      const listed = [...c.stats.map((x) => `характеристики: ${x}`), ...c.moves.map((x) => `приём ${x}`), ...c.abilities.map((x) => `способность ${x}`), ...c.card.map((x) => `карточка: ${x}`), ...c.changed.map((f) => `изменён ${f.file}: ${f.lines}`), ...c.added.map((f) => `новый файл ${f}`), ...c.removed.map((f) => `удалён ${f}`)];
      L.push(listed.length ? listed.map((x) => `- ${x}`).join('\n') : 'Ничего не изменил.', '');
      const changesFile = join(lockers, `${base}-changes.md`);
      writeFileSync(changesFile, L.join('\n'));
      add(changesFile, 'note', `Что ${m.models[cid]} изменил в раздевалке перед раундом ${c.to}, списком`);
      if (listed.length) {
        const diff = gitDiff(md, `round-${c.from}/${cid}/fighter`, `round-${c.to}/${cid}/fighter`);
        const f = join(lockers, `${base}.diff`);
        writeFileSync(f, diff);
        add(f, 'note', `Правки кода и файлов бойца ${m.models[cid]} в раздевалке перед раундом ${c.to} (diff)`);
      }
      const said = readJSON(join(md, `round-${c.to}`, cid, 'locker.json'));
      if (said?.text) {
        const f = join(lockers, `${base}-said.md`);
        writeFileSync(f, `# ${m.models[cid]} после раунда ${said.round}, своими словами\n\n${said.text}\n`);
        add(f, 'note', `Слова ${m.models[cid]} в раздевалке после раунда ${said.round}, дословно`);
      }
    }
  }

  // ---------- 05: numbers for the charts ----------
  const stats = D('05-stats');
  const proto = readJSON(join(md, 'protocol.json'));
  const rows = [];
  for (const [cid, x] of Object.entries(proto?.people || {})) {
    for (const per of x.periods) {
      const w = per.work;
      const t = w?.tokens;
      const wall = w ? +((Date.parse(w.to) - Date.parse(w.from)) / 60000).toFixed(1) : null;
      rows.push({
        model: x.model, model_id: x.modelId, agent: x.agent, effort: x.effort, cid, period: per.what,
        from: w?.from ?? null, to: w?.to ?? null, wall_minutes: wall, active_minutes: w?.activeMinutes ?? null,
        tokens_input: t?.input ?? null, tokens_output: t?.output ?? null, tokens_cache_read: t?.cacheRead ?? null, tokens_cache_write: t?.cacheWrite ?? null, tokens_reasoning: t?.reasoning ?? null,
        cost_usd: w?.costUSD ?? (w ? runsCost(cid, per.from, per.to) : null),
        pictures: per.spent.paint, voice_designs: per.spent.voiceDesigns, voice_seconds: per.spent.voiceSeconds,
      });
    }
  }
  if (rows.length) {
    writeJSON(join(stats, 'models.json'), rows);
    writeFileSync(join(stats, 'models.csv'), toCsv(rows));
    add(join(stats, 'models.csv'), 'note', 'Время, токены, деньги, картинки и голос каждой модели: сборка и каждая раздевалка (CSV для графиков)');
  }
  const counters = [];
  for (const r of m.rounds) {
    const st = readJSON(join(md, `round-${r.n}`, 'stats.json'));
    const an = readJSON(join(md, `round-${r.n}`, 'analysis.json'));
    if (!st) continue;
    const maxHp = an?.result?.maxHp || [1000, 1000];
    const hp = st.hp.map(([t, a, b]) => ({ seconds: t, [`${st.names[0]} (${m.models[r.left]}), %`]: +(a * 100).toFixed(1), [`${st.names[1]} (${m.models[r.right]}), %`]: +(b * 100).toFixed(1), [`${st.names[0]}, здоровье`]: Math.round(a * maxHp[0]), [`${st.names[1]}, здоровье`]: Math.round(b * maxHp[1]) }));
    writeFileSync(join(stats, `health-round-${r.n}.csv`), toCsv(hp));
    add(join(stats, `health-round-${r.n}.csv`), 'note', `Здоровье обоих по времени, раунд ${r.n} (4 точки в секунду, секунды боя)`);
    st.counters.forEach((c, s) => counters.push({ round: r.n, stage: r.stage, cid: st.sides[s], model: m.models[st.sides[s]], fighter: st.names[s], won: r.winner === st.sides[s], ...c }));
  }
  writeFileSync(join(stats, 'rounds.csv'), toCsv(counters));
  add(join(stats, 'rounds.csv'), 'note', 'Цифры каждого раунда по бойцам: попадания, урон, блоки, парирования, броски, суперприёмы, серии');
  writeJSON(join(stats, 'match.json'), { match: id, ring: m.ring, models: m.models, score: m.score, winner: m.winner, rounds: m.rounds.map((r) => ({ n: r.n, stage: r.stage, left: r.left, right: r.right, winner: r.winner, reason: r.reason, seconds: +(r.ticks / 60).toFixed(1) })), people: rows, counters });

  // ---------- 06: thoughts of the fighters ----------
  const th = D('06-thoughts');
  for (const r of m.rounds) {
    const timingFile = clean[r.n].file.replace(/\.mp4$/, '.timing.json');
    const all = await roundThoughts(md, r, { timingFile });
    const key = keyThoughts(all);
    writeJSON(join(th, `round-${r.n}-thoughts.json`), { round: r.n, video: relative(dir, clean[r.n].file).split('\\').join('/'), all, key });
    writeFileSync(join(th, `round-${r.n}-thoughts.csv`), toCsv(all.map(({ seconds, tick, fighter, cid, kind, text, prio }) => ({ seconds, tick, fighter, cid, kind, text, prio }))));
    add(join(th, `round-${r.n}-thoughts.csv`), 'note', `Мысли бойцов раунда ${r.n} по секундам чистого ролика: что решил каждый (все ${all.length})`);
    for (const cid of [r.left, r.right]) {
      const f = join(th, `round-${r.n}-${cid}-key.srt`);
      writeFileSync(f, thoughtsSrt(key.filter((t) => t.cid === cid)));
      add(f, 'note', `Ключевые мысли ${name(cid, r.n)} (${m.models[cid]}) в раунде ${r.n}, субтитрами к чистому ролику`);
    }
  }

  // ---------- 07: the reel, when made ----------
  const reel = join(md, 'reel');
  if (existsSync(join(reel, 'match-16x9.mp4'))) {
    const rd = D('07-reel');
    for (const f of readdirSync(reel).filter((x) => /\.(mp4|md|json)$/.test(x))) {
      copyFileSync(join(reel, f), join(rd, f));
      if (f.endsWith('.mp4')) add(join(rd, f), 'recording', f.startsWith('match') ? `Ролик матча${f.includes('clean') ? ' без подписей' : ' с подписями'}` : `Шортс ${f}`);
      else if (f.endsWith('.md')) add(join(rd, f), 'note', ['notes-for-voice.md', 'notes-for-pasha.md'].includes(f) ? 'Шпаргалка к озвучке ролика матча' : 'Моменты матча с таймкодами');
    }
  }

  // ---------- 08: ghosts of the last round, when `match ghost` made them ----------
  const gh = join(md, 'ghost');
  if (existsSync(gh)) {
    for (const g of readdirSync(gh)) {
      const about = readJSON(join(gh, g, 'about.json'));
      if (!about) continue;
      for (const f of readdirSync(join(gh, g)).filter((x) => x.endsWith('.mp4'))) {
        const out = join(D('08-ghost'), `${g}-${f}`);
        copyFileSync(join(gh, g, f), out);
        add(out, 'recording', `Призрак: раунд ${about.round}, ${about.model} — как есть и полупрозрачно ${about.ghost} в той же ситуации (${about.moment}), ${f.includes('9x16') ? '9:16' : '16:9'}`);
      }
    }
  }

  writeFileSync(join(dir, 'README.md'), packReadme(id, m, files, dir));
  log(`Пакет: ${dir} (${files.length} файлов)`);
  let studioDone = null;
  if (studio) studioDone = toStudioPack(studio, files, log);
  return { dir, files, studio: studioDone };
}

function packReadme(id, m, files, dir) {
  const L = [`# Пакет для монтажа: матч ${id}`, '', `${m.models[m.red]} (${m.red}) против ${m.models[m.blue]} (${m.blue}), до ${m.firstTo} побед, счёт ${m.score[m.red]} : ${m.score[m.blue]}${m.winner ? `, победил ${m.models[m.winner]}` : ''}. Ринг ${m.ring?.ring || '—'}.`, ''];
  const groups = [
    ['01-rounds', 'Раунды целиком, 1920×1080, 60 к/с: `-clean` — без подписей, `-captions` — с подписями судьи. Рядом `.timing.json`: тик боя каждого кадра и фазы показа.'],
    ['02-screens', 'Экраны между раундами отдельными роликами (16:9 и 9:16, 60 к/с, со звуками ринга) и кадром PNG: `vs`, `round-N-result`, `locker-before-round-N-<угол>`, `final`.'],
    ['03-fighters', 'Каждая версия каждого бойца (`v1` — до первого раунда, `v2` — после первой раздевалки, если боец изменился): `<угол>-vN-intro`, `-stance`, `-victory`, `-defeat` — фигуры PNG с прозрачным фоном в разрешении картинок модели; `pose-sheet.png` — лист поз; `<угол>-vN-parts.png` и `parts/` — части тела рядом; `art/` — картинки модели; `about.json` — карточка и приёмы.'],
    ['04-lockers', 'Раздевалки: `-changes.md` — что изменилось списком, `.diff` — правки файлов бойца (git diff), `-said.md` — слова модели дословно.'],
    ['05-stats', 'Цифры для графиков: `models.csv` — время по часам и активное, токены, деньги (если журнал агента их пишет), картинки и голос по сборке и раздевалкам; `health-round-N.csv` — здоровье обоих по времени; `rounds.csv` — счётчики раундов; `match.json` — всё вместе.'],
    ['06-thoughts', 'Мысли бойцов для всплывашек: что каждый решил в каждый момент (из того, что он сделал в бою). `round-N-thoughts.csv` — все с секундами чистого ролика раунда, `round-N-<угол>-key.srt` — ключевые, не чаще раза в 1,25 с на бойца.'],
    ['07-reel', 'Ролик матча, шортсы и списки моментов, если ролик собран (`match reel`).'],
    ['08-ghost', 'Призрак прошлого раунда (`match ghost`): кусок раунда, где поверх бойца полупрозрачно в холодном цвете идёт его версия до раздевалки в той же ситуации.'],
  ];
  for (const [g, about] of groups) {
    const mine = files.filter((f) => relative(dir, f.file).split(/[\\/]/)[0] === g);
    if (!mine.length) continue;
    L.push(`## ${g}`, '', about, '');
    for (const f of mine) L.push(`- \`${relative(dir, f.file).split('\\').join('/')}\` — ${f.what}`);
    L.push('');
  }
  return L.join('\n');
}

// the pack into a video of the author's montage program as its materials, by kind; the program copies files in
export function toStudioPack(video, files, log = console.log) {
  const run = (args) => execFileSync('vagent', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const q = (s) => `"${String(s).replace(/"/g, "'")}"`;
  let n = 0;
  for (const f of files) {
    run(['video', 'add', video, q(f.file), '--as', f.as, '--what', q(f.what)]);
    n++;
  }
  log(`В программе монтажа: ${n} материалов в ролике ${video}`);
  return { video, added: n };
}

void extname;
void roundInfo;
