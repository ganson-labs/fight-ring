// Ring 3.0: one test for every rule of docs/v3/rules.md (R, B, O, W, M, P, C, N, D).  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { loadBrain, runFight } from '../kit/arena/tools/load.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KIT = join(root, 'tests', 'fixtures', 'ring3', 'fighter');
const DUMMY = join(root, 'tests', 'fixtures', 'ring3', 'dummy');
const raw = (dir) => Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(dir, `${f}.json`), 'utf8'))]));
const L = E.ABILITY;
const anim = { keys: [{ t: 0, pose: 'stance' }] };

// A kit fighter with extra moves (strikes or abilities whose modules are passed as objects), compiled and priced.
function fighter({ moves = [], abilities = {}, stats = null, recovery = 10 } = {}) {
  const input = raw(KIT);
  if (stats) input.fighter.stats = stats;
  input.moves.moves.push(...moves.map((m) => ({ name: m.id, slot: 'normal', posture: 'stand', anim, ...m })));
  for (const id of Object.keys(abilities)) input.moves.moves.push({ id, name: id, slot: 'special', posture: 'stand', blocks: [{ type: 'ability', script: `abilities/${id}.js`, startup: 6, recovery }], anim });
  const r = E.checkFighter(input);
  assert.ok(r.ok, r.errors.join('\n'));
  if (Object.keys(abilities).length) {
    const prep = E.prepareAbilities(r.fighter, Object.fromEntries(Object.entries(abilities).map(([id, m]) => [`abilities/${id}.js`, m])));
    assert.ok(prep.ok, prep.errors.join('\n'));
    r.fighter.report = prep.report;
  }
  return r.fighter;
}
const dummy = () => E.checkFighter(raw(DUMMY)).fighter;
// a fight with the fighters gap apart around the centre; ether: an endless pool for tests of other rules
function fightOf(fighters, { gap = 140, ether = Infinity } = {}) {
  const fight = E.createFight({ fighters });
  fight.f[0].x = fight.f[0].px = E.STAGE.width / 2 - gap / 2;
  fight.f[1].x = fight.f[1].px = E.STAGE.width / 2 + gap / 2;
  if (ether !== null) for (const F of fight.f) F.ether = ether;
  return fight;
}
// step n ticks; act(i, fight) → [left, right]; returns the events with i
function steps(fight, n, act = () => [{}, {}]) {
  const ev = [];
  for (let i = 0; i < n; i++) for (const e of E.stepFight(fight, fight.freeze || fight.hitstop ? null : act(i, fight))) ev.push({ i, tick: fight.tick, ...e });
  return ev;
}
const heavy = { id: 'heavy', blocks: [{ type: 'strike', startup: 10, active: 3, recovery: 12, damage: 80, reach: 'mid', zone: 'mid' }] };

// ---------- R: time and reaction ----------

test('R1: мозги видят соперника на reaction тиков позже, себя сразу; reaction в виде и в init', () => {
  const fight = E.createFight({ fighters: [dummy(), dummy()] });
  const xs = [];
  for (let i = 0; i < 40; i++) {
    E.stepFight(fight, [{ walk: 1 }, { walk: -1 }]);
    xs[fight.tick] = fight.f[1].x;
  }
  const v = E.brainView(fight, 0);
  assert.equal(v.reaction, E.REACTION_TICKS);
  assert.equal(v.me.x, fight.f[0].x);
  // the state at the start of tick t − reaction is the state after the step of tick t − reaction − 1
  assert.equal(v.opponent.x, xs[fight.tick - E.REACTION_TICKS - 1]);
});

test('R2: удар способности через весь экран приходит позже и виден защитнику ≥ 7 тиков', () => {
  const far = fighter({ abilities: { snipe: { start: (api) => api.hit({ box: [800, 0, 900, 290], damage: 40 }) } } });
  const fight = fightOf([far, dummy()], { gap: 900 });
  let seen = null;
  const ev = steps(fight, 80, (i, f) => {
    const s = E.brainView(f, 1).strikes.find((x) => !x.mine);
    if (s && seen === null) seen = { i, in: s.in };
    return [i === 0 ? { attack: 'snipe' } : {}, {}];
  });
  const warn = ev.find((e) => e.type === 'strikeWarn');
  assert.equal(warn.ticks, E.telegraphTicks(850));
  assert.ok(warn.ticks > E.telegraphTicks(0) + 20, 'издалека намного позже, чем в упор');
  assert.ok(seen && seen.in >= E.TELEGRAPH.base, `защитник увидел удар за ${seen?.in} тиков`);
});

