// Move constructor: every move is built from blocks. A block has parameters, a cost in budget points,
// and runtime behaviour in sim.js. "action" blocks run one after another on the move's timeline;
// "modifier" blocks change the move as a whole. New blocks are added here (plus their runtime in sim.js):
// the checker, the cost table in `arena check` and the docs read this registry.
import { ABILITY, ABILITY_PRICE } from './constants.js';

const int = (min, max, extra = {}) => ({ type: 'int', min, max, ...extra });
const num = (min, max, extra = {}) => ({ type: 'number', min, max, ...extra });
const oneOf = (values, extra = {}) => ({ type: 'enum', values, ...extra });
const bool = (extra = {}) => ({ type: 'bool', ...extra });
const path = (extra = {}) => ({ type: 'path', ...extra });

// Damage cost: per-hit damage outside supers, the whole damage of the move in a super.
function damageCost(p, slot, mul = 1) {
  const hits = p.hits ?? 1;
  if (slot === 'super') return Math.ceil((p.damage * hits * mul) / 50);
  return Math.ceil((p.damage * mul * (1 + 0.6 * (hits - 1))) / 20);
}

export const BLOCKS = {
  strike: {
    kind: 'action',
    title: 'Удар',
    about: 'Хитбокс перед бойцом. Несколько попаданий — hits, они идут равномерно внутри active.',
    params: {
      startup: int(3, 40, { required: true }),
      active: int(1, 12, { required: true }),
      recovery: int(4, 60, { required: true }),
      damage: int(1, 250, { required: true }),
      hits: int(1, 5, { default: 1 }),
      reach: oneOf(['short', 'mid', 'long'], { required: true }),
      zone: oneOf(['high', 'mid', 'low', 'overhead', 'air'], { required: true }),
      launch: bool({ default: false }),
      push: oneOf(['light', 'heavy'], { default: 'light' }),
    },
    cost(p, slot, mods) {
      let c = 1 + damageCost(p, slot, mods.chargeMul);
      c += p.startup <= 4 ? 3 : p.startup <= 6 ? 2 : p.startup <= 9 ? 1 : 0;
      c += { short: 0, mid: 1, long: 2 }[p.reach];
      c += p.zone === 'low' || p.zone === 'overhead' ? 1 : 0;
      c += p.launch ? 2 : 0;
      c += p.push === 'heavy' ? 1 : 0;
      if (p.recovery >= 25) c -= 1;
      return Math.max(1, c);
    },
    check(p, move) {
      const e = [];
      if (p.hits > p.active) e.push(`hits (${p.hits}) не может быть больше active (${p.active}): одно попадание на тик`);
      if (p.zone === 'air' && move.posture !== 'air') e.push('zone "air" — только у приёмов с posture "air"');
      if (move.posture === 'air' && p.zone !== 'air') e.push('в воздухе удар бывает только zone "air"');
      if (move.slot !== 'super' && p.damage > 80) e.push(`damage ${p.damage}: вне суперприёма удар не больше 80 (8 % здоровья)`);
      return e;
    },
    duration: (p) => ({ startup: p.startup, active: p.active, recovery: p.recovery }),
  },

  projectile: {
    kind: 'action',
    title: 'Снаряд',
    about: 'Летит вперёд по прямой. У бойца на поле одновременно не больше одного своего снаряда; встречные снаряды гасят друг друга.',
    params: {
      startup: int(6, 40, { required: true }),
      recovery: int(8, 60, { required: true }),
      damage: int(1, 250, { required: true }),
      hits: int(1, 3, { default: 1 }),
      speed: oneOf(['slow', 'mid', 'fast'], { required: true }),
      zone: oneOf(['high', 'mid', 'low'], { required: true }),
    },
    cost(p, slot, mods) {
      let c = 2 + damageCost(p, slot, mods.chargeMul);
      c += { slow: 0, mid: 1, fast: 2 }[p.speed];
      c += p.startup <= 10 ? 1 : 0;
      c += p.zone === 'low' ? 1 : 0;
      return c;
    },
    check(p, move) {
      const e = [];
      if (move.slot !== 'super' && p.damage > 80) e.push(`damage ${p.damage}: вне суперприёма попадание не больше 80 (8 % здоровья)`);
      return e;
    },
    duration: (p) => ({ startup: p.startup, active: 1, recovery: p.recovery }),
  },

  teleport: {
    kind: 'action',
    title: 'Телепорт',
    about: 'Боец исчезает в конце startup и появляется в новом месте. Последние 6 тиков startup неуязвим.',
    params: {
      startup: int(8, 30, { required: true }),
      recovery: int(4, 40, { required: true }),
      to: oneOf(['behind', 'forward', 'back'], { required: true }),
      distance: int(120, 500, { default: 250 }),
    },
    cost(p) {
      return 2 + (p.to === 'behind' ? 2 : 0) + (p.startup <= 12 ? 1 : 0);
    },
    check(p, move) {
      return move.posture === 'air' ? ['телепорт только с земли (posture "stand" или "crouch")'] : [];
    },
    duration: (p) => ({ startup: p.startup, active: 1, recovery: p.recovery }),
  },

  charge: {
    kind: 'modifier',
    title: 'Заряд',
    about: 'Пока мозги держат hold: true, приём замирает перед первым ударом или снарядом (до maxHold тиков). Урон растёт до ×(1 + bonus).',
    params: {
      maxHold: int(10, 60, { required: true }),
      bonus: num(0.1, 0.6, { required: true }),
    },
    cost(p) {
      return 1 + Math.ceil(p.bonus * 5);
    },
    check(p, move) {
      const target = move.blocks.find((b) => b.type === 'strike' || b.type === 'projectile');
      return target ? [] : ['заряду нужен удар или снаряд в этом приёме'];
    },
  },

  armor: {
    kind: 'modifier',
    title: 'Броня на замахе',
    about: 'С начала приёма до первого активного тика выдерживает hits ударов: урон ×0.5, приём не прерывается. Бросок броню пробивает.',
    params: {
      hits: int(1, 2, { required: true }),
    },
    cost(p) {
      return 3 * p.hits;
    },
    check() {
      return [];
    },
  },

  ability: {
    kind: 'action',
    title: 'Способность кодом',
    about: 'Твой модуль JS (script) на примитивах ринга. Хуки: start(api) в первый активный тик, tick(api) пока живут её объекты и эффекты, passive(api) каждый тик боя. Силу ринг измеряет сам и назначает перезарядку и стоимость.',
    params: {
      script: path({ required: true }),
      startup: int(4, 40, { required: true }),
      active: int(1, 60, { default: 1 }),
      recovery: int(6, 60, { required: true }),
    },
    // Until the ring has measured the ability this is the lower bound; the measured price replaces it (abilityPrice).
    cost(p) {
      return p.measuredCost ?? ABILITY_PRICE.cost.base;
    },
    check(p, move) {
      return move.blocks.filter((b) => b.type === 'ability').length > 1 ? ['в приёме может быть только одна способность'] : [];
    },
    duration: (p) => ({ startup: p.startup, active: p.active, recovery: p.recovery }),
  },
};

