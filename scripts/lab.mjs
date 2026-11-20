// Lab league: every fighter folder against every other, 5 starts × draws × 2 sides, in one process.
// A quick look at how a kit plays: who wins, how long, what deals the damage. node scripts/lab.mjs <dir> <dir> … [--draws 2]
import { loadFighter, runFight } from '../kit/arena/tools/load.js';
import { STARTS, noisyStart, noiseDraw, ROUND_TICKS } from '../kit/arena/engine/index.js';
import { basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const di = args.indexOf('--draws');
const draws = di >= 0 ? Number(args.splice(di, 2)[1]) : 2;
const dirs = args.map((d) => resolve(d));
const names = dirs.map((d) => (basename(d) === 'fighter' ? basename(resolve(d, '..')) : basename(d)));
const defs = [];
for (const d of dirs) {
  const r = await loadFighter(d, { verify: false });
  if (!r.ok) throw new Error(`${d}: ${r.errors.join('; ')}`);
  defs.push(r.fighter);
}
const n = dirs.length;
const wins = names.map(() => names.map(() => 0));
const games = names.map(() => names.map(() => 0));
const dmg = names.map(() => ({}));
const all = { ticks: [], timeouts: 0, draws: 0, lead: 0, n: 0, blocks: 0, hits: 0, supers: 0, loserShare: [], throws: 0, errors: 0 };
for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
  if (a === b) continue;
  for (const start of Object.keys(STARTS)) for (let k = 0; k < draws; k++) {
    const seed = 1000 + k * 77 + Object.keys(STARTS).indexOf(start) * 13 + Math.min(a, b) * 1009 + Math.max(a, b) * 9173;
    const { fight, events, stats } = await runFight({ dirs: [dirs[a], dirs[b]], fighters: [defs[a], defs[b]], seed, start: noisyStart(start, noiseDraw(seed)), maxTicks: ROUND_TICKS + 10 });
    all.errors += stats[0].errors + stats[1].errors + stats[0].skipped + stats[1].skipped;
    const ids = [a, b];
    games[a][b]++;
    games[b][a]++;
    if (fight.winner === null || fight.winner === undefined) all.draws++;
    else wins[ids[fight.winner]][ids[1 - fight.winner]]++;
    all.n++;
    all.ticks.push(fight.endTick ?? fight.tick);
    if (fight.endReason !== 'ko') all.timeouts++;
    let lead = null, changes = 0;
    const hp = [1, 1];
    for (const e of events) {
      if (e.type === 'hit' || e.type === 'throwHit' || e.type === 'thrown') {
        const who = ids[e.attacker ?? 1 - e.side];
        const key = e.type === 'hit' ? e.move : 'throw';
        dmg[who][key] = (dmg[who][key] || 0) + (e.damage || 0);
      }
      if (e.type === 'hit') all.hits++;
      if (e.type === 'block') all.blocks++;
      if (e.type === 'super') all.supers++;
    }
    const t = fight.f.map((F) => F.tally);
    all.throws += t[0].throws + t[1].throws;
    for (const s of [0, 1]) dmg[ids[s]].__throw = (dmg[ids[s]].__throw || 0) + t[s].throwDamage;
    if (fight.winner != null) all.loserShare.push(t[1 - fight.winner].damageDealt / Math.max(1, t[fight.winner].damageDealt));
  }
}
const med = (xs) => [...xs].sort((x, y) => x - y)[xs.length >> 1];
console.log(`\nбоёв ${all.n}, медиана ${Math.round(med(all.ticks) / 60)} с (10 % ${Math.round([...all.ticks].sort((x, y) => x - y)[Math.floor(all.n * 0.1)] / 60)}, 90 % ${Math.round([...all.ticks].sort((x, y) => x - y)[Math.floor(all.n * 0.9)] / 60)}), по времени ${Math.round((100 * all.timeouts) / all.n)} %, ничьих ${all.draws}, суперов на бой ${(all.supers / all.n).toFixed(1)}, бросков на бой ${(all.throws / all.n).toFixed(1)}, в блок ${Math.round((100 * all.blocks) / Math.max(1, all.blocks + all.hits))} %, урон проигравшего/победителя ${med(all.loserShare)?.toFixed(2)}, ошибок мозгов ${all.errors}`);
console.log('\nпобеды (строка над столбцом):\n' + ' '.repeat(12) + names.map((x) => x.slice(0, 9).padStart(10)).join(''));
names.forEach((nm, i) => console.log(nm.slice(0, 11).padEnd(12) + names.map((_, j) => (i === j ? '—' : `${wins[i][j]}/${games[i][j]}`).padStart(10)).join('') + `   ${Math.round((100 * wins[i].reduce((s, v) => s + v, 0)) / games[i].reduce((s, v) => s + v, 0))} %`));
console.log('\nурон по приёмам:');
names.forEach((nm, i) => {
  const d = { ...dmg[i] };
  d.throw = d.__throw;
  delete d.__throw;
  const tot = Object.values(d).reduce((s, v) => s + v, 0) || 1;
  console.log(`  ${nm.padEnd(12)} ` + Object.entries(d).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / tot)}%`).join(', '));
});