test('R3: наценка за короткий удар и быстрый подброс', () => {
  const cost = (p) => E.BLOCKS.strike.cost({ hits: 1, launch: false, push: 'light', reach: 'short', zone: 'mid', damage: 20, ...p }, 'normal', { chargeMul: 1 });
  assert.equal(cost({ startup: 10, active: 3, recovery: 10 }) - cost({ startup: 10, active: 4, recovery: 10 }), 1, 'total 23 дороже total 24 на 1');
  assert.equal(cost({ startup: 10, active: 4, recovery: 10 }), cost({ startup: 10, active: 5, recovery: 10 }), 'от 24 наценки нет');
  assert.equal(cost({ startup: 3, active: 3, recovery: 4 }) - cost({ startup: 3, active: 3, recovery: 18 }), 4, 'total 10: +⌈14/4⌉');
  assert.equal(cost({ startup: 5, active: 3, recovery: 20, launch: true }) - cost({ startup: 5, active: 3, recovery: 20 }), 4, 'подброс с замахом 5: +2 и ещё +2');
  assert.equal(cost({ startup: 6, active: 3, recovery: 20, launch: true }) - cost({ startup: 6, active: 3, recovery: 20 }), 2, 'с замахом 6 только +2 за подброс');
  // pilot v2: a long active window does not hide a short strike, and costs by itself
  assert.equal(cost({ startup: 3, active: 12, recovery: 9 }) - cost({ startup: 3, active: 4, recovery: 17 }), 2 + 2, '3/12/9: короткий (16 тиков) и активность 12');
  const shot = (p) => E.BLOCKS.projectile.cost({ hits: 1, speed: 'mid', zone: 'mid', damage: 40, ...p }, 'special', { chargeMul: 1 });
  assert.equal(shot({ startup: 6, recovery: 8 }) - shot({ startup: 6, recovery: 17 }), 3, 'снаряд 6 + 1 + 8 = 15 тиков: +3');
});

test('B7: после блокированного удара защитник освобождается раньше атакующего', () => {
  const f = fighter({ moves: [{ id: 'meaty', blocks: [{ type: 'strike', startup: 3, active: 12, recovery: 9, damage: 80, hits: 5, reach: 'long', zone: 'mid' }] }] });
  const fight = fightOf([f, dummy()], { gap: 150 });
  let free = [null, null];
  for (let i = 0; i < 80; i++) {
    E.stepFight(fight, fight.freeze || fight.hitstop ? null : [i === 0 ? { attack: 'meaty' } : {}, { guard: 'high' }]);
    for (const s of [0, 1]) if (free[s] === null && i > 3 && ['neutral'].includes(fight.f[s].state)) free[s] = fight.tick;
  }
  assert.ok(free[1] <= free[0] - E.BLOCK_MINUS, `защитник свободен на тике ${free[1]}, атакующий на ${free[0]}`);
});

test('R4: промах восстанавливается на 8 тиков дольше', () => {
  const f = fighter({ moves: [{ id: 'quick', blocks: [{ type: 'strike', startup: 6, active: 3, recovery: 4, damage: 20, reach: 'short', zone: 'mid' }] }] });
  const time = (gap) => {
    const fight = fightOf([f, dummy()], { gap });
    // the press goes in before tick 1; the answer is the tick the fighter is out of the move
    let seen = false;
    for (let i = 0; i < 60; i++) {
      E.stepFight(fight, fight.freeze || fight.hitstop ? null : [i === 0 ? { attack: 'quick' } : {}, {}]);
      if (fight.f[0].state === 'move') seen = true;
      else if (seen) return fight.tick;
    }
    return null;
  };
  assert.equal(time(600), 6 + 3 + 4 + E.WHIFF_RECOVERY, 'промах');
  assert.equal(time(100), 6 + 3 + 4, 'попадание');
});

// ---------- B: block, throw, pressure ----------

