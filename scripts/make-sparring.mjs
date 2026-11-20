// Builds the ring's sparring partners in kit/arena/sparring/<id>/ from the specs below:
// the dummy's body and parts, own card, stats, moves and a brain on the shared core (_core/core.js).
// node scripts/make-sparring.mjs   — then: node kit/arena/cli.mjs check kit/arena/sparring/<id>
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SP = join(root, 'kit', 'arena', 'sparring');
const DUMMY = join(SP, 'dummy');

// animation from the block timings: wind-up, hit pose held through active, back to stance
function anim(blocks, low = false) {
  const keys = [{ t: 0, pose: low ? 'crouch' : 'stance' }];
  let t = 0;
  for (const b of blocks) {
    if (b.type === 'charge' || b.type === 'armor') continue;
    const s = b.startup;
    const act = b.type === 'strike' ? b.active : b.type === 'ability' ? b.active || 1 : 0;
    keys.push({ t: t + Math.max(1, s - 3), pose: b.type === 'projectile' || b.type === 'ability' ? 'windup' : 'punch_ready' });
    keys.push({ t: t + s, pose: 'punch', ease: 'hold' });
    keys.push({ t: t + s + act, pose: 'punch' });
    t += s + act + b.recovery;
  }
  keys.push({ t, pose: low ? 'crouch' : 'stance' });
  return { keys: keys.filter((k, i, a) => i === 0 || k.t > a[i - 1].t) };
}

const strike = (o) => ({ type: 'strike', active: 3, reach: 'mid', zone: 'mid', ...o });
const move = (id, name, slot, blocks, extra = {}) => ({ id, name, slot, posture: extra.posture || 'stand', blocks, anim: anim(blocks, extra.posture === 'crouch'), ...(extra.director ? { director: extra.director } : {}), ...(extra.fx ? { fx: extra.fx } : {}) });

