// Unattended run of a contestant's agent: the prompt from prompts/*.md word for word (the text after the `---` line),
// through the contestant's own launch script (launch/<id>.ps1 on Windows, launch/<id>.sh on macOS and Linux), on
// stdin (Windows PowerShell 5.1 drops double quotes from native arguments, stdin keeps the text intact), with a time
// limit and a journal. The locker room continues the same
// agent session. Every run is written to ledger/runs.json: start, end, minutes, exit code, timeout, session id.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RING, getContestant, prepareCodexHome, launchInvocation } from './contestants.js';
import { releaseVoice, sweepVoices, activeContestants } from './voices.js';

const firstLine = (err) => String(err?.message || err).split(/\r?\n/)[0];

const RUNS = join(RING, 'ledger', 'runs.json');

// The prompt as the model gets it: everything after the first `---` line, with {N} and {M} filled in.
export function promptText(file, vars = {}) {
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const at = src.search(/^---\s*$/m);
  if (at < 0) throw new Error(`${file}: нет строки --- перед текстом промпта`);
  let text = src.slice(at).replace(/^---\s*\n/, '').trim();
  for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  const left = text.match(/\{[A-Z]\}/);
  if (left) throw new Error(`${file}: не задано ${left[0]} (--vars ${left[0].slice(1, -1)}=…)`);
  return text;
}

// Arguments after the launch script's own ones: headless mode, a machine-readable journal, prompt on stdin.
export function agentArgs(agent, { resume = null } = {}) {
  if (agent === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', ...(resume ? ['--resume', resume] : [])];
  // Antigravity takes a prompt on stdin only as an NDJSON user event (stdinFor); its -p wants the text as an argument
  if (agent === 'gemini') return ['--input-format', 'stream-json', '--output-format', 'stream-json', ...(resume ? ['--conversation', resume] : [])];
  // no `-` for "prompt on stdin": powershell -File takes a lone dash for a parameter name and fails; codex exec
  // reads stdin anyway when there is no prompt argument
  return ['exec', ...(resume ? ['resume', resume] : []), '--skip-git-repo-check', '--json'];
}

// What goes to the agent's stdin: the prompt as is, for Antigravity one user event
export function stdinFor(agent, text) {
  return agent === 'gemini' ? JSON.stringify({ event: 'user', message: { content: text } }) + '\n' : text;
}

// Session id from the first lines of the journal: Claude Code stream-json `system/init`, Codex `thread.started`,
// Antigravity `init`.
export function sessionFrom(line) {
  try {
    const o = JSON.parse(line);
    if (o.event === 'init' && o.conversation_id) return o.conversation_id;
    if (o.type === 'system' && o.session_id) return o.session_id;
    if (o.type === 'thread.started' && o.thread_id) return o.thread_id;
  } catch {}
  return null;
}

export function runs() {
  return existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : {};
}

function saveRun(id, entry) {
  const all = runs();
  const list = (all[id] ||= []);
  const i = list.findIndex((x) => x.label === entry.label && x.started === entry.started);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  mkdirSync(join(RING, 'ledger'), { recursive: true });
  writeFileSync(RUNS, JSON.stringify(all, null, 2) + '\n');
}

// The session to continue: the last run of this contestant that reported one.
export function lastSession(id) {
  const list = runs()[id] || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].session) return list[i].session;
  return null;
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
}