test('B1: пять блокированных ударов по 80 ломают защиту; без блоков шкала убывает', () => {
  const f = fighter({ moves: [heavy] });
  const fight = fightOf([f, dummy()], { gap: 130 });
  const ev = steps(fight, 600, (i, fi) => [fi.f[0].state === 'neutral' ? (Math.abs(fi.f[1].x - fi.f[0].x) < 140 ? { attack: 'heavy' } : { walk: 1 }) : {}, { guard: 'high' }]);
  const crush = ev.findIndex((e) => e.type === 'guardCrush');
  assert.ok(crush > 0, 'защита сломана');
  assert.equal(ev.slice(0, crush).filter((e) => e.type === 'block').length, 5);
  const after = ev[crush];
  assert.ok(ev.some((e) => e.i === after.i && e.type === 'block'));
  const g = fightOf([f, dummy()], { gap: 130 });
  steps(g, 60, (i, fi) => [i === 0 ? { attack: 'heavy' } : {}, { guard: 'high' }]);
  const full = g.f[1].guardGauge;
  assert.equal(full, E.GUARD_GAUGE.base + 80 * E.GUARD_GAUGE.perDamage);
  steps(g, 80, () => [{}, { guard: 'high' }]);
  assert.ok(g.f[1].guardGauge < full, 'через 60 тиков без блока шкала падает');
});

test('B1: один приём из пяти попаданий по 80 в блок добавляет к шкале не больше 34 и защиту не ломает', () => {
  const multi = { id: 'flurry', slot: 'special', blocks: [{ type: 'strike', startup: 10, active: 5, recovery: 20, damage: 80, hits: 5, reach: 'mid', zone: 'mid' }] };
  const f = fighter({ moves: [multi] });
  const fight = fightOf([f, dummy()], { gap: 130 });
  const ev = steps(fight, 60, (i) => [i === 0 ? { attack: 'flurry' } : {}, { guard: 'high' }]);
  assert.equal(ev.filter((e) => e.type === 'block').length, 5);
  assert.ok(!ev.some((e) => e.type === 'guardCrush'));
  assert.equal(fight.f[1].guardGauge, E.GUARD_GAUGE.perAttack);
});

test('B2: удар способности в блок ранит на 10 %, обычный удар нет, последнюю единицу не снимает', () => {
  const f = fighter({ moves: [heavy], abilities: { blast: { start: (api) => api.hit({ box: [0, 0, 200, 290], damage: 80 }) } } });
  const run = (move, hp) => {
    const fight = fightOf([f, dummy()], { gap: 130 });
    if (hp) fight.f[1].hp = hp;
    const ev = steps(fight, 60, (i) => [i === 0 ? { attack: move } : {}, { guard: 'high' }]);
    return { fight, block: ev.find((e) => e.type === 'block') };
  };
  const a = run('blast');
  assert.equal(a.block.chip, 8);
  assert.equal(a.fight.f[1].hp, a.fight.f[1].maxHp - 8);
  const b = run('heavy');
  assert.equal(b.block.chip, 0);
  assert.equal(b.fight.f[1].hp, b.fight.f[1].maxHp);
  const c = run('blast', 1);
  assert.equal(c.fight.f[1].hp, 1);
  assert.ok(!c.fight.over);
});

test('B3: бросок сразу после выхода из блокстана не хватает, через 7 тиков хватает', () => {
  const run = (wait) => {
    const fight = fightOf([dummy(), dummy()], { gap: 110 });
    const V = fight.f[1];
    V.state = 'blockstun';
    V.st = 0;
    V.len = 10;
    V.guard = 'high';
    let out = null;
    let at = null;
    const ev = steps(fight, 80, (i, fi) => {
      if (at === null && fi.f[1].state === 'neutral') at = i;
      return [at !== null && i === at + wait ? { throw: true } : {}, { guard: 'high' }];
    });
    out = ev.some((e) => e.type === 'grab');
    return out;
  };
  assert.equal(run(0), false, 'на тике выхода');
  assert.equal(run(4), false, 'через 4 тика');
  assert.equal(run(7), true, 'через 7 тиков');
});

