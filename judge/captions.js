// Captions over the match reel and notes for the person who voices it. The facts the commentator used to speak
// become short plates on the screen at the key moments (one at a time, at most one every CAPTION_GAP seconds), and
// notes-for-voice.md next to the reel: what happened in every round, what each model changed in the locker room in
// its own words, the best moments with the reel's timecodes and a line on what to say there. A model (claude -p,
// prompts/commentator.md, no tools) words the captions and the notes from the facts; without it the judge words
// them itself.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RING, getContestant } from './contestants.js';
import { loadMatch, matchDir, roundInfo, changes } from './match.js';
import { askModel, commentatorSpend } from './commentator.js';

export const CAPTION_GAP = 7; // seconds from one caption's start to the next
export const CAPTION_SECONDS = 3.6;
const CAPTION_MIN = 2.8; // a caption shorter than this is not shown
const TEXT_MAX = 46;

const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb);
export const tc = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- what can be captioned ----------

// the judge's own wording of a moment of the fight
function momentCaption(x) {
  switch (x.kind) {
    case 'combo': return { text: `Серия из ${x.hits} ударов`, prio: 6 + x.hits * 0.3 };
    case 'comeback': return { text: `Камбэк: отставал на ${x.deficit} % здоровья`, prio: 9 };
    case 'new': return { text: `Новое из раздевалки: «${x.moveName || x.move}»`, prio: 8.5 };
    case 'super': return x.damage ? { text: `Суперприём: ${x.damage} урона`, prio: 5 } : { text: 'Суперприём мимо', prio: 2 };
    case 'last': return { text: 'Нокаут', prio: 7 };
    case 'juicy': return { text: `Самый сочный удар: ${x.damage}${x.counter ? ', контрудар' : ''}`, prio: 4 };
    default: return null;
  }
}

// the side's colour on a plate: the fighter's accent, or the contestant's own colour in a mirror match
function sideColors(m) {
  const accent = {};
  for (const r of m.rounds) for (const cid of [r.left, r.right]) {
    const f = readJSON(join(matchDir(m.id), `round-${r.n}`, cid, 'fighter', 'fighter.json'));
    accent[cid] = f?.colors?.accent || null;
  }
  const mirror = accent[m.red] && accent[m.red] === accent[m.blue];
  return Object.fromEntries([m.red, m.blue].map((cid) => [cid, (mirror ? getContestant(cid).color : accent[cid]) || '#ffc94a']));
}

// What a locker room changed, in plain words (the judge's wording).
export function lockerChanges(id, cid, n) {
  const c = changes(id, cid).find((x) => x.to === n);
  if (!c) return null;
  const list = [...c.stats.map((x) => `характеристики: ${x}`), ...c.moves.map((x) => `приём ${x}`), ...c.abilities.map((x) => `способность ${x}`), ...c.card.map((x) => `карточка: ${x}`)];
  const brain = c.changed.find((f) => f.file === 'brain.js');
  if (brain) {
    const [a, b] = brain.lines.match(/\d+/g) || [];
    list.push(a && a === b ? 'мозги (brain.js) переписаны, строк столько же' : `мозги (brain.js): ${brain.lines}`);
  }
  for (const f of c.changed) if (f.file !== 'brain.js' && !/^(fighter|moves|body)\.json$/.test(f.file)) list.push(`файл ${f.file}`);
  for (const f of c.added) list.push(`новый файл ${f}`);
  return { list, said: c.note?.text || null, brain: !!brain };
}

