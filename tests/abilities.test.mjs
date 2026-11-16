// Abilities written as code: limits, diminishing control, determinism, measured cooldown.  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { loadFighter, runFight, replayFight, scanAbilityModule } from '../kit/arena/tools/load.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KIT = join(root, 'kit', 'fighter');
const DUMMY = join(root, 'kit', 'arena', 'sparring', 'dummy');
const FIXTURE = join(root, 'tests', 'fixtures', 'ability-fighter');
const raw = (dir) => Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(dir, `${f}.json`), 'utf8'))]));
const L = E.ABILITY;

// A kit fighter with extra ability moves; modules: { id: module object } (no files: the hooks are passed directly).
function withAbilities(modules, { slot = 'special', fighter = {} } = {}) {
  const input = raw(KIT);
  Object.assign(input.fighter, fighter);
  for (const id of Object.keys(modules)) {
    input.moves.moves.push({ id, name: id, slot, posture: 'stand', blocks: [{ type: 'ability', script: `abilities/${id}.js`, startup: 6, recovery: 10 }], anim: { keys: [{ t: 0, pose: 'stance' }] } });
  }
  if (slot === 'super') input.moves.moves = input.moves.moves.filter((m) => m.id !== 'super_1');
  const r = E.checkFighter(input);
  assert.ok(r.ok, r.errors.join('\n'));
  const def = r.fighter;
  const prep = E.prepareAbilities(def, Object.fromEntries(Object.entries(modules).map(([id, m]) => [`abilities/${id}.js`, m])));
  return { def, prep };
}

const dummyDef = () => {
  const r = E.checkFighter(raw(DUMMY));
  assert.ok(r.ok);
  return r.fighter;
};

// Press `id` once (and again when `again` says so), the opponent stands; returns the events.
// at: the tick of the press (control on the opponent never lands in the first L.controlStart ticks of a round)
function cast(def, id, { ticks = 400, gap = 140, again = () => false, foe = dummyDef(), seed, at = 0 } = {}) {
  const fight = E.createFight({ fighters: [def, foe], seed });
  fight.f[0].x = E.STAGE.width / 2 - gap / 2;
  fight.f[1].x = E.STAGE.width / 2 + gap / 2;
  if (def.movesById[id].slot === 'super') fight.f[0].meter = E.METER_MAX;
  const ev = [];
  for (let i = 0; i < ticks; i++) {
    const press = i === at || again(i, fight);
    for (const e of E.stepFight(fight, fight.freeze || fight.hitstop ? null : [press ? { attack: id } : {}, {}])) ev.push({ i, ...e });
  }
  return { fight, ev };
}

test('блоки-заглушки убраны, способность есть в реестре', () => {
  for (const t of ['trap', 'stance', 'assist', 'status', 'resource']) assert.equal(E.BLOCKS[t], undefined);
  assert.equal(E.BLOCKS.ability.kind, 'action');
  const input = raw(KIT);
  input.moves.moves[0].blocks = [{ type: 'ability', script: 'abilities/x.js', startup: 6, recovery: 10 }];
  assert.match(E.checkFighter(input).errors.join('\n'), /обычный приём/);
});

test('тестовый боец со способностями проходит check, сильная способность дороже и с большей перезарядкой', async () => {
  const r = await loadFighter(FIXTURE);
  assert.ok(r.ok, r.errors.join('\n'));
  const by = Object.fromEntries(r.abilities.map((a) => [a.id, a]));
  assert.ok(by.frost.power > by.spark.power);
  assert.ok(by.frost.cooldown > by.spark.cooldown, `${by.frost.cooldown} > ${by.spark.cooldown}`);
  assert.ok(by.frost.cost > by.spark.cost);
  assert.ok(by.frost.measured.control >= 50, 'заморозка замерена как контроль');
  assert.ok(by.burn.measured.damage > 25, 'горение входит в урон');
  assert.equal(r.fighter.movesById.frost.ability.cooldown, by.frost.cooldown);
  assert.ok(r.budget.used <= E.MOVE_BUDGET);
});