const SCRIPT_PATH = /^[A-Za-z0-9_\-][A-Za-z0-9_\-./]*\.m?js$/;

// Price of an ability from its measurement. Monotonic: more power — longer cooldown and higher cost.
export function abilityPower(m) {
  const w = ABILITY_PRICE.weights;
  return m.damage * w.damage + m.control * w.control + m.buff * w.buff + m.shove * w.shove + m.objectTicks * w.objectTicks;
}

export function abilityPrice(m, slot) {
  const power = abilityPower(m);
  const cd = ABILITY_PRICE.cooldown;
  const c = ABILITY_PRICE.cost;
  const cooldown = slot === 'super' ? 0 : Math.min(cd.max, Math.max(cd.min, Math.round(cd.base + power * cd.perPower)));
  const cost = Math.min(c.max, c.base + Math.ceil(power / (slot === 'super' ? c.perPowerSuper : c.perPower)));
  return { power, cooldown, cost };
}

// What the ability code can call. Printed by `arena blocks`; the rules in detail are in ARENA.md.
export const ABILITY_PRIMITIVES = [
  ['api.hit({ box, damage, zone, launch, push, effect })', `удар по коробке [x0, y0, x1, y1] от источника (x вперёд): общий путь попаданий — блок, парирование, броня, серия ×0.8, 8 % / 25 %, шкалы. damage до ${ABILITY.hitDamageMax} (в супере до ${ABILITY.hitDamageMaxSuper}), один источник бьёт не чаще раза в ${ABILITY.hitEvery} тиков. effect — эффект на соперника при чистом попадании. Ответ: hit, block, parry, armor, miss, wait, cut`],
  ['api.effect(target, { id, ticks, speed, taken, dot, stop, drift, label, color, icon, particles })', `эффект на "opponent" или "me": до ${ABILITY.effectTicks} тиков (stop до ${ABILITY.stopTicks}, замедление до ${ABILITY.slowTicks}); speed ${ABILITY.speed.join('…')}, taken ${ABILITY.taken.join('…')} (итог всех эффектов в тех же рамках), dot до ${ABILITY.dotMax} урона в секунду, drift до ${ABILITY.driftMax} ед./тик; повторный контроль за ${ABILITY.controlWindow} тиков слабее: ${ABILITY.controlDecay.map((k) => `×${k}`).join(', ')}; не больше ${ABILITY.effectsMax} эффектов на цели`],
  ['api.spawn({ x, y, w, h, vx, vy, life, tick, touch, solid, image, color, particles, label, data })', `объект на поле, не больше ${ABILITY.objectsMax} своих сразу, живёт до ${ABILITY.objectLife} тиков, скорость до ${ABILITY.objectSpeed} ед./тик; tick(api, o) — поведение каждый тик; touch — удар при касании; solid — стена шириной до ${ABILITY.solidWidthMax}`],
  ['api.remove(id?)', 'убрать свой объект (в поведении объекта без id — этот)'],
  ['api.shove(target, dx)', `сдвинуть "me" или "opponent" по x (вперёд от себя), не больше ${ABILITY.shovePerTick} ед. на цель за тик, стены держат`],
  ['api.resource(id) / api.addResource(id, delta)', 'свой ресурс из fighter.json → resources: прочитать и изменить в пределах 0…max'],
  ['api.setStance(id | null)', 'стойка из fighter.json → stances; приём с полем stance доступен только в ней'],
  ['api.view()', 'всё о бою, как видят мозги'],
  ['api.objects()', 'свои объекты на поле'],
  ['api.fx([x, y])', 'показать эффекты приёма с on: "ability" в точке (только для зрителя)'],
  ['api.end()', 'закончить каст: tick больше не вызывается'],
  ['api.rand(), api.mem, api.t, api.tick, api.side, api.move', `случайность с зерном ринга, своя память на бой, тик каста, тик боя, сторона, id приёма. Не больше ${ABILITY.hookCallsPerTick} вызовов примитивов за тик`],
];