// Caption candidates on the reel's timeline. pieces: the reel's pieces in order, each with its offset in the reel
// (at) and length (seconds); for a piece cut from a round's clip, its source window (from, to) and the round's
// moment it shows (moment). Returns [{ id, at, latest, prio, text, kicker, color, round, kind, why }].
export function captionCandidates(id, pieces, clipTime) {
  const m = loadMatch(id);
  const colors = sideColors(m);
  const out = [];
  for (const p of pieces) {
    if (p.from === undefined || p.round == null) continue;
    const end = p.at + p.seconds;
    const { r } = roundInfo(m, p.round);
    const st = readJSON(join(matchDir(id), `round-${p.round}`, 'stats.json'));
    if (p.kind === 'board' && p.round > 1) {
      for (const cid of [r.left, r.right]) {
        const ch = lockerChanges(id, cid, p.round);
        if (!ch || (!ch.list.length && !ch.said)) continue;
        const first = ch.brain && ch.list.length === 1 ? 'переписал мозги бойца' : ch.list[0]?.replace(/^характеристики: /, '') || 'доработал бойца';
        out.push({ id: `locker-${p.round}-${cid}`, kind: 'locker', round: p.round, cid, at: p.at + 0.5, latest: end + 4, prio: 10, text: `${m.models[cid]}: ${first}`, kicker: `Раздевалка · раунд ${p.round}`, color: colors[cid], why: { changed: ch.list, said: ch.said }, what: `Раздевалка ${m.models[cid]}, ${first}` });
      }
      continue;
    }
    const x = p.moment;
    if (!x) continue;
    const cid = st.sides[x.side];
    const moveName = x.move && readJSON(join(matchDir(id), `round-${p.round}`, cid, 'fighter', 'moves.json'))?.moves?.find?.((mv) => mv.id === x.move)?.name;
    const c = momentCaption({ ...x, moveName });
    if (!c) continue;
    // the piece is about this moment: a caption reads from a second before it, or from the piece's start when the
    // piece is short, and ends before the cut
    const hit = p.at + (clipTime(p.round, x.at) - p.from);
    const t = Math.max(p.at + 0.4, Math.min(hit - 1, end - CAPTION_SECONDS));
    if (!(hit >= p.at && hit < end + 0.5)) continue;
    out.push({ id: `r${p.round}-${x.kind}-${x.at}`, kind: x.kind, round: p.round, cid, at: t, latest: end - CAPTION_MIN, prio: c.prio + (x.score || 0) * 0.05, text: c.text, kicker: `${st.names[x.side]} · ${m.models[cid]}`, color: colors[cid], why: { moment: x.text } });
  }
  return out;
}

// One caption at a time, starts at least CAPTION_GAP apart, the most telling ones first; equal texts once.
export function scheduleCaptions(cands, total) {
  const placed = [];
  const seen = new Set();
  for (const c of [...cands].sort((a, b) => b.prio - a.prio || a.at - b.at)) {
    if (seen.has(c.text)) continue;
    for (let t = c.at; t <= Math.min(c.latest, c.at + 4); t += 0.5) {
      if (placed.some((p) => Math.abs(p.at - t) < CAPTION_GAP)) continue;
      const seconds = Math.min(CAPTION_SECONDS, total - t, c.latest + CAPTION_MIN - t);
      if (seconds < CAPTION_MIN) break;
      placed.push({ ...c, at: +t.toFixed(2), seconds: +seconds.toFixed(2) });
      seen.add(c.text);
      break;
    }
  }
  return placed.sort((a, b) => a.at - b.at);
}

// ---------- the model's wording ----------

