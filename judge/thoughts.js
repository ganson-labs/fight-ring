// «Thoughts» of the fighters for the reel's pop-ups: what each fighter decided at each moment of a round, in short
// human words, read from what it actually did (the round played again on its own engine): a move it started, a
// block it put up, a dash, a jump, a throw, a parry, walking in or away, and why when the situation says it (the
// opponent open after a whiffed move, on the floor, low on health). Only what is seen on screen, nothing guessed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayRound } from './protocol.js';
import { clipTime, readTiming } from './moments.js';

const OPEN = new Set(['staggered', 'landing', 'knockdown', 'getup', 'dizzy']);
const HURT = new Set(['hitstun', 'blockstun', 'juggle', 'knockdown', 'getup', 'grabbed', 'thrown', 'dizzy', 'ko']);
const PRIO = { super: 10, punish: 8, parried: 8, finish: 8, move: 6, throw: 7, parry: 6, guard: 4, dash: 4, jump: 3, walk: 2 };

// One side's decisions over a round from per-tick views: [{ tick, kind, text, prio }]
export function decide(views) {
  const out = [];
  let prev = null;
  let walk = { dir: 0, from: 0, said: false };
  // the same strike again within a second of the last one (a string) is one thought: «Серия: «…»»
  const strike = (t) => t.replace(/^(Бью|Серия): /, '');
  const push = (tick, kind, text) => {
    const last = out[out.length - 1];
    if (kind === 'move' && last?.kind === 'move' && strike(last.text) === strike(text) && tick - last.at < 60) {
      last.text = `Серия: ${strike(text)}`;
      last.at = tick;
      return;
    }
    out.push({ tick, at: tick, kind, text, prio: PRIO[kind] ?? 1 });
  };
  for (const v of views) {
    const { tick, me, op, dist, events } = v;
    const name = (mv) => mv?.name || mv?.id || 'приём';
    if (events.some((e) => e.type === 'parry' && e.side === v.side)) push(tick, 'parried', 'Поймал! Парирование');
    if (prev) {
      const started = me.state === 'move' && (prev.state !== 'move' || prev.move?.id !== me.move?.id || me.move?.t < prev.move?.t);
      if (started) {
        const mv = me.moveDef || me.move;
        const opOpen = OPEN.has(op.state) || (op.state === 'move' && op.move?.phase === 'recovery');
        if (me.move.slot === 'super') push(tick, 'super', `Суперприём «${name(mv)}»!`);
        else if (op.hp / op.maxHp < 0.2 && !HURT.has(op.state)) push(tick, 'finish', `Добиваю: «${name(mv)}»`);
        else if (opOpen) push(tick, 'punish', `Он открылся — «${name(mv)}»`);
        else push(tick, 'move', me.move.slot === 'normal' ? `Бью: «${name(mv)}»` : `«${name(mv)}»`);
      } else if (me.state === 'dash' && prev.state !== 'dash') push(tick, 'dash', me.dashDir > 0 ? 'Рывок к нему' : 'Отскок назад');
      else if (me.state === 'prejump' && prev.state !== 'prejump') push(tick, 'jump', v.act?.jump === 1 ? 'Прыжок на него' : v.act?.jump === -1 ? 'Прыжок назад' : 'Прыжок');
      else if (me.state === 'parry' && prev.state !== 'parry') push(tick, 'parry', op.state === 'move' ? `Ловлю «${name(op.moveDef || op.move)}» на парирование` : 'Жду удар — парирование');
      else if ((me.state === 'throw' || me.state === 'throwing') && prev.state !== 'throw' && prev.state !== 'throwing') push(tick, 'throw', 'Хватаю');
      else if (me.guard && me.guard !== prev.guard && (me.state === 'neutral' || me.state === 'blockstun')) {
        push(tick, 'guard', op.state === 'move' ? `Закрываюсь от «${name(op.moveDef || op.move)}»` : me.guard === 'low' ? 'Держу нижний блок' : 'Держу блок');
      }
    }
    // walking: said once it lasts half a second in one direction
    const dir = me.state === 'neutral' && !me.guard ? Math.sign(me.vx * me.facing) : 0;
    if (dir !== walk.dir) walk = { dir, from: tick, said: false };
    else if (dir && !walk.said && tick - walk.from >= 30) {
      walk.said = true;
      push(walk.from, 'walk', dir > 0 ? (dist > 260 ? 'Сближаюсь' : 'Давлю, иду вперёд') : 'Отхожу, держу дистанцию');
    }
    prev = me;
  }
  return out.map(({ at, ...t }) => t);
}

// Fewer, stronger pop-ups for a video: one at a time per side, at least `gap` ticks apart, the stronger one wins.
export function keyThoughts(list, gap = 75) {
  const kept = [];
  for (const t of [...list].sort((a, b) => b.prio - a.prio || a.tick - b.tick)) {
    if (t.prio < 4) continue;
    if (kept.some((k) => k.side === t.side && Math.abs(k.tick - t.tick) < gap)) continue;
    kept.push(t);
  }
  return kept.sort((a, b) => a.tick - b.tick);
}

// The thoughts of both fighters in round r of a match folder; seconds on the round's 16:9 clip when it has a
// timing file (timingFile, default round-N/fight-16x9.timing.json).
export async function roundThoughts(dir, r, { timingFile = null } = {}) {
  const views = [[], []];
  const names = [];
  await replayRound(dir, r, (fight, acts, ev, E) => {
    const dist = Math.abs(fight.f[0].x - fight.f[1].x);
    for (let s = 0; s < 2; s++) {
      const V = E.brainView(fight, s);
      const F = fight.f[s];
      const me = { ...V.me, vx: F.vx, facing: F.facing, dashDir: F.dashDir, moveDef: F.state === 'move' ? F.move.def : null };
      const O = fight.f[1 - s];
      const op = { ...V.opponent, moveDef: O.state === 'move' ? O.move.def : null };
      views[s].push({ tick: fight.tick, side: s, me, op, dist, events: ev, act: acts?.[s] || null });
    }
    if (!names.length) names.push(...fight.f.map((F) => F.def.card.name));
  });
  const timing = readTiming(timingFile || join(dir, `round-${r.n}`, 'fight-16x9.timing.json'));
  const cids = [r.left, r.right];
  const all = [];
  for (let s = 0; s < 2; s++) {
    for (const t of decide(views[s])) all.push({ ...t, side: s, cid: cids[s], fighter: names[s], seconds: timing ? clipTime(timing, t.tick) : +(t.tick / 60).toFixed(2) });
  }
  all.sort((a, b) => a.tick - b.tick || a.side - b.side);
  return all;
}

const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

// subtitles of one side's thoughts, each shown until the next one or for `hold` seconds
export function thoughtsSrt(list, hold = 1.4) {
  return list.map((t, i) => {
    const next = list[i + 1];
    const end = Math.min(t.seconds + hold, next ? next.seconds - 0.05 : t.seconds + hold);
    return `${i + 1}\n${srtTime(t.seconds)} --> ${srtTime(Math.max(t.seconds + 0.4, end))}\n${t.text}\n`;
  }).join('\n');
}

export const readJSONFile = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