const PARTNERS = [
  {
    id: 'shkval',
    card: { name: 'Шквал', motto: 'Вплотную и без пауз', story: 'Спарринг-партнёр ринга: штурмовик. Сокращает дистанцию, мешает низ, верх и бросок.', colors: { primary: '#c0392b', secondary: '#7b241c', accent: '#f5b7b1' } },
    stats: { health: 2, power: 4, speed: 5, defense: 1 },
    moves: [
      move('jab', 'Тычок', 'normal', [strike({ startup: 5, active: 2, recovery: 17, damage: 30, reach: 'short' })]),
      move('low_kick', 'Подсечка', 'normal', [strike({ startup: 7, recovery: 14, damage: 30, zone: 'low' })], { posture: 'crouch' }),
      move('overhead', 'Сверху', 'normal', [strike({ startup: 16, recovery: 16, damage: 40, zone: 'overhead' })]),
      move('rising', 'Апперкот', 'normal', [strike({ startup: 7, active: 4, recovery: 16, damage: 40, reach: 'short', zone: 'high', launch: true })]),
      move('rush', 'Рывок', 'special', [strike({ startup: 8, active: 4, recovery: 18, damage: 55, reach: 'mid', push: 'heavy' })], { fx: [{ on: 'active', type: 'afterimage', color: '#f5b7b1' }] }),
      move('storm', 'Шквал', 'super', [strike({ startup: 6, active: 10, recovery: 30, damage: 50, hits: 5 })], { director: { title: 'ШКВАЛ', zoom: 1.6, angle: 'close' } }),
    ],
    style: { range: [100, 170], dash: 0.9, pokes: ['jab', 'low_kick', 'rush'], mixLow: ['low_kick'], mixHigh: ['overhead', 'jab'], punish: ['jab', 'rising', 'rush'], antiAir: 'rising', specials: [{ id: 'rush', when: 'far', rate: 0.03 }], superWhen: 'punish', parry: 0.1, throwRate: 0.25, techRate: 0.06, jumpIn: 0.01, patience: 0.1 },
  },
  {
    id: 'strelok',
    card: { name: 'Стрелок', motto: 'Не подходи', story: 'Спарринг-партнёр ринга: держит дистанцию снарядами, встречает прыжки, отскакивает от натиска.', colors: { primary: '#2e86c1', secondary: '#1b4f72', accent: '#aed6f1' } },
    stats: { health: 3, power: 4, speed: 2, defense: 3 },
    moves: [
      move('poke', 'Длинный тычок', 'normal', [strike({ startup: 7, recovery: 14, damage: 35, reach: 'long' })]),
      move('bolt', 'Заряд', 'special', [{ type: 'projectile', startup: 12, recovery: 20, damage: 45, speed: 'mid', zone: 'mid' }], { fx: [{ on: 'projectile', type: 'glow', color: '#aed6f1' }] }),
      move('ground_bolt', 'Низовой заряд', 'special', [{ type: 'projectile', startup: 14, recovery: 22, damage: 35, speed: 'slow', zone: 'low' }]),
      move('anti_air', 'Свеча', 'special', [strike({ startup: 7, active: 6, recovery: 24, damage: 60, reach: 'short', zone: 'high', launch: true })]),
      move('step_back', 'Отход', 'special', [{ type: 'teleport', startup: 10, recovery: 10, to: 'back', distance: 400 }]),
      move('volley', 'Залп', 'super', [{ type: 'projectile', startup: 10, recovery: 30, damage: 80, hits: 3, speed: 'fast', zone: 'mid' }], { director: { title: 'ЗАЛП', zoom: 1.4, angle: 'wide' } }),
    ],
    style: { range: [380, 480], dash: 0.5, pokes: ['poke'], mixLow: ['poke'], mixHigh: ['poke'], punish: ['poke', 'anti_air'], antiAir: 'anti_air', zoning: ['bolt', 'ground_bolt'], specials: [{ id: 'step_back', when: 'near', rate: 0.04 }], superWhen: 'any', parry: 0.15, throwRate: 0.1, techRate: 0.08, jumpIn: 0, patience: 0.35 },
  },
  {
    id: 'skala',
    card: { name: 'Скала', motto: 'Ошибись первым', story: 'Спарринг-партнёр ринга: стоит в блоке, парирует и наказывает за каждый промах.', colors: { primary: '#7d6608', secondary: '#4d3f05', accent: '#f9e79f' } },
    stats: { health: 5, power: 2, speed: 0, defense: 5 },
    moves: [
      move('jab', 'Тычок', 'normal', [strike({ startup: 5, active: 2, recovery: 17, damage: 30, reach: 'short' })]),
      move('heavy', 'Таран', 'normal', [strike({ startup: 9, active: 4, recovery: 20, damage: 70, push: 'heavy' })]),
      move('sweep', 'Подсечка', 'normal', [strike({ startup: 9, recovery: 22, damage: 45, zone: 'low' })], { posture: 'crouch' }),
      move('armored', 'Сквозь удар', 'special', [{ type: 'armor', hits: 1 }, strike({ startup: 14, active: 4, recovery: 24, damage: 80, push: 'heavy' })], { fx: [{ on: 'start', type: 'glow', color: '#f9e79f' }] }),
      move('quake', 'Обвал', 'super', [strike({ startup: 4, active: 6, recovery: 30, damage: 80, hits: 3 })], { director: { title: 'ОБВАЛ', zoom: 1.5, angle: 'low' } }),
    ],
    style: { range: [130, 220], dash: 0.1, pokes: ['jab', 'sweep'], mixLow: ['sweep'], mixHigh: ['heavy'], punish: ['jab', 'heavy', 'armored'], antiAir: 'heavy', specials: [{ id: 'armored', when: 'near', rate: 0.02 }], superWhen: 'punish', parry: 0.45, throwRate: 0.15, techRate: 0.12, jumpIn: 0, patience: 0.75 },
  },
  {
    id: 'mekhanik',
    card: { name: 'Механик', motto: 'Поле — моё', story: 'Спарринг-партнёр ринга: ставит мины и бьёт разрядом издалека, способности кодом.', colors: { primary: '#1e8449', secondary: '#145a32', accent: '#abebc6' } },
    stats: { health: 3, power: 3, speed: 3, defense: 3 },
    moves: [
      move('jab', 'Тычок', 'normal', [strike({ startup: 5, active: 2, recovery: 9, damage: 30, reach: 'short' })]),
      move('low_poke', 'Низкий тычок', 'normal', [strike({ startup: 7, recovery: 14, damage: 35, zone: 'low' })], { posture: 'crouch' }),
      move('mine', 'Мина', 'special', [{ type: 'ability', script: 'abilities/mine.js', startup: 12, active: 1, recovery: 18 }], { fx: [{ on: 'ability', type: 'sparks', color: '#f4d03f' }] }),
      move('pulse', 'Разряд', 'special', [{ type: 'ability', script: 'abilities/pulse.js', startup: 10, active: 1, recovery: 22 }], { fx: [{ on: 'ability', type: 'shockwave', color: '#abebc6' }] }),
      move('overload', 'Перегрузка', 'super', [strike({ startup: 6, active: 10, recovery: 30, damage: 50, hits: 5 })], { director: { title: 'ПЕРЕГРУЗКА', zoom: 1.5, angle: 'dutch' } }),
    ],
    abilities: {
      'abilities/mine.js': `// A mine: slides forward along the floor and bursts low on touch.
export function start(api) {
  api.spawn({ x: 110, y: 25, w: 60, h: 40, vx: 3, life: 240, color: '#f4d03f', label: 'мина', touch: { damage: 50, zone: 'low' } });
  api.fx([110, 25]);
}
`,
      'abilities/pulse.js': `// A pulse: a moment after the cast, an overhead discharge at mid range that slows.
export function start(api) {
  api.mem.pulse = 0;
}
export function tick(api) {
  api.mem.pulse++;
  if (api.mem.pulse === 12) {
    api.hit({ box: [140, 150, 380, 290], damage: 55, zone: 'overhead', effect: { id: 'slow', ticks: 60, speed: 0.75, label: 'разряд' } });
    api.fx([260, 220]);
    api.end();
  }
}
`,
    },
    style: { range: [260, 420], dash: 0.4, pokes: ['jab', 'low_poke'], mixLow: ['low_poke'], mixHigh: ['jab'], punish: ['jab', 'pulse'], antiAir: 'jab', specials: [{ id: 'mine', when: 'any', rate: 0.05 }, { id: 'pulse', when: 'near', rate: 0.04 }], superWhen: 'punish', parry: 0.2, throwRate: 0.2, techRate: 0.08, jumpIn: 0.01, patience: 0.4 },
  },
];