// The model words the captions and the notes from the facts; its answer is kept next to the match and reused
// while the facts stay the same.
export async function wordMatch(id, facts, { model = 'claude-opus-5-5', log = console.log } = {}) {
  const key = createHash('sha1').update(JSON.stringify(facts)).digest('hex').slice(0, 16);
  const cache = join(matchDir(id), 'comment', 'wording.json');
  const had = readJSON(cache);
  if (had?.key === key && had.model === model) return had.answer;
  const tpl = readFileSync(join(RING, 'prompts', 'commentator.md'), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
  const prompt = tpl.replace('{{FACTS}}', JSON.stringify(facts, null, 1)).replace('{{TEXT_MAX}}', String(TEXT_MAX));
  log(`Подписи и шпаргалка: пишет ${model}…`);
  const ans = await askModel(prompt, { model });
  commentatorSpend('modelCalls', 1, `${id} подписи и шпаргалка${ans.cost !== null ? ` $${ans.cost}` : ''}`);
  const j = ans.text.match(/\{[\s\S]*\}/);
  if (!j) throw new Error('модель ответила не JSON-объектом');
  const answer = JSON.parse(j[0]);
  mkdirSync(join(matchDir(id), 'comment'), { recursive: true });
  writeFileSync(cache, JSON.stringify({ key, model, cost: ans.cost, answer }, null, 2) + '\n');
  return answer;
}

// a caption line from the model is used only when it is one short line
const okLine = (s) => typeof s === 'string' && s.trim().length >= 3 && s.trim().length <= TEXT_MAX && !/\n/.test(s);
const clean = (s) => s.trim().replace(/\s+—\s+/g, ': ').replace(/[.]$/, '');

// The facts of the whole match for the model: rounds, locker rooms with the models' own words, the caption
// candidates and the reel's best moments with their timecodes.
export function matchFacts(id, cands, best) {
  const m = loadMatch(id);
  const rounds = m.rounds.map((r) => {
    const { num, rerun, final } = roundInfo(m, r.n);
    const st = readJSON(join(matchDir(id), `round-${r.n}`, 'stats.json'));
    return {
      n: r.n, number: num, rerun, final, stage: r.stage,
      fighters: [r.left, r.right].map((cid, s) => ({ name: st.names[s], model: m.models[cid], side: s ? 'справа' : 'слева' })),
      result: { winner: r.winner ? st.names[[r.left, r.right].indexOf(r.winner)] : 'ничья', how: r.reason === 'ko' ? 'нокаут' : 'по времени', seconds: st.result.seconds },
      counters: Object.fromEntries(st.names.map((nm, s) => [`${nm} (${m.models[[r.left, r.right][s]]})`, st.counters[s]])),
      moments: st.moments.slice().sort((a, b) => b.score - a.score).slice(0, 8).map((x) => x.text),
      locker: r.n === 1 ? [] : [r.left, r.right].map((cid) => ({ model: m.models[cid], fighter: st.names[[r.left, r.right].indexOf(cid)], ...(lockerChanges(id, cid, r.n) || { list: [], said: null }) })).map(({ brain, ...x }) => x),
    };
  });
  return {
    match: { winner: m.winner ? m.models[m.winner] : null, score: Object.fromEntries([m.red, m.blue].map((cid) => [m.models[cid], m.score[cid]])) },
    rounds,
    captions: cands.map((c) => ({ id: c.id, round: c.round, kind: c.kind, draft: c.text, ...c.why })),
    best: best.map((b) => ({ id: b.id, t: tc(b.at), round: b.round, what: b.what })),
  };
}

// The model's wording laid over the judge's: captions by id, round stories, locker summaries, lines for the moments.
export function applyWording(cands, answer) {
  const lines = Object.fromEntries((answer?.captions || []).filter((c) => okLine(c?.text)).map((c) => [c.id, clean(c.text)]));
  return cands.map((c) => (lines[c.id] ? { ...c, text: lines[c.id], worded: true } : c));
}

// ---------- the plates on the video ----------

// Captions as transparent PNGs from viewer/card.html (the game's server at base), laid over the video with a
// short fade and slide. out: the video with captions.
export async function burnCaptions(video, captions, out, { base, browser, aspect = '16:9', dir }) {
  const [w, h] = aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  mkdirSync(dir, { recursive: true });
  const pngs = [];
  for (const [i, c] of captions.entries()) {
    const page = await browser.open(`${base}/viewer/card.html?${new URLSearchParams({ kind: 'caption', text: c.text, kicker: c.kicker || '', color: c.color || '', aspect })}`, { w, h });
    await page.cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await page.evaluate('new Promise((r) => { const t = setInterval(() => window.cardReady && (clearInterval(t), r()), 50); })', { timeout: 30000 });
    const f = join(dir, `caption-${String(i + 1).padStart(2, '0')}-${aspect === '9:16' ? 'v' : 'h'}.png`);
    writeFileSync(f, await page.screenshot());
    await page.close();
    pngs.push(f);
  }
  if (!captions.length) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, '-c', 'copy', out], { stdio: 'ignore' });
    return [];
  }
  const args = ['-y', '-v', 'error', '-i', video];
  const chain = [];
  let last = '0:v';
  captions.forEach((c, i) => {
    const d = c.seconds;
    args.push('-loop', '1', '-t', d.toFixed(2), '-i', pngs[i]);
    chain.push(`[${i + 1}:v]format=rgba,fade=t=in:st=0:d=0.22:alpha=1,fade=t=out:st=${(d - 0.3).toFixed(2)}:d=0.3:alpha=1,setpts=PTS-STARTPTS+${c.at.toFixed(2)}/TB[c${i}]`);
    const x = `'if(lt(t-${c.at.toFixed(2)},0.22),-50*(1-(t-${c.at.toFixed(2)})/0.22),0)'`;
    chain.push(`[${last}][c${i}]overlay=x=${x}:y=0:eof_action=pass:enable='between(t,${c.at.toFixed(2)},${(c.at + d).toFixed(2)})'[v${i}]`);
    last = `v${i}`;
  });
  args.push('-filter_complex', chain.join(';'), '-map', `[${last}]`, '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-crf', '18', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', out);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return pngs;
}