test('перезарядка растёт с силой: одна и та же способность с бóльшим уроном', () => {
  const hit = (damage) => ({ start: (api) => api.hit({ box: [0, 0, 200, 290], damage }) });
  const { def } = withAbilities({ weak: hit(15), strong: hit(60) });
  const w = def.movesById.weak.ability;
  const s = def.movesById.strong.ability;
  assert.ok(s.cooldown > w.cooldown && s.cost >= w.cost, `${s.cooldown}/${s.cost} против ${w.cooldown}/${w.cost}`);
  const p = E.abilityPrice({ damage: 0, control: 0, buff: 0, shove: 0, objectTicks: 0 }, 'special');
  let prev = p.cooldown;
  for (let d = 10; d < 500; d += 10) {
    const q = E.abilityPrice({ damage: d, control: 0, buff: 0, shove: 0, objectTicks: 0 }, 'special');
    assert.ok(q.cooldown >= prev);
    prev = q.cooldown;
  }
});

test('урон способности идёт по общим правилам: выше предела срезается, не больше 8 % здоровья', () => {
  const { def, prep } = withAbilities({ nuke: { start: (api) => api.hit({ box: [0, 0, 200, 290], damage: 500 }) } });
  assert.ok(prep.ok, prep.errors.join('\n'));
  assert.ok(prep.report[0].measured.damage <= L.hitDamageMax);
  assert.ok(Object.keys(prep.report[0].cuts).some((m) => /предел попадания вне супера/.test(m)), 'check говорит, что срезано');
  const foe = dummyDef();
  const { ev } = cast(def, 'nuke', { foe });
  const hits = ev.filter((e) => e.type === 'hit' && e.move === 'nuke');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].damage <= Math.floor(foe.derived.maxHp * E.NORMAL_HIT_CAP));
});

test('удар способности блокируется и парируется, как обычный', () => {
  const { def } = withAbilities({ poke: { start: (api) => api.hit({ box: [0, 0, 200, 290], damage: 40, zone: 'mid' }) } });
  const run = (act) => {
    const fight = E.createFight({ fighters: [def, dummyDef()] });
    fight.f[0].x = fight.f[1].x - 140;
    const ev = [];
    let after = null;
    for (let i = 0; i < 60; i++) {
      const got = E.stepFight(fight, fight.freeze || fight.hitstop ? null : [i === 0 ? { attack: 'poke' } : {}, act(i)]);
      ev.push(...got);
      if (!after && got.some((e) => e.type === 'parry')) after = fight.f[0].state;
    }
    return { ev, after };
  };
  assert.ok(run(() => ({ guard: 'high' })).ev.some((e) => e.type === 'block' && e.move === 'poke'));
  const p = run((i) => (i === 3 ? { parry: true } : {}));
  assert.ok(p.ev.some((e) => e.type === 'parry'));
  assert.equal(p.after, 'staggered', 'парированный атакующий замирает');
});

test('контроль и множители срезаются по рамкам, объектов не больше лимита', () => {
  const mods = {
    freeze: { start: (api) => api.effect('opponent', { id: 'f', ticks: 900, stop: true, box: [0, 0, 200, 290] }) },
    slowx: { start: (api) => api.effect('opponent', { id: 's', ticks: 100, speed: 0.05, taken: 3, box: [0, 0, 200, 290] }) },
    swarm: { start: (api) => { for (let i = 0; i < 6; i++) api.spawn({ x: 100 + i * 10, life: 100 }); } },
  };
  const { def, prep } = withAbilities(mods);
  assert.ok(prep.ok, prep.errors.join('\n'));
  const cutsOf = (id) => Object.keys(prep.report.find((r) => r.id === id).cuts).join('\n');
  assert.match(cutsOf('freeze'), /предел запрета действий/);
  assert.match(cutsOf('slowx'), /множитель скорости 0.05 → 0.5/);
  assert.match(cutsOf('slowx'), /получаемого урона 3 → 1.25/);
  assert.match(cutsOf('swarm'), new RegExp(`больше ${L.objectsMax} своих объектов`));

  let { fight } = cast(def, 'freeze', { ticks: L.controlStart + 20, at: L.controlStart + 2 });
  const e = fight.f[1].effects.find((x) => x.id === 'f');
  assert.equal(e.ticks, L.stopTicks);
  assert.equal(fight.f[1].mods.stop, true);
  assert.equal(E.brainView(fight, 1).me.canAct, false);
  ({ fight } = cast(def, 'slowx', { ticks: L.controlStart + 20, at: L.controlStart + 2 }));
  assert.equal(fight.f[1].mods.speed, L.speed[0]);
  assert.equal(fight.f[1].mods.taken, L.taken[1]);
  ({ fight } = cast(def, 'swarm', { ticks: 12 }));
  assert.equal(fight.objects.filter((o) => o.side === 0).length, L.objectsMax);
  assert.equal(E.brainView(fight, 1).objects.length, L.objectsMax, 'объекты видны мозгам соперника');
});

