// The match reel, assembled by the judge from its own recordings: the VS of round 1, the best moments of every
// round (supers, the last blow, the longest combo, a comeback, the first use of what a locker room added),
// the locker rooms as "before and after" cards, the round's stats card, the final with the knockout replay. The
// sound is the game's own: the reel is voiced by a person (the voiced commentary only with `comment`). Captions
// (judge/captions.js) mark the key moments on the screen, notes-for-voice.md tells the match for the voice-over.
// Plus 2–3 shorts 9:16 of 20–40 s and a folder for the montage: every piece apart (without captions),
// moments.json and moments.md with the timecodes.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { RING } from './contestants.js';
import { loadMatch, matchDir, roundInfo, changes } from './match.js';
import { matchStats, pickMoments, clipTime, readTiming } from './moments.js';
import { renderRound } from './render.js';
import { launch } from '../kit/arena/tools/browser.js';
import { captionCandidates, scheduleCaptions, matchFacts, wordMatch, applyWording, burnCaptions, notesMd, bestMoments, matchStory } from './captions.js';

const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb);
// every encode has a deadline: a stuck ffmpeg fails the step instead of holding the reel forever
const ff = (args, timeout = 600000) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout, killSignal: 'SIGKILL' });
const SOUNDS = join(RING, 'kit', 'arena', 'sounds');

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

// the game's server for the cards (they read /api/game), on a free port for the time of the reel
export async function withServer(fn) {
  const port = await freePort();
  const p = spawn(process.execPath, ['serve.mjs', '--port', String(port)], { cwd: RING, stdio: 'ignore', windowsHide: true });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://localhost:${port}/api/game`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return await fn(`http://localhost:${port}`);
  } finally {
    p.kill();
  }
}

// The sounds of a screen between rounds (viewer/game/screens.js → SCREEN_SOUNDS, the game plays the same)
const SCREEN_SOUNDS = {
  round: [['vs-whoosh', 0, 0.55], ['vs-impact', 0.22, 0.8], ['crowd-1', 0.3, 0.35]],
  locker: [['vs-whoosh', 0, 0.55], ['vs-impact', 0.2, 0.6], ['sparkle', 0.7, 0.5]],
};