// ---------- the notes ----------

const quote = (t) => t.trim().split('\n').map((l) => `> ${l}`).join('\n');

// notes-for-voice.md: the match for the person who voices the reel.
export function notesMd(id, { reelSeconds, captions, best, answer = null, model = null }) {
  const m = loadMatch(id);
  const stories = Object.fromEntries((answer?.rounds || []).filter((x) => typeof x?.story === 'string').map((x) => [x.n, x.story.trim()]));
  const lockers = Object.fromEntries((answer?.lockers || []).filter((x) => typeof x?.summary === 'string').map((x) => [`${x.round}|${x.model}`, x.summary.trim()]));
  const say = Object.fromEntries((answer?.say || []).filter((x) => typeof x?.say === 'string').map((x) => [x.id, x.say.trim()]));
  const names = (r) => readJSON(join(matchDir(id), `round-${r.n}`, 'stats.json'))?.names || [r.left, r.right];
  const L = [];
  const head = m.rounds[0] ? names(m.rounds[0]) : [];
  L.push(`# Шпаргалка к ролику матча ${id}`, '');
  L.push(`${head[0]} (${m.models[m.rounds[0]?.left]}) против ${head[1]} (${m.models[m.rounds[0]?.right]}). ${m.over ? (m.winner ? `Победил ${m.models[m.winner]}` : 'Ничья') : 'Матч не окончен'}, счёт ${m.score[m.red]} : ${m.score[m.blue]} (${m.models[m.red]} : ${m.models[m.blue]}). Ролик \`match-16x9.mp4\`, ${tc(reelSeconds)}.`, '');
  if (typeof answer?.opening === 'string') L.push(`С чего начать: ${answer.opening.trim()}`, '');
  for (const r of m.rounds) {
    const { num, rerun, wins } = roundInfo(m, r.n);
    // the deciding round: both one win away from the match (1:1 to two wins), not just the last round
    const final = wins[0] === m.firstTo - 1 && wins[1] === m.firstTo - 1;
    const st = readJSON(join(matchDir(id), `round-${r.n}`, 'stats.json'));
    const nm = names(r);
    const who = r.winner ? nm[[r.left, r.right].indexOf(r.winner)] : null;
    L.push(`## Раунд ${num}${rerun ? ', переигровка' : ''}${final ? ', решающий' : ''} (${r.stage})`, '');
    const c = st.counters;
    L.push(`${who ? `Победил ${who} (${m.models[r.winner]}) ${r.reason === 'ko' ? 'нокаутом' : 'по времени'}` : r.reason === 'ko' ? 'Двойной нокаут, ничья' : 'Ничья по времени'} на ${Math.round(st.result.seconds)}-й секунде. Попадания ${c[0].hits} : ${c[1].hits}, урон ${c[0].damage} : ${c[1].damage}, блоки ${c[0].blocks} : ${c[1].blocks}, суперприёмы ${c[0].supers} : ${c[1].supers} (${nm[0]} : ${nm[1]}).`);
    if (stories[r.n]) L.push('', stories[r.n]);
    L.push('');
    // who changed something first, who did not after
    const order = [r.left, r.right].sort((a, b) => !!lockerChanges(id, b, r.n)?.list.length - !!lockerChanges(id, a, r.n)?.list.length);
    if (r.n > 1) for (const cid of order) {
      const ch = lockerChanges(id, cid, r.n);
      L.push(`**Раздевалка ${m.models[cid]} перед этим раундом.**${ch?.list.length ? ` Изменил: ${ch.list.join('; ')}.` : ' Ничего не изменил.'}${lockers[`${r.n}|${m.models[cid]}`] ? ` ${lockers[`${r.n}|${m.models[cid]}`]}` : ''}`, '');
      if (ch?.said) L.push('Своими словами:', '', quote(ch.said), '');
    }
  }
  L.push('## Лучшие моменты', '');
  // the line on what to say comes from the model; in the judge's own words the column would stand empty
  const sayCol = best.some((b) => say[b.id]);
  L.push(sayCol ? '| Таймкод | Что видно | Что тут сказать |' : '| Таймкод | Что видно |', sayCol ? '|---|---|---|' : '|---|---|');
  for (const b of best) L.push(`| ${tc(b.at)} | ${b.what.replace(/\|/g, '/')} |${sayCol ? ` ${(say[b.id] || '').replace(/\|/g, '/')} |` : ''}`);
  L.push('', '## Подписи в ролике', '');
  L.push(captions.length ? 'Эти плашки уже на экране: голосом лучше дополнить, чем повторить.' : 'Подписей в ролике нет.', '');
  for (const c of captions) L.push(`- ${tc(c.at)}–${tc(c.at + c.seconds)} · ${c.text}`);
  L.push('', `Собрано судьёй ринга${model ? `, слова подписей и подсказок: ${model}` : ', без модели: подписи и подсказки словами судьи'}.`, '');
  return L.join('\n');
}

