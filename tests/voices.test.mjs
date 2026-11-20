// Voice slots: the judge deletes only the ring's contestant voices, marks them released, and `voice lines` makes a
// released voice again from its preview. No network: a fake voice server.  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ringVoiceOwner, sweepVoices, releaseVoice, activeContestants } from '../judge/voices.js';
import { voiceIdFor } from '../kit/arena/tools/voice.js';

const tmp = mkdtempSync(join(tmpdir(), 'ring-voices-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// a contestant root with a picked voice
function contestant(id, state) {
  const root = join(tmp, id);
  mkdirSync(join(root, 'fighter', 'voice', 'design'), { recursive: true });
  writeFileSync(join(root, 'fighter', 'fighter.json'), JSON.stringify({ name: 'Будильник' }));
  writeFileSync(join(root, 'fighter', 'voice', 'design', 'design.json'), JSON.stringify({ description: 'бодрый баритон', previews: [{ n: 1, file: 'voice/design/preview-1.mp3', generated_voice_id: `gen-${id}` }] }));
  if (state) writeFileSync(join(root, 'fighter', 'voice', 'voice-id.json'), JSON.stringify(state));
  return root;
}
const state = (root) => JSON.parse(readFileSync(join(root, 'fighter', 'voice', 'voice-id.json'), 'utf8'));

// the fake account: voices by id; calls are recorded
function account(voices) {
  const calls = [];
  const live = new Map(voices.map((v) => [v.voice_id, v]));
  const server = async (p) => {
    calls.push(p);
    if (p.action === 'list') return { voices: [...live.values()], used: live.size, limit: 30 };
    if (p.action === 'delete') {
      const v = live.get(p.voice_id);
      if (!v) throw new Error('ElevenLabs через сервер: ElevenLabs HTTP 404: voice_not_found');
      if (!v.name.startsWith(p.prefix) || !p.prefix.startsWith('Ринг · ')) throw new Error('ElevenLabs через сервер: refused: the voice is not the ring\'s');
      live.delete(p.voice_id);
      return { deleted: p.voice_id, name: v.name };
    }
    if (p.action === 'create') {
      const id = `same-as-${p.generated_voice_id}`;
      live.set(id, { voice_id: id, name: p.name });
      return { voice_id: id };
    }
    throw new Error(`unexpected ${p.action}`);
  };
  return { server, calls, live };
}

const OTHERS = [
  { voice_id: 'host', name: 'Ринг моделей · ведущий' },
  { voice_id: 'expert', name: 'Ринг моделей · эксперт' },
  { voice_id: 'clone', name: 'Клон голоса ведущего' },
  { voice_id: 'maya', name: 'Голос другого проекта' },
  { voice_id: 'odd', name: 'Ринг ·без id' },
];

test('голос участника ринга узнаётся только по «Ринг · <id> · …»', () => {
  assert.equal(ringVoiceOwner('Ринг · opus33 · Метроном'), 'opus33');
  assert.equal(ringVoiceOwner('Ринг · carbon30b · Раскол'), 'carbon30b');
  for (const v of OTHERS) assert.equal(ringVoiceOwner(v.name), null, v.name);
  assert.equal(ringVoiceOwner('Ринг · Opus · x'), null, 'id участника — латиница в нижнем регистре');
});

test('чистка удаляет голоса участников, кроме работающих сейчас; чужие голоса не трогает никогда', async () => {
  const done = contestant('fable33', { voice_id: 'v-fable', name: 'Ринг · fable33 · Будильник' });
  const acc = account([...OTHERS, { voice_id: 'v-fable', name: 'Ринг · fable33 · Будильник' }, { voice_id: 'v-opus', name: 'Ринг · opus33 · Метроном' }, { voice_id: 'v-red', name: 'Ринг · red · Цугцванг' }]);
  const dry = await sweepVoices({ server: acc.server, active: ['opus33'], dry: true, reg: { fable33: { root: done } } });
  assert.deepEqual(dry.deleted.sort(), ['Ринг · fable33 · Будильник', 'Ринг · red · Цугцванг']);
  assert.ok(!acc.calls.some((c) => c.action === 'delete'), 'сухой прогон ничего не удаляет');
  const r = await sweepVoices({ server: acc.server, active: ['opus33'], reg: { fable33: { root: done } }, now: () => 'T' });
  assert.deepEqual(r.kept, ['Ринг · opus33 · Метроном']);
  for (const v of OTHERS) assert.ok(acc.live.has(v.voice_id), `${v.name} на месте`);
  assert.ok(acc.live.has('v-opus') && !acc.live.has('v-fable') && !acc.live.has('v-red'));
  assert.equal(state(done).released, 'T');
  assert.equal(state(done).voice_id, 'v-fable', 'id голоса остаётся в истории');
  for (const c of acc.calls.filter((x) => x.action === 'delete')) assert.ok(c.prefix.startsWith('Ринг · ') && c.prefix.endsWith(' · '));
});

test('после запуска судья освобождает голос участника; повтор и уже удалённый голос не ошибка', async () => {
  const root = contestant('opus40', { voice_id: 'v-op', name: 'Ринг · opus40 · Метроном' });
  const acc = account([{ voice_id: 'v-op', name: 'Ринг · opus40 · Метроном' }]);
  const r = await releaseVoice('opus40', { server: acc.server, root, now: () => 'T1' });
  assert.equal(r.deleted, true);
  assert.equal(state(root).released, 'T1');
  assert.equal((await releaseVoice('opus40', { server: acc.server, root })).skipped, 'уже освобождён');
  const gone = contestant('sol40', { voice_id: 'v-missing', name: 'Ринг · sol40 · Полюс' });
  assert.equal((await releaseVoice('sol40', { server: acc.server, root: gone, now: () => 'T2' })).deleted, true);
  assert.equal(state(gone).released, 'T2');
  // a voice whose name is not the contestant's is refused and the state stays
  const odd = contestant('astra40', { voice_id: 'clone', name: 'Ринг · astra40 · Фаро' });
  const acc2 = account([{ voice_id: 'clone', name: 'Клон голоса ведущего' }]);
  await assert.rejects(releaseVoice('astra40', { server: acc2.server, root: odd }), /refused/);
  assert.equal(state(odd).released, undefined);
  assert.ok(acc2.live.has('clone'));
});

test('voice lines пересоздаёт освобождённый голос из того же образца', async () => {
  const fighter = join(contestant('fable41', { voice_id: 'v-old', from: 'voice/design/preview-1.mp3', name: 'Ринг · fable41 · Будильник', description: 'бодрый баритон', released: 'T' }), 'fighter');
  const acc = account([]);
  const id = await voiceIdFor(fighter, acc.server);
  assert.equal(id, 'same-as-gen-fable41');
  const create = acc.calls.find((c) => c.action === 'create');
  assert.equal(create.generated_voice_id, 'gen-fable41', 'образец найден по полю from (голоса до 3.0 не хранили его id)');
  assert.equal(create.name, 'Ринг · fable41 · Будильник');
  const st = JSON.parse(readFileSync(join(fighter, 'voice', 'voice-id.json'), 'utf8'));
  assert.equal(st.released, undefined);
  assert.equal(st.generated_voice_id, 'gen-fable41');
  // a live voice is not made again
  assert.equal(await voiceIdFor(fighter, acc.server), 'same-as-gen-fable41');
  assert.equal(acc.calls.filter((c) => c.action === 'create').length, 1);
});

test('работающим считается участник, чей запуск не кончился и не вышел за свой предел', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const runs = {
    a: [{ started: '2026-11-18T11:00:00Z', ended: null, minutes: 300 }],
    b: [{ started: '2026-11-18T11:00:00Z', ended: '2026-11-18T11:30:00Z', minutes: 300 }],
    c: [{ started: '2026-11-17T01:00:00Z', ended: null, minutes: 300 }],
  };
  assert.deepEqual(activeContestants(runs, now), ['a']);
});
