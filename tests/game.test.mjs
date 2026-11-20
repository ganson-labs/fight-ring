// Game data: fighter versions from the judge's snapshots and the model's locker-room reply from agent journals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildVersions } from '../judge/gamedata.js';
import { lockerReplyIn } from '../judge/contestants.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KIT = join(root, 'tests', 'fixtures', 'ring3', 'fighter');

test('версии бойца: одинаковые снимки — одна версия, изменённый — следующая с разбором, путей наружу нет', () => {
  const base = mkdtempSync(join(tmpdir(), 'ring-ver-'));
  try {
    const snap = (n) => {
      const d = join(base, `round-${n}`, 'fighter');
      cpSync(KIT, d, { recursive: true });
      return d;
    };
    const [a, b, c] = [snap(1), snap(2), snap(3)];
    const f = JSON.parse(readFileSync(join(c, 'fighter.json'), 'utf8'));
    const [k1, k2] = Object.keys(f.stats);
    f.stats[k1] += 1;
    f.stats[k2] -= 1;
    writeFileSync(join(c, 'fighter.json'), JSON.stringify(f));
    const snaps = [a, b, c].map((dir, i) => ({ dir, match: 'm', round: i + 1, num: i + 1, rerun: false, note: i === 2 ? { round: 2, text: 'поменял характеристики' } : null }));
    const live = join(base, 'live');
    cpSync(c, live, { recursive: true });
    const vs = buildVersions(snaps, live, '/c/x/fighter/');
    assert.equal(vs.length, 2);
    assert.deepEqual(vs[0].rounds.map((r) => r.round), [1, 2]);
    assert.deepEqual(vs[1].rounds.map((r) => r.round), [3]);
    assert.equal(vs[1].current, true, 'папка участника совпадает с последним снимком');
    assert.equal(vs[1].changes.stats.length, 2);
    assert.equal(vs[1].note.text, 'поменял характеристики');
    assert.equal(vs[0].changes, null);
    const text = JSON.stringify(vs);
    assert.ok(!text.includes(base) && !text.includes(base.replace(/\\/g, '/')), 'в данных игры нет путей диска');
    // the folder moved on after the last round: one more version, the current one
    f.stats[k1] -= 1;
    f.stats[k2] += 1;
    writeFileSync(join(live, 'fighter.json'), JSON.stringify(f));
    const vs2 = buildVersions(snaps, live, '/c/x/fighter/');
    assert.equal(vs2.length, 3);
    assert.equal(vs2[2].url, '/c/x/fighter/');
    assert.deepEqual(vs2[2].rounds, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ответ раздевалки берётся из журнала Claude Code и Codex: последнее сообщение модели после промпта', () => {
  const base = mkdtempSync(join(tmpdir(), 'ring-notes-'));
  try {
    mkdirSync(base, { recursive: true });
    const L = (o) => JSON.stringify(o);
    const claude = join(base, 'claude.jsonl');
    writeFileSync(claude, [
      L({ type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'Раунд 1 окончен. Материалы…' } }),
      L({ type: 'assistant', timestamp: '2026-01-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'смотрю запись' }] } }),
      L({ type: 'user', timestamp: '2026-01-01T10:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      L({ type: 'assistant', timestamp: '2026-01-01T10:09:00Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Добавил блок низом.' }] } }),
      L({ type: 'user', timestamp: '2026-01-01T11:00:00Z', message: { role: 'user', content: 'Раунд 2 окончен. Материалы…' } }),
      L({ type: 'assistant', timestamp: '2026-01-01T11:05:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Ускорил бросок.' }] } }),
    ].join('\n'));
    const codex = join(base, 'codex.jsonl');
    writeFileSync(codex, [
      L({ timestamp: '2026-01-01T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Раунд 1 окончен.' }] } }),
      L({ timestamp: '2026-01-01T10:07:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Сменил стойку.' }] } }),
    ].join('\n'));
    assert.equal(lockerReplyIn([claude], 1).text, 'Добавил блок низом.');
    assert.equal(lockerReplyIn([claude], 2).text, 'Ускорил бросок.');
    assert.equal(lockerReplyIn([codex], 1).text, 'Сменил стойку.');
    const gemini = join(base, 'transcript_full.jsonl');
    writeFileSync(gemini, [
      L({ step_index: '0', source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-01-01T10:00:00Z', content: '<USER_REQUEST>\nРаунд 1 окончен. Материалы…\n</USER_REQUEST>' }),
      L({ step_index: '1', source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-01-01T10:01:00Z', input_tokens: '10', output_tokens: '2', tool_calls: '[]' }),
      L({ step_index: '2', source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-01-01T10:06:00Z', content: 'Добавил подкат.' }),
    ].join('\n'));
    assert.equal(lockerReplyIn([gemini], 1).text, 'Добавил подкат.');
    assert.equal(lockerReplyIn([claude, codex], 3), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('игрок: команда кнопкой запускает приём, назад при атаке соперника — блок', async () => {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
  globalThis.navigator ??= {};
  const E = await import('../kit/arena/engine/index.js');
  const { readFighterDir } = await import('../kit/arena/tools/load.js');
  const { Controls, moveList } = await import('../viewer/game/input.js');
  const me = readFighterDir(KIT).fighter;
  const dummy = readFighterDir(join(root, 'tests', 'fixtures', 'ring3', 'dummy')).fighter;
  const first = me.moves.find((m) => m.slot === 'normal' && m.posture === 'stand');
  assert.equal(first.command, 'LP');
  assert.equal(moveList(me).filter((m) => m.slot === 'super').length, 1);
  const c = new Controls(me);
  const fight = E.createFight({ fighters: [me, dummy] });
  for (let i = 0; i < 5; i++) E.stepFight(fight, [E.sanitizeAction(c.act(fight, 0)), E.IDLE_ACTION]);
  c.pending.push('LP');
  let started = false;
  for (let i = 0; i < 10 && !started; i++) {
    E.stepFight(fight, [E.sanitizeAction(c.act(fight, 0)), E.IDLE_ACTION]);
    started = fight.f[0].state === 'move' && fight.f[0].move?.def.id === first.id;
  }
  assert.ok(started, 'приём на LP начался');
  // holding back while the opponent attacks gives a guard
  const f2 = E.createFight({ fighters: [me, me] });
  const atk = me.moves.find((m) => m.slot === 'normal');
  E.stepFight(f2, [E.IDLE_ACTION, E.sanitizeAction({ attack: atk.id })]);
  c.down.add('ArrowLeft');
  const a = c.act(f2, 0);
  assert.equal(a.walk, -1);
  assert.equal(a.guard, 'high');
  c.dispose();
});

test('игрок: каждая команда набора вызывает свой приём с клавиатуры и с геймпада, бросок вплотную', async () => {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
  const E = await import('../kit/arena/engine/index.js');
  const { Controls } = await import('../viewer/game/input.js');
  const input = JSON.parse(JSON.stringify(Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(KIT, `${f}.json`), 'utf8'))]))));
  const base = input.moves.moves[0];
  const sup = input.moves.moves[1];
  const strike = (id, slot, posture, zone, command) => ({ ...JSON.parse(JSON.stringify(base)), id, name: id, slot, posture, ...(command ? { command } : {}), blocks: [{ ...base.blocks[0], zone, damage: 20, recovery: 18 }] });
  input.moves.moves = [
    strike('jab', 'normal', 'stand', 'mid'),
    strike('fwd', 'normal', 'stand', 'mid', '6HK'),
    strike('low', 'normal', 'crouch', 'low', '2LK'),
    strike('qcf', 'special', 'stand', 'mid', '236P'),
    strike('dp', 'special', 'stand', 'high', '623K'),
    strike('chg', 'special', 'stand', 'mid', '[4]6P'),
    sup,
  ];
  const r = E.checkFighter(input);
  assert.ok(r.ok, r.errors.join('\n'));
  const me = r.fighter;
  const dummy = E.checkFighter(Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'ring3', 'dummy', `${f}.json`), 'utf8'))]))).fighter;
  // the input of a command, tick by tick: { dir (numpad, facing right), press }
  const BTN = { P: 'LP', K: 'LK', PP: ['LP', 'HP'], KK: ['LK', 'HK'] };
  const framesOf = (cmd, posture) => {
    const c = E.parseCommand(cmd);
    const out = [];
    if (c.charge !== null) for (let i = 0; i < 36; i++) out.push({ dir: c.charge });
    const motion = c.motion.length ? c.motion : posture === 'crouch' ? [2] : [5];
    for (const d of motion) out.push({ dir: d }, { dir: d });
    const b = BTN[c.token] || c.token;
    out[out.length - 1].press = Array.isArray(b) ? b : [b];
    return out;
  };
  const KEYS_OF = { 1: ['ArrowDown', 'ArrowLeft'], 2: ['ArrowDown'], 3: ['ArrowDown', 'ArrowRight'], 4: ['ArrowLeft'], 5: [], 6: ['ArrowRight'], 7: ['ArrowUp', 'ArrowLeft'], 8: ['ArrowUp'], 9: ['ArrowUp', 'ArrowRight'] };
  const STICK = { 1: [-1, 1], 2: [0, 1], 3: [1, 1], 4: [-1, 0], 5: [0, 0], 6: [1, 0], 7: [-1, -1], 8: [0, -1], 9: [1, -1] };
  const PAD = { LP: 2, HP: 3, LK: 0, HK: 1 };
  let pad = null;
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => (pad ? [pad] : []) }, configurable: true, writable: true });
  const fresh = () => {
    const fight = E.createFight({ fighters: [me, dummy] });
    for (let i = 0; i < 3; i++) E.stepFight(fight, [E.IDLE_ACTION, E.IDLE_ACTION]);
    return fight;
  };
  const started = (fight, id) => (id === 'throw' ? fight.f[0].state === 'throwing' : fight.f[0].state === 'move' && fight.f[0].move?.def.id === id);
  const play = (fight, frames, device, id) => {
    const c = new Controls(me);
    try {
      for (const f of [...frames, ...Array(12).fill({ dir: 5 })]) {
        if (device === 'kb') {
          c.down = new Set(KEYS_OF[f.dir]);
          if (f.press) c.pending.push(...f.press);
          pad = null;
        } else {
          const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: !!f.press?.some((b) => PAD[b] === i) }));
          pad = { connected: true, index: 0, buttons, axes: STICK[f.dir] };
        }
        E.stepFight(fight, [E.sanitizeAction(c.act(fight, 0)), E.IDLE_ACTION]);
        if (started(fight, id)) return true;
      }
      return false;
    } finally {
      c.dispose();
      pad = null;
    }
  };
  for (const m of me.moves) for (const device of ['kb', 'pad']) {
    const fight = fresh();
    if (m.slot === 'super') fight.f[0].meter = E.METER_MAX;
    assert.ok(play(fight, framesOf(m.command, m.posture), device, m.id), `${device}: ${m.id} (${m.command})`);
  }
  // the super also on both heavies, the throw on both lights next to the opponent
  const f2 = fresh();
  f2.f[0].meter = E.METER_MAX;
  assert.ok(play(f2, [{ dir: 5, press: ['HP', 'HK'] }], 'kb', sup.id), 'суперприём на HP+HK');
  const f3 = fresh();
  f3.f[0].x = f3.f[1].x - 90;
  assert.ok(play(f3, [{ dir: 5, press: ['LP', 'LK'] }], 'kb', 'throw'), 'бросок LP+LK вплотную');
});