test('B8: блок, который держат на подъёме, держит удар в первый же свободный тик', () => {
  const f = fighter({ moves: [{ id: 'meaty', blocks: [{ type: 'strike', startup: 10, active: 6, recovery: 12, damage: 40, reach: 'mid', zone: 'mid' }] }] });
  for (let off = -4; off <= 2; off++) {
    const fight = fightOf([f, dummy()], { gap: 110 });
    const V = fight.f[1];
    V.state = 'getup';
    V.st = 0;
    V.len = 20;
    const ev = steps(fight, 60, (i) => [i === 10 + off ? { attack: 'meaty' } : {}, { guard: 'high' }]);
    assert.ok(ev.some((e) => e.type === 'block') && !ev.some((e) => e.type === 'hit'), `удар со смещением ${off}: ${ev.filter((e) => e.type === 'hit' || e.type === 'block').map((e) => e.type)}`);
  }
  // without a guard the same meaty lands
  const fight = fightOf([f, dummy()], { gap: 110 });
  fight.f[1].state = 'getup';
  fight.f[1].st = 0;
  fight.f[1].len = 20;
  assert.ok(steps(fight, 60, (i) => [i === 10 ? { attack: 'meaty' } : {}, {}]).some((e) => e.type === 'hit'));
});

test('B4: коробка со stop на защитника в блоке не действует и растит шкалу защиты; без блока действует', () => {
  const f = fighter({ abilities: { hold: { start: (api) => api.effect('opponent', { id: 'h', ticks: 40, stop: true, box: [0, 0, 200, 290] }) } } });
  const run = (guard) => {
    const fight = fightOf([f, dummy()]);
    const ev = steps(fight, 110, (i) => [i === E.ABILITY.controlStart ? { attack: 'hold' } : {}, guard ? { guard: 'high' } : {}]);
    return { fight, ev };
  };
  const g = run(true);
  assert.ok(!g.ev.some((e) => e.type === 'effect' && e.stop), 'stop не наложен');
  assert.equal(g.fight.f[1].guard, 'high', 'остался в блоке');
  assert.equal(g.fight.f[1].guardGauge, E.GUARD_GAUGE.controlAdd);
  const o = run(false);
  assert.ok(o.ev.some((e) => e.type === 'effect' && e.stop));
});

test('B6: флага tech нет; кто держит throw, раз за разом бросает впустую', () => {
  assert.equal('tech' in E.sanitizeAction({ tech: true }), false);
  const fight = fightOf([dummy(), dummy()], { gap: 400 });
  const ev = steps(fight, 360, () => [{ throw: true }, {}]);
  assert.ok(!ev.some((e) => e.type === 'grab'));
  assert.equal(fight.f[0].state, 'throw');
  assert.ok(fight.f[0].throwStart > 300, 'бросок начинается снова и снова');
});

// ---------- O: objects ----------

test('O1: объект, передающий себя преемнику, исчезает через 600 тиков после каста', () => {
  const relay = (a, o) => {
    if (o.age === 250) a.spawn({ x: 0, y: 0, w: 40, h: 40, life: 300, tick: relay });
  };
  const f = fighter({ abilities: { relay: { start: (api) => api.spawn({ x: 0, y: 300, w: 40, h: 40, life: 300, tick: relay }) } } });
  const fight = fightOf([f, dummy()], { gap: 600 });
  let castTick = null;
  let lastSeen = 0;
  steps(fight, 1000, (i, fi) => {
    if (fi.objects.some((o) => o.side === 0)) lastSeen = fi.tick;
    return [i === 0 ? { attack: 'relay' } : {}, {}];
  });
  castTick = 7; // startup 6: the cast starts on the 7th tick
  assert.ok(lastSeen > castTick + 300, 'преемник появлялся');
  assert.ok(lastSeen <= castTick + L.castLife, `последний объект на тике ${lastSeen}`);
});

test('O2: время объектов каста не больше замеренного × 1.25 + 60', () => {
  const f = fighter({ abilities: { lamp: { start: (api) => api.spawn({ x: 0, y: 300, w: 40, h: 40, life: 300 }) } } });
  f.movesById.lamp.ability.measured = Object.freeze({ ...f.movesById.lamp.ability.measured, objectTicks: 40 });
  const fight = fightOf([f, dummy()], { gap: 600 });
  const ev = steps(fight, 400, (i) => [i === 0 ? { attack: 'lamp' } : {}, {}]);
  const born = ev.find((e) => e.type === 'object');
  const gone = ev.find((e) => e.type === 'objectEnd');
  assert.equal(gone.i - born.i + 1, 40 * L.capMul + L.capAdd.objectTicks, 'живёт столько тиков, считая тик появления');
});

