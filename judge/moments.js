// What happened in a recorded round, for the show: the health of both by time, counters, and the moments worth
// showing again — supers, the last blow, the longest combo, a comeback by the health graph, the first use of a
// move or ability that the locker room added, the juiciest single hit. Ticks are the fight's own (60 per second);
// clipTime() turns them into seconds of a rendered clip by its timing file.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TICK_RATE } from '../kit/arena/engine/index.js';

const S = TICK_RATE;
const sec = (t) => +(t / S).toFixed(2);

// an: analyze() of judge/match.js; fighters: the two compiled fighters (left, right); prevMoves: for each side the
// move ids of its previous version (null — no previous round)
export function roundStats(an, fighters, { prevMoves = [null, null] } = {}) {
  const { samples, events, result } = an;
  const maxHp = result.maxHp;
  // health by time, every quarter second
  const hp = [];
  for (let i = 0; i < samples.length; i += 15) {
    const s = samples[i];
    hp.push([sec(s[0]), +(s[5] / maxHp[0]).toFixed(3), +(s[12] / maxHp[1]).toFixed(3)]);
  }
  const last = samples[samples.length - 1];
  if (last) hp.push([sec(last[0]), +(last[5] / maxHp[0]).toFixed(3), +(last[12] / maxHp[1]).toFixed(3)]);
  const hits = events.filter((e) => e.type === 'hit');
  const counters = [0, 1].map((s) => {
    const mine = hits.filter((e) => e.attacker === s);
    return {
      hits: mine.length,
      damage: mine.reduce((a, e) => a + e.damage, 0) + events.filter((e) => e.type === 'dot' && e.from === s).reduce((a, e) => a + (e.damage || 0), 0),
      blocks: events.filter((e) => e.type === 'block' && e.side === s).length,
      parries: events.filter((e) => e.type === 'parry' && e.side === s).length,
      throws: events.filter((e) => e.type === 'throw' && e.side === s).length,
      supers: events.filter((e) => e.type === 'super' && e.side === s).length,
      abilityDamage: mine.filter((e) => e.ability).reduce((a, e) => a + e.damage, 0) + events.filter((e) => e.type === 'dot' && e.from === s).reduce((a, e) => a + (e.damage || 0), 0),
      maxCombo: Math.max(0, ...mine.map((e) => e.combo || 0)),
      knockdowns: events.filter((e) => e.type === 'knockdown' && e.side === 1 - s).length,
    };
  });
  const name = (s, id) => fighters[s].movesById[id]?.name || id;
  const end = result.ticks;
  const moments = [];
  const add = (m) => moments.push({ ...m, from: Math.max(0, m.from), to: Math.min(end + 90, m.to), at: m.at ?? m.from });
  // supers: from the freeze to the last hit of that move
  for (const e of events.filter((x) => x.type === 'super')) {
    const mine = hits.filter((h) => h.attacker === e.side && h.move === e.move && h.tick >= e.tick && h.tick < e.tick + 360);
    const dmg = mine.reduce((a, h) => a + h.damage, 0);
    add({ kind: 'super', side: e.side, at: e.tick, from: e.tick - 30, to: (mine.length ? mine[mine.length - 1].tick : e.tick + 120) + 50, score: 8 + (dmg ? 3 : 0), move: e.move, damage: dmg, text: `${fighters[e.side].card.name}: суперприём «${name(e.side, e.move)}»${dmg ? `, ${dmg} урона` : ', мимо'}` });
  }
  // the last blow of the round
  const lastHit = hits[hits.length - 1];
  if (lastHit) add({ kind: 'last', side: lastHit.attacker, at: lastHit.tick, from: lastHit.tick - 120, to: lastHit.tick + 75, score: result.reason === 'ko' ? 10 : 5, move: lastHit.move, damage: lastHit.damage, text: `${result.reason === 'ko' ? 'Нокаутирующий удар' : 'Последний удар раунда'}: ${fighters[lastHit.attacker].card.name}, «${name(lastHit.attacker, lastHit.move)}» (${lastHit.damage})` });
  // the longest combo of each side
  for (let s = 0; s < 2; s++) {
    let best = null;
    let cur = [];
    for (const h of hits.filter((x) => x.attacker === s)) {
      if (h.combo > 1 && cur.length && h.tick - cur[cur.length - 1].tick < 90) cur.push(h);
      else cur = [h];
      if (!best || cur.length > best.length) best = [...cur];
    }
    if (best && best.length >= 3) {
      const dmg = best.reduce((a, h) => a + h.damage, 0);
      add({ kind: 'combo', side: s, at: best[0].tick, from: best[0].tick - 45, to: best[best.length - 1].tick + 45, score: 3 + best.length * 1.2, hits: best.length, damage: dmg, text: `${fighters[s].card.name}: серия из ${best.length} ударов, ${dmg} урона` });
    }
  }
  // comeback: the side that was behind by a third of the health or more and came back (won or retook the lead)
  {
    let worst = [0, 0];
    let worstAt = [0, 0];
    for (const p of hp) {
      const lead = p[1] - p[2];
      if (-lead > worst[0]) [worst[0], worstAt[0]] = [-lead, p[0]];
      if (lead > worst[1]) [worst[1], worstAt[1]] = [lead, p[0]];
    }
    for (let s = 0; s < 2; s++) {
      if (worst[s] < 0.3) continue;
      const after = hp.filter((p) => p[0] > worstAt[s]);
      const back = after.find((p) => (s === 0 ? p[1] - p[2] : p[2] - p[1]) > 0);
      if (!back && result.winner !== s) continue;
      const t0 = Math.round(worstAt[s] * S);
      const t1 = back ? Math.round(back[0] * S) : end;
      add({ kind: 'comeback', side: s, at: t0, from: t0 - 60, to: Math.min(t1 + 120, t0 + 900), score: 9, deficit: Math.round(worst[s] * 100), text: `${fighters[s].card.name}: камбэк — отставал на ${Math.round(worst[s] * 100)} % здоровья${result.winner === s ? ' и выиграл раунд' : ' и вышел вперёд'}` });
    }
  }
  // the first use of what the locker room added
  for (let s = 0; s < 2; s++) {
    if (!prevMoves[s]) continue;
    const fresh = fighters[s].moves.filter((m) => !prevMoves[s].includes(m.id));
    for (const mv of fresh) {
      const first = events.find((e) => e.type === 'move' && e.side === s && e.move === mv.id);
      if (!first) continue;
      const mine = hits.filter((h) => h.attacker === s && h.move === mv.id && h.tick >= first.tick && h.tick < first.tick + 240);
      add({ kind: 'new', side: s, at: first.tick, from: first.tick - 45, to: first.tick + 150, score: 7 + (mine.length ? 2 : 0), move: mv.id, damage: mine.reduce((a, h) => a + h.damage, 0), text: `${fighters[s].card.name} впервые пробует новое из раздевалки: «${mv.name}»${mv.ability ? ' (способность кодом)' : ''}${mine.length ? `, попадание на ${mine.reduce((a, h) => a + h.damage, 0)}` : ''}` });
    }
  }
  // the juiciest single hit
  const top = [...hits].sort((a, b) => b.damage - a.damage)[0];
  if (top) add({ kind: 'juicy', side: top.attacker, at: top.tick, from: top.tick - 75, to: top.tick + 60, score: 4 + top.damage / 20, move: top.move, damage: top.damage, counter: !!top.counter, text: `Самый сочный удар: ${fighters[top.attacker].card.name}, «${name(top.attacker, top.move)}» — ${top.damage}${top.counter ? ', контрудар' : ''}` });
  moments.sort((a, b) => b.score - a.score);
  return { hp, counters, moments, juicy: top ? { side: top.attacker, move: top.move, name: name(top.attacker, top.move), damage: top.damage, tick: top.tick } : null, result: { winner: result.winner, reason: result.reason, ticks: end, seconds: sec(end) } };
}

