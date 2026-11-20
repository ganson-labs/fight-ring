// Engine tests: determinism, balance limits, the checker.  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { readFighterDir, runFight, replayFight } from '../kit/arena/tools/load.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KIT = join(root, 'tests', 'fixtures', 'ring3', 'fighter');
const DUMMY = join(root, 'tests', 'fixtures', 'ring3', 'dummy');
const raw = (dir) => Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(dir, `${f}.json`), 'utf8'))]));
const compile = (input) => {
  const r = E.checkFighter(input);
  assert.ok(r.ok, r.errors.join('\n'));
  return r.fighter;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

// A scripted, deterministic "brain" for engine-level tests: actions as a function of tick and view.
function play(fighters, script, ticks = 1200) {
  const fight = E.createFight({ fighters });
  const log = [];
  for (let i = 0; i < ticks; i++) {
    const acts = fight.freeze || fight.hitstop || fight.over ? null : [0, 1].map((s) => script(s, E.brainView(fight, s)));
    for (const e of E.stepFight(fight, acts)) log.push({ i, ...e });
  }
  return { fight, log };
}

const aggressor = (s, v) => {
  if (s === 1) return v.tick % 120 < 60 ? { guard: 'high' } : {};
  if (v.me.bars >= 3 && v.distance < 220) return { attack: 'super_1' };
  if (v.distance > 150) return { walk: 1 };
  return v.me.canAct ? (v.tick % 90 === 0 ? { throw: true } : { attack: 'strike_1' }) : {};
};

test('шаблон бойца и манекен проходят проверку', () => {
  for (const dir of [KIT, DUMMY]) {
    const r = readFighterDir(dir);
    assert.ok(r.ok, `${dir}:\n${r.errors.join('\n')}`);
    assert.ok(r.budget.used <= E.MOVE_BUDGET);
  }
});

test('бой повторяется кадр в кадр', () => {
  const fighters = [compile(raw(KIT)), compile(raw(DUMMY))];
  const a = play(fighters, aggressor, 3000);
  const b = play(fighters, aggressor, 3000);
  assert.equal(E.fightHash(a.fight), E.fightHash(b.fight));
  assert.deepEqual(a.log, b.log);
  assert.ok(a.log.some((e) => e.type === 'hit'), 'в тестовом бою есть попадания');
});

test('зеркальный бой одинаковых бойцов даёт одинаковый результат', () => {
  const f = compile(raw(KIT));
  const mirror = (s, v) => (v.distance > 150 ? { walk: 1 } : v.me.canAct ? { attack: 'strike_1' } : {});
  const { fight } = play([f, f], mirror, 2000);
  assert.equal(fight.f[0].hp, fight.f[1].hp);
  assert.ok(Math.abs(fight.f[0].x + fight.f[1].x - E.STAGE.width) < 1e-6);
  assert.equal(fight.winner, null);
});

test('повтор из записи совпадает с живым боем (мозги в Node)', async () => {
  const fighters = [compile(raw(KIT)), compile(raw(DUMMY))];
  const run = await runFight({ dirs: [KIT, DUMMY], fighters, options: { dummy: 'block' }, maxTicks: 900 });
  const again = replayFight(fighters, run.replay);
  assert.equal(E.fightHash(again), run.replay.hash);
});

test('обычный удар не больше 8 % здоровья, даже с силой 5 и контрударом', () => {
  const input = raw(KIT);
  input.fighter.stats = { health: 0, power: 5, speed: 2, defense: 5 };
  input.moves.moves[0].blocks[0].damage = 80;
  const strong = compile(input);
  const weakIn = raw(DUMMY);
  weakIn.fighter.stats = { health: 0, power: 0, speed: 7 - 2, defense: 0 };
  weakIn.fighter.stats.speed = 5;
  const weak = compile(weakIn);
  const { log } = play([strong, weak], (s, v) => (s === 0 ? (v.distance > 150 ? { walk: 1 } : { attack: 'strike_1' }) : {}), 1500);
  const hits = log.filter((e) => e.type === 'hit' && e.attacker === 0);
  assert.ok(hits.length > 3);
  for (const h of hits) assert.ok(h.damage <= Math.floor(weak.derived.hp * E.NORMAL_HIT_CAP), `урон ${h.damage}`); // 8 % of the health damage is written against (before ×HP_MUL)
});

test('серия: каждый следующий удар слабее на 20 %, после 5 ударов неуязвимость', () => {
  const input = raw(KIT);
  input.moves.moves[0].blocks[0] = { type: 'strike', startup: 3, active: 2, recovery: 4, damage: 20, reach: 'long', zone: 'mid' };
  input.moves.moves[0].anim = { keys: [{ t: 0, pose: 'stance' }] };
  const f = compile(input);
  const d = compile(raw(DUMMY));
  const fight = E.createFight({ fighters: [f, d] });
  fight.f[0].x = fight.f[1].x - 120;
  const hits = [];
  for (let i = 0; i < 400 && hits.length < 7; i++) {
    const acts = fight.freeze || fight.hitstop ? null : [{ attack: 'strike_1' }, {}];
    for (const e of E.stepFight(fight, acts)) {
      if (e.type === 'hit') hits.push({ ...e, invuln: fight.f[1].invuln });
      if (e.type === 'comboLimit') hits.push({ type: 'limit' });
    }
  }
  const combo = hits.filter((h) => h.type === 'hit').slice(0, 5);
  assert.equal(combo.length, 5);
  assert.deepEqual(combo.map((h) => h.combo), [1, 2, 3, 4, 5]);
  for (let k = 1; k < 5; k++) assert.ok(combo[k].damage < combo[k - 1].damage);
  // the same move again and again: the combo's ×0.8 and the move's tiredness (S1) together
  const expected = [0, 1, 2, 3, 4].map((k) => Math.round(20 * f.derived.damageMul * d.derived.takenMul * 0.8 ** k * (1 - E.STALE.slice(0, k).reduce((s, w) => s + w, 0))));
  assert.deepEqual(combo.map((h) => h.damage), expected);
  assert.ok(hits.some((h) => h.type === 'limit'));
});

test('суперприём только с полной шкалой и не больше 25 % здоровья', () => {
  const input = raw(KIT);
  const sup = input.moves.moves.find((m) => m.slot === 'super');
  sup.blocks[0] = { type: 'strike', startup: 10, active: 10, recovery: 20, damage: 50, hits: 5, reach: 'long', zone: 'mid' };
  sup.anim = { keys: [{ t: 0, pose: 'stance' }] };
  input.fighter.stats = { health: 2, power: 5, speed: 0, defense: 5 };
  const f = compile(input);
  const d = compile(raw(DUMMY));
  const fight = E.createFight({ fighters: [f, d] });
  fight.f[0].x = fight.f[1].x - 130;
  let ev = E.stepFight(fight, [{ attack: 'super_1' }, {}]);
  assert.ok(!ev.some((e) => e.type === 'super'), 'без шкалы супер не начинается');
  fight.f[0].meter = E.METER_MAX;
  let total = 0;
  let started = false;
  for (let i = 0; i < 300; i++) {
    ev = E.stepFight(fight, fight.freeze || fight.hitstop ? null : [i === 0 ? { attack: 'super_1' } : {}, {}]);
    for (const e of ev) {
      if (e.type === 'super') started = true;
      if (e.type === 'hit' && e.super) total += e.damage;
    }
  }
  assert.ok(started);
  assert.equal(fight.f[0].meter, 0);
  assert.ok(total > 0 && total <= d.derived.maxHp * E.SUPER_TOTAL_CAP, `урон супера ${total}`);
});

test('проверка ловит перебор очков, бюджета и несуществующие блоки', () => {
  const a = raw(KIT);
  a.fighter.stats = { health: 5, power: 5, speed: 3, defense: 0 };
  assert.match(E.checkFighter(a).errors.join('\n'), /сумма 13/);
  const b = raw(KIT);
  for (let i = 0; i < 6; i++) b.moves.moves.push({ ...clone(b.moves.moves[0]), id: `heavy_${i}`, blocks: [{ type: 'strike', startup: 3, active: 3, recovery: 4, damage: 80, reach: 'long', zone: 'overhead', launch: true }] });
  assert.match(E.checkFighter(b).errors.join('\n'), /бюджет 40/);
  const c = raw(KIT);
  c.moves.moves[1].blocks.push({ type: 'trap' });
  assert.match(E.checkFighter(c).errors.join('\n'), /нет блока "trap"/);
  const d = raw(KIT);
  d.moves.moves[0].blocks[0].damage = 81;
  assert.match(E.checkFighter(d).errors.join('\n'), /не больше 80/);
  const e = raw(KIT);
  e.moves.moves[1].blocks[0].damage = 70;
  assert.match(E.checkFighter(e).errors.join('\n'), /предел 250/);
});

test('парирование гасит удар, бросок бьёт блок, свой бросок до захвата ломает бросок (B6)', () => {
  const f = compile(raw(KIT));
  const d = compile(raw(DUMMY));
  const setup = () => {
    const fight = E.createFight({ fighters: [f, d] });
    fight.f[0].x = fight.f[1].x - 120;
    return fight;
  };
  const run = (fight, a0, a1, n = 120) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(...E.stepFight(fight, fight.freeze || fight.hitstop ? null : [a0(i), a1(i, fight)]));
    return out;
  };
  let ev = run(setup(), (i) => (i === 0 ? { attack: 'strike_1' } : {}), (i) => (i === 2 ? { parry: true } : {}));
  assert.ok(ev.some((e) => e.type === 'parry'));
  assert.ok(!ev.some((e) => e.type === 'hit'));
  ev = run(setup(), (i) => (i === 0 ? { throw: true } : {}), () => ({ guard: 'high' }));
  assert.ok(ev.some((e) => e.type === 'throw'));
  // the defender throws a moment before the grab: the throws break each other
  ev = run(setup(), (i) => (i === 0 ? { throw: true } : {}), (i) => (i === 2 ? { throw: true } : {}));
  assert.ok(ev.some((e) => e.type === 'tech'));
  assert.ok(!ev.some((e) => e.type === 'throw'));
  // once grabbed it is too late: a throw input in the grab does nothing (the brains see their own grab at once)
  ev = run(setup(), (i) => (i === 0 ? { throw: true } : {}), (i) => (i >= 7 && i <= 14 ? { throw: true } : {}));
  assert.ok(ev.some((e) => e.type === 'throw'));
  assert.ok(!ev.some((e) => e.type === 'tech'));
});

