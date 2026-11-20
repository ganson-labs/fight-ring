// Ring 4: one kit for everyone. A fighter chooses specials and a super from the ring's pools and brings its look;
// it cannot change a number of a move, its stats, or bring a move of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';

E.setRuleset('standard');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = (dir) => Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(dir, `${f}.json`), 'utf8'))]));
const KIT = join(root, 'kit', 'fighter');
const errs = (input) => E.checkFighter(input).errors.join('\n');
const mechanics = (def) => JSON.stringify(def.moves.map((m) => [m.id, m.slot, m.posture, m.blocks]));

test('шаблон и партнёры проходят проверку, без поля stats боец ровный 3/3/3/3', () => {
  for (const d of [KIT, ...['dummy', 'shkval', 'strelok', 'skala', 'mekhanik'].map((n) => join(root, 'kit', 'arena', 'sparring', n))]) {
    const r = E.checkFighter(raw(d));
    assert.ok(r.ok, `${d}: ${r.errors.join('\n')}`);
    assert.deepEqual(r.fighter.stats, E.STANDARD_STATS);
    assert.equal(r.fighter.derived.maxHp, 1000 * E.STANDARD_SCALE.hpMul);
    assert.equal(r.fighter.moves.length, E.STANDARD_MOVES.length + E.LOADOUT.specials + E.LOADOUT.supers);
  }
});

test('число приёма, характеристики, свой приём и способность кодом не проходят', () => {
  const a = raw(KIT);
  a.moves.moves[0].blocks = [{ type: 'strike', startup: 3, active: 3, recovery: 8, damage: 25, reach: 'short', zone: 'mid' }];
  assert.match(errs(a), /механику приёма задаёт ринг/);
  const b = raw(KIT);
  b.fighter.stats = { health: 5, power: 5, speed: 3, defense: 0 };
  assert.match(errs(b), /сумма 13/);
  const c = raw(KIT);
  c.moves.moves.push({ id: 'trezvon', name: 'Трезвон', slot: 'special', posture: 'stand', blocks: [{ type: 'ability', script: 'abilities/x.js', startup: 4, active: 1, recovery: 6 }] });
  assert.match(errs(c), /в наборе ринга нет приёма "trezvon"/);
  const d = raw(KIT);
  d.fighter.resources = [{ id: 'zavod', name: 'Завод', max: 12 }];
  assert.match(errs(d), /стоек и своих ресурсов в наборе ринга нет/);
});

test('выбор: ровно шесть спецприёмов из пула и один суперприём', () => {
  const a = raw(KIT);
  a.moves.moves.push({ id: 'ram' });
  assert.match(errs(a), /спецприёмов из пула нужно ровно 6, сейчас 7/);
  const b = raw(KIT);
  b.moves.moves.push({ id: 'storm' });
  assert.match(errs(b), /суперприём нужен ровно один, сейчас 2/);
  const c = raw(KIT);
  c.moves.moves = c.moves.moves.filter((m) => m.id !== 'finale');
  assert.match(errs(c), /суперприём нужен ровно один, сейчас 0/);
});

test('облик не меняет механику: свои имя, анимация и эффекты — те же числа приёма', () => {
  const plain = E.checkFighter(raw(KIT)).fighter;
  const a = raw(KIT);
  for (const m of a.moves.moves) {
    m.name = 'Своё имя';
    m.fx = [{ on: 'hit', type: 'sparks', color: '#ff0000' }];
    m.anim = { keys: [{ t: 0, pose: { bones: { torso: 20 } } }] };
  }
  const r = E.checkFighter(a);
  assert.ok(r.ok, r.errors.join('\n'));
  assert.equal(mechanics(r.fighter), mechanics(plain));
  assert.equal(r.fighter.movesById.jab.name, 'Своё имя');
});

