// Judge tests: round analysis and the locker room, the winner after a knockout, ring sounds, the audit of journals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { readFighterDir, runFight } from '../kit/arena/tools/load.js';
import { analyze } from '../judge/match.js';
import { soundsFor, SOUNDS, stageBeds } from '../kit/arena/render/sound.js';
import { mixFight } from '../kit/arena/tools/sounds.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KIT = join(root, 'tests', 'fixtures', 'ring3', 'fighter');
const DUMMY = join(root, 'tests', 'fixtures', 'ring3', 'dummy');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === '.git') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// the contestant's folder and the launch of its agent: tests/launch.test.mjs

test('после нокаута победитель сразу перестаёт атаковать и встаёт в победу', () => {
  const k = readFighterDir(KIT).fighter;
  const d = readFighterDir(DUMMY).fighter;
  const fight = E.createFight({ fighters: [k, d] });
  fight.f[0].x = fight.f[1].x - 120;
  fight.f[1].hp = 5;
  let endAt = null;
  for (let i = 0; i < 400; i++) {
    const acts = fight.freeze || fight.hitstop || fight.over ? null : [{ attack: 'strike_1' }, {}];
    for (const e of E.stepFight(fight, acts)) if (e.type === 'end') endAt = fight.tick;
    if (endAt !== null && fight.tick > endAt + 3) break;
  }
  assert.ok(endAt !== null, 'нокаут случился');
  const W = fight.f[0];
  assert.equal(W.state, 'neutral');
  assert.equal(W.move, null);
  assert.equal(W.vx, 0);
  assert.equal(fight.projectiles.length, 0);
});

test('разбор раунда: приёмы, попадания и промахи сходятся с событиями боя', async () => {
  const fighters = [readFighterDir(KIT).fighter, readFighterDir(DUMMY).fighter];
  const run = await runFight({ dirs: [KIT, DUMMY], fighters, options: { dummy: 'block' }, maxTicks: 1500 });
  const an = analyze(fighters, run.replay);
  assert.equal(E.fightHash(an.fight), run.replay.hash, 'разбор повторяет бой кадр в кадр');
  const me = an.summary[0];
  const moveEvents = run.events.filter((e) => e.type === 'move' && e.side === 0).length;
  assert.equal(me.moves.reduce((s, m) => s + m.used, 0), moveEvents);
  for (const m of me.moves) assert.equal(m.landed + m.blocked + m.parried + m.armored + m.whiffed, m.used);
  const hitDmg = run.events.filter((e) => e.type === 'hit' && e.attacker === 0).reduce((s, e) => s + e.damage, 0);
  assert.equal(me.moves.reduce((s, m) => s + m.damage, 0), hitDmg + run.events.filter((e) => e.type === 'armor' && e.attacker === 0).reduce((s, e) => s + e.damage, 0));
  assert.ok(an.samples.length > 100);
});

test('каждое событие боя звучит файлом из каталога, звуки бойца заменяют обычные, у сцен свои петли', async () => {
  const { existsSync } = await import('node:fs');
  for (const [name, s] of Object.entries(SOUNDS)) for (const f of s.files) assert.ok(existsSync(join(root, 'kit', 'arena', 'sounds', f)), `${name}: ${f}`);
  for (const type of ['hit', 'block', 'parry', 'throw', 'knockdown', 'super', 'projectile', 'teleport', 'end', 'dash', 'jump', 'land', 'grab']) {
    const list = soundsFor({ type, reason: 'ko' });
    assert.ok(list.length && list.every((x) => SOUNDS[x.name]), type);
  }
  const defs = [{ movesById: { m: { slot: 'normal', limb: 'K', sounds: { hit: 'fire' } }, k: { slot: 'normal', limb: 'K', sounds: {} } } }];
  assert.equal(soundsFor({ type: 'hit', attacker: 0, move: 'm', damage: 20 }, 0, defs)[0].name, 'fire');
  assert.equal(soundsFor({ type: 'hit', attacker: 0, move: 'k', damage: 20 }, 0, defs)[0].name, 'kick');
  for (const id of ['rooftop', 'server', 'foundry', 'temple']) {
    const b = stageBeds({ def: { sound: id } });
    assert.ok(b.music && b.ambience, id);
  }
  const track = mixFight({ sounds: [{ at: 0.1, name: 'hit-light' }, { at: 0.5, name: 'ko' }], beds: stageBeds({ def: { sound: 'rooftop' } }), seconds: 2 });
  assert.ok(track.length >= 2 * 2 * 48000);
  assert.ok(track.some((x) => Math.abs(x) > 0.2));
});

test('раунд после ничьей идёт под тем же номером как переигровка, 1:1 — решающий', async () => {
  const { roundOrder } = await import('../judge/match.js');
  const rounds = [{ winner: 'red' }, { winner: null }, { winner: 'blue' }, { winner: null }, { winner: 'red' }];
  assert.deepEqual(rounds.map((_, i) => roundOrder(rounds, i)), [
    { num: 1, rerun: false },
    { num: 2, rerun: false },
    { num: 2, rerun: true },
    { num: 3, rerun: false },
    { num: 3, rerun: true },
  ]);
});

test('ролик раунда снимается на движке снимка раунда, а не на текущем', async () => {
  const { snapshotEngine } = await import('../judge/render.js');
  const rd = join(root, 'tests', 'fixtures', 'match-2.0', 'round-1');
  const f = snapshotEngine(rd, 'lisb');
  assert.equal(f['/arena/engine/'][0], join(rd, 'lisb', 'arena', 'engine'));
  assert.equal(f['/arena/engine/'][1], join(root, 'kit', 'arena', 'engine'), 'недостающие модули показа — из набора');
  assert.deepEqual(f['/f/arena/engine/'], f['/arena/engine/']);
  assert.deepEqual(snapshotEngine(rd, 'нет-такого'), {});
});

test('аудит: свои сохранённые выводы сессии Claude Code не нарушение, чужая папка и ~/.claude оператора — нарушение, регистр не важен', async () => {
  const { auditLine } = await import('../judge/contestants.js');
  const needles = [{ what: '~/.claude оператора', n: 'c:\\users\\op\\.claude' }, { what: 'участник «b»', n: 'c:/ring-contest-b' }];
  const own = ['c:\\users\\op\\.claude\\projects\\c--ring-contest-a'];
  const mine = '{"file_path":"C:\\Users\\Op\\.claude\\projects\\C--ring-contest-a\\abc\\tool-results\\x.txt"}';
  assert.deepEqual(auditLine(mine, needles, own), []);
  assert.equal(auditLine('{"file_path":"C:\\Users\\Op\\.claude\\skills\\x.md"}', needles, own)[0].what, '~/.claude оператора');
  assert.equal(auditLine('cat C:/Ring-Contest-B/fighter/brain.js', needles, own)[0].what, 'участник «b»');
  // a longer name that starts like another contestant's folder is not that folder
  assert.deepEqual(auditLine('cd C:/ring-contest-b55/fighter', needles, own), []);
  assert.equal(auditLine('cd C:/ring-contest-b55 && cat C:/ring-contest-b', needles, own)[0].what, 'участник «b»');
});
