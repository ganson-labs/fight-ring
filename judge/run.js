// Unattended run of a contestant's agent: the prompt from prompts/*.md word for word (the text after the `---` line),
// through the contestant's own launch/<id>.ps1, on stdin (Windows PowerShell 5.1 drops double quotes from native
// arguments, stdin keeps the text intact), with a time limit and a journal. The locker room continues the same
// agent session. Every run is written to ledger/runs.json: start, end, minutes, exit code, timeout, session id.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RING, getContestant, prepareCodexHome } from './contestants.js';

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

export async function runAgent(id, { prompt, vars = {}, minutes = 90, label = 'build', resume = false, log = console.log }) {
  const c = getContestant(id);
  const text = promptText(prompt, vars);
  const session = resume ? (typeof resume === 'string' ? resume : lastSession(id)) : null;
  if (resume && !session) throw new Error(`у «${id}» нет прошлой сессии в ledger/runs.json, продолжать нечего`);
  const script = join(RING, 'launch', `${id}.ps1`);
  if (!existsSync(script)) throw new Error(`нет ${script} (node ring.mjs launch-script ${id})`);
  const dir = join(RING, 'ledger', 'runs');
  mkdirSync(dir, { recursive: true });
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${id}-${label}-${stamp}.jsonl`);
  const out = createWriteStream(file);
  const entry = { label, prompt: prompt.split(/[\\/]/).slice(-1)[0], vars, minutes, started: started.toISOString(), ended: null, exit: null, timedOut: false, session, log: file };
  saveRun(id, entry);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...agentArgs(c.agent, { resume: session })];
  log(`${id}: ${c.agent} ${c.agentModel || ''}, ${label}, до ${minutes} мин, журнал ${file}`);
  const p = spawn('powershell', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let buf = '';
  p.stdout.on('data', (d) => {
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
  // 'exit', not 'close': a grandchild holding the pipe would keep 'close' waiting
  const exit = await new Promise((r) => p.on('exit', (code) => r(code)));
  clearTimeout(timer);
  // the launch script's Windows job closes what the agent left running (launch/<id>.ps1, JOB_LINES)
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
  return entry;
}