test('удар с advance несёт бойца вперёд и не проходит сквозь соперника', () => {
  const def = E.checkFighter(raw(KIT)).fighter;
  const idle = E.IDLE_ACTION;
  const run = (gap) => {
    const fight = E.createFight({ fighters: [def, def], start: { x: [800, 800 + gap], delay: [0, 0] } });
    E.stepFight(fight, [{ ...idle, attack: 'rush' }, idle]);
    for (let i = 0; i < 18; i++) E.stepFight(fight, [idle, idle]);
    return fight.f[0].x - 800;
  };
  assert.ok(Math.abs(run(900) - 280) < 1, `прошёл ${run(900)}`);
  assert.ok(run(200) <= 200 - E.PUSH_WIDTH + 1e-9, `упёрся в соперника: ${run(200)}`);
});

test('телосложение: 12 очков меняют здоровье, силу, скорость и защиту в узких рамках, числа приёмов те же', () => {
  const a = raw(KIT);
  a.fighter.stats = { health: 5, power: 5, speed: 2, defense: 0 };
  const r = E.checkFighter(a);
  assert.ok(r.ok, r.errors.join('\n'));
  assert.equal(r.fighter.derived.maxHp, 1120 * E.STANDARD_SCALE.hpMul);
  assert.equal(r.fighter.derived.damageMul.toFixed(2), '1.08');
  assert.equal(mechanics(r.fighter), mechanics(E.checkFighter(raw(KIT)).fighter));
});

test('объекты сцены: два предмета зеркально от центра; боец рядом швыряет предмет, удар прерывает захват', () => {
  const def = E.checkFighter(raw(KIT)).fighter;
  const idle = E.IDLE_ACTION;
  const P = E.ARENA.objects;
  const probe = E.createFight({ fighters: [def, def], seed: 11 });
  const xs = E.brainView(probe, 0).props.map((o) => o.x);
  assert.equal(xs.length, 2);
  assert.equal(xs[0] + xs[1], E.STAGE.width);
  assert.ok(E.STAGE.width / 2 - xs[0] >= P.near && E.STAGE.width / 2 - xs[0] <= P.far);
  // the left fighter stands at its object, the right one far away with no guard: the object knocks it down
  const a = E.createFight({ fighters: [def, def], seed: 11, start: { x: [xs[0], xs[0] + 600], delay: [0, 0] } });
  const ev = [];
  E.stepFight(a, [{ ...idle, use: true }, idle]);
  assert.equal(a.f[0].state, 'neutral', 'до 5-й секунды предмет не взять');
  for (let i = 0; i < P.from; i++) E.stepFight(a, [idle, idle]);
  ev.push(...E.stepFight(a, [{ ...idle, use: true }, idle]));
  for (let i = 0; i < 120; i++) ev.push(...E.stepFight(a, [idle, idle]));
  assert.equal(E.brainView(a, 0).props.length, 1);
  const hit = ev.find((e) => e.type === 'hit' && e.move === 'stage');
  assert.ok(hit && hit.damage === P.damage && hit.launch, JSON.stringify(hit));
  // a jab during the grab: the object stays
  const b = E.createFight({ fighters: [def, def], seed: 11, start: { x: [xs[0], xs[0] + 100], delay: [0, 0] } });
  for (let i = 0; i < P.from; i++) E.stepFight(b, [idle, idle]);
  E.stepFight(b, [{ ...idle, use: true }, { ...idle, attack: 'jab' }]);
  for (let i = 0; i < 60; i++) E.stepFight(b, [idle, idle]);
  assert.equal(E.brainView(b, 0).props.length, 2);
  // far from an object `use` does nothing; a fight of the constructor has no objects
  const c = E.createFight({ fighters: [def, def], seed: 11, start: { x: [xs[0] + 200, xs[0] + 700], delay: [0, 0] } });
  for (let i = 0; i < P.from; i++) E.stepFight(c, [idle, idle]);
  E.stepFight(c, [{ ...idle, use: true }, idle]);
  assert.equal(c.f[0].state, 'neutral');
  assert.equal(E.createFight({ fighters: [def, def], arena: false }).props, undefined);
});
