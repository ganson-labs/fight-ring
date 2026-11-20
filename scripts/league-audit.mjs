// Audit of a played league, for the judge (not shown to contestants):
//  1. how each fighter deals damage (abilities, moves, throws, supers) and how much of it the opponent blocks or parries;
//  2. brains matter: every fighter again with a plain brain on its own moves, against the others at full strength;
//  3. how often a pair's result turns over across starts and seeds.
// node scripts/league-audit.mjs <league> [--no-ablation]      Names are printed: run it where the operator alone reads it.
import { readFileSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const name = process.argv[2];
const noAblation = process.argv.includes('--no-ablation');
const { loadFighter, expandSteps, runFight } = await import('../kit/arena/tools/load.js');
const E = await import('../kit/arena/engine/index.js');
const dir = join(root, 'leagues', name);
const L = JSON.parse(readFileSync(join(dir, 'league.json'), 'utf8'));
const ids = L.table.map((r) => r.id);
const defs = {};
for (const id of ids) defs[id] = (await loadFighter(join(dir, 'fighters', id, 'fighter'))).fighter;
const nm = (id) => `${L.people[id].name} (${L.people[id].model})`;

// 1. damage sources: replay every fight of the first seed and read the events
const src = Object.fromEntries(ids.map((id) => [id, { dmg: 0, ability: 0, superDmg: 0, throwDmg: 0, hits: 0, blocked: 0, parried: 0, abilityHits: 0, abilityBlocked: 0 }]));
for (const f of L.fights) {
  const rep = JSON.parse(readFileSync(join(dir, 'fights', f.id + '.json'), 'utf8'));
  const fight = E.createFight({ fighters: [defs[f.left], defs[f.right]], seed: rep.seed, start: rep.start });
  const who = [f.left, f.right];
  for (const acts of expandSteps(rep.steps)) {
    for (const e of E.stepFight(fight, acts)) {
      if (e.type === 'hit' && e.attacker !== undefined) {
        const a = src[who[e.attacker]];
        a.hits++;
        a.dmg += e.damage || 0;
        if (e.ability) {
          a.ability += e.damage || 0;
          a.abilityHits++;
        }
        if (e.super || (e.move && defs[who[e.attacker]].movesById[e.move]?.slot === 'super')) a.superDmg += e.damage || 0;
      } else if (e.type === 'throw') {
        src[who[e.side]].throwDmg += e.damage || 0;
      } else if (e.type === 'block' && e.attacker !== undefined) {
        src[who[e.attacker]].blocked++;
        if (e.ability || defs[who[e.attacker]].movesById[e.move]?.ability) src[who[e.attacker]].abilityBlocked++;
      } else if (e.type === 'parry') {
        const att = e.attacker ?? (e.side !== undefined ? 1 - e.side : null);
        if (att !== null) src[who[att]].parried++;
      }
    }
  }
}
console.log(`# Аудит лиги «${name}»\n\n## Таблица\n`);
for (const r of L.table) console.log(`${r.place}. ${r.tier} ${nm(r.id)} — ${Math.round(r.share * 100)} %, рейтинг ${r.rating} (${r.range.join('–')})`);
console.log('\n## Чем бьют (все бои лиги)\n');
for (const id of ids) {
  const a = src[id];
  const pct = (x, y) => (y ? `${Math.round((100 * x) / y)} %` : '—');
  console.log(`${nm(id)}: попаданий ${a.hits}, в блок ${a.blocked} (${pct(a.blocked, a.hits + a.blocked)}), парировано ${a.parried}; урон способностями ${pct(a.ability, a.dmg)}, суперприёмом ${pct(a.superDmg, a.dmg)}, бросками ${a.throwDmg}; удары способностей в блок ${pct(a.abilityBlocked, a.abilityHits + a.abilityBlocked)}`);
}

// 3. turnovers: in how many pairs the loser of the pair still won some fights
console.log('\n## Пары: сколько боёв взял слабший в паре\n');
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const a = L.table[i];
  const b = L.table[j];
  const v = a.vs[b.id];
  console.log(`${L.people[a.id].name} — ${L.people[b.id].name}: ${v.wins} : ${v.losses}${v.draws ? ` (ничьих ${v.draws})` : ''}`);
}

// 2. brains matter
if (!noAblation) {
  const tmp = join(tmpdir(), `ring-ablation-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const core = readFileSync(join(root, 'kit', 'arena', 'sparring', '_core', 'core.js'), 'utf8');
  console.log('\n## Мозги решают? Боец с простыми мозгами на своих же приёмах против остальных в полной силе\n');
  for (const id of ids) {
    const d = join(tmp, id, 'fighter');
    cpSync(join(dir, 'fighters', id), join(tmp, id), { recursive: true });
    const def = defs[id];
    const normals = def.moves.filter((m) => m.slot === 'normal').map((m) => m.id);
    const specials = def.moves.filter((m) => m.slot === 'special').map((m) => ({ id: m.id, when: 'any', rate: 0.03 }));
    const style = { range: [140, 320], dash: 0.3, pokes: normals, mixLow: normals, mixHigh: normals, punish: normals, specials, superWhen: 'punish', parry: 0.1, throwRate: 0.15, jumpIn: 0.01, patience: 0.3 };
    writeFileSync(join(d, 'core.js'), core);
    writeFileSync(join(d, 'brain.js'), `import { makeBrain } from './core.js';\nexport default makeBrain(${JSON.stringify(style)});\n`);
    const plain = (await loadFighter(d)).fighter;
    let full = 0;
    let weak = 0;
    let n = 0;
    for (const op of ids) {
      if (op === id) continue;
      for (const start of Object.keys(E.STARTS)) for (const side of [0, 1]) {
        const seed = E.RING_SEED;
        const dirs = side === 0 ? [d, join(dir, 'fighters', op, 'fighter')] : [join(dir, 'fighters', op, 'fighter'), d];
        const fighters = side === 0 ? [plain, defs[op]] : [defs[op], plain];
        const run = await runFight({ dirs, fighters, seed, start: E.STARTS[start], maxTicks: E.ROUND_TICKS + 900 });
        const w = run.fight.winner;
        weak += w === side ? 1 : w === null ? 0.5 : 0;
        n++;
        const real = L.fights.find((f) => f.start === start && f.seed === seed && ((side === 0 && f.left === id && f.right === op) || (side === 1 && f.right === id && f.left === op)));
        if (real) full += real.winner === id ? 1 : real.winner === null ? 0.5 : 0;
      }
    }
    console.log(`${nm(id)}: со своими мозгами ${Math.round((100 * full) / n)} %, с простыми ${Math.round((100 * weak) / n)} % (${n} боёв)`);
  }
  rmSync(tmp, { recursive: true, force: true });
}