// the reel's best moments for the notes: 5–7 pieces showing the fight's highlights and the locker rooms
export function bestMoments(pieces, cands, clipT = null) {
  // the reel time of the moment itself (its decisive tick), not of the start of its piece
  const momentAt = (p) => (clipT && p.moment && p.from !== undefined ? +(p.at + Math.max(0, clipT(p.round, p.moment.at ?? p.moment.from) - p.from)).toFixed(1) : p.at);
  const lock = cands.filter((c) => c.kind === 'locker').map((c) => ({ id: c.id, at: c.at, round: c.round, what: c.what, score: 9.5, kind: 'locker', cid: c.cid }));
  const fights = pieces.filter((p) => p.moment && p.score).map((p) => ({ id: `r${p.round}-${p.moment.kind}-${p.moment.at}`, at: momentAt(p), round: p.round, what: p.what, score: p.score, kind: p.moment.kind, side: p.moment.side, tick: p.moment.at, from: p.moment.from, to: p.moment.to }));
  const fin = pieces.filter((p) => p.kind === 'final').map((p) => ({ id: 'final', at: p.at, round: p.round, what: p.what, score: 9, kind: 'final' }));
  const all = [...lock, ...fights, ...fin].sort((a, b) => b.score - a.score);
  const seen = new Set();
  const pick = [];
  for (const x of all) {
    if (seen.has(x.what) || pick.length >= 7) continue;
    seen.add(x.what);
    pick.push(x);
  }
  return pick.sort((a, b) => a.at - b.at);
}

// ---------- the match's story for the game ----------