// ---------- W: walls ----------

const wallMaker = (spec) => ({ start: (api) => api.spawn({ x: 0, y: 0, w: 80, h: 600, life: 360, solid: true, ...spec }) });

test('W1: у бойца одна стена — новая убирает старую; W2: стена стоит на полу и не выше 160', () => {
  const f = fighter({ abilities: { wall: wallMaker({ x: 200 }) } });
  f.movesById.wall.ability.cooldown = 0;
  const fight = fightOf([f, dummy()], { gap: 600 });
  steps(fight, 60, (i, fi) => [fi.f[0].state === 'neutral' ? { attack: 'wall' } : {}, {}]);
  const walls = fight.objects.filter((o) => o.solid && o.side === 0);
  assert.equal(walls.length, 1);
  assert.equal(walls[0].h, L.solidHeightMax);
  assert.equal(walls[0].y, L.solidHeightMax / 2);
});

test('W2: при скорости 0 прямой прыжок вперёд перелетает стену шириной 80 из положения вплотную', () => {
  const slow = fighter({ stats: { health: 4, power: 4, speed: 0, defense: 4 } });
  const owner = fighter({ abilities: { wall: wallMaker({ x: 300, life: 300 }) } });
  const fight = fightOf([slow, owner], { gap: 600 });
  steps(fight, 10, (i) => [{}, i === 0 ? { attack: 'wall' } : {}]);
  const w = fight.objects.find((o) => o.solid);
  assert.ok(w, 'стена стоит');
  fight.f[0].x = fight.f[0].px = w.x - (w.w / 2 + 35);
  steps(fight, 3, () => [{ walk: 1 }, {}]);
  assert.ok(fight.f[0].x <= w.x - (w.w / 2 + 35) + 0.001, 'пешком не пройти');
  steps(fight, 60, (i) => [i === 0 ? { jump: 1 } : {}, {}]);
  assert.ok(fight.f[0].x > w.x + w.w / 2 + 35 - 0.001, `после прыжка ${fight.f[0].x} за стеной ${w.x}`);
});

test('W3: стена со скоростью 24 едет не быстрее 6 и двигает соперника не больше 12 за тик', () => {
  const f = fighter({ abilities: { ram: wallMaker({ x: 100, vx: 24, life: 200 }) } });
  const fight = fightOf([f, dummy()], { gap: 300 });
  fight.audit = [];
  let prev = null;
  let maxPush = 0;
  let maxWall = 0;
  steps(fight, 150, (i, fi) => {
    const w = fi.objects.find((o) => o.solid);
    if (w && prev?.w !== undefined) maxWall = Math.max(maxWall, Math.abs(w.x - prev.w));
    if (prev) maxPush = Math.max(maxPush, Math.abs(fi.f[1].x - prev.x));
    prev = { w: w?.x, x: fi.f[1].x };
    return [i === 0 ? { attack: 'ram' } : {}, {}];
  });
  assert.ok(maxWall <= L.solidSpeed + 1e-9, `стена за тик ${maxWall}`);
  assert.ok(maxPush <= L.shovePerTick + 1e-9, `соперник за тик ${maxPush}`);
  assert.ok(fight.audit.some((a) => a.kind === 'wall'), 'стена толкала через бюджет сдвига');
  assert.ok(f.movesById.ram.ability.measured.shove > 0, 'замер видит сдвиг стеной');
});

