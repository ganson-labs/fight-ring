// One worker of the 3.0 league (judge/bench.js): plays the fights it is sent, writes each record to disk and returns
// the numbers the table and the passport need. Fighters are loaded once per worker (their brains fresh every fight).
import { parentPort } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { loadFighter, runFight } from '../kit/arena/tools/load.js';
import { ROUND_TICKS, noisyStart } from '../kit/arena/engine/index.js';

const cache = new Map();
async function fighter(dir, off) {
  const key = `${dir}|${off || ''}`;
  if (!cache.has(key)) {
    if (!cache.has(dir)) {
      const r = await loadFighter(dir);
      if (!r.ok) throw new Error(`${dir}: ${r.errors.slice(0, 5).join('; ')}`);
      cache.set(dir, r.fighter);
    }
    const def = cache.get(dir);
    if (off) {
      // move ablation (method §2.4.5): the move is still listed, but pressing it does nothing
      const movesById = { ...def.movesById };
      delete movesById[off];
      cache.set(key, { ...def, movesById });
    } else cache.set(key, def);
  }
  return cache.get(key);
}

// What a fight was made of, from its events and its ticks.
export function fightStats(run) {
  const f = run.fight;
  const dmg = [{}, {}];
  const add = (side, move, d) => {
    if (!(d > 0) || side === undefined || side === null) return;
    dmg[side][move || '?'] = (dmg[side][move || '?'] || 0) + d;
  };
  const hits = [0, 0];
  const blocks = [0, 0];
  const parried = [0, 0];
  const throwDmg = [0, 0];
  const counts = { crush: [0, 0], passive: [0, 0], wallBreak: [0, 0], chip: [0, 0], whiffs: f.f.map((F) => F.tally.whiffs) };
  const hp = f.f.map((F) => F.maxHp);
  let lead = 0;
  let changes = 0;
  const shareOf = (s) => hp[s] / f.f[s].maxHp;
  for (const e of run.events) {
    let victim = null;
    let d = 0;
    if (e.type === 'hit' || e.type === 'armor') {
      add(e.attacker, e.move, e.damage);
      if (e.type === 'hit') hits[e.attacker]++;
      victim = e.type === 'hit' ? e.side : e.side;
      d = e.damage;
    } else if (e.type === 'block') {
      blocks[e.attacker]++;
      if (e.chip > 0) {
        add(e.attacker, e.move, e.chip);
        counts.chip[e.attacker] += e.chip;
        victim = e.side;
        d = e.chip;
      }
    } else if (e.type === 'throw') {
      add(e.side, 'throw', e.damage);
      throwDmg[e.side] += e.damage;
      victim = e.victim;
      d = e.damage;
    } else if (e.type === 'dot') {
      add(e.from, e.move, e.damage);
      victim = e.side;
      d = e.damage;
    } else if (e.type === 'parry') {
      if (e.attacker !== undefined) parried[e.attacker]++;
    } else if (e.type === 'guardCrush') counts.crush[e.attacker]++;
    else if (e.type === 'passive') counts.passive[e.side]++;
    else if (e.type === 'wallBreak') counts.wallBreak[1 - e.side]++;
    if (victim !== null && d > 0) {
      hp[victim] = Math.max(0, hp[victim] - d);
      // the leader by the share of health left, with a 2 % margin
      const diff = shareOf(0) - shareOf(1);
      const now = diff > 0.02 ? 1 : diff < -0.02 ? -1 : lead;
      if (lead !== 0 && now !== lead) changes++;
      lead = now;
    }
  }
  return { dmg, hits, blocks, parried, throwDmg, leadChanges: changes, ...counts };
}

parentPort.on('message', async (job) => {
  try {
    const fighters = [await fighter(job.dirs[0], job.off?.[0]), await fighter(job.dirs[1], job.off?.[1])];
    let far = 0;
    let ticks = 0;
    let lastTick = -1;
    const run = await runFight({
      dirs: job.dirs,
      fighters,
      options: { round: 1, league: true },
      seed: job.seed,
      start: noisyStart(job.start, job.noise),
      maxTicks: ROUND_TICKS + 900,
      onStep: (fight) => {
        if (fight.over || fight.tick === lastTick) return;
        lastTick = fight.tick;
        ticks++;
        if (Math.abs(fight.f[0].x - fight.f[1].x) > 900) far++;
      },
    });
    const f = run.fight;
    const out = {
      id: job.id,
      left: job.left,
      right: job.right,
      start: job.start,
      draw: job.draw,
      cluster: job.cluster,
      seed: job.seed,
      noise: job.noise,
      ...(job.off ? { off: job.off } : {}),
      winner: f.winner === null ? null : f.winner === 0 ? job.left : job.right,
      reason: f.endReason,
      ticks: f.tick,
      hp: f.f.map((F) => Math.max(0, Math.ceil(F.hp))),
      maxHp: f.f.map((F) => F.maxHp),
      dealt: f.f.map((F) => F.tally.damageDealt),
      supers: f.f.map((F) => F.tally.supers),
      far: ticks ? far / ticks : 0,
      stats: fightStats(run),
      brain: run.stats.map((s) => ({ skipped: s.skipped, errors: s.errors, stepsMax: s.stepsMax, msMax: Math.round(s.msMax * 100) / 100 })),
      hash: run.replay.hash,
    };
    if (job.save) writeFileSync(job.save, JSON.stringify({ ...run.replay, fighters: [job.left, job.right], league: out }) + '\n');
    parentPort.postMessage({ ok: true, result: out });
  } catch (e) {
    parentPort.postMessage({ ok: false, id: job.id, error: String(e?.stack || e), judge: /сбой судьи/.test(String(e?.message || e)) });
  }
});
