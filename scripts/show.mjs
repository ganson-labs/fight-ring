// The host's console of a tournament: one page to run a video from, top to bottom — the fighters (figures with alpha
// for the montage), how each was built and what its model said, its build and moves, the league's tier list and who beat
// whom, the bracket, the fights. Written into show/ of the ring and opened from the game's server: /show/
//   node scripts/show.mjs --ids a,b,c,d,e --league <name> [--matches semi-1,semi-2,final] [--demo <match>] [--test] [--no-figures]
// show/index.html — the show itself, a stepper for the frame (→ next, ← back, F full screen); show/cheatsheet.html —
// the host's notes without a single result.
// Notes of the judge for the host (what was curious in a build) live in show/notes.json: { "<id>": ["…", "…"] }.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFighter } from '../kit/arena/tools/load.js';
import { STANDARD_MOVES } from '../kit/arena/engine/index.js';
import { runUsage } from './run-usage.mjs';
import { changes, brainLines } from '../judge/match.js';

const RING = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const ids = String(opt('ids', '')).split(',').filter(Boolean);
if (!ids.length) throw new Error('нужен --ids a,b,c');
const leagueName = opt('league');
const matchIds = String(opt('matches', '') || '').split(',').filter(Boolean);
const title = opt('title', 'Турнир нейросетей');
// --test: results replaced with invented numbers and stamped ТЕСТ — to check the result screens without seeing the outcome
const TEST = !!opt('test');
const demoId = opt('demo', null); // the match of the fighter that did not reach the bracket
const tanks = opt('tanks', 'http://localhost:4747/?a=contestants/t17-1&b=contestants/t17-3');
const OUT = join(RING, 'show');
mkdirSync(join(OUT, 'fig'), { recursive: true });
const json = (f, fb = null) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const reg = json(join(RING, 'contestants.json'), {});
const runs = json(join(RING, 'ledger', 'runs.json'), {});
const notes = json(join(OUT, 'notes.json'), {});

// the last thing the model said in its build: Claude Code — the result line, Codex — the last agent message,
// Antigravity — the last text of the model
function lastWords(log) {
  if (!log || !existsSync(log)) return '';
  let text = '';
  let deltas = '';
  let deltaStep = null;
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'result' && typeof o.result === 'string' && !o.is_error) text = o.result;
    else if (o.item?.type === 'agent_message' && o.item.text) text = o.item.text;
    else if (o.event === 'message' && o.message?.role === 'assistant' && typeof o.message.text === 'string') text = o.message.text;
    else if (line.includes('"finished_reason"')) {
      // Antigravity: the last line carries the whole answer next to finished_reason
      const holder = Object.values(o).find((v) => v && typeof v === 'object' && 'finished_reason' in v) || o;
      // not the error text: Antigravity ends some runs with a sign-in error after the answer is already written
      const longest = Object.entries(holder).filter(([k, v]) => typeof v === 'string' && !/error/i.test(k)).map(([, v]) => v).sort((a, b) => b.length - a.length)[0];
      if (typeof holder.response === 'string' && holder.response.trim().length > 40) text = holder.response;
      else if (longest && longest.length > 200) text = longest;
      else if (deltas.trim().length > 200) text = deltas;
    }
    else if (o.event === 'step_update' && o.step_update?.step_type === 'agent_response') {
      // Antigravity streams its answer in pieces; the last answer of the run is the one that counts
      if (o.step_update.step_index !== deltaStep) {
        deltaStep = o.step_update.step_index;
        deltas = '';
      }
      deltas += o.step_update.text_delta || '';
    }
    else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const t = o.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (t.length > 200) text = t;
    }
  }
  return (text || (deltas.trim().length > 200 ? deltas : '')).trim();
}

// all the code of the fighter: brain.js and the modules it imports, wherever they lie
const jsBytes = (d) => readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? (['out', 'work', 'voice', 'parts', 'art'].includes(e.name) ? 0 : jsBytes(join(d, e.name))) : e.name.endsWith('.js') ? readFileSync(join(d, e.name)).length : 0), 0);
const people = [];
for (const id of ids) {
  const c = reg[id];
  if (!c) throw new Error(`нет участника ${id}`);
  // the fighter as it entered the league: the locker rooms of the bracket changed the contestant's own folder since
  const snap = leagueName ? join(RING, 'leagues', leagueName, 'fighters', id, 'fighter') : null;
  const dir = snap && existsSync(join(snap, 'fighter.json')) ? snap : join(c.root, 'fighter');
  const r = await loadFighter(dir, { verify: false });
  if (!r.ok) throw new Error(`${id}: ${r.errors.join('; ')}`);
  const f = r.fighter;
  const run = [].concat(runs[id] || []).filter((x) => x.label === 'build').slice(-1)[0] || {};
  let usage = null;
  try {
    usage = run.log ? runUsage(run.log) : null;
  } catch {
    usage = null;
  }
  const limits = json(join(c.root, '.ring', 'limits.json'), {});
  const voiced = existsSync(join(dir, 'voice')) ? readdirSync(join(dir, 'voice')).filter((x) => x.endsWith('.mp3')).length : 0;
  people.push({
    id, model: c.model, color: c.color, name: f.card.name, motto: f.card.motto, story: f.card.story, stats: f.stats, derived: f.derived,
    moves: f.moves.map((m) => ({ id: m.id, name: m.name, slot: m.slot, basic: STANDARD_MOVES.some((s) => s.id === m.id), damage: Math.round(m.totalDamage), duration: m.duration })),
    minutes: run.workMinutes ?? null, exit: run.exit ?? null, annulled: run.annulled || null, usage,
    paint: limits.used?.paint ?? limits.paint?.used ?? null, voiced, lines: f.voice.lines.length,
    brainBytes: jsBytes(dir),
    words: lastWords(run.log), notes: notes[id] || [], figures: {},
  });
}

if (!opt('no-figures')) {
  const { renderFigures } = await import('../kit/arena/tools/preview.js');
  for (const p of people) {
    const poses = [['intro', 'intro', 'peak'], ['stance', 'idle', 0], ['victory', 'victory', 'peak']];
    try {
      await renderFigures({ fighterDir: join(reg[p.id].root, 'fighter'), poses: poses.map(([name, anim, t]) => ({ anim, t, out: join(OUT, 'fig', `${p.id}-${name}.png`) })) });
    } catch (err) {
      console.log(`  ! фигуры ${p.id}: ${String(err.message).split('\n')[0]}`);
    }
  }
}
for (const p of people) for (const n of ['intro', 'stance', 'victory']) if (existsSync(join(OUT, 'fig', `${p.id}-${n}.png`))) p.figures[n] = `fig/${p.id}-${n}.png`;
for (const p of people) {
  const dir = join(reg[p.id].root, 'fighter');
  const card = json(join(dir, 'fighter.json'), {});
  p.portrait = null;
  if (card.portrait && existsSync(join(dir, card.portrait))) {
    copyFileSync(join(dir, card.portrait), join(OUT, 'fig', `${p.id}-portrait.png`));
    p.portrait = `fig/${p.id}-portrait.png`;
  }
  // the pictures of the parts, as the model drew them, in the order of the skeleton
  const body = json(join(dir, 'body.json'), { parts: {} });
  mkdirSync(join(OUT, 'fig', 'parts', p.id), { recursive: true });
  p.parts = [];
  for (const bone of ['head', 'torso', 'pelvis', 'upper_arm_front', 'forearm_front', 'hand_front', 'thigh_front', 'shin_front', 'foot_front']) {
    const img = body.parts?.[bone]?.image;
    if (!img || !existsSync(join(dir, img)) || !/\.png$/i.test(img)) continue;
    copyFileSync(join(dir, img), join(OUT, 'fig', 'parts', p.id, `${bone}.png`));
    p.parts.push(`fig/parts/${p.id}/${bone}.png`);
  }
}

// ---- the league ----
let league = null;
if (leagueName) {
  const L = json(join(RING, 'leagues', leagueName, 'league.json'));
  if (!L) throw new Error(`нет лиги ${leagueName}`);
  const rows = L.table.entries.filter((e) => ids.includes(e.id));
  const pair = {};
  for (const f of L.fights) {
    if (!ids.includes(f.left) || !ids.includes(f.right)) continue;
    for (const [a, b] of [[f.left, f.right], [f.right, f.left]]) {
      pair[a] ??= {};
      pair[a][b] ??= { w: 0, n: 0 };
      pair[a][b].n++;
      if (f.winner === a) pair[a][b].w++;
    }
  }
  const dmg = {};
  for (const f of L.fights) [f.left, f.right].forEach((id, i) => {
    if (!ids.includes(id)) return;
    dmg[id] ??= {};
    for (const [m, d] of Object.entries(f.stats.dmg[i])) dmg[id][m] = (dmg[id][m] || 0) + d;
  });
  league = { name: leagueName, fights: L.fights.length, rows, pair, dmg, refs: L.table.entries.filter((e) => !ids.includes(e.id)), passport: L.passport };
}