// stall: minutes of a silent journal after which the judge stops the agent as a failure of the judge (method §1.3):
// Antigravity without a window can lose the notice that a background task finished and then waits forever
// (pilot 3.0, the first Gemini build). Such a build is annulled and made again from scratch, never continued.
export async function runAgent(id, { prompt, vars = {}, minutes = 90, label = 'build', resume = false, stall = 30, voices = true, log = console.log }) {
  const c = getContestant(id);
  const text = promptText(prompt, vars);
  const session = resume ? (typeof resume === 'string' ? resume : lastSession(id)) : null;
  if (resume && !session) throw new Error(`у «${id}» нет прошлой сессии в ledger/runs.json, продолжать нечего`);
  const launch = launchInvocation(id);
  const script = launch.script;
  if (!existsSync(script)) throw new Error(`нет ${script} (node ring.mjs launch-script ${id})`);
  const dir = join(RING, 'ledger', 'runs');
  mkdirSync(dir, { recursive: true });
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${id}-${label}-${stamp}.jsonl`);
  const out = createWriteStream(file);
  const entry = { label, prompt: prompt.split(/[\\/]/).slice(-1)[0], vars, minutes, started: started.toISOString(), ended: null, exit: null, timedOut: false, session, log: file };
  saveRun(id, entry);
  // voice slots: before a new build, the voices of contestants not running now go (judge/voices.js)
  if (label === 'build' && voices) {
    try {
      const s = await sweepVoices({ active: activeContestants(runs()) });
      if (s.deleted.length) log(`голоса ринга: освобождено мест ${s.deleted.length} (${s.deleted.join(', ')})`);
    } catch (err) {
      log(`голоса ринга: чистка не вышла — ${firstLine(err)}`);
    }
  }
  const args = [...launch.args, ...agentArgs(c.agent, { resume: session })];
  log(`${id}: ${c.agent} ${c.agentModel || ''}, ${label}, до ${minutes} мин, журнал ${file}`);
  // detached: on macOS and Linux the launch script leads a process group of its own, the agent and what it starts in it
  const p = spawn(launch.exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let buf = '';
  let lastOut = Date.now();
  p.stdout.on('data', (d) => {
    lastOut = Date.now();
    out.write(d);
    if (!entry.session || entry.session === session) {
      buf += d.toString('utf8');
      for (const line of buf.split('\n').slice(0, -1)) {
        const s = sessionFrom(line);
        if (s) {
          entry.session = s;
          saveRun(id, entry);
          break;
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    }
  });
  p.stderr.on('data', (d) => out.write(JSON.stringify({ type: 'ring.stderr', text: d.toString('utf8') }) + '\n'));
  p.stdin.end(stdinFor(c.agent, text));
  const timer = setTimeout(() => {
    entry.timedOut = true;
    log(`${id}: время вышло (${minutes} мин), останавливаю агента`);
    killTree(p.pid);
  }, minutes * 60 * 1000);
  const watch = stall > 0 ? setInterval(() => {
    if (Date.now() - lastOut < stall * 60 * 1000) return;
    entry.stalled = true;
    entry.annulled = `сбой судьи: журнал агента молчал ${stall} мин — сборка аннулируется, новая с нуля`;
    log(`${id}: журнал молчит ${stall} мин, останавливаю агента (сбой судьи)`);
    clearInterval(watch);
    killTree(p.pid);
  }, 30000) : null;
  // 'exit', not 'close': a grandchild holding the pipe would keep 'close' waiting
  const exit = await new Promise((r) => p.on('exit', (code) => r(code)));
  clearTimeout(timer);
  if (watch) clearInterval(watch);
  // the launch script closes what the agent left running: a Windows job (JOB_LINES) or its process group
  // (GROUP_LINES); the group once more from here, for a script that was itself stopped half-way
  if (process.platform !== 'win32') killTree(p.pid);
  p.stdout.destroy();
  p.stderr.destroy();
  out.end();
  // the launch script returns the Codex login itself, but not when the run was stopped by the time limit
  if (c.agent === 'codex') prepareCodexHome(id, { back: true });
  entry.exit = exit;
  entry.ended = new Date().toISOString();
  entry.workMinutes = Math.round(((Date.parse(entry.ended) - started.getTime()) / 60000) * 10) / 10;
  saveRun(id, entry);
  log(`${id}: ${entry.timedOut ? 'остановлен по времени' : `закончил сам (код ${exit})`} за ${entry.workMinutes} мин`);
  // the run is over: the contestant's voice frees its slot (the lines are files; voice lines makes it again if needed)
  if (voices) {
    try {
      const r = await releaseVoice(id);
      if (r.deleted) log(`${id}: голос освобождён на аккаунте озвучки (реплики остаются файлами)`);
    } catch (err) {
      log(`${id}: голос не освобождён — ${firstLine(err)}`);
    }
  }
  return entry;
}