// Fill defaults and check types. Returns { value, errors }.
export function readParams(spec, raw) {
  const value = {};
  const errors = [];
  for (const [name, s] of Object.entries(spec)) {
    let v = raw?.[name];
    if (v === undefined) {
      if (s.required) {
        errors.push(`${name}: обязательный параметр`);
        continue;
      }
      v = s.default;
    }
    if (s.type === 'int' && !(Number.isInteger(v) && v >= s.min && v <= s.max)) {
      errors.push(`${name}: целое от ${s.min} до ${s.max}, сейчас ${JSON.stringify(v)}`);
      continue;
    }
    if (s.type === 'number' && !(typeof v === 'number' && Number.isFinite(v) && v >= s.min && v <= s.max)) {
      errors.push(`${name}: число от ${s.min} до ${s.max}, сейчас ${JSON.stringify(v)}`);
      continue;
    }
    if (s.type === 'enum' && !s.values.includes(v)) {
      errors.push(`${name}: одно из ${s.values.map((x) => `"${x}"`).join(', ')}, сейчас ${JSON.stringify(v)}`);
      continue;
    }
    if (s.type === 'path' && !(typeof v === 'string' && SCRIPT_PATH.test(v) && !v.split('/').includes('..'))) {
      errors.push(`${name}: путь к модулю .js внутри папки бойца, например "abilities/x.js", сейчас ${JSON.stringify(v)}`);
      continue;
    }
    if (s.type === 'bool' && typeof v !== 'boolean') {
      errors.push(`${name}: true или false, сейчас ${JSON.stringify(v)}`);
      continue;
    }
    value[name] = v;
  }
  for (const name of Object.keys(raw || {})) {
    if (name !== 'type' && !(name in spec)) errors.push(`${name}: такого параметра у блока нет`);
  }
  return { value, errors };
}
