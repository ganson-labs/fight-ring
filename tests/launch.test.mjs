// A contestant's folder and the launch of its agent: the folder knows nothing of the ring, the launch script exists
// for Windows (PowerShell) and for macOS and Linux (bash), and an unattended run through the bash script does what
// it promises. No real agent is started here: a stand-in script takes the agent's place on PATH, reads the prompt
// from stdin, writes down what it was given and leaves processes running in the background.
// Every test that touches the judge's registry (contestants.json) lives in this one file: test files run in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFighterDir } from '../kit/arena/tools/load.js';
import { createContestant, setClaudeAccount, claudeTokenFile, launchScriptText, launchScriptFile, launchInvocation, codexHome, geminiHome, defaultRoot } from '../judge/contestants.js';
import { runAgent } from '../judge/run.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const POSIX = process.platform !== 'win32';
const REG = join(root, 'contestants.json');
const RUNS = join(root, 'ledger', 'runs.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === '.git') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// A contestant for one test: a real folder under a temporary one, its agent profiles there too; afterwards the
// judge's registry, the record of runs and the launch scripts are as they were.
async function withContestant(id, opts, fn) {
  const keep = [REG, RUNS].map((f) => [f, existsSync(f) ? readFileSync(f, 'utf8') : null]);
  const env = { ...process.env };
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ring-launch-')));
  process.env.RING_PROFILES = join(base, 'profiles');
  const logs = [];
  try {
    const r = createContestant(id, { model: 'Проба', root: join(base, 'contestant'), ...opts });
    return await fn({ ...r, base, id, logs });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    for (const [f, text] of keep) {
      if (text === null) rmSync(f, { force: true });
      else writeFileSync(f, text);
    }
    for (const p of ['win32', 'linux']) rmSync(launchScriptFile(id, p), { force: true });
    for (const f of logs) rmSync(f, { force: true });
    // a test that failed half-way leaves no stand-in running
    for (const n of ['stub.pid', 'sleeper.pid', 'loop.pid']) {
      try {
        process.kill(Number(readFileSync(join(base, 'out', n), 'utf8')), 'SIGKILL');
      } catch {}
    }
    rmSync(base, { recursive: true, force: true });
  }
}

test('папка участника создаётся вне ринга и не знает пути к рингу', async () => {
  assert.throws(() => createContestant('inside-test', { agent: 'claude', root: join(root, 'contestants', 'x') }), /внутри папки ринга/);
  await withContestant('iso-test', { agent: 'codex' }, async (r) => {
    // the ring's path as a whole path, in either spelling (a ring in a folder with a short name is a part of other words)
    const esc = (p) => p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
    const ring = new RegExp(`(^|[^a-z0-9._\\\\/-])(${esc(root)}|${esc(root.split('\\').join('/'))})(?![a-z0-9._-])`);
    let read = 0;
    for (const f of walk(r.root)) {
      if (!/\.(md|json|txt|html|css|gitignore)$/i.test(f)) continue;
      read++;
      assert.ok(!ring.test(readFileSync(f, 'utf8').toLowerCase()), `${f} содержит путь к рингу`);
    }
    assert.ok(read > 20, 'тексты набора прочитаны');
    const c = JSON.parse(readFileSync(join(r.root, 'contestant.json'), 'utf8'));
    assert.deepEqual(Object.keys(c).sort(), ['color', 'id', 'model']);
    assert.ok(existsSync(join(r.root, '.ring', 'limits.json')));
    assert.match(readFileSync(join(r.root, '.gitignore'), 'utf8'), /\.ring\//);
    assert.ok(readFighterDir(join(r.root, 'fighter'), { ruleset: 'standard' }).ok); // the template is a fighter of ring 4's kit
    // its own git identity, or the agent cannot commit its work (found on the rehearsal)
    assert.ok(execFileSync('git', ['config', 'user.name'], { cwd: r.root, encoding: 'utf8' }).trim());
    // the script written for this system is the one the judge starts
    assert.equal(r.script, launchInvocation('iso-test').script);
    assert.equal(readFileSync(r.script, 'utf8'), launchScriptText('iso-test'));
  });
});

test('по умолчанию участник живёт вне ринга: ~/ring-contest/<id>, в Windows C:/ring-contest-<id>', () => {
  const cfg = JSON.parse(readFileSync(join(root, 'ring.config.json'), 'utf8'));
  assert.equal(cfg.contestRoot, undefined, 'в репозитории путь участников не задан: его выбирает система');
  assert.equal(defaultRoot('red'), POSIX ? join(homedir(), 'ring-contest', 'red') : resolve('C:/ring-contest-red'));
});

test('скрипт запуска для Windows: чистое окружение, задание Windows, код агента наружу', async () => {
  await withContestant('ps-test', { agent: 'codex' }, async () => {
    const ps = launchScriptText('ps-test', 'win32');
    assert.ok(ps.startsWith('\ufeff') && ps.includes('\r\n'), 'PowerShell 5.1 читает кириллицу только с BOM');
    assert.match(ps, /CLAUDE_CODE_\|.*CODEX_\|T3CODE_/);
    assert.ok(ps.indexOf('Remove-Item') < ps.indexOf('$env:'), 'чистка окружения до своих переменных');
    // a Windows job that closes what the agent leaves running (a background preview outlived the agent)
    assert.ok(ps.includes('0x2000') && ps.indexOf('[RingJob]::Start()') < ps.indexOf('Set-Location'));
    assert.match(ps, /\$code = \$LASTEXITCODE[\s\S]*exit \$code\s*$/);
    assert.match(ps, /codex-home ps-test\r\n[\s\S]*codex-home ps-test --back/);
    assert.deepEqual(launchInvocation('ps-test', 'win32').args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  });
});

test('скрипт запуска для macOS и Linux: тот же смысл на bash для каждого агента', async () => {
  for (const agent of ['claude', 'codex', 'gemini']) {
    await withContestant('sh-test', { agent, agentModel: 'model-x', effort: 'high' }, async (r) => {
      const sh = launchScriptText('sh-test', 'linux');
      assert.ok(sh.startsWith('#!/usr/bin/env bash\n') && !sh.includes('\r'));
      assert.match(sh, /CLAUDE_CODE_\|.*CODEX_\|T3CODE_/);
      const unset = sh.indexOf('unset "$v"');
      const cd = sh.indexOf("\ncd '");
      assert.ok(unset > 0 && cd > unset, 'чистка окружения до запуска агента');
      for (const m of sh.matchAll(/^export /gm)) assert.ok(m.index > unset && m.index < cd, 'свои переменные после чистки и до агента');
      // a process group of its own, swept when the script ends
      assert.ok(sh.indexOf('trap ring_sweep EXIT') > 0 && sh.indexOf('trap ring_sweep EXIT') < unset);
      assert.match(sh, /"\$@"\ncode=\$\?\n[\s\S]*exit \$code\n$/);
      assert.ok(sh.includes(`cd '${r.root}'`), 'путь участника как есть, без обратных косых черт');
      if (agent === 'claude') assert.match(sh, /export CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'\n[\s\S]*'claude' '--settings' .*'--setting-sources' 'project' '--strict-mcp-config' '--dangerously-skip-permissions' '--model' 'model-x' '--effort' 'high' "\$@"/);
      if (agent === 'codex') {
        assert.match(sh, /codex-home sh-test \|\| exit 1\n[\s\S]*codex-home sh-test --back\nexit \$code\n$/);
        assert.ok(sh.includes(`export CODEX_HOME='${codexHome('sh-test')}'`));
        assert.ok(codexHome('sh-test').startsWith(process.env.RING_PROFILES), 'профили не в папке участника и не в %LOCALAPPDATA%');
      }
      if (agent === 'gemini') {
        assert.ok(sh.includes(`export HOME='${geminiHome('sh-test')}'`) && sh.includes('export RING_OPERATOR_HOME='));
        assert.ok(!sh.includes('USERPROFILE'), 'USERPROFILE — только в Windows');
        assert.match(sh, /gemini-home sh-test \|\| exit 1\n/);
      }
      if (POSIX) {
        const file = join(r.base, 'check.sh');
        writeFileSync(file, sh);
        assert.equal(spawnSync('bash', ['-n', file], { encoding: 'utf8' }).stderr, '', 'bash принимает скрипт');
      }
    });
  }
});

test('Claude-участник на другой подписке: токен читается из файла при запуске, в скрипт не попадает', async () => {
  await withContestant('acc-test', { agent: 'claude' }, async () => {
    assert.throws(() => setClaudeAccount('acc-test', 'Bad Name'), /имя аккаунта/);
    setClaudeAccount('acc-test', 'friend');
    const file = claudeTokenFile('friend');
    const ps = launchScriptText('acc-test', 'win32');
    assert.ok(ps.includes(file) && ps.includes('Test-Path'));
    // set after the cleanup of CLAUDE_CODE_* variables, or the cleanup erases it
    assert.ok(ps.indexOf('Remove-Item') < ps.indexOf('CLAUDE_CODE_OAUTH_TOKEN =') && ps.indexOf('CLAUDE_CODE_OAUTH_TOKEN =') < ps.indexOf('Set-Location'));
    const sh = launchScriptText('acc-test', 'linux');
    assert.ok(sh.includes(`[ -f '${file}' ]`));
    assert.ok(sh.indexOf('unset "$v"') < sh.indexOf('export CLAUDE_CODE_OAUTH_TOKEN=') && sh.indexOf('export CLAUDE_CODE_OAUTH_TOKEN=') < sh.indexOf("\ncd '"));
    setClaudeAccount('acc-test', null);
    for (const p of ['win32', 'linux']) assert.ok(!launchScriptText('acc-test', p).includes('OAUTH_TOKEN'));
  });
});

// ---------- an unattended run through the bash script, with a stand-in for the agent ----------

// The stand-in: writes down the prompt from stdin, its arguments, folder and environment, answers with a session id
// as the agent's journal does, leaves two background processes (a sleeper and a loop that keeps writing a file, like
// a preview left running) and ends with code 7, or hangs when STUB_HANG is set.
const STUB = `#!/usr/bin/env bash
out="$STUB_OUT"
echo $$ > "$out/stub.pid"
cat > "$out/prompt.txt"
printf '%s\\n' "$@" > "$out/args.txt"
pwd > "$out/cwd.txt"
env > "$out/env.txt"
sleep 300 &
echo $! > "$out/sleeper.pid"
( while :; do echo x >> "$out/ticks.txt"; sleep 0.1; done ) &
echo $! > "$out/loop.pid"
\${STUB_BEFORE_EXIT:-:}
echo '{"type":"system","subtype":"init","session_id":"stub-session"}'
echo '{"type":"thread.started","thread_id":"stub-session"}'
if [ -n "\${STUB_HANG:-}" ]; then sleep 600; fi
exit 7
`;

function stubAgent(base, name) {
  const bin = join(base, 'bin');
  const out = join(base, 'out');
  mkdirSync(bin, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(bin, name), STUB);
  chmodSync(join(bin, name), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  process.env.STUB_OUT = out;
  const read = (f) => readFileSync(join(out, f), 'utf8');
  const alive = (f) => {
    try {
      return process.kill(Number(read(f)), 0);
    } catch {
      return false;
    }
  };
  const envOf = () => Object.fromEntries(read('env.txt').split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  // nothing of the stand-in is left: both background processes are gone and the file stopped growing
  const assertSwept = async (why) => {
    for (let i = 0; i < 30 && (alive('sleeper.pid') || alive('loop.pid')); i++) await sleep(100);
    assert.ok(!alive('sleeper.pid') && !alive('loop.pid'), `${why}: фоновые процессы участника закрыты`);
    const n = read('ticks.txt').length;
    await sleep(400);
    assert.equal(read('ticks.txt').length, n, `${why}: после выхода агента в папке ничего не меняется`);
  };
  return { out, read, alive, envOf, assertSwept };
}

const PROMPT = 'Заголовок для человека\n---\nРаунд {N} окончен.\nСтрока с "двойными" и \'одинарными\' кавычками, $HOME, `обратными` и \\ косой.\n\nПоследняя строка.\n';

test('запуск без человека на macOS и Linux: промпт через stdin, чистое окружение, код агента, фоновые процессы закрыты', { skip: !POSIX && 'скрипт bash', timeout: 60000 }, async () => {
  await withContestant('run-test', { agent: 'claude', agentModel: 'model-x' }, async (r) => {
    const stub = stubAgent(r.base, 'claude');
    writeFileSync(join(r.base, 'prompt.md'), PROMPT);
    // traces of the operator's own agent session: the contestant must not inherit them
    Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 'operator-token', CODEX_THREAD_ID: 't', T3CODE_SESSION: 's', CLAUDE_EFFORT: 'max' });
    const entry = await runAgent('run-test', { prompt: join(r.base, 'prompt.md'), vars: { N: 3 }, minutes: 1, voices: false, log: () => {} });
    r.logs.push(entry.log);
    assert.equal(stub.read('prompt.txt'), PROMPT.split('---\n')[1].trim().replace('{N}', '3'), 'промпт слово в слово');
    assert.equal(entry.exit, 7, 'код агента');
    assert.equal(entry.timedOut, false);
    assert.equal(entry.session, 'stub-session');
    assert.equal(stub.read('cwd.txt').trim(), r.root, 'агент стартует в папке участника');
    const args = stub.read('args.txt').trim().split('\n');
    assert.deepEqual(args.slice(-4), ['-p', '--output-format', 'stream-json', '--verbose']);
    assert.ok(args.includes('--strict-mcp-config') && args.join(' ').includes('--setting-sources project') && args.join(' ').includes('--model model-x'));
    const env = stub.envOf();
    const left = Object.keys(env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK|CODEX_|T3CODE_)/.test(k));
    assert.deepEqual(left, ['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], 'от сессии оператора ничего, своя переменная на месте');
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.match(readFileSync(entry.log, 'utf8'), /stub-session/, 'журнал агента записан');
    await stub.assertSwept('агент закончил сам');
  });
});

test('остановка по времени на macOS и Linux: агент и всё, что он запустил, закрыты', { skip: !POSIX && 'скрипт bash', timeout: 60000 }, async () => {
  await withContestant('stop-test', { agent: 'claude' }, async (r) => {
    const stub = stubAgent(r.base, 'claude');
    writeFileSync(join(r.base, 'prompt.md'), PROMPT);
    process.env.STUB_HANG = '1';
    const t0 = Date.now();
    const entry = await runAgent('stop-test', { prompt: join(r.base, 'prompt.md'), vars: { N: 1 }, minutes: 0.03, voices: false, log: () => {} });
    r.logs.push(entry.log);
    assert.equal(entry.timedOut, true);
    assert.ok(Date.now() - t0 < 20000, 'судья не ждёт зависшего агента');
    assert.ok(existsSync(join(stub.out, 'prompt.txt')), 'агент успел стартовать');
    await stub.assertSwept('остановлен по времени');
  });
});

test('скрипт bash, запущенный не лидером группы и остановленный сигналом, тоже закрывает своё', { skip: !POSIX && 'скрипт bash', timeout: 60000 }, async () => {
  await withContestant('grp-test', { agent: 'claude' }, async (r) => {
    const stub = stubAgent(r.base, 'claude');
    // from another program without a group of its own (a script, a CI step): the script takes one itself
    // (a process left behind would hold the output open: the time limit turns that wait into a failure)
    const done = spawnSync('bash', [r.script, '-p'], { input: 'текст промпта', encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assert.equal(done.status, 7, done.stderr);
    assert.equal(stub.read('prompt.txt'), 'текст промпта');
    assert.match(done.stdout, /stub-session/);
    await stub.assertSwept('не лидер группы');
    // SIGTERM to the script while the agent works (a closed terminal sends SIGHUP the same way)
    process.env.STUB_HANG = '1';
    rmSync(join(stub.out, 'prompt.txt'));
    const { spawn } = await import('node:child_process');
    const p = spawn('bash', [r.script], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    p.stdin.end('x');
    for (let i = 0; i < 50 && !existsSync(join(stub.out, 'loop.pid')); i++) await sleep(100);
    await sleep(300);
    process.kill(p.pid, 'SIGTERM');
    await Promise.race([new Promise((res) => p.on('exit', res)), sleep(10000)]);
    await stub.assertSwept('скрипт остановлен сигналом');
  });
});

test('Codex на macOS и Linux: свой дом профиля, вход копируется в него и свежий возвращается обратно', { skip: !POSIX && 'скрипт bash', timeout: 60000 }, async () => {
  await withContestant('cdx-test', { agent: 'codex', agentModel: 'model-x', effort: 'high' }, async (r) => {
    const stub = stubAgent(r.base, 'codex');
    const main = join(r.base, 'operator-codex');
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, 'auth.json'), JSON.stringify({ last_refresh: '2026-01-01T00:00:00Z', who: 'operator' }));
    process.env.RING_MAIN_CODEX_HOME = main;
    process.env.CODEX_HOME = join(r.base, 'operator-session-home'); // the operator's own Codex session
    // the agent refreshes its login while it works
    process.env.STUB_BEFORE_EXIT = `eval printf '%s' '{"last_refresh":"2026-02-02T00:00:00Z","who":"contestant"}' > "$CODEX_HOME/auth.json"`;
    writeFileSync(join(r.base, 'prompt.md'), PROMPT);
    const entry = await runAgent('cdx-test', { prompt: join(r.base, 'prompt.md'), vars: { N: 1 }, minutes: 1, voices: false, log: () => {} });
    r.logs.push(entry.log);
    const env = stub.envOf();
    assert.equal(env.CODEX_HOME, codexHome('cdx-test'), 'свой дом профиля, не оператора');
    assert.ok(env.CODEX_HOME.startsWith(join(r.base, 'profiles')));
    const toml = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.ok(toml.includes(`[projects.'${r.root}']`) && toml.includes('memories = false') && toml.includes('model = "model-x"'));
    assert.deepEqual(stub.read('args.txt').trim().split('\n'), ['-C', r.root, '-m', 'model-x', '-c', 'model_reasoning_effort="high"', 'exec', '--skip-git-repo-check', '--json']);
    assert.equal(entry.session, 'stub-session');
    assert.equal(JSON.parse(readFileSync(join(main, 'auth.json'), 'utf8')).who, 'contestant', 'свежий вход вернулся в основной профиль');
    await stub.assertSwept('Codex');
  });
});

test('Gemini на macOS и Linux: свой дом, настройки и запрет своей генерации картинок в нём, промпт одним событием', { skip: !POSIX && 'скрипт bash', timeout: 60000 }, async () => {
  await withContestant('gem-test', { agent: 'gemini', agentModel: 'gemini-x-high', effort: 'high' }, async (r) => {
    const stub = stubAgent(r.base, 'agy');
    writeFileSync(join(r.base, 'prompt.md'), PROMPT);
    const entry = await runAgent('gem-test', { prompt: join(r.base, 'prompt.md'), vars: { N: 2 }, minutes: 1, voices: false, log: () => {} });
    r.logs.push(entry.log);
    const env = stub.envOf();
    assert.equal(env.HOME, geminiHome('gem-test'));
    assert.equal(env.RING_OPERATOR_HOME, homedir(), 'инструменты ринга находят сервисы оператора');
    const settings = JSON.parse(readFileSync(join(env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.trustedWorkspaces, [r.root]);
    const hook = JSON.parse(readFileSync(join(env.HOME, '.gemini', 'config', 'hooks.json'), 'utf8'))['ring-no-image-tool'].PreToolUse[0].hooks[0].command;
    assert.equal(JSON.parse(execFileSync('bash', ['-c', hook], { encoding: 'utf8' })).decision, 'deny', 'хук отвечает отказом');
    assert.deepEqual(JSON.parse(stub.read('prompt.txt')), { event: 'user', message: { content: PROMPT.split('---\n')[1].trim().replace('{N}', '2') } });
    // the model id carries the effort, so no --effort next to it
    assert.deepEqual(stub.read('args.txt').trim().split('\n'), ['--dangerously-skip-permissions', '--model', 'gemini-x-high', '--input-format', 'stream-json', '--output-format', 'stream-json']);
    await stub.assertSwept('Gemini');
  });
});