test('W4: стена держит и хозяина; низкий снаряд гаснет, средний пролетает', () => {
  const f = fighter({
    abilities: { wall: wallMaker({ x: 120, life: 300 }) },
    moves: [
      { id: 'lowshot', slot: 'special', blocks: [{ type: 'projectile', startup: 8, recovery: 16, damage: 30, speed: 'fast', zone: 'low' }] },
      { id: 'midshot', slot: 'special', blocks: [{ type: 'projectile', startup: 8, recovery: 16, damage: 30, speed: 'fast', zone: 'mid' }] },
    ],
  });
  const run = (shot) => {
    const fight = fightOf([f, dummy()], { gap: 600 });
    const ev = steps(fight, 120, (i, fi) => [i === 0 ? { attack: 'wall' } : i === 30 ? { attack: shot } : i > 60 ? { walk: 1 } : {}, {}]);
    return { fight, ev };
  };
  const low = run('lowshot');
  assert.ok(!low.ev.some((e) => e.type === 'hit' && e.move === 'lowshot'), 'низкий снаряд погас о свою стену');
  const mid = run('midshot');
  assert.ok(mid.ev.some((e) => e.type === 'hit' && e.move === 'midshot'), 'средний пролетел');
  const w = mid.fight.objects.find((o) => o.solid);
  assert.ok(mid.fight.f[0].x <= w.x - (w.w / 2 + 35) + 0.001, 'хозяин упёрся в свою стену');
});

test('W5: два удара по 80 ломают стену соперника, удары хозяина её не ломают', () => {
  const owner = fighter({ moves: [heavy], abilities: { wall: wallMaker({ x: 100, life: 360 }) } });
  const hitter = fighter({ moves: [heavy] });
  const fight = fightOf([hitter, owner], { gap: 240 });
  const ev = steps(fight, 200, (i, fi) => [i > 20 && fi.f[0].state === 'neutral' ? { attack: 'heavy', walk: 1 } : i > 20 ? {} : {}, i === 0 ? { attack: 'wall' } : {}]);
  const hits = ev.filter((e) => e.type === 'wallHit');
  assert.ok(ev.some((e) => e.type === 'wallBreak'), 'стена сломана');
  assert.equal(hits.length, 2);
  const own = fightOf([owner, dummy()], { gap: 300 });
  const ev2 = steps(own, 120, (i, fi) => [i === 0 ? { attack: 'wall' } : fi.f[0].state === 'neutral' ? { attack: 'heavy' } : {}, {}]);
  assert.ok(!ev2.some((e) => e.type === 'wallHit'));
});

// ---------- M: moving oneself ----------

test('M1: в хитстане свой объект не сдвигает хозяина', () => {
  const pusher = (a) => a.shove('me', 12);
  const f = fighter({ abilities: { drift: { start: (api) => api.spawn({ x: 0, y: 300, w: 20, h: 20, life: 200, tick: pusher }) } } });
  const fight = fightOf([f, dummy()], { gap: 600 });
  steps(fight, 30, (i) => [i === 0 ? { attack: 'drift' } : {}, {}]);
  const F = fight.f[0];
  F.state = 'hitstun';
  F.st = 0;
  F.len = 50;
  F.vx = 0;
  const x = F.x;
  steps(fight, 20, () => [{}, {}]);
  assert.equal(F.x, x);
});

test('M1: способность не сдвигает соперника, пока хозяин в хитстане', () => {
  const pusher = (a) => a.shove('opponent', 12);
  const f = fighter({ abilities: { push: { start: (api) => api.spawn({ x: 0, y: 300, w: 20, h: 20, life: 200, tick: pusher }) } } });
  const fight = fightOf([f, dummy()], { gap: 300 });
  steps(fight, 30, (i) => [i === 0 ? { attack: 'push' } : {}, {}]);
  const x0 = fight.f[1].x;
  steps(fight, 5, () => [{}, {}]);
  assert.ok(Math.abs(fight.f[1].x - x0) > 20, 'свободный хозяин толкает');
  const F = fight.f[0];
  F.state = 'hitstun';
  F.st = 0;
  F.len = 50;
  F.vx = 0;
  const x1 = fight.f[1].x;
  steps(fight, 20, () => [{}, {}]);
  assert.equal(fight.f[1].x, x1);
});