test('повторный контроль в окне слабее: ×1, ×0.5, ×0.25, затем не действует', () => {
  const { def } = withAbilities({ stun: { start: (api) => api.effect('opponent', { id: `s${api.tick}`, ticks: 60, speed: 0.5, box: [0, 0, 200, 290] }) } });
  def.movesById.stun.ability.cooldown = 0; // only here: press it four times in a row
  const fight = E.createFight({ fighters: [def, dummyDef()] });
  fight.f[0].x = E.STAGE.width / 2 - 70;
  fight.f[1].x = E.STAGE.width / 2 + 70;
  const got = [];
  for (let i = 0; i < 300; i++) {
    for (const e of E.stepFight(fight, [fight.tick >= L.controlStart && fight.f[0].state === 'neutral' ? { attack: 'stun' } : {}, {}])) if (e.type === 'effect') got.push(e.ticks);
  }
  assert.deepEqual(got.slice(0, 3), [60, 30, 15]);
  assert.ok(fight.abilityStats[0].cuts[`повторный контроль за ${L.controlWindow} тиков: ×0`] >= 1, 'четвёртый не действует');
});

test('перезарядка соблюдается и видна мозгам', () => {
  const { def } = withAbilities({ zap: { start: (api) => api.hit({ box: [0, 0, 200, 290], damage: 30 }) } });
  const cd = def.movesById.zap.ability.cooldown;
  assert.ok(cd >= E.ABILITY_PRICE.cooldown.min);
  let seen = null;
  const { ev } = cast(def, 'zap', { ticks: cd + 120, again: (i, f) => {
    if (i === 40) seen = E.brainView(f, 0);
    return f.f[0].state === 'neutral';
  } });
  const starts = ev.filter((e) => e.type === 'move' && e.side === 0).map((e) => e.i);
  assert.ok(starts.length >= 2);
  assert.ok(starts[1] - starts[0] >= cd - 1, `второй каст через ${starts[1] - starts[0]} тиков, перезарядка ${cd}`);
  assert.ok(seen.me.cooldowns.zap > 0);
  assert.equal(seen.me.moves.find((m) => m.id === 'zap').cooldown, cd);
});

test('стойка открывает свои приёмы, ресурс ведётся кодом', () => {
  const input = raw(KIT);
  input.fighter.stances = [{ id: 'hot', name: 'Жар' }];
  input.fighter.resources = [{ id: 'heat', name: 'Жар', max: 50 }];
  input.moves.moves.push(
    { id: 'heat_up', name: 'Разогрев', slot: 'special', posture: 'stand', blocks: [{ type: 'ability', script: 'abilities/h.js', startup: 6, recovery: 10 }], anim: { keys: [{ t: 0, pose: 'stance' }] } },
    { id: 'hot_hit', name: 'Жаркий', slot: 'special', posture: 'stand', stance: 'hot', blocks: [{ type: 'strike', startup: 5, active: 2, recovery: 10, damage: 30, reach: 'mid', zone: 'mid' }], anim: { keys: [{ t: 0, pose: 'stance' }] } },
  );
  const r = E.checkFighter(input);
  assert.ok(r.ok, r.errors.join('\n'));
  const def = r.fighter;
  const prep = E.prepareAbilities(def, { 'abilities/h.js': { start(api) { if (api.addResource('heat', 80) >= 50) api.setStance('hot'); } } });
  assert.ok(prep.ok, prep.errors.join('\n'));
  const fight = E.createFight({ fighters: [def, dummyDef()] });
  E.stepFight(fight, [{ attack: 'hot_hit' }, {}]);
  assert.notEqual(fight.f[0].state, 'move', 'вне стойки приём недоступен');
  for (let i = 0; i < 40; i++) E.stepFight(fight, [i === 0 ? { attack: 'heat_up' } : {}, {}]);
  const v = E.brainView(fight, 0).me;
  assert.equal(v.stance, 'hot');
  assert.equal(v.resources.heat.value, 50);
  E.stepFight(fight, [{ attack: 'hot_hit' }, {}]);
  assert.equal(fight.f[0].move?.def.id, 'hot_hit');
  const bad = raw(KIT);
  bad.moves.moves[1].stance = 'cold';
  assert.match(E.checkFighter(bad).errors.join('\n'), /нет стойки "cold"/);
});

