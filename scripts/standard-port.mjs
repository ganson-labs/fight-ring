// Ring 4: bring the ring's own fighters (the template and the sparring partners) to the shared kit.
// Their moves.json keeps only the look; mechanics, stats and abilities are the ring's. Run once: node scripts/standard-port.mjs
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_MOVES, KIT_MOVES } from '../kit/arena/engine/standard.js';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'kit');
const STYLES = {
  shkval: { range: [100, 170], dash: 0.9, pokes: ['jab', 'low', 'knee', 'heavy'], mixLow: ['low', 'sweep'], mixHigh: ['overhead', 'jab', 'knee', 'flurry', 'twin', 'cyclone'], punish: ['jab', 'upper', 'heavy'], antiAir: 'upper', specials: [{ id: 'rush', when: 'far', rate: 0.03 }, { id: 'slide', when: 'far', rate: 0.02 }, { id: 'ram', when: 'near', rate: 0.02 }], superWhen: 'punish', parry: 0.1, throwRate: 0.25, techRate: 0.06, jumpIn: 0.01, patience: 0.1 },
  strelok: { range: [380, 520], dash: 0.5, pokes: ['heavy'], mixLow: ['low'], mixHigh: ['jab'], punish: ['heavy', 'jab'], antiAir: 'upper', zoning: ['fireball', 'wave', 'spike', 'lance'], specials: [{ id: 'retreat', when: 'near', rate: 0.05 }], superWhen: 'any', parry: 0.15, throwRate: 0.1, techRate: 0.08, jumpIn: 0, patience: 0.35 },
  skala: { range: [130, 220], dash: 0.1, pokes: ['jab', 'low'], mixLow: ['sweep'], mixHigh: ['heavy', 'smash'], punish: ['upper', 'heavy', 'jab'], antiAir: 'upper', zoning: ['fireball'], specials: [{ id: 'ram', when: 'near', rate: 0.02 }, { id: 'breaker', when: 'near', rate: 0.02 }, { id: 'twin', when: 'near', rate: 0.03 }], superWhen: 'punish', parry: 0.45, throwRate: 0.15, techRate: 0.12, jumpIn: 0, patience: 0.75 },
  mekhanik: { range: [220, 360], dash: 0.4, pokes: ['heavy', 'low', 'smash'], mixLow: ['low', 'sweep'], mixHigh: ['overhead'], punish: ['jab', 'heavy'], antiAir: 'upper', zoning: ['fireball'], specials: [{ id: 'blink', when: 'far', rate: 0.02 }, { id: 'cross', when: 'far', rate: 0.02 }, { id: 'slide', when: 'far', rate: 0.03 }], superWhen: 'any', parry: 0.2, throwRate: 0.2, techRate: 0.08, jumpIn: 0.02, patience: 0.4 },
};
// which specials and which super each of the ring's fighters takes
const PICKS = {
  fighter: ['fireball', 'rush', 'slide', 'blink', 'twin', 'dive', 'finale'],
  dummy: ['fireball', 'rush', 'slide', 'blink', 'twin', 'dive', 'finale'],
  shkval: ['rush', 'slide', 'flurry', 'ram', 'twin', 'cyclone', 'storm'],
  strelok: ['fireball', 'wave', 'spike', 'lance', 'retreat', 'smash', 'barrage'],
  skala: ['ram', 'smash', 'breaker', 'retreat', 'fireball', 'twin', 'finale'],
  mekhanik: ['blink', 'cross', 'fireball', 'smash', 'slide', 'dive', 'ambush'],
};
const TITLES = { shkval: 'Шквал', strelok: 'Стрелок', skala: 'Скала', mekhanik: 'Механик' };

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const save = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const look = (picks) => ({ moves: KIT_MOVES.filter((m) => STANDARD_MOVES.includes(m) || picks.includes(m.id)).map((m) => ({ id: m.id, name: m.name, anim: m.anim, ...(m.slot === 'super' ? { director: { title: m.name.toUpperCase(), zoom: 1.6, angle: 'low', background: 'darken', slowmo: 0.6 } } : {}) })) });

for (const dir of [join(KIT, 'fighter'), ...['dummy', ...Object.keys(STYLES)].map((n) => join(KIT, 'arena', 'sparring', n))]) {
  const card = json(join(dir, 'fighter.json'));
  delete card.stats;
  delete card.stances;
  delete card.resources;
  save(join(dir, 'fighter.json'), card);
  save(join(dir, 'moves.json'), look(PICKS[basename(dir)]));
  if (existsSync(join(dir, 'abilities'))) rmSync(join(dir, 'abilities'), { recursive: true });
}
for (const [name, style] of Object.entries(STYLES)) {
  writeFileSync(join(KIT, 'arena', 'sparring', name, 'brain.js'), `// Sparring partner «${TITLES[name]}» of the ring. Style below, the brain itself in core.js.\nimport { makeBrain } from './core.js';\n\nexport default makeBrain(${JSON.stringify(style, null, 2)});\n`);
}
console.log('ok');
