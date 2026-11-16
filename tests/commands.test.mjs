// Commands in numpad notation: parsing, the ring's own picks, clashes and reading the input with genre leniency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, assignCommands, readCommand, InputLog, numpad } from '../kit/arena/engine/commands.js';

test('разбор записи: движение, заряд, кнопки', () => {
  assert.deepEqual(parseCommand('236P').motion, [2, 3, 6]);
  assert.equal(parseCommand('[4]6K').charge, 4);
  assert.deepEqual(parseCommand('HP').motion, []);
  assert.ok(parseCommand('PP').two);
  for (const bad of ['236', '22P', '[4]P', 'XP', '236Q', 5]) assert.ok(parseCommand(bad).error, String(bad));
});

const mv = (id, slot, posture, extra = {}) => ({ id, slot, posture, totalDamage: 50, limb: 'P', ...extra });

test('ринг назначает свободные команды по слоту и не пересекается со своими командами бойца', () => {
  const { byId, errors } = assignCommands([mv('a', 'normal', 'stand'), mv('b', 'normal', 'stand', { limb: 'K' }), mv('c', 'normal', 'crouch'), mv('s1', 'special', 'stand', { command: '236P' }), mv('s2', 'special', 'stand'), mv('su', 'super', 'stand')]);
  assert.deepEqual(errors, []);
  assert.equal(byId.a.raw, 'LP');
  assert.equal(byId.b.raw, 'LK');
  assert.equal(byId.c.raw, '2LP');
  assert.equal(byId.s1.raw, '236P');
  assert.equal(byId.s2.raw, '214P');
  assert.equal(byId.su.raw, '236236P');
});

test('пересечения и неверная форма команды — ошибки', () => {
  assert.match(assignCommands([mv('a', 'special', 'stand', { command: '236P' }), mv('b', 'special', 'stand', { command: '236LP' })]).errors.join(), /пересекается/);
  assert.match(assignCommands([mv('a', 'normal', 'stand', { command: '236P' })]).errors.join(), /обычного приёма/);
  assert.match(assignCommands([mv('a', 'special', 'stand', { command: 'HP' })]).errors.join(), /особого/);
  assert.match(assignCommands([mv('a', 'normal', 'crouch', { command: '6HP' })]).errors.join(), /присев/);
  // the same command in the air and on the ground is fine
  assert.deepEqual(assignCommands([mv('a', 'special', 'stand', { command: '236K' }), mv('b', 'special', 'air', { command: '236K' })]).errors, []);
});

const OPTS = [
  { id: 'jab', slot: 'normal', posture: 'stand', command: parseCommand('LP') },
  { id: 'fwd', slot: 'normal', posture: 'stand', command: parseCommand('6HP') },
  { id: 'heavy', slot: 'normal', posture: 'stand', command: parseCommand('HP') },
  { id: 'low', slot: 'normal', posture: 'crouch', command: parseCommand('2LK') },
  { id: 'fire', slot: 'special', posture: 'stand', command: parseCommand('236P') },
  { id: 'dp', slot: 'special', posture: 'stand', command: parseCommand('623P') },
  { id: 'charge', slot: 'special', posture: 'stand', command: parseCommand('[4]6K') },
  { id: 'air', slot: 'special', posture: 'air', command: parseCommand('236K') },
  { id: 'sup', slot: 'super', posture: 'stand', command: parseCommand('236236P') },
];
// plays dirs (one per tick) and a button on the last tick; returns what the reader sees then
function play(dirs, btns, state = {}) {
  const log = new InputLog();
  dirs.forEach((d, t) => log.push(t, d, t === dirs.length - 1 ? btns : []));
  return readCommand(log, OPTS, { airborne: false, crouching: false, ...state }, dirs.length - 1);
}
const hold = (d, n) => Array(n).fill(d);

test('обычные удары: кнопка, направление вперёд, присед', () => {
  assert.equal(play([5, 5], ['LP']).move, 'jab');
  assert.equal(play([5, 6], ['HP']).move, 'fwd');
  assert.equal(play([5, 5], ['HP']).move, 'heavy');
  assert.equal(play([2, 2], ['LK'], { crouching: true }).move, 'low');
});

test('четверть круга, драконий, заряд, суперприём и упрощённые вводы', () => {
  assert.equal(play([5, 2, 3, 6], ['LP']).move, 'fire');
  assert.equal(play([5, ...hold(2, 3), ...hold(3, 2), ...hold(6, 2)], ['HP']).move, 'fire');
  assert.equal(play([5, 2, 6], ['LP']).move, 'fire'); // the middle diagonal may be skipped
  assert.equal(play([5, 6, 5, 2, 3], ['LP']).move, 'dp');
  assert.equal(play([...hold(4, 35), 6], ['LK']).move, 'charge');
  assert.equal(play([...hold(4, 10), 6], ['LK']), null); // too short a charge, and no 6K normal
  assert.equal(play([5, 2, 3, 6, 2, 3, 6], ['LP']).move, 'sup');
  assert.equal(play([5, 2, 3, 6], ['LK'], { airborne: true }).move, 'air');
});

test('слишком медленное движение не засчитывается, кнопка ждёт в буфере', () => {
  assert.equal(play([5, 2, ...hold(5, 20), 3, 6], ['LP']).move, 'jab');
  const log = new InputLog();
  [5, 2, 3, 6].forEach((d, t) => log.push(t, d, t === 3 ? ['LP'] : []));
  for (let t = 4; t < 9; t++) log.push(t, 5, []);
  assert.equal(readCommand(log, OPTS, { airborne: false }, 8).move, 'fire');
  for (let t = 9; t < 14; t++) log.push(t, 5, []);
  assert.equal(readCommand(log, OPTS, { airborne: false }, 13), null);
});

test('две сильные — суперприём, две лёгкие — бросок', () => {
  assert.equal(play([5, 5], ['HP', 'HK']).move, 'sup');
  assert.equal(play([5, 5], ['LP', 'LK']).throw, true);
});

test('направления считаются от соперника: справа «вперёд» — влево', () => {
  assert.equal(numpad({ left: true }, -1), 6);
  assert.equal(numpad({ right: true, down: true }, -1), 1);
  assert.equal(numpad({ right: true, down: true }, 1), 3);
});
