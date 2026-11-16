// The montage pack: CSV that spreadsheets read, the fighters' thoughts from what they did, subtitles of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../judge/pack.js';
import { decide, keyThoughts, thoughtsSrt } from '../judge/thoughts.js';

test('CSV: заголовки и значения с запятой и кавычками в кавычках', () => {
  const csv = toCsv([{ 'Кармин, %': 92.5, text: 'Он сказал "стоп", и всё' }]);
  assert.equal(csv, '"Кармин, %",text\n92.5,"Он сказал ""стоп"", и всё"\n');
  assert.equal(toCsv([]), '');
});

// per-tick views of one side, as roundThoughts builds them from the replay
const view = (tick, me, op = {}, extra = {}) => ({ tick, side: 0, dist: 200, events: [], act: null, me: { state: 'neutral', guard: null, vx: 0, facing: 1, hp: 1000, maxHp: 1000, ...me }, op: { state: 'neutral', hp: 1000, maxHp: 1000, ...op }, ...extra });

test('мысли бойца: приём, наказание, серия одним, суперприём, блок от удара', () => {
  const mv = (id, slot = 'normal', t = 0) => ({ state: 'move', move: { id, slot, t, phase: 'startup' }, moveDef: { id, name: id === 'keel' ? 'Срез киля' : 'Весь океан', slot } });
  const views = [
    view(0, {}),
    view(1, mv('keel', 'normal', 0)),
    view(10, {}),
    view(20, mv('keel', 'normal', 0)),
    view(30, {}),
    view(200, {}, { state: 'staggered' }),
    view(201, mv('keel', 'normal', 0), { state: 'staggered' }),
    view(300, {}),
    view(301, mv('ocean', 'super', 0)),
    view(400, {}),
    view(401, { guard: 'low' }, { state: 'move', moveDef: { name: 'Подсечка' } }),
  ];
  const t = decide(views).map((x) => x.text);
  assert.deepEqual(t, ['Серия: «Срез киля»', 'Он открылся — «Срез киля»', 'Суперприём «Весь океан»!', 'Закрываюсь от «Подсечка»']);
});

test('ключевые мысли: не чаще раза в 1,25 с на бойца, сильная побеждает', () => {
  const list = [
    { tick: 0, side: 0, prio: 6, text: 'a' },
    { tick: 30, side: 0, prio: 10, text: 'супер' },
    { tick: 40, side: 1, prio: 6, text: 'другой' },
    { tick: 200, side: 0, prio: 2, text: 'хожу' },
  ];
  assert.deepEqual(keyThoughts(list).map((x) => x.text), ['супер', 'другой']);
});

test('субтитры мыслей: время SRT, не дольше следующей', () => {
  const srt = thoughtsSrt([{ seconds: 7.05, text: 'Серия' }, { seconds: 8, text: 'Супер' }]);
  assert.match(srt, /^1\n00:00:07,050 --> 00:00:07,950\nСерия\n/);
  assert.match(srt, /2\n00:00:08,000 --> 00:00:09,400\nСупер/);
});

test('призрак: момент по тику, по виду или лучший своей стороны', async () => {
  const { pickTick } = await import('../judge/ghost.js');
  const st = { moments: [{ kind: 'combo', side: 1, at: 100, score: 9, text: 'серия' }, { kind: 'super', side: 0, at: 300, score: 5, text: 'супер' }, { kind: 'last', side: 1, at: 500, score: 7, text: 'нокаут' }] };
  assert.equal(pickTick(st, 0, { tick: 42 }).tick, 42);
  assert.equal(pickTick(st, 0, {}).tick, 300, 'лучший момент своей стороны');
  assert.equal(pickTick(st, 1, { moment: 'last' }).tick, 500);
  assert.throws(() => pickTick(st, 0, { moment: 'new' }), /нет такого момента/);
});