// The best moments for a reel: overlapping ones merged, at most n, in the order of the fight
export function pickMoments(moments, n = 3) {
  const out = [];
  const free = (m) => !out.some((o) => m.from < o.to && m.to > o.from);
  // one of each kind first (the knockout, a super, a combo, a comeback, something new), then the best of the rest
  const kinds = new Set();
  for (const m of moments) {
    if (out.length >= n) break;
    if (kinds.has(m.kind) || !free(m)) continue;
    kinds.add(m.kind);
    out.push(m);
  }
  for (const m of moments) {
    if (out.length >= n) break;
    if (!out.includes(m) && free(m)) out.push(m);
  }
  return out.sort((a, b) => a.from - b.from);
}

// tick of the fight → seconds of a rendered clip (its timing file: the fight tick of every frame)
// The clip time of a fight tick: searched from the start of the fight phase. Frames of the VS screen and the board
// carry tick 0 too, so tick 0 of a fight (an opening ability on the first tick) used to land on the VS screen and a
// reel piece of that moment showed the VS once more (found on the rehearsal).
export function clipTime(timing, tick) {
  if (!timing) return null;
  const { fps, ticks } = timing;
  const fight = timing.phases?.indexOf('fight') ?? -1;
  const from = fight >= 0 && Array.isArray(timing.phase) ? Math.max(0, timing.phase.indexOf(fight)) : 0;
  for (let i = from; i < ticks.length; i++) if (ticks[i] >= tick) return +(i / fps).toFixed(2);
  return +(ticks.length / fps).toFixed(2);
}

