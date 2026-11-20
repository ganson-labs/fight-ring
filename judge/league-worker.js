// One worker of the league: plays the fights it is sent and writes each record to disk.
// Fighters are loaded once per worker and kept (a fighter's brain module is loaded fresh for every fight by runFight).
import { parentPort } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { loadFighter, runFight } from '../kit/arena/tools/load.js';
import { ROUND_TICKS, STARTS } from '../kit/arena/engine/index.js';

const cache = new Map();
async function fighter(dir) {
  if (!cache.has(dir)) {
    const r = await loadFighter(dir);
    if (!r.ok) throw new Error(`${dir}: ${r.errors.slice(0, 5).join('; ')}`);
    cache.set(dir, r.fighter);
  }
  return cache.get(dir);
}

parentPort.on('message', async (job) => {
  try {
    const fighters = [await fighter(job.dirs[0]), await fighter(job.dirs[1])];
    const run = await runFight({ dirs: job.dirs, fighters, options: { round: 1, league: true }, seed: job.seed, start: STARTS[job.start], maxTicks: ROUND_TICKS + 900 });
    const f = run.fight;
    const out = {
      id: job.id,
      left: job.left,
      right: job.right,
      start: job.start,
      seed: job.seed,
      winner: f.winner === null ? null : f.winner === 0 ? job.left : job.right,
      reason: f.endReason,
      ticks: f.tick,
      hp: f.f.map((F) => Math.max(0, Math.ceil(F.hp))),
      maxHp: f.f.map((F) => F.maxHp),
      dealt: f.f.map((F) => F.tally.damageDealt),
      supers: f.f.map((F) => F.tally.supers),
      brain: run.stats.map((s) => ({ slow: s.slow, errors: s.errors, msMax: Math.round(s.msMax * 100) / 100 })),
      hash: run.replay.hash,
    };
    writeFileSync(job.save, JSON.stringify({ ...run.replay, fighters: [job.left, job.right], league: out }) + '\n');
    parentPort.postMessage({ ok: true, result: out });
  } catch (e) {
    parentPort.postMessage({ ok: false, id: job.id, error: String(e?.stack || e) });
  }
});
