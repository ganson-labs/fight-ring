// The step meter of ability code: a hung or too long hook stops at the same step everywhere and switches only
// its ability off; the rewrite that builds the meter in keeps the code's meaning.  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { abilityLoader } from '../kit/arena/engine/instrument.js';
import { meterOpen } from '../kit/arena/engine/meter.js';
import { loadFighter, runFight, replayFight } from '../kit/arena/tools/load.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = join(root, 'tests', 'fixtures', 'ability-fighter');
const DUMMY = join(root, 'kit', 'arena', 'sparring', 'dummy');
const L = E.ABILITY;
const tmp = mkdtempSync(join(tmpdir(), 'ring-meter-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// The test fighter with some of its ability files replaced.
let n = 0;
function fighterWith(files) {
  const dir = join(tmp, `f${++n}`);
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [f, src] of Object.entries(files)) writeFileSync(join(dir, f), src);
  return dir;
}

async function checkFails(files) {
  const t0 = Date.now();
  const r = await loadFighter(fighterWith(files));
  assert.ok(Date.now() - t0 < 30000, 'check закончился');
  assert.equal(r.ok, false);
  return r.errors.join('\n');
}

test('бесконечный цикл в хуке: check называет приём, файл, хук и бюджет', async () => {
  const errs = await checkFails({ 'abilities/spark.js': 'export function start(api) {\n  while (true) {}\n}\n' });
  assert.match(errs, /spark \(abilities\/spark\.js\): ошибка на манекене[^\n]*хук start: больше 100000 шагов[^\n]*бесконечный цикл/);
  const forever = await checkFails({ 'abilities/spark.js': 'export function tick(api) {\n  for (;;) api.mem.n = (api.mem.n || 0) + 1;\n}\nexport function start(api) {}\n' });
  assert.match(forever, /spark \(abilities\/spark\.js\)[^\n]*хук tick: больше/);
});

test('цикл, который сам ловит ошибку бюджета, всё равно отключает способность', async () => {
  const errs = await checkFails({ 'abilities/spark.js': 'export function start(api) {\n  try { do {} while (1) } catch {}\n  api.hit({ box: [20, 100, 140, 240], damage: 20 });\n}\n' });
  assert.match(errs, /spark[^\n]*хук start: больше 100000 шагов/);
});

test('глубокая рекурсия: отключается по вложенности, одинаково при любом стеке', async () => {
  const errs = await checkFails({ 'abilities/frost.js': 'function deeper(n) { return deeper(n + 1) + 1 }\nexport function start(api) { deeper(0) }\n' });
  assert.match(errs, /frost \(abilities\/frost\.js\)[^\n]*хук start: вложенность вызовов своих функций больше 256/);
  const arrow = await checkFails({ 'abilities/frost.js': 'const deeper = (n) => deeper(n + 1) + 1\nexport function start(api) { deeper(0) }\n' });
  assert.match(arrow, /frost[^\n]*вложенность/);
  const objTick = await checkFails({ 'abilities/frost.js': "const spin = (o) => { for (const k in o) spin(o) }\nexport function start(api) { api.spawn({ x: 70, y: 170, life: 60, tick(api, o) { spin({ a: 1 }) } }) }\n" });
  assert.match(objTick, /frost[^\n]*хук tick объекта: вложенность/);
});

test('долгий, но конечный цикл в пределах бюджета работает как обычно', async () => {
  const dir = fighterWith({
    'abilities/spark.js': `function weight(i) { return i % 7 }
export function start(api) {
  let s = 0;
  for (let i = 0; i < ${L.hookSteps / 2 - 100}; i++) s += weight(i);
  api.mem.s = s;
  api.hit({ box: [20, 100, 140, 240], damage: s > 0 ? 20 : 1, zone: 'mid' });
}
`,
  });
  const r = await loadFighter(dir);
  assert.ok(r.ok, r.errors.join('\n'));
  assert.ok(r.fighter.movesById.spark.ability.measured.damage >= 20);
});

test('цикл верхнего уровня модуля не вешает загрузку', async () => {
  const errs = await checkFails({ 'abilities/spark.js': 'let x = 0\nwhile (x >= 0) x++\nexport function start(api) {}\n' });
  assert.match(errs, /abilities\/spark\.js: модуль не загрузился — больше 100000 шагов/);
});

test('в бою зависший хук отключает только свою способность, бой детерминирован и повторяется', async () => {
  // spark hangs only late in a fight, where the dummy measurement never goes: check passes, the fight meets it
  const dir = fighterWith({
    'abilities/spark.js': `export function start(api) {
  api.hit({ box: [20, 100, 140, 240], damage: 20, zone: 'mid' });
}
export function passive(api) {
  if (api.tick > 1500) while (true) api.mem.spin = (api.mem.spin || 0) + 1;
}
`,
  });
  const me = await loadFighter(dir);
  assert.ok(me.ok, me.errors.join('\n'));
  const foe = await loadFighter(DUMMY);
  const fighters = [me.fighter, foe.fighter];
  const go = () => runFight({ dirs: [dir, DUMMY], fighters, options: { dummy: 'block' }, seed: 9, maxTicks: 2400 });
  const a = await go();
  const off = a.events.filter((e) => e.type === 'abilityOff');
  assert.equal(off.length, 1);
  assert.equal(off[0].script, 'abilities/spark.js');
  assert.match(off[0].reason, /хук passive: больше 100000 шагов/);
  assert.equal(off[0].tick, 1501);
  assert.equal(a.fight.f[0].abilityOff['abilities/frost.js'], undefined, 'другие способности работают');
  assert.ok(a.fight.tick >= 2400 || a.fight.over, 'бой дошёл до конца');
  assert.ok(a.events.some((e) => e.type === 'ability' && e.tick > 1501), 'после отключения бой идёт, способности кастуются');
  const b = await go();
  assert.equal(b.replay.hash, a.replay.hash);
  assert.equal(E.fightHash(replayFight(fighters, JSON.parse(JSON.stringify(a.replay)))), a.replay.hash);
});

test('переписанный счётчиком движок играет тот же бой кадр в кадр', async () => {
  // the engine itself is a large piece of real code: arrows, classes, templates, regexps, every kind of loop
  const engineDir = join(root, 'kit', 'arena', 'engine');
  const load = abilityLoader({
    base: pathToFileURL(engineDir).href + '/',
    read: async (u) => readFileSync(fileURLToPath(u), 'utf8'),
    toUrl: (src) => `data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`,
  });
  const IE = await load('index.js');
  const raw = (dir) => Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(dir, `${f}.json`), 'utf8'))]));
  const fixture = await loadFighter(FIXTURE);
  const modules = Object.fromEntries(Object.entries(fixture.fighter.abilities).map(([k, v]) => [k, { ...v }]));
  const play = (X) => {
    meterOpen(1e15);
    const defs = [FIXTURE, DUMMY].map((d) => X.checkFighter(raw(d)).fighter);
    assert.ok(X.prepareAbilities(defs[0], modules).ok);
    const fight = X.createFight({ fighters: defs, seed: 3 });
    const ids = ['strike_1', 'spark', 'frost', 'burn', 'flare', 'super_1'];
    let r = 7;
    const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
    const log = [];
    for (let i = 0; i < 1800; i++) {
      meterOpen(1e15);
      const acts = fight.freeze || fight.hitstop ? null : [{ walk: rnd() < 0.5 ? 1 : -1, attack: rnd() < 0.2 ? ids[Math.floor(rnd() * ids.length)] : undefined }, { guard: rnd() < 0.3 ? 'high' : undefined }];
      log.push(JSON.stringify(X.stepFight(fight, acts)));
    }
    return { hash: X.fightHash(fight), log, view: JSON.stringify(X.brainView(fight, 0)) };
  };
  const plain = play(E);
  const counted = play(IE);
  assert.equal(counted.hash, plain.hash);
  assert.deepEqual(counted.log, plain.log);
  assert.equal(counted.view, plain.view);
  assert.ok(plain.log.join('').includes('"ability"'), 'в бою были способности');
});