// ---- the locker rooms of a match: after round n both models saw the round and changed their fighters ----
// What a model said comes from the journal of its locker run (ledger/runs.json, label locker, vars.N = the round);
// what it changed — from the judge's snapshots of the fighter before the two rounds.
function lockersOf(mid, m) {
  const out = [];
  let diffs = {};
  try {
    diffs = Object.fromEntries([m.red, m.blue].map((c) => [c, changes(mid, c)]));
  } catch {
    diffs = {};
  }
  const stats = json(join(RING, 'matches', mid, 'stats.json'), { rounds: [] });
  for (const r of m.rounds.slice(1)) {
    const after = r.n - 1;
    const prev = m.rounds.find((x) => x.n === after);
    const st = stats.rounds.find((x) => x.n === after);
    const hp = json(join(RING, 'matches', mid, `round-${after}`, 'replay.json'), {}).result?.hp || [0, 0];
    const sides = [m.red, m.blue].map((c) => {
      const run = [].concat(runs[c] || []).filter((x) => x.label === 'locker' && String(x.vars?.N) === String(after) && x.started >= m.created)[0];
      const d = (diffs[c] || []).find((x) => x.to === r.n) || null;
      const text = run ? lastWords(run.log) : '';
      // the headline of every change the model named: the bold start of a list item or of a paragraph; a model that
      // wrote prose gives the first sentences of its «what I changed» part
      const part = text.split(/^#+\s*Что\s+(?:я\s+)?(?:изменил|поменял)[^\n]*$/im)[1] || text.split(/\*\*Что\s+(?:я\s+)?(?:изменил|поменял)[^*]*\*\*/i)[1] || text;
      const dull = /^(Проверк|Что\s|Итог|Результат|Запустил|Прогоняю)|мини-лиг|побед из|готова к/i;
      let heads = [...part.matchAll(/^\s*(?:[-*]|\d+[.)])?\s*\*\*(.+?)\*\*/gm)].map((x) => x[1]).filter((x) => !dull.test(x));
      if (!heads.length) {
        const sentences = text.replace(/\*\*/g, '').replace(/`[^`]*`/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^[-*#>\s]+/, '').trim()).filter((x) => x.length > 12 && !x.startsWith('|') && !dull.test(x));
        const now = sentences.filter((x) => /^(Теперь|Добавил|Больше не|Исправил|Убрал|Научил)/i.test(x));
        heads = now.length ? now : sentences.filter((x) => /репли|спарринг|доработ/i.test(x));
      }
      heads = heads.map((x) => x.replace(/[.:]$/, '').replace(/\s+/g, ' ')).map((x) => (x.length > 78 ? `${x.slice(0, 76)}…` : x)).slice(0, 3);
      // what the model made of the round, to read aloud: the paragraph before its changes that carries the most numbers
      const before = text.split(/^#+\s*Что\s+(?:я\s+)?(?:изменил|поменял)[^\n]*$/im)[0].split(/\*\*Что\s+(?:я\s+)?(?:изменил|поменял)/i)[0];
      const paras = before.replace(/^#+.*$/gm, '\n').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#') && !x.startsWith('|') && !/^Правка стоит|^Проверка ринга|мини-лиг|^Боец (готов|сдан)|^Запустил|^Доработки/i.test(x));
      const best = paras.sort((x, y) => (y.match(/\d/g) || []).length - (x.match(/\d/g) || []).length)[0] || '';
      let quote = '';
      for (const sentence of best.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) {
        if ((quote + sentence).length > 250) break;
        quote += (quote ? ' ' : '') + sentence;
      }
      // a line of code that went out and one that came in, from the first changed module of the brains
      let code = null;
      const js = (d?.changed || []).map((x) => x.file).filter((f) => f.endsWith('.js'));
      for (const f of js) {
        const bl = brainLines(join(RING, 'matches', mid, `round-${after}`, c, 'fighter', f), join(RING, 'matches', mid, `round-${r.n}`, c, 'fighter', f));
        if (bl.added.length || bl.removed.length) {
          code = { file: f, removed: bl.removed[0] || null, added: bl.added[0] || null };
          break;
        }
      }
      const side = prev.left === c ? 0 : 1;
      const k = st?.counters?.[side] || {};
      const lines = js.reduce((n, f) => n + brainLines(join(RING, 'matches', mid, `round-${after}`, c, 'fighter', f), join(RING, 'matches', mid, `round-${r.n}`, c, 'fighter', f)).count, 0);
      return { id: c, minutes: run?.workMinutes ?? null, text, heads, quote, code, lines, hp: Math.round(hp[side]), won: prev.winner === c, hits: k.hits ?? null, parries: k.parries ?? null, throws: k.throws ?? null, supers: k.supers ?? null, damage: k.damage ?? null, stats: d?.stats || [], moves: d?.moves || [], unchanged: d ? !(d.brain || d.stats.length || d.moves.length || d.changed.length) : null };
    });
    out.push({ after, reason: prev.reason, sides });
  }
  return out;
}

// ---- the matches of the bracket ----
const matches = matchIds.map((mid) => {
  const m = json(join(RING, 'matches', mid, 'match.json'));
  if (!m) return { id: mid, missing: true };
  return {
    id: mid, red: m.red, blue: m.blue, winner: m.winner || null, over: !!m.over, lockers: lockersOf(mid, m),
    stat: (json(join(RING, 'matches', mid, 'stats.json'), { rounds: [] }).rounds || []).map((x) => { const r = m.rounds.find((y) => y.n === x.n); return { n: x.n, ids: [r.left, r.right], juicy: x.juicy, counters: x.counters }; }),
    rounds: m.rounds.map((r) => ({ n: r.n, winner: r.winner || null, reason: r.reason, stage: r.stage, video: existsSync(join(RING, 'matches', mid, `round-${r.n}`, 'fight-16x9.mp4')) ? `/matches/${mid}/round-${r.n}/fight-16x9.mp4` : null })),
    reel: existsSync(join(RING, 'matches', mid, 'reel', 'match-16x9.mp4')) ? `/matches/${mid}/reel/match-16x9.mp4` : null,
  };
});

// ---- test mode: the same screens on invented results ----
if (TEST && league) {
  const order = [...league.rows].sort((x, y) => x.id.localeCompare(y.id));
  order.forEach((e, i) => Object.assign(e, { rating: 2000 - i * 111, range: [1950 - i * 111, 2050 - i * 111], share: 0.9 - i * 0.17, kos: 100 - i * 9 }));
  league.rows = order;
  for (const x of order) for (const y of order) if (x.id !== y.id) league.pair[x.id][y.id] = { n: 20, w: order.indexOf(x) < order.indexOf(y) ? 13 : 7 };
}

// ---- the pages of the show ----
const by = Object.fromEntries(people.map((p) => [p.id, p]));
const P = join(OUT, 'p');
// a fresh set of pages: nothing of an earlier build of the show stays next to them
if (existsSync(P)) for (const f of readdirSync(P)) rmSync(join(P, f));
mkdirSync(P, { recursive: true });
const STAT = { health: 'Здоровье', power: 'Сила', speed: 'Скорость', defense: 'Защита' };
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n ?? '—'));
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
const page = (name, t, body, css = '') => writeFileSync(join(P, `${name}.html`), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(t)}</title><style>
*{box-sizing:border-box}html{background:#07080c;height:100%;overflow:hidden}body{margin:0;width:1920px;height:1080px;overflow:hidden;position:absolute;left:50%;top:50%;transform-origin:0 0;font-family:"Bahnschrift","Arial Narrow","Segoe UI",sans-serif;color:#fff;background:radial-gradient(ellipse at 50% 0%,#232a3d,#0a0c12 70%)}
h1{position:absolute;left:90px;top:44px;margin:0;font-size:76px;font-style:italic;font-weight:800;letter-spacing:2px;text-transform:uppercase;text-shadow:0 4px 0 #000;line-height:1}
h1 span{display:block;font-size:26px;font-style:normal;font-weight:600;letter-spacing:6px;color:#ffd23c;margin-bottom:6px}
.test{position:absolute;right:40px;top:30px;font-size:60px;font-weight:800;color:#ff3c3c;border:6px solid #ff3c3c;padding:0 18px;transform:rotate(6deg);z-index:9}
@keyframes in{from{opacity:0;translate:-240px 0}to{opacity:1;translate:0 0}}@keyframes up{from{opacity:0;translate:0 60px}to{opacity:1;translate:0 0}}@keyframes pop{from{opacity:0;scale:.6}to{opacity:1;scale:1}}
.a{opacity:0;animation:in .55s cubic-bezier(.2,1.2,.3,1) forwards}.u{opacity:0;animation:up .6s ease-out forwards}.pp{opacity:0;animation:pop .45s cubic-bezier(.2,1.4,.3,1) forwards}
${css}</style><script>const fit=()=>{const k=Math.min(innerWidth/1920,innerHeight/1080);document.body.style.transform='scale('+k+') translate(-50%,-50%)'};addEventListener('resize',fit);addEventListener('DOMContentLoaded',()=>{fit();if(new URLSearchParams(location.search).get('bg')==='0'){document.documentElement.style.background='transparent';document.body.style.background='transparent'}});addEventListener('keydown',e=>{if(['ArrowRight','ArrowLeft','f','F'].includes(e.key))parent.postMessage({key:e.key},'*')})</script></head><body>${TEST ? '<div class="test">ТЕСТ</div>' : ''}${body}</body></html>`);
const fig = (p, pose = 'stance') => p.figures[pose] || p.figures.stance || p.figures.intro || '';

// 1. the race of the builds: who took how long
const maxMin = Math.max(...people.map((p) => p.minutes || 1));
page('race', 'Гонка сборки', `<h1><span>Одно задание · время никто не ограничивал</span>Гонка сборки</h1>${[...people].sort((x, y) => (x.minutes || 0) - (y.minutes || 0)).map((p, i) => `<div class="lane" style="top:${230 + i * 160}px;--c:${p.color}"><div class="nm"><b>${esc(p.model)}</b></div><div class="track"><div class="bar" style="--w:${Math.max(6, Math.round((100 * (p.minutes || 0)) / maxMin))}%;animation-duration:${1 + 5 * ((p.minutes || 0) / maxMin)}s"></div><div class="t" style="animation-delay:${1 + 5 * ((p.minutes || 0) / maxMin)}s">${Math.round(p.minutes || 0)} мин</div></div></div>`).join('')}`,
  `.lane{position:absolute;left:90px;right:90px;height:120px;display:flex;align-items:center}.lane .nm{width:520px;font-size:46px;font-weight:800;text-transform:uppercase;color:var(--c);text-shadow:0 3px 0 #000}.track{flex:1;display:flex;align-items:center;height:84px;background:#10131b;border-left:8px solid var(--c)}.bar{height:100%;width:0;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 40%,#10131b),var(--c));animation:grow linear forwards}@keyframes grow{to{width:var(--w)}}.t{font-size:54px;font-weight:800;margin-left:24px;opacity:0;animation:pop .4s forwards;white-space:nowrap}`);

// 2. every fighter: the entrance, the build, the moves
for (const p of people) {
  page(`fighter-${p.id}`, p.name, `<div class="glow" style="--c:${p.color}"></div><img class="hero u" src="../${fig(p, 'intro')}" style="animation-delay:.2s"><div class="txt" style="--c:${p.color}"><div class="model a" style="animation-delay:.9s">${esc(p.model)}</div><div class="name a" style="animation-delay:1.2s">${esc(p.name)}</div><div class="motto a" style="animation-delay:1.9s">«${esc(p.motto)}»</div><p class="story u" style="animation-delay:2.7s">${esc(p.story)}</p></div>${p.portrait ? `<div class="port pp" style="--c:${p.color};animation-delay:3.4s"><img src="../${p.portrait}"><span>портрет нарисовала сама модель</span></div>` : ''}`,
    `.glow{position:absolute;left:0;bottom:0;width:1000px;height:900px;background:radial-gradient(ellipse at 50% 100%,color-mix(in srgb,var(--c) 60%,transparent),transparent 65%)}.hero{position:absolute;left:120px;bottom:40px;height:940px;max-width:800px;object-fit:contain;object-position:bottom;filter:drop-shadow(0 20px 30px #000)}.txt{position:absolute;left:960px;right:90px;top:150px}.model{font-size:34px;font-weight:700;letter-spacing:5px;text-transform:uppercase;color:var(--c)}.name{font-size:${p.name.length > 12 ? 104 : 136}px;font-weight:800;font-style:italic;text-transform:uppercase;line-height:1;text-shadow:0 6px 0 #000;margin:8px 0 22px}.motto{font-size:44px;font-style:italic;color:#ffd23c;line-height:1.2}.story{font-size:29px;line-height:1.42;color:#d3d9e4;margin-top:30px}.port{position:absolute;left:660px;bottom:44px;width:250px}.port img{width:250px;height:250px;object-fit:cover;border:4px solid var(--c);box-shadow:0 10px 24px #000;display:block}.port span{display:block;font-size:19px;color:#aab2c2;margin-top:6px;text-align:center}`);
  const facts = p.notes.length ? p.notes : [];
  page(`facts-${p.id}`, `${p.name}: сборка`, `<h1><span>${esc(p.model)} · как собирала</span>${esc(p.name)}</h1><img class="side" src="../${fig(p, 'victory')}"><div class="nums">${[[`${Math.round(p.minutes || 0)}`, 'минут работы'], [`${Math.round(p.brainBytes / 1024)} КБ`, 'кода мозгов'], [p.usage ? tok(p.usage.output) : '—', 'токенов написала'], [`${p.moves.length}`, 'приёмов с анимацией']].map(([b, t], i) => `<div class="pp" style="--c:${p.color};animation-delay:${0.3 + i * 0.35}s"><b>${b}</b><i>${t}</i></div>`).join('')}</div><ul class="facts">${facts.map((f, i) => `<li class="a" style="--c:${p.color};animation-delay:${1.9 + i * 1.1}s">${md(f)}</li>`).join('')}</ul>${p.parts.length ? `<div class="parts">${p.parts.map((src, i) => `<img class="pp" src="../${src}" style="animation-delay:${0.4 + i * 0.12}s">`).join('')}<span>из этого он собран</span></div>` : ''}`,
    `.side{position:absolute;right:60px;bottom:30px;height:640px;max-width:520px;object-fit:contain;object-position:bottom;filter:drop-shadow(0 16px 24px #000)}.nums{position:absolute;left:90px;top:230px;display:flex;gap:22px}.nums div{width:290px;background:#10131b;border-top:8px solid var(--c);padding:16px 22px}.nums b{display:block;font-size:56px;font-weight:800;line-height:1.1;white-space:nowrap}.nums i{font-style:normal;font-size:24px;color:#aab2c2}.facts{position:absolute;left:90px;top:450px;width:1240px;margin:0;padding:0;list-style:none}.facts li{font-size:36px;line-height:1.32;margin-bottom:24px;padding-left:30px;border-left:8px solid var(--c)}.facts code{font-size:30px;color:#ffd23c}.parts{position:absolute;left:1390px;top:232px;width:470px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}.parts img{height:62px;max-width:90px;object-fit:contain;background:#0b0d13;border:1px solid #2a3040;padding:5px}.parts span{font-size:19px;color:#aab2c2;width:100%}.side{height:560px!important}`);
  const sp = p.moves.filter((m) => m.slot !== 'normal');
  page(`kit-${p.id}`, `${p.name}: приёмы`, `<h1><span>${esc(p.model)} · телосложение и приёмы</span>${esc(p.name)}</h1><img class="side" src="../${fig(p, 'stance')}"><div class="stats">${Object.entries(STAT).map(([k, ru], i) => `<div class="a" style="--c:${p.color};animation-delay:${0.3 + i * 0.3}s"><span>${ru}</span><i>${'<b></b>'.repeat(p.stats[k])}${'<u></u>'.repeat(5 - p.stats[k])}</i></div>`).join('')}</div><div class="moves">${sp.map((m, i) => `<div class="pp ${m.slot}" style="--c:${p.color};animation-delay:${1.7 + i * 0.4}s"><b>${esc(m.name)}</b><i>${m.slot === 'super' ? 'суперприём' : ''}</i></div>`).join('')}</div>`,
    `.side{position:absolute;right:70px;bottom:30px;height:820px;max-width:560px;object-fit:contain;object-position:bottom;filter:drop-shadow(0 16px 24px #000)}.stats{position:absolute;left:90px;top:240px;width:760px}.stats div{display:flex;align-items:center;justify-content:space-between;font-size:42px;font-weight:700;margin-bottom:14px}.stats i{display:flex;gap:10px}.stats b,.stats u{width:56px;height:30px;transform:skewX(-14deg);background:var(--c)}.stats u{background:#232836}.moves{position:absolute;left:90px;top:560px;width:1230px;display:flex;flex-wrap:wrap;gap:18px}.moves div{background:linear-gradient(90deg,color-mix(in srgb,var(--c) 45%,#10131b),#10131b);border-left:8px solid var(--c);padding:16px 26px;min-width:380px}.moves b{font-size:40px;font-weight:800;text-transform:uppercase}.moves i{display:block;font-style:normal;font-size:22px;color:#ffd23c;height:26px}.moves .super{box-shadow:0 0 0 4px #ffd23c;min-width:100%}`);
}

// what the builds have in common: nobody saw the others
const common = notes['_общее'] || [];
if (common.length) page('common', 'Совпадения', `<h1><span>Они не видели друг друга</span>Совпадения</h1><div class="row">${people.map((p, i) => `<img class="u" src="../${fig(p)}" style="animation-delay:${0.2 + i * 0.25}s">`).join('')}</div><ul class="facts">${common.map((f, i) => `<li class="a" style="animation-delay:${1.8 + i * 1.3}s">${md(f)}</li>`).join('')}</ul>`,
  `.row{position:absolute;left:90px;right:90px;top:200px;height:330px;display:flex;justify-content:space-around;align-items:flex-end}.row img{height:320px;max-width:300px;object-fit:contain;object-position:bottom;filter:drop-shadow(0 12px 18px #000)}.facts{position:absolute;left:90px;right:90px;top:590px;margin:0;padding:0;list-style:none}.facts li{font-size:42px;line-height:1.3;margin-bottom:26px;padding-left:30px;border-left:8px solid #ffd23c}`);

// the locker room between two rounds, as a picture: how the round ended for each, what each changed — cards with
// numbers, and a line of the code that went out and one that came in
const PLAIN = json(join(OUT, 'lockers.json'), {}); // the change of the code in plain words, by match, round and fighter
for (const m of matches) for (const L of m.lockers || []) {
  page(`locker-${m.id}-${L.after}`, 'Раздевалка', `<h1><span>После раунда ${L.after} · запись боя и 15 минут каждой</span>Раздевалка</h1>${L.sides.map((x, i) => {
    const p = by[x.id];
    const max = p.derived.maxHp;
    const num = (v, t) => (v == null ? '' : `<div><b>${v}</b><i>${t}</i></div>`);
    return `<div class="side s${i}" style="--c:${p.color}">
<img class="fg u" src="../${fig(p, x.won ? 'victory' : 'stance')}" style="animation-delay:${0.2 + i * 0.25}s">
<div class="who a" style="animation-delay:${0.4 + i * 0.25}s"><b>${esc(p.name)}</b><i>${esc(p.model)}</i></div>
<div class="hp a" style="animation-delay:${0.9 + i * 0.25}s"><div class="bar"><u style="--w:${Math.round((100 * x.hp) / max)}%"></u></div><span>${x.won ? (L.reason === 'ko' ? 'нокаутировал' : 'выиграл по времени') : x.hp <= 0 ? 'в нокауте' : 'проиграл по времени'} · здоровья ${Math.max(0, x.hp)}</span></div>
<div class="nums">${[num(x.hits, 'попаданий'), num(x.parries, 'парирований'), num(x.throws, 'бросков'), num(x.supers, 'суперприёмов')].map((h, k) => h.replace('<div>', `<div class="pp" style="animation-delay:${1.5 + k * 0.2 + i * 0.25}s">`)).join('')}</div>
${x.quote ? `<blockquote class="u" style="animation-delay:${2.2 + i * 0.25}s">${md(x.quote)}</blockquote>` : ''}
<div class="cap u" style="animation-delay:${3 + i * 0.25}s">${x.unchanged ? 'Ничего не поменяла' : 'Что поменяла'}</div>
<ol>${x.heads.map((h, k) => `<li class="a" style="animation-delay:${2.9 + k * 0.8 + i * 0.25}s"><em>${k + 1}</em><span>${md(h)}</span></li>`).join('')}</ol>
${x.code ? `<div class="code u" style="animation-delay:${3.1 + x.heads.length * 0.8}s">${x.code.removed ? `<div class="del">− ${esc(x.code.removed.slice(0, 84))}</div>` : ''}${x.code.added ? `<div class="add">+ ${esc(x.code.added.slice(0, 84))}</div>` : ''}</div>` : ''}${PLAIN[`${m.id}-${L.after}-${x.id}`] ? `<div class="plain u" style="animation-delay:${3.3 + x.heads.length * 0.8}s">${esc(PLAIN[`${m.id}-${L.after}-${x.id}`])}</div>` : ''}
<div class="tags u" style="animation-delay:${3.4 + x.heads.length * 0.8}s">${[x.minutes != null ? `${x.minutes < 1 ? 'меньше минуты' : `${Math.round(x.minutes)} мин`} в раздевалке` : null, x.lines ? `${x.lines} строк кода` : null, ...x.stats, ...x.moves].filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('')}</div></div>`;
  }).join('')}`,
    `.side{position:absolute;top:196px;bottom:36px;width:860px;background:linear-gradient(180deg,color-mix(in srgb,var(--c) 30%,#10131b),#10131b 46%);border-top:10px solid var(--c);padding:20px 26px}.s0{left:90px}.s1{right:90px}
.plain{font-size:23px;line-height:1.3;color:#ffe9a6;margin:8px 0 0;padding-left:14px;border-left:4px solid #ffd23c}
.fg{position:absolute;right:6px;top:-64px;height:330px;max-width:300px;object-fit:contain;object-position:bottom;filter:drop-shadow(0 10px 14px #000)}
.who b{display:block;font-size:${L.sides.some((x) => by[x.id].name.length > 14) ? 40 : 52}px;font-weight:800;text-transform:uppercase;line-height:1;max-width:560px}.who i{font-style:normal;font-size:23px;color:var(--c);letter-spacing:2px;text-transform:uppercase}
.hp{margin-top:18px;width:540px}.bar{height:26px;background:#0a0c12;transform:skewX(-14deg);overflow:hidden;border:2px solid #2a3040}.bar u{display:block;height:100%;width:0;background:linear-gradient(90deg,#ffd23c,#ffe58a);animation:grow 1s .9s ease-out forwards}@keyframes grow{to{width:var(--w)}}.hp span{display:block;font-size:22px;color:#c6ccd8;margin-top:6px}
.nums{display:flex;gap:12px;margin-top:16px}.nums div{flex:1;background:#0b0d13;border-bottom:5px solid var(--c);padding:8px 12px}.nums b{display:block;font-size:44px;font-weight:800;line-height:1}.nums i{font-style:normal;font-size:18px;color:#aab2c2}
blockquote{margin:16px 0 0;padding:10px 16px;font-size:25px;line-height:1.32;font-style:italic;color:#eef1f6;border-left:6px solid #ffd23c;background:rgba(0,0,0,.28)}blockquote code{color:#ffd23c;font-style:normal}
.cap{font-size:22px;letter-spacing:5px;text-transform:uppercase;color:#ffd23c;margin:14px 0 8px}
ol{margin:0;padding:0;list-style:none}li{display:flex;align-items:center;gap:14px;margin-bottom:8px;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 28%,#10131b),transparent)}li em{flex:none;width:52px;height:52px;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:40px;font-weight:800;background:var(--c);color:#0a0c12;transform:skewX(-10deg)}li span{font-size:27px;font-weight:700;line-height:1.15}li code{color:#ffd23c;font-size:.9em}
.code{margin-top:14px;font:20px/1.5 Consolas,"Cascadia Mono",monospace;background:#07090d;border-left:5px solid #2a3040;padding:8px 14px;white-space:nowrap;overflow:hidden}.del{color:#ff7b7b}.add{color:#7be08f}
.tags{position:absolute;left:26px;right:26px;bottom:16px;display:flex;flex-wrap:wrap;gap:10px}.tags span{font-size:20px;background:#0b0d13;border:1px solid #2a3040;padding:4px 12px;color:#c6ccd8}`);
}

// the host's own tier list, before any result: he drags the fighters into the rows. It is kept in the browser
// (localStorage of the show) and comes back at the end next to the league's table.
const TIERS = [['S', '#ff5a5a'], ['A', '#ffa34d'], ['B', '#ffd23c'], ['C', '#7be08f'], ['D', '#6fb6ff']];
const cards = JSON.stringify(people.map((p) => ({ id: p.id, name: p.name, model: p.model, color: p.color, img: `../${fig(p)}` })));
page('predict', 'Мой прогноз', `<h1><span>До первого боя · перетащи бойцов по рядам</span>Мой прогноз</h1><div id="rows">${TIERS.map(([t, c]) => `<div class="tier" style="--t:${c}"><b>${t}</b><div class="drop" data-tier="${t}"></div></div>`).join('')}</div><div id="pool" class="drop" data-tier=""></div><button id="reset">сбросить</button>
<script>
const CARDS=${cards};const KEY='ring-predict';let state={};try{state=JSON.parse(localStorage.getItem(KEY))||{}}catch{}
const el=(c)=>{const d=document.createElement('div');d.className='card';d.draggable=true;d.dataset.id=c.id;d.style.setProperty('--c',c.color);d.innerHTML='<img src="'+c.img+'" draggable="false"><span><b>'+c.name+'</b><i>'+c.model+'</i></span>';d.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',c.id);d.classList.add('drag')});d.addEventListener('dragend',()=>d.classList.remove('drag'));return d};
const place=()=>{document.querySelectorAll('.drop').forEach(z=>z.innerHTML='');for(const c of CARDS){const t=state[c.id]||'';document.querySelector('.drop[data-tier="'+t+'"]').appendChild(el(c))}};
document.querySelectorAll('.drop').forEach(z=>{z.addEventListener('dragover',e=>{e.preventDefault();z.classList.add('over')});z.addEventListener('dragleave',()=>z.classList.remove('over'));z.addEventListener('drop',e=>{e.preventDefault();z.classList.remove('over');const id=e.dataTransfer.getData('text/plain');if(z.dataset.tier)state[id]=z.dataset.tier;else delete state[id];localStorage.setItem(KEY,JSON.stringify(state));place()})});
document.getElementById('reset').onclick=()=>{state={};localStorage.removeItem(KEY);place()};place();
</script>`,
  `#rows{position:absolute;left:90px;right:90px;top:190px}.tier{display:flex;height:128px;margin-bottom:10px;background:#10131b}.tier>b{flex:none;width:128px;display:flex;align-items:center;justify-content:center;font-size:86px;font-weight:800;font-style:italic;background:var(--t);color:#0a0c12}.drop{flex:1;display:flex;align-items:center;gap:12px;padding:0 12px;min-height:128px;transition:background .15s}.drop.over{background:rgba(255,210,60,.16)}
#pool{position:absolute;left:90px;right:240px;bottom:28px;height:150px;border:3px dashed #3a4152;justify-content:center}
.card{display:flex;align-items:center;gap:10px;height:112px;padding:0 18px 0 6px;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 55%,#10131b),#161a22);border-left:8px solid var(--c);cursor:grab;user-select:none}.card.drag{opacity:.4}.card img{height:124px;margin-top:-10px;filter:drop-shadow(0 5px 8px #000);pointer-events:none}.card b{display:block;font-size:26px;font-weight:800;text-transform:uppercase;line-height:1;white-space:nowrap}.card i{font-style:normal;font-size:17px;color:#d7dce6;white-space:nowrap}
#reset{position:absolute;right:90px;bottom:70px;font:600 20px inherit;color:#aab2c2;background:#161a22;border:1px solid #3a4152;padding:10px 18px;cursor:pointer}`);

// what changed in the ring since the last video: the first screen, and the whole list rolling like credits
const CH = json(join(OUT, 'changes.json'));
if (CH) {
  page('changes', CH.since, `<h1><span>${esc(CH.thanks)}</span>${esc(CH.since)}</h1><div class="grid">${CH.highlights.map(([t, d], i) => `<div class="c pp" style="animation-delay:${0.4 + i * 0.55}s"><em>${i + 1}</em><b>${esc(t)}</b><p>${esc(d)}</p></div>`).join('')}</div>`,
    `h1{font-size:60px}.grid{position:absolute;left:90px;right:90px;top:196px;display:grid;grid-template-columns:repeat(4,1fr);gap:20px}.c{position:relative;height:392px;padding:86px 24px 20px;background:linear-gradient(180deg,#1a2030,#10131b);border-top:8px solid #ffd23c}.c em{position:absolute;left:20px;top:10px;font-style:italic;font-weight:800;font-size:64px;color:#ffd23c;line-height:1}.c b{display:block;font-size:35px;font-weight:800;text-transform:uppercase;line-height:1.06;margin-bottom:14px}.c p{margin:0;font-size:24px;line-height:1.34;color:#c9d0dc}`);
  const total = CH.full.reduce((n, g) => n + g[1].length, 0);
  page('changelog', 'Полный список', `<h1><span>${total} изменений с прошлого ролика</span>Полный список</h1><div class="win"><div class="roll">${CH.full.map(([g, items]) => `<h2>${esc(g)}</h2>${items.map((x) => `<p>${esc(x)}</p>`).join('')}`).join('')}<h2>${esc(CH.thanks)}</h2></div></div>`,
    `.win{position:absolute;left:90px;right:90px;top:196px;bottom:0;overflow:hidden;mask-image:linear-gradient(180deg,transparent,#000 8%,#000 90%,transparent)}.roll{animation:roll ${Math.round(total * 0.62 + 6)}s linear forwards}@keyframes roll{from{transform:translateY(860px)}to{transform:translateY(calc(-100% + 560px))}}.roll h2{font-size:54px;font-style:italic;font-weight:800;text-transform:uppercase;color:#ffd23c;margin:70px 0 22px}.roll p{font-size:38px;line-height:1.3;margin:0 0 16px;padding-left:26px;border-left:6px solid #2f3648}`);
}

// the briefing on the new models before the ring: what came out, where it leads, where it does not, what the early testers say
const BN = json(join(OUT, 'bench.json'));
if (BN) {
  const col = (k) => (people.find((p) => k && p.id.startsWith(k)) || {}).color || '#7d8698';
  const num = (v) => String(v).replace('.', ',');
  const chart = (c, i) => `<div class="ch u" style="animation-delay:${0.3 + i * 0.5}s"><b>${esc(c.name)}</b><i>${esc(c.what)}</i>${c.places
    ? `<div class="pl">${c.places.map(([n, m, k]) => `<div style="--c:${col(k)}"><em>${esc(n)}</em><span>${esc(m)}</span></div>`).join('')}</div>`
    : c.rows.map(([m, v, k], j) => { const max = Math.max(...c.rows.map((r) => r[1])); return `<div class="row${k === 'astra' ? ' me' : ''}" style="--c:${col(k)}"><span>${esc(m)}</span><div class="tr"><div class="bar" style="--w:${Math.round((100 * (v - c.base)) / (max - c.base))}%;animation-delay:${0.7 + i * 0.5 + j * 0.12}s"></div></div><em>${num(v)}</em></div>`; }).join('')}</div>`;
  const CSS = `h1{font-size:60px}.src{position:absolute;left:90px;bottom:22px;font-size:19px;color:#7d8698}.g{position:absolute;left:90px;right:90px;top:176px;display:grid;grid-template-columns:1fr 1fr;gap:20px 28px}.ch{height:404px;padding:20px 26px;background:linear-gradient(180deg,#1a2030,#10131b);border-top:6px solid #ffd23c}.ch>b{display:block;font-size:36px;font-weight:800;text-transform:uppercase;line-height:1.05}.ch>i{display:block;font-style:normal;font-size:23px;color:#aab2c2;margin:4px 0 16px}.row{display:flex;align-items:center;height:56px;gap:14px}.row span{width:330px;font-size:23px;line-height:1.05;color:#d7dce6}.row.me span{color:#fff;font-weight:800}.tr{flex:1;height:38px;background:#0c0e14}.bar{height:100%;width:0;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 45%,#10131b),var(--c));animation:grow .7s ease-out forwards}@keyframes grow{to{width:var(--w)}}.row em{width:96px;text-align:right;font-style:normal;font-size:34px;font-weight:800}.row.me em{color:#ffd23c}.pl{display:flex;gap:18px;margin-top:8px}.pl div{flex:1;height:250px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0c0e14;border-bottom:8px solid var(--c)}.pl em{font-style:italic;font-weight:800;font-size:130px;line-height:1}.pl span{font-size:24px;color:#d7dce6;margin-top:6px}`;
  page('bench-1', 'Что вышло', `<h1><span>OpenAI · ${esc(BN.date)}</span>Что вышло</h1><div class="ms">${BN.models.map((m, i) => `<div class="m pp" style="--c:${col(m.key)};animation-delay:${0.4 + i * 0.6}s"><b>${esc(m.name)}</b><p>${esc(m.role)}</p><em>${esc(m.price)}</em><i>за миллион токенов на входе и выходе · ${esc(m.delta)}</i></div>`).join('')}</div><div class="plan">${[BN.top.title, BN.weak.title, BN.people.title, 'И что показал наш ринг'].map((t, i) => `<div class="a" style="animation-delay:${1.8 + i * 0.45}s"><em>${i + 1}</em>${esc(t)}</div>`).join('')}</div>`,
    `h1{font-size:60px}.ms{position:absolute;left:90px;right:90px;top:186px;display:grid;grid-template-columns:1fr 1fr;gap:28px}.m{height:400px;padding:30px 36px;background:linear-gradient(180deg,color-mix(in srgb,var(--c) 30%,#1a2030),#10131b);border-top:10px solid var(--c)}.m b{display:block;font-size:76px;font-weight:800;font-style:italic;text-transform:uppercase;line-height:1;text-shadow:0 4px 0 #000}.m p{font-size:36px;margin:14px 0 30px;color:#e6eaf2}.m em{display:block;font-style:normal;font-size:84px;font-weight:800;color:#ffd23c;line-height:1}.m i{display:block;font-style:normal;font-size:23px;color:#aab2c2;margin-top:8px}.plan{position:absolute;left:90px;right:90px;top:626px;display:grid;grid-template-columns:1fr 1fr;gap:16px 28px}.plan div{height:92px;display:flex;align-items:center;font-size:38px;font-weight:700;background:#10131b;border-left:8px solid #ffd23c}.plan em{width:86px;text-align:center;font-style:italic;font-weight:800;font-size:54px;color:#ffd23c}`);
  [['bench-2', BN.top], ['bench-3', BN.weak]].forEach(([n, S]) => page(n, S.title, `<h1><span>GPT-6.2 Astra против остальных</span>${esc(S.title)}</h1><div class="g">${S.charts.map(chart).join('')}</div><div class="src">${esc(BN.source)}</div>`, CSS));
  (BN.slides || []).forEach((S, i) => page(`bench-s${String(i + 1).padStart(2, '0')}`, S.name, `<h1><span>${esc(S.who)}</span>${esc(S.name)}</h1><div class="shot pp" style="animation-delay:.3s"><img src="../${S.img}"></div><div class="tx">${[['Что проверяют', S.what], ['Пример задания', S.example], ['Что видно', S.see]].filter((x) => x[1]).map(([h, t], k) => `<div class="b a${h === 'Что видно' ? ' see' : ''}" style="animation-delay:${1 + k * 1.1}s"><i>${h}</i><p>${esc(t)}</p></div>`).join('')}${S.rows ? `<div class="cmp u" style="animation-delay:3.6s">${S.rows.map(([m, v, k]) => { const max = Math.max(...S.rows.map((r) => r[1])); return `<div class="row${k === 'astra' ? ' me' : ''}" style="--c:${col(k)}"><span>${esc(m)}</span><div class="tr"><div class="bar" style="width:${Math.round((100 * (v - S.base)) / (max - S.base))}%"></div></div><em>${num(v)}</em></div>`; }).join('')}</div>` : ''}</div>`,
    `.cmp{padding:10px 20px;background:#10131b}.row{display:flex;align-items:center;height:38px;gap:12px}.row span{width:250px;font-size:21px;color:#d7dce6;white-space:nowrap}.row.me span{color:#fff;font-weight:800}.tr{flex:1;height:22px;background:#0c0e14}.bar{height:100%;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 45%,#10131b),var(--c))}.row em{width:76px;text-align:right;font-style:normal;font-size:25px;font-weight:800}.row.me em{color:#ffd23c}h1{font-size:60px}.shot{position:absolute;left:90px;top:180px;width:1010px;height:860px;background:#0b0d13;border-radius:14px;overflow:hidden;box-shadow:0 16px 36px #000;display:flex;align-items:flex-start;justify-content:center}.shot img{width:100%;height:100%;object-fit:contain;object-position:top}.tx{position:absolute;left:1150px;right:90px;top:180px}.b{margin-bottom:16px;padding:14px 22px;background:#10131b;border-left:8px solid #3a4152}.b i{display:block;font-style:normal;font-size:20px;letter-spacing:4px;text-transform:uppercase;color:#aab2c2;margin-bottom:6px}.b p{margin:0;font-size:28px;line-height:1.26}.b.see{border-left-color:#ffd23c}.b.see p{font-weight:700}`));
  page('bench-4', BN.people.title, `<h1><span>Ранний доступ · ${esc(BN.date)}</span>${esc(BN.people.title)}</h1><div class="tw">${BN.people.tweets.map((t, i) => `<div class="t u" style="animation-delay:${0.4 + i * 1.1}s"><img src="../${t.img}"><p>${esc(t.ru)}</p></div>`).join('')}</div>`,
    `h1{font-size:60px}.tw{position:absolute;left:90px;right:90px;top:180px;bottom:30px;display:grid;grid-template-columns:repeat(3,1fr);gap:28px}.t{display:flex;flex-direction:column;align-items:center}.t img{max-width:100%;max-height:640px;border-radius:16px;box-shadow:0 14px 30px #000}.t p{margin:18px 0 0;font-size:31px;line-height:1.25;font-weight:700;color:#ffd23c;text-align:center}`);
}

// what both games cost every model: minutes, tokens written, dollars at the prices of the API
const SP = json(join(OUT, 'spend.json'));
if (SP) {
  const colOf = (k) => (people.find((p) => k && p.id.startsWith(k)) || {}).color || '#7d8698';
  const cell = (v, u = '') => (v == null ? '<td class="no">—</td>' : `<td><b>${esc(String(v))}</b>${u ? `<i>${u}</i>` : ''}</td>`);
  page('spend', 'Кто сколько потратил', `<h1><span>Файтинг и танчики</span>Кто сколько потратил</h1><table><tr><th></th><th colspan="3">Боец для ринга</th><th>Раздевалки</th><th colspan="3">Танк</th></tr><tr class="sub"><th></th><th>время</th><th>написала</th><th>цена</th><th>время</th><th>время</th><th>написала</th><th>цена</th></tr>${SP.rows.map((r, i) => `<tr class="a" style="--c:${colOf(r.key)};animation-delay:${0.4 + i * 0.45}s"><td class="m">${esc(r.model)}</td>${cell(r.ring[0], 'мин')}${cell(r.ring[1], 'токенов')}${cell(r.ring[2])}${cell(r.locker, 'мин')}${r.tank ? cell(r.tank[0], 'мин') + cell(r.tank[1] === '—' ? null : r.tank[1], 'токенов') + cell(r.tank[2] === '—' ? null : r.tank[2]) : '<td class="no" colspan="3">не участвовала</td>'}</tr>`).join('')}</table><div class="src">${esc(SP.note)}</div>`,
    `h1{font-size:60px}table{position:absolute;left:90px;right:90px;top:190px;width:1740px;border-collapse:separate;border-spacing:0 12px}th{font-size:26px;letter-spacing:3px;text-transform:uppercase;color:#ffd23c;font-weight:700;text-align:left;padding:0 18px}.sub th{font-size:20px;color:#aab2c2;letter-spacing:2px}td{height:112px;padding:0 18px;background:#10131b;font-size:22px;white-space:nowrap}td b{font-size:44px;font-weight:800;margin-right:8px}td i{font-style:normal;color:#aab2c2}td.m{font-size:36px;font-weight:800;text-transform:uppercase;border-left:10px solid var(--c);background:linear-gradient(90deg,color-mix(in srgb,var(--c) 40%,#10131b),#10131b)}td.no{color:#5d6577;font-size:26px}.src{position:absolute;left:90px;right:90px;bottom:26px;font-size:21px;color:#8d96a8;line-height:1.3}`);
}

// the awards of the fighting tournament, before the tanks: one card a fact, every number from the journals and the fights
if (league && matches.length) {
  const A = [];
  const final = matches[2] && !matches[2].missing && matches[2].over ? matches[2] : null;
  const pick = (list, f, max = true) => [...list].sort((x, y) => (max ? f(y) - f(x) : f(x) - f(y)))[0];
  if (final) A.push([final.winner, 'Чемпион сетки', 'до двух побед, с раздевалками', '🏆']);
  A.push([league.rows[0].id, 'Лучший в лиге', `${Math.round(league.rows[0].share * 100)} % очков в ${league.fights} боях`, '']);
  const fast = pick(people, (p) => p.minutes ?? 1e9, false);
  A.push([fast.id, 'Самая быстрая сборка', `${Math.round(fast.minutes)} минут на всё`, '']);
  const slow = pick(people, (p) => p.minutes ?? 0);
  A.push([slow.id, 'Дольше всех думал', `${Math.round(slow.minutes)} минут`, '']);
  const big = pick(people, (p) => p.brainBytes);
  A.push([big.id, 'Больше всех кода', `${Math.round(big.brainBytes / 1024)} КБ мозгов`, '']);
  const rounds = matches.filter((m) => !m.missing).flatMap((m) => m.stat || []);
  const hit = pick(rounds.filter((r) => r.juicy), (r) => r.juicy.damage);
  if (hit) A.push([hit.ids[hit.juicy.side], 'Самый сильный удар', `«${hit.juicy.name}» — ${hit.juicy.damage} урона`, '']);
  const par = pick(rounds.flatMap((r) => r.counters.map((c, i) => ({ id: r.ids[i], v: c.parries }))), (x) => x.v);
  if (par) A.push([par.id, 'Стена', `${par.v} парирований за один раунд`, '']);
  const thr = pick(rounds.flatMap((r) => r.counters.map((c, i) => ({ id: r.ids[i], v: c.throws }))), (x) => x.v);
  if (thr) A.push([thr.id, 'Вышибала', `${thr.v} бросков за один раунд`, '']);
  const lk = matches.filter((m) => !m.missing).flatMap((m) => (m.lockers || []).flatMap((L) => L.sides)).filter((x) => x.minutes != null);
  if (lk.length) {
    const long = pick(lk, (x) => x.minutes);
    const quick = pick(lk, (x) => x.minutes, false);
    A.push([long.id, 'Дольше всех в раздевалке', `${Math.round(long.minutes)} минут над одной правкой`, '']);
    A.push([quick.id, 'Быстрее всех перестроился', `${quick.minutes < 1.5 ? 'одна минута' : `${Math.round(quick.minutes)} мин`} — и новые мозги`, '']);
  }
  page('awards', 'Итоги ринга', `<h1><span>Пять моделей · ${league.fights} боёв лиги · сетка с раздевалками</span>Итоги ринга</h1><div class="grid">${A.map(([id, t, d], i) => `<div class="aw pp${i === 0 ? ' first' : ''}" style="--c:${by[id].color};animation-delay:${0.5 + i * 0.7}s"><img src="../${fig(by[id], i === 0 ? 'victory' : 'stance')}"><div><i>${esc(t)}</i><b>${esc(by[id].name)}</b><span>${esc(d)}</span></div></div>`).join('')}<div class="aw q pp" style="animation-delay:${0.5 + A.length * 0.7}s"><div><i>Приз зрителей</i><b>?</b><span>чей персонаж лучший — пишите в комментариях</span></div></div></div>`,
    `.grid{position:absolute;left:90px;right:90px;top:192px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.aw{display:flex;align-items:center;height:${Math.floor((840 - 16 * Math.ceil((A.length + 1) / 3)) / Math.ceil((A.length + 1) / 3))}px;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 50%,#10131b),#10131b 85%);border-left:10px solid var(--c);overflow:hidden}.aw img{height:112%;margin:0 6px -6px 0;filter:drop-shadow(0 6px 10px #000);max-width:170px;object-fit:contain;object-position:bottom;align-self:flex-end}.aw i{display:block;font-style:normal;font-size:23px;letter-spacing:3px;text-transform:uppercase;color:#ffd23c}.aw b{display:block;font-size:36px;font-weight:800;text-transform:uppercase;line-height:1.05;margin:4px 0}.aw span{font-size:23px;color:#d7dce6;line-height:1.2;display:block}.aw.first{box-shadow:inset 0 0 0 5px #ffd23c}.aw.q{--c:#ffd23c;justify-content:center;text-align:center;border-left:0;border:4px dashed #ffd23c;background:none}.aw.q b{font-size:90px}`);
}

// 3. everyone against everyone: the table fills pair by pair
if (league) {
  const rowsL = [...league.rows].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); // the order of the entrance, not of the result
  let k = 0;
  page('league', 'Все со всеми', `<h1><span>${league.fights} боёв · пять стартов · с обеих сторон</span>Все со всеми</h1><table><tr><th></th>${rowsL.map((e) => `<th style="color:${by[e.id].color}">${esc(by[e.id].name)}</th>`).join('')}</tr>${rowsL.map((x) => `<tr><th style="color:${by[x.id].color}"><img src="../${fig(by[x.id])}">${esc(by[x.id].name)}</th>${rowsL.map((y) => {
    if (x.id === y.id) return '<td class="self"></td>';
    const c = league.pair[x.id]?.[y.id] || { w: 0, n: 0 };
    const win = c.w * 2 > c.n;
    return `<td class="pp ${win ? 'w' : c.w * 2 === c.n ? '' : 'l'}" style="animation-delay:${0.6 + (rowsL.indexOf(x) < rowsL.indexOf(y) ? k++ : k) * 0.0 + (Math.min(rowsL.indexOf(x), rowsL.indexOf(y)) * rowsL.length + Math.max(rowsL.indexOf(x), rowsL.indexOf(y))) * 0.55}s"><b>${c.w}</b> : ${c.n - c.w}</td>`;
  }).join('')}</tr>`).join('')}</table><div class="hint">В клетке: сколько боёв строка выиграла у столбца — и сколько проиграла</div>`,
    `table{position:absolute;left:90px;top:180px;border-collapse:separate;border-spacing:10px}th{font-size:30px;font-weight:800;text-transform:uppercase;text-align:left;white-space:nowrap}tr:first-child th{text-align:center;width:250px;padding-bottom:6px}tr th:first-child{width:420px;height:${Math.min(130, Math.floor(600 / people.length))}px}th img{height:${Math.min(120, Math.floor(600 / people.length) - 10)}px;vertical-align:middle;margin-right:14px}td{text-align:center;font-size:42px;font-weight:700;background:#141821;color:#c9d0dc;line-height:1}td b{font-size:54px;color:#fff}td.w{background:linear-gradient(180deg,#1f6b3f,#12402a)}td.l{background:linear-gradient(180deg,#6b2323,#3d1515)}td.self{background:repeating-linear-gradient(45deg,#11141b,#11141b 12px,#161a22 12px,#161a22 24px)}.hint{position:absolute;left:90px;bottom:36px;font-size:28px;color:#aab2c2}`);

  // 4. the tier list: from the last place to the first
  const n = league.rows.length;
  const h = Math.min(150, Math.floor(820 / n) - 18);
  page('tier', 'Тир-лист', `<h1><span>Лига · ${league.fights} боёв · одна сборка на модель</span>Тир-лист</h1>${league.rows.map((e, i) => `<div class="row a" style="--c:${by[e.id].color};top:${210 + i * (h + 18)}px;height:${h}px;animation-delay:${(n - 1 - i) * 2.2 + 0.6}s"><div class="place">${i + 1}</div><div class="fg" style="height:${h + 60}px"><img src="../${fig(by[e.id])}" style="max-height:${h + 70}px"></div><div class="nm"><b>${esc(by[e.id].name)}</b><i>${esc(e.model)}</i></div><div class="num"><b>${Math.round(e.share * 100)} %</b><i>очков в лиге</i></div><div class="num"><b>${e.rating}</b><i>рейтинг ${e.range[0]}–${e.range[1]}</i></div></div>`).join('')}`,
    `.row{position:absolute;left:90px;right:90px;display:flex;align-items:center;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 55%,#10131b),#10131b 62%);border-left:12px solid var(--c);transform:skewX(-8deg)}.row>*{transform:skewX(8deg)}.place{width:150px;text-align:center;font-size:104px;font-weight:800;font-style:italic;text-shadow:0 5px 0 #000}.fg{width:210px;align-self:flex-end;display:flex;align-items:flex-end;justify-content:center;margin-bottom:-4px}.fg img{max-width:230px;filter:drop-shadow(0 8px 12px #000)}.nm{flex:1;padding-left:20px}.nm b{display:block;font-size:60px;font-weight:800;text-transform:uppercase;line-height:1;text-shadow:0 3px 0 #000}.nm i{font-style:normal;font-size:27px;color:#d7dce6}.num{width:300px;text-align:right;padding-right:36px}.num b{font-size:66px;font-weight:800}.num i{display:block;font-style:normal;font-size:22px;color:#aab2c2}`);

  // the host's forecast next to the league: his rows on the left, the real places on the right
  const real = JSON.stringify(league.rows.map((e, i) => ({ id: e.id, place: i + 1, share: Math.round(e.share * 100) })));
  page('verdict', 'Прогноз и результат', `<h1><span>Что я поставил до боёв · что показала лига</span>Прогноз и результат</h1><div id="v"></div>
<script>
const CARDS=${cards};const REAL=${real};const T=${JSON.stringify(Object.fromEntries(TIERS))};let st={};try{st=JSON.parse(localStorage.getItem('ring-predict'))||{}}catch{}
const order=['S','A','B','C','D',''];const mine=[...CARDS].sort((a,b)=>order.indexOf(st[a.id]||'')-order.indexOf(st[b.id]||''));
document.getElementById('v').innerHTML=REAL.map((r,i)=>{const c=CARDS.find(x=>x.id===r.id);const t=st[r.id]||'?';const my=mine.findIndex(x=>x.id===r.id)+1;const hit=st[r.id]&&my===r.place;return '<div class="row a" style="--c:'+c.color+';animation-delay:'+((REAL.length-1-i)*1.6+0.5)+'s"><div class="place">'+r.place+'</div><img src="'+c.img+'"><div class="nm"><b>'+c.name+'</b><i>'+c.model+'</i></div><div class="sh">'+r.share+' %<i>очков в лиге</i></div><div class="my" style="--t:'+(T[t]||'#3a4152')+'"><b>'+t+'</b><i>мой прогноз</i></div><div class="ok">'+(hit?'✓':'')+'</div></div>'}).join('');
</script>`,
    `#v{position:absolute;left:90px;right:90px;top:200px}.row{display:flex;align-items:center;height:${Math.min(150, Math.floor(820 / league.rows.length) - 16)}px;margin-bottom:16px;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 55%,#10131b),#10131b 60%);border-left:12px solid var(--c)}.place{width:130px;text-align:center;font-size:96px;font-weight:800;font-style:italic;text-shadow:0 5px 0 #000}.row img{height:${Math.min(170, Math.floor(820 / league.rows.length))}px;margin:-20px 10px 0;filter:drop-shadow(0 8px 12px #000)}.nm{flex:1}.nm b{display:block;font-size:52px;font-weight:800;text-transform:uppercase;line-height:1}.nm i,.sh i,.my i{display:block;font-style:normal;font-size:21px;color:#c6ccd8;font-weight:400}.sh{width:240px;text-align:right;font-size:58px;font-weight:800;padding-right:30px}.my{width:190px;text-align:center}.my b{display:inline-block;width:92px;line-height:92px;font-size:64px;font-weight:800;font-style:italic;background:var(--t);color:#0a0c12}.ok{width:90px;font-size:70px;color:#7be08f;text-align:center}`);

  // 5. the bracket by steps: who met whom; the winners appear only after their match
  const seed = league.rows.slice(0, 4).map((e) => e.id);
  const M = (i) => (matches[i] && !matches[i].missing && matches[i].over ? matches[i].winner : null);
  const slot = (id, win, d, tbd) => (id ? `<div class="slot a${win ? ' win' : ''}" style="--c:${by[id].color};animation-delay:${d}s"><img src="../${fig(by[id])}"><div><b>${esc(by[id].name)}</b><i>${esc(by[id].model)}</i></div></div>` : `<div class="slot tbd a" style="animation-delay:${d}s">${tbd}</div>`);
  const w = TEST ? [seed[0], seed[1], seed[0]] : [M(0), M(1), M(2)];
  for (let step = 1; step <= 4 && seed.length === 4; step++) {
    const s1 = step >= 2 ? w[0] : null;
    const s2 = step >= 3 ? w[1] : null;
    const ch = step >= 4 ? w[2] : null;
    page(`bracket-${step}`, 'Сетка', `<h1><span>Четыре лучших лиги · до двух побед</span>Сетка</h1>
<div class="cap" style="left:90px;top:176px">Полуфинал 1</div><div class="col" style="left:90px;top:212px">${slot(seed[0], s1 === seed[0], step === 1 ? 0.3 : 0, '')}${slot(seed[3], s1 === seed[3], step === 1 ? 0.7 : 0, '')}</div>
<div class="cap" style="left:90px;top:614px">Полуфинал 2</div><div class="col" style="left:90px;top:650px">${slot(seed[1], s2 === seed[1], step === 1 ? 1.4 : 0, '')}${slot(seed[2], s2 === seed[2], step === 1 ? 1.8 : 0, '')}</div>
<div class="cap" style="left:700px;top:390px">Финал</div><div class="col" style="left:700px;top:430px">${slot(s1, ch && ch === s1, step === 2 ? 0.8 : 0, 'победитель полуфинала 1')}${slot(s2, ch && ch === s2, step === 3 ? 0.8 : 0, 'победитель полуфинала 2')}</div>
<div class="cap" style="left:1310px;top:490px">Чемпион</div><div class="col" style="left:1310px;top:530px">${slot(ch, !!ch, 1.2, 'победитель финала')}</div>`,
      `.col{position:absolute;width:520px}.slot{height:170px;margin-bottom:44px;display:flex;align-items:center;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 55%,#10131b),#10131b 75%);border-left:10px solid var(--c)}.slot img{height:190px;margin:0 10px -6px;align-self:flex-end;filter:drop-shadow(0 6px 10px #000)}.slot b{font-size:40px;font-weight:800;text-transform:uppercase;line-height:1}.slot i{display:block;font-style:normal;font-size:21px;color:#d7dce6}.slot.win{box-shadow:0 0 0 5px #ffd23c}.slot.tbd{--c:#3a4152;color:#8d96a8;justify-content:center;font-size:28px}.cap{position:absolute;font-size:26px;letter-spacing:5px;color:#ffd23c;text-transform:uppercase}`);
  }
}

// ---- the stepper: the whole show in order ----
const items = [...(existsSync(join(P, 'bench-1.html')) ? [['Что вышло', 'p/bench-1.html', 'page'], ...(BN.slides || []).map((S, i) => [S.name, `p/bench-s${String(i + 1).padStart(2, '0')}.html`, 'page']), ['Итог: первая', 'p/bench-2.html', 'page'], ['Итог: не выросла', 'p/bench-3.html', 'page'], ...(BN.videos || []).map(([t, v]) => [t, v, 'video']), ['Что говорят', 'p/bench-4.html', 'page']] : []), ...(existsSync(join(P, 'changes.html')) ? [['Что поменялось', 'p/changes.html', 'page'], ['Полный список', 'p/changelog.html', 'page']] : []), ['Гонка сборки', 'p/race.html', 'page']];
people.forEach((p) => {
  // the assembly from parts with the entrance line (viewer/show/hero.html, the real clock), then the name, the build, the moves
  items.push(['Выход', `/viewer/show/hero.html?id=${p.id}&do=reveal&bg=1&live=1`, 'page'], [p.model, `p/fighter-${p.id}.html`, 'page'], ['Сборка', `p/facts-${p.id}.html`, 'page'], ['Приёмы', `p/kit-${p.id}.html`, 'page']);
});
if (common.length) items.push(['Совпадения', 'p/common.html', 'page']);
items.push(['Мой прогноз', 'p/predict.html', 'page']);
if (league) items.push(['Все со всеми', 'p/league.html', 'page']);
const rounds = (m, label) => (m && !m.missing ? m.rounds.filter((r) => r.video).flatMap((r) => [...((m.lockers || []).some((L) => L.after === r.n - 1) ? [['Раздевалка', `p/locker-${m.id}-${r.n - 1}.html`, 'page']] : []), [`${label} · раунд ${r.n}`, r.video, 'video']]) : []);
if (league && league.rows.length >= 4) {
  items.push(['Сетка', 'p/bracket-1.html', 'page'], ...rounds(matches[0], 'Полуфинал 1'), ['Сетка', 'p/bracket-2.html', 'page'], ...rounds(matches[1], 'Полуфинал 2'), ['Сетка', 'p/bracket-3.html', 'page'], ...rounds(matches[2], 'Финал'), ['Чемпион', 'p/bracket-4.html', 'page'], ['Тир-лист', 'p/tier.html', 'page'], ['Прогноз и результат', 'p/verdict.html', 'page']);
}
if (demoId) {
  const m = json(join(RING, 'matches', demoId, 'match.json'));
  if (m) items.push(...m.rounds.filter((r) => existsSync(join(RING, 'matches', demoId, `round-${r.n}`, 'fight-16x9.mp4'))).map((r) => [`Показательный · раунд ${r.n}`, `/matches/${demoId}/round-${r.n}/fight-16x9.mp4`, 'video']));
}
if (existsSync(join(P, 'awards.html'))) items.push(['Итоги ринга', 'p/awards.html', 'page']);
items.push(['Танчики', tanks, 'page']);
if (SP) items.push(['Кто сколько потратил', 'p/spend.html', 'page']);
writeFileSync(join(OUT, 'index.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)} — показ</title>
<style>*{margin:0;box-sizing:border-box}html,body{height:100%;background:#000;color:#eee;font-family:"Segoe UI",sans-serif;overflow:hidden}
#bar{position:fixed;left:0;right:0;bottom:0;padding:8px 12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:rgba(0,0,0,.82);z-index:2;transition:opacity .4s}
#bar button{background:#1c2029;color:#cfd5e0;border:1px solid #333a48;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer}#bar button.on{background:#ffd23c;color:#000;font-weight:700}#bar button.seen{opacity:.45}
video,iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:#000}video{object-fit:contain}#hint{margin-left:auto;opacity:.6;font-size:12px}</style></head><body>
<div id="bar"></div><video id="v" controls></video><iframe id="f" allow="autoplay; fullscreen" style="display:none"></iframe>
<script>
const ITEMS=${JSON.stringify(items)};let i=Number(location.hash.slice(1))||0;const v=document.getElementById('v'),f=document.getElementById('f'),bar=document.getElementById('bar');
function go(k){i=Math.max(0,Math.min(ITEMS.length-1,k));location.hash=i;const [,src,kind]=ITEMS[i];
 if(kind==='page'){v.pause();v.removeAttribute('src');v.style.display='none';f.style.display='block';f.src=src;setTimeout(()=>window.focus(),300);}else{f.src='about:blank';f.style.display='none';v.style.display='block';v.src=src;v.play().catch(()=>{});}
 [...bar.querySelectorAll('button')].forEach((b,j)=>{b.classList.toggle('on',j===i);b.classList.toggle('seen',j<i);b.style.display=j<=i+1?'':'none';});}
ITEMS.forEach((it,j)=>{const b=document.createElement('button');b.textContent=(j+1)+'. '+it[0];b.onclick=()=>go(j);bar.appendChild(b);});
const h=document.createElement('span');h.id='hint';h.textContent='→ дальше · ← назад · пробел пауза · F экран';bar.appendChild(h);
const key=k=>{if(k==='ArrowRight')go(i+1);else if(k==='ArrowLeft')go(i-1);else if(k==='f'||k==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();}};
document.addEventListener('keydown',e=>{if(e.key===' '&&ITEMS[i][2]==='video'){e.preventDefault();v.paused?v.play():v.pause();}else key(e.key)});addEventListener('message',e=>e.data&&e.data.key&&key(e.data.key));
let t;document.onmousemove=()=>{bar.style.opacity=1;clearTimeout(t);t=setTimeout(()=>bar.style.opacity=0,2500)};go(i);
</script></body></html>`);

// ---- the host's notes: what to say, without a single result ----
writeFileSync(join(OUT, 'cheatsheet.html'), `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)} — шпаргалка</title><style>body{background:#0d0f14;color:#eef1f6;font:19px/1.5 "Segoe UI",sans-serif;max-width:1100px;margin:0 auto;padding:30px}h1{font-size:40px}h2{margin-top:44px;border-left:8px solid var(--c);padding-left:14px}h2 span{color:#8d96a8;font-weight:400;font-size:18px}li{margin:8px 0}.n{color:#8d96a8}details{margin:10px 0}summary{cursor:pointer;color:#ffd23c}code{color:#ffd23c}</style></head><body>
<h1>${esc(title)}: шпаргалка</h1><p class="n">Результатов здесь нет: лигу, сетку и тир-лист ты видишь впервые в показе. Показ: <a href="index.html" style="color:#ffd23c">index.html</a> (→ дальше, F — на весь экран). Шагов: ${items.length}.</p>
${people.map((p) => `<h2 style="--c:${p.color}">${esc(p.name)} <span>${esc(p.model)}</span></h2><p class="n">${Math.round(p.minutes || 0)} минут, ${Math.round(p.brainBytes / 1024)} КБ мозгов${p.usage ? `, ${tok(p.usage.output)} токенов` : ''}. Телосложение: ${Object.entries(STAT).map(([k, ru]) => `${ru.toLowerCase()} ${p.stats[k]}`).join(', ')}. Свои приёмы: ${p.moves.filter((m) => m.slot !== 'normal').map((m) => esc(m.name)).join(', ')}.</p><ul>${p.notes.map((x) => `<li>${md(x)}</li>`).join('')}</ul>${p.words ? `<details><summary>Что модель сама сказала о бойце</summary><p>${md(p.words)}</p></details>` : ''}`).join('')}
</body></html>`);
writeFileSync(join(OUT, 'data.json'), JSON.stringify({ title, test: TEST, people, items }, null, 1));
console.log(`Показ: show/index.html, ${items.length} шагов${TEST ? ' (ТЕСТ: результаты выдуманы)' : ''}. Открыть: http://localhost:4848/show/`);
