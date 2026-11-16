// Judge tests: contestant isolation, round analysis and the locker room, the winner after a knockout, ring sounds.
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
const KIT = join(root, 'kit', 'fighter');
const DUMMY = join(root, 'kit', 'arena', 'sparring', 'dummy');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === '.git') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('папка участника создаётся вне ринга и не знает пути к рингу', async () => {
  const { createContestant } = await import('../judge/contestants.js');
  assert.throws(() => createContestant('inside-test', { agent: 'claude', root: join(root, 'contestants', 'x') }), /внутри папки ринга/);
  // a real folder: the registry entry is removed afterwards
  const reg = join(root, 'contestants.json');
  const before = existsSync(reg) ? readFileSync(reg, 'utf8') : null;
  const base = mkdtempSync(join(tmpdir(), 'ring-iso-'));
  try {
    const r = createContestant('iso-test', { agent: 'codex', model: 'Проба', root: join(base, 'iso') });
    const ring = root.toLowerCase();
    const ringSlash = root.split('\\').join('/').toLowerCase();
    for (const f of walk(r.root)) {
      if (/\.(png|webp|mp3|mjs|js)$/i.test(f) && !f.endsWith('contestant.json')) continue;
      const text = readFileSync(f, 'utf8').toLowerCase();
      assert.ok(!text.includes(ring) && !text.includes(ringSlash), `${f} содержит путь к рингу`);
    }
    const c = JSON.parse(readFileSync(join(r.root, 'contestant.json'), 'utf8'));
    assert.deepEqual(Object.keys(c).sort(), ['color', 'id', 'model']);
    assert.ok(existsSync(join(r.root, '.ring', 'limits.json')));
    assert.match(readFileSync(join(r.root, '.gitignore'), 'utf8'), /\.ring\//);
    assert.ok(readFighterDir(join(r.root, 'fighter')).ok);
    // the launch script: no trace of the operator's agent session, the agent's exit code back
    const ps = readFileSync(r.script, 'utf8');
    assert.match(ps, /CLAUDE_CODE_\|.*CODEX_\|T3CODE_/);
    assert.ok(ps.indexOf('Remove-Item') < ps.indexOf('$env:'), 'чистка окружения до своих переменных');
    // a Windows job that closes what the agent leaves running (a background preview outlived the agent)
    assert.ok(ps.includes('0x2000') && ps.indexOf('[RingJob]::Start()') < ps.indexOf('Set-Location'));
    assert.match(ps, /\$code = \$LASTEXITCODE[\s\S]*exit \$code\s*$/);
    // its own git identity, or the agent cannot commit its work (found on the rehearsal)
    const { execFileSync } = await import('node:child_process');
    assert.ok(execFileSync('git', ['config', 'user.name'], { cwd: r.root, encoding: 'utf8' }).trim());
  } finally {
    rmSync(base, { recursive: true, force: true });
    const { writeFileSync } = await import('node:fs');
    if (before === null) rmSync(reg, { force: true });
    else writeFileSync(reg, before);
    rmSync(join(root, 'launch', 'iso-test.ps1'), { force: true });
  }
});

test('Claude-участник на другой подписке: токен читается из файла при запуске, в скрипт не попадает', async () => {
  const { createContestant, setClaudeAccount, claudeTokenFile } = await import('../judge/contestants.js');
  const reg = join(root, 'contestants.json');
  const before = existsSync(reg) ? readFileSync(reg, 'utf8') : null;
  const base = mkdtempSync(join(tmpdir(), 'ring-acc-'));
  try {
    createContestant('acc-test', { agent: 'claude', model: 'Проба', root: join(base, 'acc') });
    assert.throws(() => setClaudeAccount('acc-test', 'Bad Name'), /имя аккаунта/);
    const ps = readFileSync(setClaudeAccount('acc-test', 'friend'), 'utf8');
    const file = claudeTokenFile('friend');
    assert.ok(ps.includes(file) && ps.includes('Test-Path'));
    // set after the cleanup of CLAUDE_CODE_* variables, or the cleanup erases it
    assert.ok(ps.indexOf('Remove-Item') < ps.indexOf('CLAUDE_CODE_OAUTH_TOKEN =') && ps.indexOf('CLAUDE_CODE_OAUTH_TOKEN =') < ps.indexOf('Set-Location'));
    assert.ok(!readFileSync(setClaudeAccount('acc-test', null), 'utf8').includes('OAUTH_TOKEN'));
  } finally {
    rmSync(base, { recursive: true, force: true });
    const { writeFileSync } = await import('node:fs');
    if (before === null) rmSync(reg, { force: true });
    else writeFileSync(reg, before);
    rmSync(join(root, 'launch', 'acc-test.ps1'), { force: true });
  }
});

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