test('Math.random, Date и время недоступны способности; ошибка отключает только её', () => {
  for (const [name, fn] of [['Math.random', () => Math.random()], ['Date', () => Date.now()], ['performance', () => performance.now()]]) {
    const { prep } = withAbilities({ cheat: { start: (api) => api.hit({ box: [0, 0, 200, 290], damage: Math.round(fn() % 50) + 1 }) } });
    assert.ok(!prep.ok);
    assert.match(prep.errors.join('\n'), new RegExp(`${name.replace('.', '\\.')}[^\\n]*недоступен`));
  }
  assert.ok(typeof Math.random() === 'number' && Date.now() > 0, 'после хуков всё возвращено');
  const errs = scanAbilityModule(FIXTURE, 'abilities/frost.js');
  assert.deepEqual(errs, []);
});

test('детерминизм: два прогона дают один хэш, повтор записи совпадает с живым боем', async () => {
  const me = await loadFighter(FIXTURE);
  assert.ok(me.ok, me.errors.join('\n'));
  const foe = await loadFighter(DUMMY);
  const fighters = [me.fighter, foe.fighter];
  const a = await runFight({ dirs: [FIXTURE, DUMMY], fighters, options: { dummy: 'stand' }, seed: 42, maxTicks: 1500 });
  const b = await runFight({ dirs: [FIXTURE, DUMMY], fighters, options: { dummy: 'stand' }, seed: 42, maxTicks: 1500 });
  assert.equal(a.replay.hash, b.replay.hash);
  assert.equal(a.replay.seed, 42);
  const kinds = new Set(a.events.map((e) => e.type));
  for (const k of ['ability', 'object', 'effect']) assert.ok(kinds.has(k), `в бою есть событие ${k}`);
  const again = replayFight(fighters, JSON.parse(JSON.stringify(a.replay)));
  assert.equal(E.fightHash(again), a.replay.hash);
});

test('бой со способностями против манекена в runFight проходит, мозги видят способности', async () => {
  const me = await loadFighter(FIXTURE);
  const foe = await loadFighter(DUMMY);
  const run = await runFight({ dirs: [FIXTURE, DUMMY], fighters: [me.fighter, foe.fighter], options: { dummy: 'stand' }, maxTicks: 3000 });
  assert.equal(run.stats[0].errors, 0, run.stats[0].lastError);
  assert.equal(run.fight.abilityStats[0].errors.length, 0, JSON.stringify(run.fight.abilityStats[0].errors));
  assert.ok(run.events.some((e) => e.type === 'hit' && e.attacker === 0 && ['spark', 'frost', 'burn'].includes(e.move)));
  assert.ok(run.events.some((e) => e.type === 'dot'));
  const v = E.brainView(run.fight, 1);
  assert.ok('cooldowns' in v.opponent && 'effects' in v.opponent && 'resources' in v.opponent);
  assert.ok(v.opponent.moves.find((m) => m.id === 'frost').ability.cooldown > 0);
});