test('S1: приём устаёт — каждое следующее попадание тем же приёмом слабее, другой приём свежий', () => {
  const f = fighter({ moves: [heavy, { id: 'other', blocks: [{ type: 'strike', startup: 10, active: 3, recovery: 12, damage: 80, reach: 'mid', zone: 'mid' }] }] });
  const fight = fightOf([f, dummy()], { gap: 130 });
  const hits = [];
  let press = 'heavy';
  for (let i = 0; i < 900 && hits.length < 6; i++) {
    for (const e of E.stepFight(fight, fight.freeze || fight.hitstop ? null : [fight.f[0].state === 'neutral' && fight.f[1].state === 'neutral' ? { attack: hits.length === 5 ? 'other' : press } : { walk: 0 }, {}])) if (e.type === 'hit') hits.push(e);
    fight.f[1].x = fight.f[0].x + 130;
    fight.f[1].hp = fight.f[1].maxHp;
    fight.f[1].combo = 0;
  }
  const d = hits.map((h) => h.damage);
  assert.ok(d[1] < d[0] && d[2] < d[1] && d[4] < d[3], d.join(' '));
  assert.ok(d[5] > d[4], 'другой приём бьёт свежим');
  assert.equal(E.brainView(fight, 0).me.stale.heavy < 1, true);
});

test('M2: сдвиг себя на 12 за тик 300 тиков стоит как сдвиг соперника', () => {
  // an object keeps the cast alive; the fighter is in neutral by then, where moving oneself is allowed (M1)
  const glide = (a, o) => a.shove('me', Math.floor(o.age / 40) % 2 ? -12 : 12);
  const f = fighter({ abilities: { glide: { start: (api) => api.spawn({ x: 0, y: 300, w: 10, h: 10, life: 300, tick: glide }) } } });
  const r = f.report.find((x) => x.id === 'glide');
  assert.ok(r.measured.shove >= 3000, `замер сдвига ${r.measured.shove}`);
  assert.ok(E.abilityPower(r.measured) >= 300, `сила ${E.abilityPower(r.measured)}`);
});

// ---------- P: prices ----------

test('P1/P2: стена перед идущим манекеном даёт отказ, стена в стороне — нет', () => {
  const front = fighter({ abilities: { block: wallMaker({ x: 200, life: 360 }) } });
  const aside = fighter({ abilities: { block: wallMaker({ x: -400, life: 360 }) } });
  const ref = (f) => f.report.find((x) => x.id === 'block').measured.refusal;
  assert.ok(ref(front) > 0, `отказ ${ref(front)}`);
  assert.equal(ref(aside), 0);
  assert.ok(E.MEASURE.gaps.includes(900));
  for (const m of ['approach', 'shoot', 'poke']) assert.ok(E.MEASURE.modes.includes(m));
});

test('P3: четыре копии способности вместе не дают больше 36 силы в секунду; эфир растёт от полученного урона', () => {
  const zap = { start: (api) => api.hit({ box: [0, 0, 200, 290], damage: 45 }) };
  const f = fighter({ abilities: { z1: zap, z2: zap, z3: zap, z4: zap } });
  const power = f.movesById.z1.ability.power;
  assert.ok(power > 20);
  const fight = fightOf([f, dummy()], { gap: 600, ether: null });
  const ev = steps(fight, 3600, (i, fi) => {
    const id = ['z1', 'z2', 'z3', 'z4'].find((m) => !(fi.f[0].cooldowns[m] > 0));
    // walking up between the casts: no passivity penalty empties the pool (C3)
    return [fi.f[0].state === 'neutral' && id && fi.f[0].ether >= power ? { attack: id } : { walk: 1 }, {}];
  });
  const casts = ev.filter((e) => e.type === 'ability' && e.side === 0).length;
  assert.ok(casts * power <= E.ETHER.start + E.ETHER.regen * 3600 + 1e-9, `${casts} кастов по ${power}`);
  assert.ok(casts * power > 0.8 * E.ETHER.regen * 3600, `эфир тратится почти весь: ${casts} × ${power}, штрафов ${ev.filter((e) => e.type === "passive").length}`);
  const g = fightOf([fighter({ moves: [heavy] }), dummy()], { gap: 130, ether: null });
  g.f[1].ether = 0;
  steps(g, 30, (i) => [i === 0 ? { attack: 'heavy' } : {}, {}]);
  assert.ok(g.f[1].ether >= 80 * E.ETHER.perDamage, `эфир после удара ${g.f[1].ether}`);
});

// ---------- C: comebacks ----------

