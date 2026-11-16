// The match protocol and the show around a recorded fight: old records replay frame for frame on their own engine
// snapshot, the snapshot runs on its own, journals give time and tokens, a round gives its stats and moments,
// the voiced commentary sits only in the pauses, one line at a time; the captions over the reel keep their distance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = join(root, 'tests', 'fixtures', 'match-2.0');

test('запись ринга 2.0 переигрывается кадр в кадр на снимке движка рядом с ней', async () => {
  const { verifyDir } = await import('../judge/protocol.js');
  const v = await verifyDir(FIXTURE);
  assert.equal(v.length, 1);
  assert.ok(v[0].same, `записано ${v[0].recorded}, переиграно ${v[0].replayed}`);
});

test('снимок движка самодостаточен: копия папки engine запускается без остального набора', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ring-engine-'));
  try {
    cpSync(join(root, 'kit', 'arena', 'engine'), join(dir, 'engine'), { recursive: true });
    const E = await import(pathToFileURL(join(dir, 'engine', 'index.js')).href);
    assert.ok(E.RING_VERSION?.engine);
    assert.ok(E.SOUND_NAMES.length > 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('протокол: время работы без долгих пауз и токены из журналов Claude Code и Codex', async () => {
  const { workIn } = await import('../judge/protocol.js');
  const dir = mkdtempSync(join(tmpdir(), 'ring-journal-'));
  try {
    const t0 = Date.parse('2026-01-01T10:00:00Z');
    const at = (min) => new Date(t0 + min * 60000).toISOString();
    const claude = join(dir, 'c.jsonl');
    writeFileSync(claude, [
      { type: 'user', timestamp: at(0), message: { role: 'user', content: 'Раунд 1 окончен' } },
      { type: 'assistant', timestamp: at(2), message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 } } },
      { type: 'assistant', timestamp: at(4), message: { role: 'assistant', usage: { input_tokens: 5, output_tokens: 50 } } },
      // a long break does not count as work
      { type: 'assistant', timestamp: at(40), message: { role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 } } },
    ].map((x) => JSON.stringify(x)).join('\n'));
    const codex = join(dir, 'x.jsonl');
    writeFileSync(codex, JSON.stringify({ timestamp: at(41), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 7 } } } }));
    const w = workIn([claude, codex], t0, t0 + 3600000);
    assert.equal(w.activeMinutes, 5);
    assert.deepEqual(w.tokens, { input: 216, output: 171, cacheRead: 1100, cacheWrite: 0, reasoning: 7 });
    assert.equal(workIn([claude], t0 + 7200000, t0 + 9000000), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('статистика раунда по записи: здоровье по времени, счётчики, моменты; секунды ролика по разметке кадров', async () => {
  const { analyze } = await import('../judge/match.js');
  const { roundStats, pickMoments, clipTime } = await import('../judge/moments.js');
  const E = await import('../kit/arena/engine/index.js');
  // the fixture keeps the fighters' rules without their pictures: compile them without the file list
  const fighters = ['lisb', 'lisa'].map((id) => E.checkFighter(Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(FIXTURE, 'round-1', id, 'fighter', `${f}.json`), 'utf8'))]))).fighter);
  const replay = JSON.parse(readFileSync(join(FIXTURE, 'round-1', 'replay.json'), 'utf8'));
  const st = roundStats(analyze(fighters, replay), fighters);
  assert.ok(st.hp.length > 4);
  assert.equal(st.hp[0][1], 1);
  for (const p of st.hp) assert.ok(p[1] >= 0 && p[1] <= 1 && p[2] >= 0 && p[2] <= 1);
  assert.equal(st.counters.length, 2);
  assert.ok(st.counters[0].hits + st.counters[1].hits > 0, 'кто-то попал');
  const best = pickMoments(st.moments, 3);
  for (let i = 1; i < best.length; i++) assert.ok(best[i].from >= best[i - 1].to, 'моменты не перекрываются');
  // timing: 3 frames of intro (-1), then ticks 0, 2, 4 …
  const timing = { fps: 30, ticks: [-1, -1, -1, 0, 2, 4, 6, 8] };
  assert.equal(clipTime(timing, 0), 0.1);
  assert.equal(clipTime(timing, 5), 0.2);
});

