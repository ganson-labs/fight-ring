// Prints the kit of ring 4 as the Markdown tables of kit/ARENA.md (so the text never drifts from engine/standard.js).
import { STANDARD_MOVES, SPECIAL_POOL, SUPER_POOL } from '../kit/arena/engine/standard.js';
const P = { stand: 'стоя', crouch: 'присед', air: 'прыжок' };
const Z = { high: 'верх', mid: 'середина', low: 'низ', overhead: 'сверху', air: 'воздух' };
const R = { short: 'короткая', mid: 'средняя', long: 'длинная' };
const row = (m) => {
  const what = m.blocks.map((b) => {
    if (b.type === 'strike') return `удар ${b.startup}/${b.active}/${b.recovery}, урон ${b.damage}${b.hits > 1 ? `×${b.hits}` : ''}, ${Z[b.zone]}, дальность ${R[b.reach]}${b.advance ? `, проходит ${b.advance}` : ''}${b.launch ? ', подброс' : ''}${b.push === 'heavy' ? ', сильный толчок' : ''}`;
    if (b.type === 'projectile') return `снаряд ${b.startup}/–/${b.recovery}, урон ${b.damage}${b.hits > 1 ? `×${b.hits}` : ''}, ${Z[b.zone]}, скорость ${{ slow: 6, mid: 9, fast: 13 }[b.speed]}`;
    if (b.type === 'teleport') return `телепорт ${b.startup}/–/${b.recovery} ${b.to === 'behind' ? 'за спину' : b.to === 'back' ? `назад на ${b.distance}` : `вперёд на ${b.distance}`}`;
    if (b.type === 'armor') return `броня на замахе: ${b.hits} попадание`;
    if (b.type === 'charge') return `заряд до ${b.maxHold} тиков, до ×${1 + b.bonus}`;
    return b.type;
  }).join('; ');
  return `| \`${m.id}\` | ${P[m.posture]} | ${what} |`;
};
const table = (list) => ['| id | Откуда | Что делает (замах/активность/восстановление в тиках) |', '|---|---|---|', ...list.map(row)].join('\n');
console.log(`**Основные приёмы — есть у каждого бойца:**\n\n${table(STANDARD_MOVES)}\n\n**Пул спецприёмов — боец берёт ровно шесть:**\n\n${table(SPECIAL_POOL)}\n\n**Суперприёмы — боец берёт один:**\n\n${table(SUPER_POOL)}`);