const core = readFileSync(join(SP, '_core', 'core.js'), 'utf8');
for (const p of PARTNERS) {
  const dir = join(SP, p.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(DUMMY, 'parts'), join(dir, 'parts'), { recursive: true });
  cpSync(join(DUMMY, 'body.json'), join(dir, 'body.json'));
  const voice = JSON.parse(readFileSync(join(DUMMY, 'voice.json'), 'utf8'));
  voice.description = `Голос спарринг-партнёра «${p.card.name}».`;
  writeFileSync(join(dir, 'voice.json'), JSON.stringify(voice, null, 2) + '\n');
  writeFileSync(join(dir, 'fighter.json'), JSON.stringify({ ...p.card, stats: p.stats }, null, 2) + '\n');
  writeFileSync(join(dir, 'moves.json'), JSON.stringify({ moves: p.moves }, null, 2) + '\n');
  writeFileSync(join(dir, 'core.js'), core);
  writeFileSync(join(dir, 'brain.js'), `// Sparring partner «${p.card.name}» of the ring. Style below, the brain itself in core.js.\nimport { makeBrain } from './core.js';\n\nexport default makeBrain(${JSON.stringify(p.style, null, 2)});\n`);
  for (const [file, src] of Object.entries(p.abilities || {})) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), src);
  }
  console.log('sparring:', p.id, p.card.name);
}