test('озвучка: одна законченная реплика за раз, только в паузах, не поверх бойцов и ведущего ринга; имена моделей вслух', async () => {
  const { layout, parseLines, speakable, clipPauses } = await import('../judge/commentator.js');
  const facts = { clip: { seconds: 40 } };
  const lines = parseLines('Вот: [{"t":5,"who":"host","text":"Удар!"},{"t":5.5,"who":"expert","text":"Так и было — снова"},{"t":3,"who":"nobody","text":"x"}]', facts);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].text, 'Так и было, снова.', 'законченное предложение');
  // 0–8 s before the fight, 8–30 s the fight, 30–40 s after it
  const timing = { fps: 10, phases: ['vs', 'board', 'fight', 'after', 'result'], phase: [...Array(40).fill(0), ...Array(40).fill(1), ...Array(220).fill(2), ...Array(60).fill(3), ...Array(40).fill(4)] };
  const pauses = clipPauses(timing);
  assert.deepEqual(pauses.map((p) => [p.from, p.to, p.what]), [[0, 8, 'до боя'], [30, 40, 'после боя']]);
  const voices = [{ t: 2, seconds: 1.5, who: 'ведущий ринга' }, { t: 31, seconds: 2, who: 'Лис' }];
  const placed = layout([{ t: 1, seconds: 2 }, { t: 1.5, seconds: 2 }, { t: 12, seconds: 2 }, { t: 30, seconds: 3 }, { t: 38, seconds: 3 }], voices, pauses, 40);
  for (let i = 1; i < placed.length; i++) assert.ok(placed[i].at >= placed[i - 1].at + placed[i - 1].seconds, 'одна за раз');
  for (const l of placed) {
    assert.ok(pauses.some((p) => l.at >= p.from && l.at + l.seconds <= p.to), 'только в паузе');
    for (const v of voices) assert.ok(l.at >= v.t + v.seconds || l.at + l.seconds <= v.t, 'не поверх голоса');
  }
  assert.deepEqual(placed.map((l) => l.t), [1, 30], 'реплика во время боя и не влезшие в паузу целиком выпадают');
  assert.equal(speakable('Claude Sonnet 5.5 против GPT-6.2'), 'Клод Сонет пять точка пять против джи-пи-ти-шесть точка два');
});

test('подписи: одна за раз, не чаще одной на 7 секунд, по 3–4 секунды, важные первыми, одинаковые один раз', async () => {
  const { scheduleCaptions, applyWording, CAPTION_GAP } = await import('../judge/captions.js');
  const c = (id, at, prio, text, latest = at + 6) => ({ id, at, latest, prio, text });
  const cands = [c('a', 2, 3, 'Суперприём: 54 урона'), c('b', 4, 10, 'Opus: первым не бить'), c('c', 6, 6, 'Серия из 5 ударов'), c('d', 20, 4, 'Суперприём: 54 урона'), c('e', 30, 9, 'Камбэк', 30.5), c('f', 59, 7, 'Нокаут', 59)];
  const out = scheduleCaptions(cands, 60);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].at - out[i - 1].at >= CAPTION_GAP && out[i].at >= out[i - 1].at + out[i - 1].seconds);
  for (const x of out) assert.ok(x.seconds >= 2.8 && x.seconds <= 4 && x.at + x.seconds <= 60);
  assert.equal(out[0].id, 'b', 'раздевалка важнее суперприёма рядом');
  assert.equal(out.filter((x) => x.text === 'Суперприём: 54 урона').length, 1);
  assert.ok(!out.some((x) => x.id === 'f'), 'у самого конца ролика подпись не помещается');
  const worded = applyWording(cands, { captions: [{ id: 'b', text: 'Opus поменял одну строку: первым не бить.' }, { id: 'c', text: 'x'.repeat(80) }] });
  assert.equal(worded.find((x) => x.id === 'b').text, 'Opus поменял одну строку: первым не бить');
  assert.equal(worded.find((x) => x.id === 'c').text, 'Серия из 5 ударов', 'длинная строка модели не берётся');
});

test('токены Claude Code: одно сообщение из нескольких строк журнала считается один раз', async () => {
  const { journalEntries } = await import('../judge/protocol.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'ring-tok-'));
  try {
    const u = { input_tokens: 3, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 10 };
    const line = (id, at, usage) => JSON.stringify({ type: 'assistant', timestamp: at, message: { id, role: 'assistant', usage, content: [] } });
    const f = join(dir, 'j.jsonl');
    writeFileSync(f, [line('m1', '2026-11-07T10:00:00Z', { ...u, output_tokens: 40 }), line('m1', '2026-11-07T10:00:01Z', u), line('m1', '2026-11-07T10:00:02Z', u), line('m2', '2026-11-07T10:00:05Z', u)].join('\n'));
    const sum = journalEntries(f).filter((e) => e.tokens).reduce((a, e) => a + e.tokens.output, 0);
    assert.equal(sum, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