export function readTiming(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// locker room: the side's numbers in the round before and after a change
export function lockerEffect(before, after) {
  const k = ['hits', 'damage', 'blocks', 'parries', 'throws', 'supers', 'abilityDamage', 'maxCombo'];
  return Object.fromEntries(k.map((x) => [x, { before: before[x], after: after[x], delta: after[x] - before[x] }]));
}

export const roundStatsFile = (roundDir) => join(roundDir, 'stats.json');

// Stats of every round of a match and of its locker rooms, written next to the rounds (round-N/stats.json) and
// for the match (stats.json): what each change did to the numbers of the next round.
export async function matchStats(id) {
  const { loadMatch, matchDir, analyze } = await import('./match.js');
  const { loadFighter } = await import('../kit/arena/tools/load.js');
  const { writeFileSync } = await import('node:fs');
  const m = loadMatch(id);
  const rounds = [];
  const prevOf = {};
  for (const r of m.rounds) {
    const rd = join(matchDir(id), `round-${r.n}`);
    const sides = [r.left, r.right];
    const fighters = [];
    for (const cid of sides) {
      const f = await loadFighter(join(rd, cid, 'fighter'), { verify: false });
      if (!f.ok) throw new Error(`раунд ${r.n}, ${cid}: ${f.errors.slice(0, 3).join('; ')}`);
      fighters.push(f.fighter);
    }
    const replay = JSON.parse(readFileSync(join(rd, 'replay.json'), 'utf8'));
    const an = analyze(fighters, replay);
    const st = roundStats(an, fighters, { prevMoves: sides.map((cid) => prevOf[cid] || null) });
    st.n = r.n;
    st.sides = sides;
    st.names = fighters.map((f) => f.card.name);
    writeFileSync(join(rd, 'stats.json'), JSON.stringify(st) + '\n');
    rounds.push(st);
    sides.forEach((cid, i) => (prevOf[cid] = fighters[i].moves.map((x) => x.id)));
  }
  // locker rooms: for each contestant, round k → k+1 of its own numbers
  const lockers = [];
  for (const cid of [m.red, m.blue]) {
    const mine = rounds.map((st) => ({ n: st.n, c: st.counters[st.sides.indexOf(cid)], won: st.result.winner === st.sides.indexOf(cid) }));
    for (let i = 1; i < mine.length; i++) lockers.push({ cid, from: mine[i - 1].n, to: mine[i].n, effect: lockerEffect(mine[i - 1].c, mine[i].c), wonBefore: mine[i - 1].won, wonAfter: mine[i].won });
  }
  const out = { match: id, rounds: rounds.map((st) => ({ n: st.n, sides: st.sides, names: st.names, counters: st.counters, result: st.result, juicy: st.juicy, top: pickMoments(st.moments, 4) })), lockers };
  writeFileSync(join(matchDir(id), 'stats.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}
