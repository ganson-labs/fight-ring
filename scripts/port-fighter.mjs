// Ports a fighter of an older ring to the prices of this one, for calibration only (the judge's tool; ported fighters
// never enter a table). Copies <src>/fighter to <out>/fighter, then, while the moves are over the budget:
//  1) lengthens the recovery of the shortest strike up to 24 ticks in all (rule R3 makes short strikes dear);
//  2) then slows the fastest strike past the next startup price step (startup ≤ 4, ≤ 6, ≤ 9 cost more);
//  3) then lowers the damage of the dearest strike to the next price step (every 20 of damage is a point);
//  4) with nothing left to make cheaper, leaves out the last special move (its brain then presses it in vain).
// node scripts/port-fighter.mjs <src fighter folder> <out folder>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadFighter } from '../kit/arena/tools/load.js';
import { BLOCKS, MOVE_BUDGET } from '../kit/arena/engine/index.js';

const [src, out] = process.argv.slice(2).map((p) => resolve(p));
if (!src || !out) throw new Error('node scripts/port-fighter.mjs <папка бойца> <куда>');
const dst = join(out, 'fighter');
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, dst, { recursive: true });
const file = join(dst, 'moves.json');
const changes = [];
for (let round = 0; round < 60; round++) {
  const r = await loadFighter(dst, { verify: false });
  const over = r.budget ? r.budget.used - MOVE_BUDGET : 0;
  if (r.ok || over <= 0) {
    console.log(`${r.ok ? 'готово' : 'ошибки'}: ${dst}, бюджет ${r.budget?.used}/${MOVE_BUDGET}${changes.length ? `\n  ${changes.join('\n  ')}` : ''}`);
    if (!r.ok) console.log(r.errors.slice(0, 5).join('\n'));
    process.exit(r.ok ? 0 : 1);
  }
  const moves = JSON.parse(readFileSync(file, 'utf8'));
  const strikes = moves.moves.flatMap((m) => m.blocks.filter((b) => b.type === 'strike').map((b) => ({ m, b, total: b.startup + b.active + b.recovery })));
  const short = strikes.filter((s) => s.total < 24).sort((a, b) => a.total - b.total)[0];
  if (short) {
    const add = 24 - short.total;
    short.b.recovery = Math.min(60, short.b.recovery + add);
    changes.push(`${short.m.id}: восстановление +${add} (до ${short.b.recovery})`);
  } else if (strikes.some((s) => s.b.startup <= 9)) {
    const fast = strikes.filter((s) => s.b.startup <= 9).sort((a, b) => a.b.startup - b.b.startup)[0];
    const to = fast.b.startup <= 4 ? 5 : fast.b.startup <= 6 ? 7 : 10;
    changes.push(`${fast.m.id}: замах ${fast.b.startup} → ${to}`);
    fast.b.startup = to;
  } else {
    const dear = strikes.filter((s) => s.b.damage > 10).sort((a, b) => BLOCKS.strike.cost(b.b, b.m.slot, { chargeMul: 1 }) - BLOCKS.strike.cost(a.b, a.m.slot, { chargeMul: 1 }))[0];
    if (!dear) {
      const sp = moves.moves.filter((m) => m.slot === 'special');
      if (!sp.length) throw new Error('нечего удешевлять');
      // a copy of another move first (one ability script under several moves), else the last one
      const script = (m) => m.blocks.find((b) => b.type === 'ability')?.script;
      // (the same blocks and the same measured price: one ability under several names)
      const price = Object.fromEntries((r.budget?.moves || []).map((x) => [x.id, x.cost]));
      const same = (a, b) => JSON.stringify(a.blocks) === JSON.stringify(b.blocks) && price[a.id] === price[b.id];
      const copies = sp.filter((m) => script(m) && moves.moves.some((o) => o !== m && same(o, m)));
      const drop = copies[copies.length - 1] || sp[sp.length - 1];
      moves.moves = moves.moves.filter((m) => m !== drop);
      changes.push(`${drop.id}: приём убран`);
      writeFileSync(file, JSON.stringify(moves, null, 2) + '\n');
      continue;
    }
    const to = Math.max(5, Math.floor((dear.b.damage - 1) / 20) * 20);
    changes.push(`${dear.m.id}: урон ${dear.b.damage} → ${to}`);
    dear.b.damage = to;
  }
  writeFileSync(file, JSON.stringify(moves, null, 2) + '\n');
}
throw new Error('не уложился в 60 шагов');