test('каст в бою не делает больше замеренного', () => {
  // the code hits harder from the second cast on: measured on one cast, so the fight cuts the rest
  let n = 0;
  const { def } = withAbilities({ sneaky: { start(api) { api.mem.n = (api.mem.n || 0) + 1; n = api.mem.n; api.hit({ box: [0, 0, 200, 290], damage: api.mem.n > 1 ? 80 : 10 }); } } });
  def.movesById.sneaky.ability.cooldown = 0;
  const { ev, fight } = cast(def, 'sneaky', { ticks: 300, again: (i, f) => f.f[0].state === 'neutral' && f.f[1].state === 'neutral' });
  assert.ok(n > 1);
  const cap = def.movesById.sneaky.ability.measured.damage * L.capMul + L.capAdd.damage;
  for (const h of ev.filter((e) => e.type === 'hit' && e.move === 'sneaky')) assert.ok(h.damage <= cap, `урон ${h.damage}, предел каста ${cap}`);
  assert.ok(Object.keys(fight.abilityStats[0].cuts).some((m) => /больше замеренного/.test(m)));
});


// ---------- control on the opponent: only through a hit or a box within reach, not at the start, 90 ticks of stop ----------

test('контроль и урон по времени без попадания и без box снимаются, остальное действует; check это печатает', () => {
  const { def, prep } = withAbilities({ far: { start: (api) => api.effect('opponent', { id: 'p', ticks: 120, stop: true, dot: 10, taken: 1.2 }) } });
  assert.ok(prep.ok, prep.errors.join('\n'));
  const r = prep.report.find((x) => x.id === 'far');
  assert.match(Object.keys(r.cuts).join('\n'), /только через попадание api\.hit или с box/);
  assert.equal(r.measured.damage, 0, 'замер не считает снятый урон по времени');
  const { fight, ev } = cast(def, 'far', { ticks: 200, at: 100, gap: 600 });
  assert.ok(!ev.some((e) => e.type === 'effect' && e.stop), 'stop не наложен');
  assert.ok(fight.f[1].effects.some((e) => e.id === 'p' && !e.stop && e.dot === 0 && e.taken === 1.2), 'dot снят, множитель урона остался');
  assert.match(Object.keys(fight.abilityStats[0].cuts).join('\n'), /урон по времени на соперника — только через попадание/);
});

// ---------- damage over time: like control, at most 1.5 % of health a second on one target, not through a block ----------

const dotFight = (def, foeAction = () => ({})) => {
  def.movesById.curse.ability.cooldown = 0;
  const fight = E.createFight({ fighters: [def, dummyDef()] });
  fight.f[0].x = E.STAGE.width / 2 - 70;
  fight.f[1].x = E.STAGE.width / 2 + 70;
  const dot = [];
  for (let i = 0; i < 600; i++) {
    const act = [fight.f[0].state === 'neutral' ? { attack: 'curse' } : {}, foeAction(i)];
    for (const e of E.stepFight(fight, fight.freeze || fight.hitstop ? null : act)) if (e.type === 'dot') dot.push({ i, ...e });
  }
  return { fight, dot };
};
const curse = { curse: { start: (api) => { for (let k = 0; k < 4; k++) api.effect('opponent', { id: `c${k}`, ticks: 300, dot: 20, box: [0, 0, 200, 290] }); } } };

test('урон по времени: все эффекты на одной цели вместе не больше 1,5 % здоровья в секунду, срез печатается', () => {
  const { def } = withAbilities(curse);
  const { fight, dot } = dotFight(def);
  const cap = (L.dotCapShare * fight.f[1].maxHp) / E.HP_MUL;
  assert.ok(dot.length > 0, 'урон по времени идёт');
  // every second window from the first landing: no more than the cap (and one landing of rounding)
  for (let t = dot[0].i; t + 60 <= 600; t += 60) {
    const sum = dot.filter((e) => e.i >= t && e.i < t + 60).reduce((a, e) => a + e.damage, 0);
    assert.ok(sum <= cap + 1, `за секунду с тика ${t}: ${sum} > ${cap}`);
  }
  assert.match(Object.keys(fight.abilityStats[0].cuts).join('\n'), /урон по времени на одной цели сверх 1\.5 %/);
});