test('C2: на 10 % здоровья удар 80 снимает 64 × множители', () => {
  const f = fighter({ moves: [heavy] });
  const fight = fightOf([f, dummy()], { gap: 130 });
  fight.f[1].hp = Math.round(fight.f[1].maxHp * 0.1);
  const ev = steps(fight, 30, (i) => [i === 0 ? { attack: 'heavy' } : {}, {}]);
  const hit = ev.find((e) => e.type === 'hit');
  assert.equal(hit.damage, Math.round(80 * 0.8 * f.derived.damageMul * fight.f[1].def.derived.takenMul));
});

test('C3: кто долго стоит вдали и не идёт вперёд, получает штраф пассивности', () => {
  const fight = fightOf([dummy(), dummy()], { gap: 900, ether: null });
  const ev = steps(fight, E.PASSIVE.max + 30, () => [{ walk: -1 }, { walk: 0 }]);
  const pen = ev.filter((e) => e.type === 'passive');
  assert.ok(pen.length >= 1);
  assert.ok(pen.every((e) => e.side === 0 || e.side === 1));
  const walker = fightOf([dummy(), dummy()], { gap: 2000, ether: null });
  const ev2 = steps(walker, E.PASSIVE.max + 30, () => [{ walk: 1 }, {}]);
  assert.ok(!ev2.some((e) => e.type === 'passive' && e.side === 0), 'кто идёт вперёд, не пассивен');
});

// ---------- N: noise of the league ----------

test('N1: шум старта сохраняет тип старта и расстояние не меньше 120', () => {
  for (let seed = 1; seed < 400; seed++) {
    for (const name of Object.keys(E.STARTS)) {
      const s = E.noisyStart(name, seed);
      const gap = s.x[1] - s.x[0];
      assert.ok(gap >= E.START_NOISE.minGap - 1e-9, `${name} ${seed}: ${gap}`);
      assert.ok(s.x[0] >= E.STAGE_BOUNDS.left + E.START_NOISE.wallMargin - 1e-9 && s.x[1] <= E.STAGE_BOUNDS.right - E.START_NOISE.wallMargin + 1e-9);
      if (name === 'wall_left') assert.ok(s.x[0] - E.STAGE_BOUNDS.left <= E.START_NOISE.pressedMax + 1e-9);
      if (name === 'wall_right') assert.ok(E.STAGE_BOUNDS.right - s.x[1] <= E.START_NOISE.pressedMax + 1e-9);
      assert.ok(s.delay.every((d) => d >= 0 && d <= E.START_NOISE.delayMax));
    }
  }
  const close = E.noisyStart('close', { centre: 0, gap: -40, delay: [0, 0] });
  assert.equal(close.x[1] - close.x[0], 120);
});

test('N3: пока мозги бойца не вызываются, он неуязвим и его не бросить', () => {
  const f = fighter({ moves: [heavy] });
  const fight = E.createFight({ fighters: [f, dummy()], start: { x: [1040, 1160], delay: [0, 6] } });
  const ev = steps(fight, 6, (i) => [i === 0 ? { throw: true } : {}, {}]);
  assert.ok(!ev.some((e) => e.type === 'grab' || e.type === 'hit'));
  assert.equal(E.brainView(fight, 1).me.waiting, false);
  assert.deepEqual(fight.start.delay, [0, 6]);
});

// ---------- D: brains in steps ----------

function brainDir(src) {
  const dir = mkdtempSync(join(tmpdir(), 'ring3-brain-'));
  cpSync(DUMMY, dir, { recursive: true });
  writeFileSync(join(dir, 'brain.js'), src);
  return dir;
}

test('D1: мозги с бесконечным циклом теряют ход одинаково на любом прогоне', async () => {
  const dir = brainDir(`export default { tick(s) { if (s.tick % 50 === 0) { while (true) {} } return { walk: 1 }; } };\n`);
  try {
    const fighters = [dummy(), dummy()];
    const go = () => runFight({ dirs: [dir, DUMMY], fighters, maxTicks: 400 });
    const a = await go();
    const b = await go();
    assert.ok(a.stats[0].skipped >= 7, `пропущено ${a.stats[0].skipped}`);
    assert.equal(a.replay.hash, b.replay.hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D2: мозгам недоступны Math.random и Date', async () => {
  const dir = brainDir(`export default { tick() { return { walk: Math.random() > 0.5 ? 1 : -1 }; } };\n`);
  try {
    await assert.rejects(loadBrain(dir), /Math\.random/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