test('блоки конструктора: снаряд, телепорт, заряд, броня', () => {
  const input = raw(KIT);
  input.moves.moves.push(
    { id: 'shot', name: 'Снаряд', slot: 'special', posture: 'stand', blocks: [{ type: 'projectile', startup: 12, recovery: 20, damage: 50, speed: 'mid', zone: 'mid' }], anim: { keys: [{ t: 0, pose: 'stance' }] } },
    { id: 'blink', name: 'Телепорт', slot: 'special', posture: 'stand', blocks: [{ type: 'teleport', startup: 14, recovery: 10, to: 'behind' }, { type: 'strike', startup: 5, active: 3, recovery: 16, damage: 30, reach: 'mid', zone: 'mid' }], anim: { keys: [{ t: 0, pose: 'stance' }] } },
    { id: 'big', name: 'Заряд', slot: 'special', posture: 'stand', blocks: [{ type: 'charge', maxHold: 30, bonus: 0.3 }, { type: 'armor', hits: 1 }, { type: 'strike', startup: 14, active: 3, recovery: 20, damage: 30, reach: 'mid', zone: 'mid' }], anim: { keys: [{ t: 0, pose: 'stance' }] } },
  );
  const r = E.checkFighter(input);
  assert.ok(r.ok, r.errors.join('\n'));
  const f = r.fighter;
  const d = compile(raw(DUMMY));
  const fight = E.createFight({ fighters: [f, d] });
  let ev = [];
  for (let i = 0; i < 200; i++) ev.push(...E.stepFight(fight, fight.freeze || fight.hitstop ? null : [i === 0 ? { attack: 'shot' } : {}, {}]));
  assert.ok(ev.some((e) => e.type === 'projectile'));
  assert.ok(ev.some((e) => e.type === 'hit' && e.move === 'shot'));

  const f2 = E.createFight({ fighters: [f, d] });
  const startSide = Math.sign(f2.f[1].x - f2.f[0].x);
  for (let i = 0; i < 20; i++) E.stepFight(f2, [i === 0 ? { attack: 'blink' } : {}, {}]);
  assert.equal(Math.sign(f2.f[1].x - f2.f[0].x), -startSide, 'телепорт за спину');

  const charged = (hold) => {
    const fc = E.createFight({ fighters: [f, d] });
    fc.f[0].x = fc.f[1].x - 120;
    let dmg = 0;
    for (let i = 0; i < 200; i++) {
      for (const e of E.stepFight(fc, fc.freeze || fc.hitstop ? null : [i === 0 ? { attack: 'big', hold } : { hold }, {}])) if (e.type === 'hit') dmg = e.damage;
    }
    return dmg;
  };
  assert.ok(charged(true) > charged(false));

  const fa = E.createFight({ fighters: [f, compile(raw(KIT))] });
  fa.f[0].x = fa.f[1].x - 120;
  ev = [];
  for (let i = 0; i < 60; i++) ev.push(...E.stepFight(fa, fa.freeze || fa.hitstop ? null : [i === 0 ? { attack: 'big' } : {}, i === 2 ? { attack: 'strike_1' } : {}]));
  assert.ok(ev.some((e) => e.type === 'armor'), 'броня держит удар на замахе');
});