// A screen between rounds as a clip: viewer/card.html holds the screen still (rec=1) and steps it frame by frame
// (window.cardSeek), so its animations land in the video as they play in the game; the ring's sounds on top.
// png: one late frame of it (for the montage list).
export async function screenClip(base, browser, query, out, png, seconds, aspect, tmp, fps = 60) {
  const [w, h] = aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  const page = await browser.open(`${base}/viewer/card.html?${new URLSearchParams({ ...query, aspect, rec: '1' })}`, { w, h });
  const frames = join(tmp, `frames-${Date.now()}`);
  mkdirSync(frames, { recursive: true });
  try {
    await page.evaluate('new Promise((r) => { const t = setInterval(() => window.cardReady && (clearInterval(t), r()), 50); })', { timeout: 30000 });
    const n = Math.round(seconds * fps);
    for (let i = 0; i < n; i++) {
      await page.evaluate(`window.cardSeek(${(i / fps).toFixed(4)})`);
      writeFileSync(join(frames, `${String(i).padStart(4, '0')}.jpg`), await page.screenshot({ format: 'jpeg', quality: 94 }));
    }
    await page.evaluate(`window.cardSeek(${Math.min(seconds - 0.5, 4.5)})`);
    writeFileSync(png, await page.screenshot());
  } finally {
    await page.close();
  }
  const snd = SCREEN_SOUNDS[query.kind] || SCREEN_SOUNDS.round;
  const ins = snd.flatMap(([name]) => ['-i', join(SOUNDS, `${name}.ogg`)]);
  const mix = snd.map(([, at, gain], i) => `[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${gain},adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[s${i}]`).join(';');
  const args = ['-framerate', String(fps), '-i', join(frames, '%04d.jpg'), ...ins, '-filter_complex', `${mix};${snd.map((_, i) => `[s${i}]`).join('')}amix=inputs=${snd.length}:normalize=0:duration=longest,apad=whole_dur=${seconds},atrim=0:${seconds},afade=t=out:st=${seconds - 0.5}:d=0.5[a];[0:v]scale=${w}:${h}:out_range=tv,format=yuv420p[v]`, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-t', String(seconds), '-shortest', out];
  // a few seconds of frames encode in seconds; a stuck encoder is tried once more
  try {
    ff(args, 120000);
  } catch {
    ff(args, 240000);
  }
  rmSync(frames, { recursive: true, force: true });
}

// a frame of a round's clip as a picture (the blurred background of a screen between rounds)
export function frameAt(src, t, out) {
  ff(['-ss', Math.max(0, t).toFixed(2), '-i', src, '-frames:v', '1', '-q:v', '3', out]);
  return out;
}

// a piece of a round's clip, same format for every piece; zoom > 1 crops in towards the centre
export function cutClip(src, from, to, out, aspect, { zoom = 1, track = 0, fps = 60 } = {}) {
  const [w, h] = aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  const d = Math.max(0.5, to - from);
  const vf = `${zoom > 1 ? `crop=iw/${zoom}:ih/${zoom},` : ''}scale=${w}:${h}:out_range=tv,fps=${fps},format=yuv420p`;
  ff(['-ss', from.toFixed(2), '-t', d.toFixed(2), '-i', src, '-map', '0:v', '-map', `0:a:${track}`, '-vf', vf, '-af', `aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.12,afade=t=out:st=${Math.max(0, d - 0.25).toFixed(2)}:d=0.25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', out]);
  return d;
}

function concat(files, out) {
  const list = out.replace(/\.mp4$/, '.txt');
  writeFileSync(list, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  rmSync(list);
}

// did the contestant change its fighter in the locker room before round n
function changedBefore(id, cid, n) {
  const c = changes(id, cid).find((x) => x.to === n);
  return !!c && (c.stats.length || c.moves.length || c.abilities.length || c.card.length || c.changed.length || c.added.length || c.removed.length);
}

export const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()) || 0;
const tc = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// captions: plates on the screen (true) or not; comment: the rounds' voiced commentary (match comment) in the sound;
// model: who words the captions and the notes (null — the judge's own words).
export async function buildReel(id, { log = console.log, studio = false, shorts = 3, captions = true, comment = false, model = 'claude-opus-5-5' } = {}) {
  const m = loadMatch(id);
  if (!m.rounds.length) throw new Error('в матче нет раундов');
  const stats = await matchStats(id);
  const dir = join(matchDir(id), 'reel');
  const pieces = join(dir, 'pieces');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(pieces, { recursive: true });
  // the clips of every round, 16:9 and 9:16, with their timing (rendered now if missing)
  const clip = {};
  for (const r of m.rounds) {
    const rd = join(matchDir(id), `round-${r.n}`);
    for (const [aspect, name, vertical] of [['16:9', 'fight-16x9', false], ['9:16', 'fight-9x16', true]]) {
      if (!existsSync(join(rd, `${name}.mp4`)) || !existsSync(join(rd, `${name}.timing.json`))) await renderRound(id, r.n, { vertical, log });
      // the voiced commentary only when asked for: the second audio track of the -comment clip
      const withComment = join(rd, `${name}-comment.mp4`);
      const use = comment && existsSync(withComment);
      if (comment && !use) log(`  раунд ${r.n} ${aspect}: озвучки нет (node ring.mjs match comment ${id} --round ${r.n}), звук игры`);
      clip[`${r.n}|${aspect}`] = { file: use ? withComment : join(rd, `${name}.mp4`), track: use ? 1 : 0, timing: readTiming(join(rd, `${name}.timing.json`)), comment: use };
    }
  }
  const phaseAt = (t, k, last = false) => {
    const code = t.phases.indexOf(k);
    const i = last ? t.phase.lastIndexOf(code) : t.phase.indexOf(code);
    return i < 0 ? null : i / t.fps;
  };
  const moments = [];
  let seq = 0;
  const piece = (name) => join(pieces, `${String(++seq).padStart(2, '0')}-${name}.mp4`);
  const addPiece = (p) => {
    moments.push(p);
    return p.file;
  };
  return withServer(async (base) => {
    const browser = await launch({ width: 1920, height: 1080 });
    try {
      // the background of a screen: a picture of the round (the result: its own round; the locker room: the round
      // it leads to), served next to the reel
      const bgOf = (query, aspect) => {
        const n = query.round;
        const c = clip[`${n}|${aspect}`];
        if (!c) return null;
        // the middle of the fight: the stage with both fighters, no plates of the show over it
        const f0 = phaseAt(c.timing, 'fight') ?? 0;
        const f1 = phaseAt(c.timing, 'fight', true) ?? c.timing.ticks.length / c.timing.fps;
        const t = f0 + (f1 - f0) * (query.kind === 'locker' ? 0.3 : 0.6);
        const name = `bg-${query.kind}-${n}-${aspect === '9:16' ? 'v' : 'h'}.jpg`;
        if (!existsSync(join(pieces, name))) frameAt(c.file, t, join(pieces, name));
        return `/matches/${id}/reel/pieces/${name}`;
      };
      const card = async (query, aspect, name, seconds, what) => {
        const png = join(pieces, `card-${name}-${aspect === '9:16' ? 'v' : 'h'}.png`);
        const f = piece(`${name}-${aspect === '9:16' ? '9x16' : '16x9'}`);
        const bg = bgOf(query, aspect);
        await screenClip(base, browser, { ...query, ...(bg ? { bg } : {}) }, f, png, seconds, aspect, pieces);
        return { file: f, png, kind: 'card', what, seconds };
      };
      // ---------- the match, 16:9 ----------
      const main = [];
      for (const r of m.rounds) {
        const { final } = roundInfo(m, r.n);
        const c = clip[`${r.n}|16:9`];
        const t = c.timing;
        const st = readJSON(join(matchDir(id), `round-${r.n}`, 'stats.json'));
        const fightAt = phaseAt(t, 'fight') ?? 0;
        if (r.n === 1) {
          const f = piece('vs-16x9');
          cutClip(c.file, 0, fightAt + 1.2, f, '16:9', { track: c.track });
          main.push(addPiece({ file: f, round: 1, kind: 'vs', from: 0, to: fightAt + 1.2, what: 'VS и начало первого раунда' }));
        } else {
          // locker rooms before this round: a card for each side that changed something
          for (const x of stats.lockers.filter((l) => l.to === r.n && changedBefore(id, l.cid, r.n))) {
            const k = await card({ match: id, kind: 'locker', round: r.n, cid: x.cid }, '16:9', `locker-${r.n}-${x.cid}`, 6.5, `Раздевалка перед раундом ${r.n}: ${x.cid}`);
            main.push(addPiece({ ...k, round: r.n }));
          }
          const boardAt = phaseAt(t, 'board') ?? Math.max(0, fightAt - 2.5);
          const f = piece(`board-${r.n}-16x9`);
          cutClip(c.file, boardAt, fightAt + 1, f, '16:9', { track: c.track });
          main.push(addPiece({ file: f, round: r.n, kind: 'board', from: boardAt, to: fightAt + 1, what: `Табло раунда ${r.n}` }));
        }
        const best = pickMoments(st.moments, 3).filter((x) => !(final && x.kind === 'last')).sort((x, y) => x.from - y.from);
        // pieces of one round never overlap: in a short round the moments sit close and a piece repeated its neighbour
        let cursor = moments.filter((p) => !p.short && p.round === r.n && p.to !== undefined).reduce((a, p) => Math.max(a, p.to), 0);
        for (const x of best) {
          const a = Math.max(0, clipTime(t, x.from) - 0.3, cursor);
          const b = clipTime(t, x.to) + 0.3;
          if (b - a < 1) continue;
          cursor = b;
          const f = piece(`r${r.n}-${x.kind}-16x9`);
          cutClip(c.file, a, b, f, '16:9', { track: c.track });
          main.push(addPiece({ file: f, round: r.n, kind: x.kind, from: a, to: b, score: x.score, what: x.text, moment: x }));
        }
        if (final) {
          // the knockout replay and the winner of the match, to the end of the clip
          const a = (phaseAt(t, 'after') ?? phaseAt(t, 'replay') ?? t.ticks.length / t.fps - 8) - 1.5;
          const f = piece(`final-16x9`);
          const d = cutClip(c.file, a, t.ticks.length / t.fps, f, '16:9', { track: c.track });
          main.push(addPiece({ file: f, round: r.n, kind: 'final', from: a, to: a + d, what: 'Последний удар, повтор нокаута и победитель матча' }));
        } else {
          const k = await card({ match: id, kind: 'round', round: r.n }, '16:9', `round-${r.n}`, 5.5, `Итог раунда ${r.n}`);
          main.push(addPiece({ ...k, round: r.n }));
        }
      }
      const reel = join(dir, 'match-16x9.mp4');
      const cleanOf = (f) => (captions ? f.replace(/\.mp4$/, '-clean.mp4') : f);
      concat(main, cleanOf(reel));
      // ---------- shorts, 9:16 ----------
      const all = stats.rounds.flatMap((st) => readJSON(join(matchDir(id), `round-${st.n}`, 'stats.json')).moments.map((x) => ({ ...x, round: st.n })));
      const plans = [];
      const top = pickMoments([...all].sort((a, b) => b.score - a.score).map((x) => ({ ...x, from: x.from + x.round * 1e6, to: x.to + x.round * 1e6 })), 3).map((x) => ({ ...x, from: x.from - x.round * 1e6, to: x.to - x.round * 1e6 }));
      plans.push({ name: 'short-1-best', what: 'Лучшие моменты матча', parts: top.map((x) => ({ moment: x })) });
      const last = m.rounds[m.rounds.length - 1];
      const lastSt = readJSON(join(matchDir(id), `round-${last.n}`, 'stats.json'));
      plans.push({ name: 'short-2-decider', what: `Раунд ${last.n}${roundInfo(m, last.n).final ? ' и победа в матче' : ''}`, parts: [{ board: last.n }, ...pickMoments(lastSt.moments, 2).map((x) => ({ moment: { ...x, round: last.n } })), { card: { kind: 'round', round: last.n } }] });
      const fresh = all.filter((x) => x.kind === 'new');
      const lk = stats.lockers.filter((l) => changedBefore(id, l.cid, l.to)).find((l) => fresh.some((x) => x.round === l.to && readJSON(join(matchDir(id), `round-${l.to}`, 'stats.json')).sides[x.side] === l.cid)) || stats.lockers.find((l) => changedBefore(id, l.cid, l.to));
      if (lk) plans.push({ name: 'short-3-locker', what: `Раздевалка: что изменил ${lk.cid} и помогло ли`, parts: [{ card: { kind: 'locker', round: lk.to, cid: lk.cid } }, ...pickMoments(all.filter((x) => x.round === lk.to && (x.kind === 'new' || x.kind === 'super' || x.kind === 'last')), 2).map((x) => ({ moment: x }))] });
      const made = [];
      for (const plan of plans.slice(0, shorts)) {
        const files = [];
        let total = 0;
        // moments share what the fixed parts leave of ~26 s, each at least 6 s and at most 12 s
        const fixed = plan.parts.reduce((a, p) => a + (p.card ? (p.card.kind === 'locker' ? 6 : 5) : p.board ? 3.5 : 0), 0);
        const nm = plan.parts.filter((p) => p.moment).length || 1;
        const each = Math.max(6, Math.min(12, (26 - fixed) / nm));
        for (const p of plan.parts) {
          if (total > 38) break;
          if (p.moment) {
            const x = p.moment;
            const c = clip[`${x.round}|9:16`];
            let a = Math.max(0, clipTime(c.timing, x.from) - 0.4);
            let b = clipTime(c.timing, x.to) + 0.4;
            // a short needs room: a thin moment grows to its share, mostly by what led to it
            if (b - a < each) {
              a = Math.max(0, a - (each - (b - a)) * 0.7);
              b = a + each;
            }
            const f = piece(`${plan.name}-r${x.round}-${x.kind}-9x16`);
            total += cutClip(c.file, a, b, f, '9:16', { zoom: 1.08, track: c.track });
            files.push(addPiece({ file: f, round: x.round, kind: x.kind, from: a, to: b, short: plan.name, what: x.text, score: x.score, moment: x }));
          } else if (p.board) {
            const c = clip[`${p.board}|9:16`];
            const fa = phaseAt(c.timing, 'fight') ?? 0;
            const ba = phaseAt(c.timing, 'board') ?? Math.max(0, fa - 2.5);
            const f = piece(`${plan.name}-board-9x16`);
            total += cutClip(c.file, ba, fa + 0.8, f, '9:16', { track: c.track });
            files.push(addPiece({ file: f, round: p.board, kind: 'board', from: ba, to: fa + 0.8, short: plan.name, what: `Табло раунда ${p.board}` }));
          } else if (p.card) {
            const k = await card({ match: id, ...p.card }, '9:16', `${plan.name}-${p.card.kind}`, p.card.kind === 'locker' ? 6 : 5, p.card.kind === 'locker' ? `Раздевалка: ${p.card.cid}` : `Итог раунда ${p.card.round}`);
            total += k.seconds;
            files.push(addPiece({ ...k, round: p.card.round, short: plan.name }));
          }
        }
        if (total < 20 || !files.length) {
          log(`  шортс ${plan.name}: ${total.toFixed(1)} с — короче 20 с, пропускаю`);
          continue;
        }
        const out = join(dir, `${plan.name}-9x16.mp4`);
        concat(files, cleanOf(out));
        made.push({ file: out, name: plan.name, what: plan.what, seconds: +dur(cleanOf(out)).toFixed(1) });
      }
      // ---------- captions and the notes for the voice-over ----------
      const timeOf = (aspect) => (round, tick) => clipTime(clip[`${round}|${aspect}`].timing, tick);
      // each piece's place in its video
      const laid = (list) => {
        let at = 0;
        return list.map((p) => {
          const seconds = dur(p.file);
          const q = { ...p, at, seconds };
          at += seconds;
          return q;
        });
      };
      const mainLaid = laid(moments.filter((p) => !p.short));
      const reelSeconds = mainLaid.reduce((a, p) => a + p.seconds, 0);
      const shortLaid = made.map((x) => laid(moments.filter((p) => p.short === x.name)));
      let cands = captionCandidates(id, mainLaid, timeOf('16:9'));
      const shortCands = shortLaid.map((list) => captionCandidates(id, list, timeOf('9:16')));
      const best = bestMoments(mainLaid, cands, timeOf('16:9'));
      let answer = null;
      if (model) {
        const all = [...new Map([...cands, ...shortCands.flat()].map((c) => [c.id, c])).values()];
        try {
          answer = await wordMatch(id, matchFacts(id, all, best), { model, log });
        } catch (e) {
          log(`  ! подписи и шпаргалка без модели: ${e.message}`);
        }
      }
      cands = applyWording(cands, answer);
      const shown = { main: captions ? scheduleCaptions(cands, reelSeconds) : [], shorts: {} };
      if (captions) {
        await burnCaptions(cleanOf(reel), shown.main, reel, { base, browser, aspect: '16:9', dir: pieces });
        for (const [i, x] of made.entries()) {
          shown.shorts[x.name] = scheduleCaptions(applyWording(shortCands[i], answer), x.seconds);
          await burnCaptions(cleanOf(x.file), shown.shorts[x.name], x.file, { base, browser, aspect: '9:16', dir: pieces });
        }
      }
      log(`Ролик матча: ${reel} (${dur(reel).toFixed(1)} с${captions ? `, подписей ${shown.main.length}` : ''})`);
      for (const x of made) log(`Шортс: ${x.file} (${x.seconds} с${captions ? `, подписей ${shown.shorts[x.name].length}` : ''}) — ${x.what}`);
      const bare = (list) => list.map(({ why, prio, latest, ...c }) => c);
      writeFileSync(join(dir, 'captions.json'), JSON.stringify({ model: answer ? model : null, reel: bare(shown.main), shorts: Object.fromEntries(Object.entries(shown.shorts).map(([k, v]) => [k, bare(v)])) }, null, 1) + '\n');
      const notes = join(dir, 'notes-for-voice.md');
      writeFileSync(notes, notesMd(id, { reelSeconds, captions: shown.main, best, answer, model: answer ? model : null }));
      log(`Шпаргалка: ${notes}`);
      // the same story for the game's «История» tab, read as it is
      writeFileSync(join(matchDir(id), 'story.json'), JSON.stringify(matchStory(id, { best, answer, model: answer ? model : null }), null, 1) + '\n');
      // ---------- the montage folder ----------
      const rel = (f) => f.slice(dir.length + 1).replace(/\\/g, '/');
      const list = moments.map((p) => ({ file: rel(p.file), round: p.round ?? null, kind: p.kind, what: p.what, ...(p.from !== undefined ? { from: +p.from.toFixed(2), to: +p.to.toFixed(2), source: `round-${p.round}/${p.short ? 'fight-9x16' : 'fight-16x9'}${clip[`${p.round}|${p.short ? '9:16' : '16:9'}`]?.comment ? '-comment' : ''}.mp4` } : {}), ...(p.short ? { short: p.short } : {}), ...(p.score ? { score: +p.score.toFixed(1) } : {}), ...(p.png ? { png: rel(p.png) } : {}) }));
      writeFileSync(join(dir, 'moments.json'), JSON.stringify({ match: id, reel: 'match-16x9.mp4', ...(captions ? { clean: 'match-16x9-clean.mp4' } : {}), notes: 'notes-for-voice.md', shorts: made.map((x) => ({ ...x, file: rel(x.file) })), pieces: list }, null, 1) + '\n');
      const md = [`# Матч ${id}: моменты для монтажа`, '', `Ролик матча: \`match-16x9.mp4\` (${dur(reel).toFixed(1)} с)${captions ? ', без подписей — `match-16x9-clean.mp4`' : ''}. Шортсы: ${made.map((x) => `\`${rel(x.file)}\` (${x.seconds} с, ${x.what})`).join('; ') || 'нет'}. Шпаргалка для озвучки: \`notes-for-voice.md\`.`, '', 'Каждый кусок лежит в `pieces/` без подписей; время — секунды исходного ролика раунда (`from`–`to`).', ''];
      for (const p of list) md.push(`- \`${p.file}\`${p.round ? ` · раунд ${p.round}` : ''}${p.from !== undefined ? ` · ${tc(p.from)}–${tc(p.to)} из \`${p.source}\`` : ''}${p.short ? ` · для ${p.short}` : ''} — ${p.what}`);
      writeFileSync(join(dir, 'moments.md'), md.join('\n') + '\n');
      let studioId = null;
      if (studio) studioId = toStudio(id, reel, made.map((x) => x.file), dir, log, typeof studio === 'string' ? studio : 'ring');
      return { reel, shorts: made, dir, studio: studioId };
    } finally {
      await browser.close();
    }
  });
}

// The reel as a video of the author's own montage program (vagent, not part of this repository): a new video with the reel, the shorts and the montage list as its
// materials. Returns the Studio's id of the video.
export function toStudio(id, reel, shorts, dir, log = console.log, project = 'ring') {
  const run = (args) => execFileSync('vagent', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  // the ring's own project in the Studio, made once
  if (!run(['project', 'list']).split('\n').some((l) => l.startsWith(`${project} `))) run(['project', 'new', project, '--name', '"Ринг моделей"']);
  const before = new Set(studioVideos(run));
  const out = run(['video', 'new', '--kind', 'long', '--project', project, '--title', `"Ринг моделей: матч ${id}"`]);
  // the new video's id: the one the list did not have before (the answer's wording may change)
  const vid = studioVideos(run).find((v) => !before.has(v)) || (out.match(/\b(\d{4}-\d{2}-\d{2}-[a-z0-9-]+|[a-z]+-\d{3,}[a-z0-9-]*)\b/i) || [])[1];
  if (!vid) throw new Error(`программа монтажа не назвала id ролика: ${out.slice(0, 300)}`);
  run(['video', 'add', vid, `"${reel}"`, ...shorts.map((f) => `"${f}"`), '--as', 'recording', '--what', '"Ролик матча и шортсы, собраны судьёй ринга"']);
  run(['video', 'add', vid, `"${join(dir, 'moments.md')}"`, '--as', 'note', '--what', '"Моменты матча с таймкодами"']);
  log(`В программе монтажа: ролик ${vid} (проект ${project})`);
  return vid;
}

// ids of the Studio's videos (the first word of each line of `vagent video list`)
function studioVideos(run) {
  return run(['video', 'list']).split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((x) => x && /^[\w-]+$/.test(x));
}