// story.json next to the match: what notes-for-voice.md tells, for the viewer of the game. The words of the model
// that wrote the notes (or the judge's own), round by round; the locker rooms with what changed and the models'
// replies word for word; the best moments with the round's ticks, so the game can replay them. The game reads it
// as it is (judge/gamedata.js), nothing is rebuilt.
export function matchStory(id, { best = [], answer = null, model = null } = {}) {
  const m = loadMatch(id);
  const stories = Object.fromEntries((answer?.rounds || []).filter((x) => typeof x?.story === 'string').map((x) => [x.n, x.story.trim()]));
  const summaries = Object.fromEntries((answer?.lockers || []).filter((x) => typeof x?.summary === 'string').map((x) => [`${x.round}|${x.model}`, x.summary.trim()]));
  const say = Object.fromEntries((answer?.say || []).filter((x) => typeof x?.say === 'string').map((x) => [x.id, x.say.trim()]));
  const rounds = m.rounds.map((r) => {
    const st = readJSON(join(matchDir(id), `round-${r.n}`, 'stats.json'));
    const { num, rerun, final } = roundInfo(m, r.n);
    const lockers = r.n === 1 ? [] : [r.left, r.right].map((cid) => {
      const ch = lockerChanges(id, cid, r.n);
      return { cid, model: m.models[cid], changed: ch?.list || [], said: ch?.said || null, summary: summaries[`${r.n}|${m.models[cid]}`] || null };
    });
    return { n: r.n, num, rerun, final, story: stories[r.n] || judgeStory(m, r, st), by: stories[r.n] ? 'model' : 'judge', lockers };
  });
  const last = m.rounds[m.rounds.length - 1];
  const lastHit = last && readJSON(join(matchDir(id), `round-${last.n}`, 'stats.json'))?.moments?.find((x) => x.kind === 'last');
  return {
    match: id,
    model: answer ? model : null,
    opening: typeof answer?.opening === 'string' ? answer.opening.trim() : judgeOpening(m),
    rounds,
    best: best.filter((b) => b.kind !== 'locker').map((b) => {
      const t = b.kind === 'final' && lastHit ? { kind: 'last', side: lastHit.side, tick: lastHit.at, from: lastHit.from, to: lastHit.to } : {};
      return { id: b.id, round: b.round, kind: b.kind, side: b.side ?? null, tick: b.tick ?? null, from: b.from ?? null, to: b.to ?? null, ...t, what: b.what, say: say[b.id] || null };
    }),
  };
}

function judgeOpening(m) {
  const r = m.rounds[0];
  if (!r) return null;
  const nm = readJSON(join(matchDir(m.id), 'round-1', 'stats.json'))?.names || [r.left, r.right];
  return `${m.models[r.left]} и ${m.models[r.right]} сами собрали бойцов: ${nm[0]} против ${nm[1]}. Дерутся до ${m.firstTo} побед, между раундами каждая модель смотрит запись и дорабатывает своего бойца.`;
}

// the judge's own two sentences about a round, from its numbers
function judgeStory(m, r, st) {
  if (!st) return '';
  const [a, b] = st.names;
  const c = st.counters;
  const s = Math.round(st.result.seconds);
  const w = r.winner ? [r.left, r.right].indexOf(r.winner) : null;
  const head = w === null ? (r.reason === 'ko' ? `Двойной нокаут на ${s}-й секунде: оба бойца упали одновременно.` : `Время вышло, здоровья поровну: ничья.`) : `${st.names[w]} ${r.reason === 'ko' ? `нокаутирует соперника на ${s}-й секунде` : 'берёт раунд по времени'}.`;
  const top = (st.moments || []).filter((x) => x.kind !== 'last').sort((x, y) => y.score - x.score)[0];
  const tail = `Попадания ${c[0].hits} : ${c[1].hits}${c[0].supers + c[1].supers ? `, суперприёмы ${c[0].supers} : ${c[1].supers}` : ''} (${a} : ${b}).`;
  return [head, top ? `${top.text.replace(/\s+—\s+/g, ': ')}.` : null, tail].filter(Boolean).join(' ');
}