test('урон по времени не проходит через блок', () => {
  const { def } = withAbilities(curse);
  const open = dotFight(def);
  const guarded = dotFight(def, (i) => (i >= 200 ? { guard: 'high' } : {}));
  assert.ok(open.dot.some((e) => e.i >= 200), 'без блока урон идёт и после 200-го тика');
  assert.ok(guarded.dot.some((e) => e.i < 200), 'до блока урон шёл');
  assert.ok(!guarded.dot.some((e) => e.i > 205), 'в блоке урона по времени нет');
});

test('контроль коробкой: только если коробка касается соперника в пределах досягаемости', () => {
  const { def } = withAbilities({ grab: { start: (api) => api.effect('opponent', { id: 'g', ticks: 40, stop: true, box: [0, 0, 900, 290] }) } });
  const near = cast(def, 'grab', { ticks: 120, at: 80, gap: 140 });
  assert.ok(near.ev.some((e) => e.type === 'effect' && e.stop), 'вблизи stop есть');
  const far = cast(def, 'grab', { ticks: 120, at: 80, gap: 600 });
  assert.ok(!far.ev.some((e) => e.type === 'effect'), `на 600 ед. коробка обрезана до ${L.controlReach} и не достаёт`);
  assert.match(Object.keys(far.fight.abilityStats[0].cuts).join('\n'), /коробка эффекта дальше/);
});

test('через попадание контроль накладывается, в блок — нет', () => {
  const { def } = withAbilities({ jab: { start: (api) => api.hit({ box: [0, 100, 200, 290], damage: 20, effect: { id: 'j', ticks: 40, stop: true } }) } });
  const hit = cast(def, 'jab', { ticks: 120, at: 80 });
  assert.ok(hit.ev.some((e) => e.type === 'effect' && e.stop));
  const fight = E.createFight({ fighters: [def, dummyDef()] });
  fight.f[0].x = E.STAGE.width / 2 - 70;
  fight.f[1].x = E.STAGE.width / 2 + 70;
  const ev = [];
  for (let i = 0; i < 120; i++) ev.push(...E.stepFight(fight, fight.freeze || fight.hitstop ? null : [i === 80 ? { attack: 'jab' } : {}, { guard: 'high' }]));
  assert.ok(ev.some((e) => e.type === 'block'), 'удар ушёл в блок');
  assert.ok(!ev.some((e) => e.type === 'effect'));
});

test('в первые 60 тиков раунда контроль не накладывается, а замер его видит', () => {
  const { def, prep } = withAbilities({ opener: { start: (api) => api.effect('opponent', { id: 'o', ticks: 60, stop: true, box: [0, 0, 200, 290] }) } });
  assert.ok(prep.report.find((x) => x.id === 'opener').measured.control >= 60, 'замер на манекене — не начало раунда');
  const early = cast(def, 'opener', { ticks: 100, at: 0 });
  assert.ok(!early.ev.some((e) => e.type === 'effect' && e.stop));
  assert.match(Object.keys(early.fight.abilityStats[0].cuts).join('\n'), new RegExp(`первые ${L.controlStart} тиков раунда`));
});

test('одна цель стоит не больше 90 тиков за раунд', () => {
  const { def } = withAbilities({ hold: { start: (api) => api.effect('opponent', { id: `h${api.tick}`, ticks: 60, stop: true, box: [0, 0, 200, 290] }) } });
  def.movesById.hold.ability.cooldown = 0;
  const fight = E.createFight({ fighters: [def, dummyDef()] });
  fight.f[0].x = E.STAGE.width / 2 - 70;
  fight.f[1].x = E.STAGE.width / 2 + 70;
  let stopped = 0;
  for (let i = 0; i < 1500; i++) {
    for (const e of E.stepFight(fight, [fight.tick >= L.controlStart && fight.f[0].state === 'neutral' ? { attack: 'hold' } : {}, {}])) if (e.type === 'effect' && e.stop) stopped += e.ticks;
  }
  assert.ok(stopped > 0 && stopped <= L.stopRound, `stop всего ${stopped}`);
  assert.equal(fight.f[1].stopUsed, stopped);
});
