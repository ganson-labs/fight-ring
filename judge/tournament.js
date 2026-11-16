// The tournament console of the game (screen «Турнир»): the day of a shoot without a command line. The ring's server
// (serve.mjs, local only) calls these; the state lives in ledger/tournament.json, so the step survives a restart of
// the game and of the server. Steps: setup → build → round → locker → round … → final.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { homedir, setPriority, constants as osc } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RING, registry, createContestant, getContestant, codexHome, agyExe, geminiTranscripts, ringConfig, setClaudeAccount } from './contestants.js';
import { newMatch, loadMatch, runRound, writeLocker, sidesFor, matchDir } from './match.js';
import { promptText } from './run.js';
import { readFighterDir } from '../kit/arena/tools/load.js';

const FILE = join(RING, 'ledger', 'tournament.json');
const CORNERS = ['red', 'blue'];
const CORNER_RU = { red: 'Красный угол', blue: 'Синий угол' };
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const readJSON = (f, fb = null) => {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb;
  } catch {
    return fb;
  }
};

export function loadState() {
  return readJSON(FILE, null) || { step: 'setup', match: null, corners: {}, jobs: {}, log: [] };
}

function saveState(s) {
  mkdirSync(join(RING, 'ledger'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n');
  return s;
}

const note = (s, text) => {
  s.log = [...(s.log || []), { at: new Date().toISOString(), text }].slice(-60);
};

// ---------- what the machine offers ----------

let codexModels = null;
// Codex's own list of models on this machine (codex debug models), read once without holding the server
function readCodexModels() {
  return new Promise((res) => {
    const p = spawn('codex', ['debug', 'models'], { shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let raw = '';
    p.stdout.on('data', (d) => (raw += d));
    p.on('close', () => {
      try {
        const j = JSON.parse(raw);
        res((j.models || j).filter((m) => m.visibility !== 'hide').map((m) => ({ id: m.slug, name: m.display_name || m.slug, efforts: (m.supported_reasoning_levels || []).map((x) => x.effort) })));
      } catch {
        res([]);
      }
    });
    p.on('error', () => res([]));
  });
}
let geminiModels = null;
// Antigravity's list for the account (agy models: «id<TAB>name» lines); efforts as agy --effort takes them
function readGeminiModels() {
  return new Promise((res) => {
    const p = spawn(agyExe(), ['models'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let raw = '';
    p.stdout.on('data', (d) => (raw += d));
    p.on('close', () => res(raw.split(/\r?\n/).map((l) => l.split('\t')).filter((x) => x.length >= 2 && x[0].trim()).map(([id, name]) => ({ id: id.trim(), name: name.trim(), efforts: ['high', 'low', 'medium', 'xhigh', 'max'] }))));
    p.on('error', () => res([]));
  });
}
export async function options() {
  if (!codexModels) codexModels = await readCodexModels();
  if (!geminiModels?.length) geminiModels = await readGeminiModels();
  const stages = existsSync(join(RING, 'stages')) ? readdirSync(join(RING, 'stages')).filter((d) => existsSync(join(RING, 'stages', d, 'stage.json'))).map((d) => ({ id: d, name: readJSON(join(RING, 'stages', d, 'stage.json'), {}).name || d })) : [];
  return {
    agents: [
      { id: 'claude', name: 'Claude Code', models: CLAUDE_MODELS.map((m) => ({ ...m, efforts: CLAUDE_EFFORTS })) },
      { id: 'codex', name: 'Codex', models: codexModels },
      { id: 'gemini', name: 'Antigravity', models: geminiModels },
    ],
    stages,
  };
}

// ---------- step 1: a new match ----------

export function newTournament({ corners, firstTo = 2, stages = ['rooftop', 'server', 'foundry'], minutes = 20, match = null }) {
  const s = loadState();
  if (s.match && s.step !== 'final' && s.step !== 'setup') throw new Error(`идёт матч ${s.match}: доведи его до финала в пульте`);
  const reg = registry();
  const made = {};
  for (const corner of CORNERS) {
    const c = corners?.[corner];
    if (!c?.agent || !c?.agentModel || !c?.model) throw new Error(`${CORNER_RU[corner]}: агент, модель и имя на экране`);
    const id = c.id || corner;
    if (reg[id]) throw new Error(`участник «${id}» уже есть (${reg[id].root}): убери его или выбери другое имя угла`);
    made[corner] = { id, ...c };
  }
  for (const corner of CORNERS) {
    const c = made[corner];
    createContestant(c.id, { agent: c.agent, model: c.model, agentModel: c.agentModel, effort: c.effort || 'high', color: c.color || (corner === 'red' ? '#e8825a' : '#4fc3c9') });
    // ring.config.json claudeAccount: Claude corners fight on that subscription (node ring.mjs claude-account)
    if (c.agent === 'claude' && ringConfig().claudeAccount) setClaudeAccount(c.id, ringConfig().claudeAccount);
  }
  const id = match || `match-${new Date().toISOString().slice(0, 10)}`;
  newMatch(id, { red: made.red.id, blue: made.blue.id, stage: stages, minutes: Number(minutes), firstTo: Number(firstTo) });
  const st = { step: 'build', match: id, created: new Date().toISOString(), corners: { red: made.red, blue: made.blue }, build: {}, windows: {}, jobs: {}, log: [] };
  note(st, `матч ${id}: ${made.red.model} против ${made.blue.model}`);
  return saveState(st);
}

export function resetTournament() {
  const s = loadState();
  const old = { ...s };
  saveState({ step: 'setup', match: null, corners: {}, jobs: {}, log: [], previous: old.match || null });
  return loadState();
}

// ---------- step 2: the agents' windows and the build ----------

function screenArea() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($a.X) $($a.Y) $($a.Width) $($a.Height)"'], { encoding: 'utf8', windowsHide: true });
    const [x, y, w, h] = out.trim().split(/\s+/).map(Number);
    return { x, y, w, h };
  } catch {
    return { x: 0, y: 0, w: 1920, h: 1080 };
  }
}

// a window found by its exact title moved to a box of the screen (Windows Terminal keeps the title we give it)
function placeWindow(title, box, tries = 40) {
  const t = title.replace(/'/g, "''");
  const ps = `Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class RingWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  // on top of the other windows for a moment and back: Windows lets a script raise a window only this way
  public static void Raise(IntPtr h) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 3); SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 3); SetForegroundWindow(h); }
  public static IntPtr Find(string title) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var s = new StringBuilder(512); GetWindowText(h, s, 512); if (s.ToString() == title) { found = h; return false; } return true; }, IntPtr.Zero); return found; }
  // visible or not yet: the newest window with this title (EnumWindows goes top to bottom)
  public static IntPtr FindAny(string title) { IntPtr found = IntPtr.Zero; EnumWindows((h, l) => { var s = new StringBuilder(512); GetWindowText(h, s, 512); if (s.ToString() == title) { found = h; return false; } return true; }, IntPtr.Zero); return found; }
}
'@
for ($i = 0; $i -lt ${tries}; $i++) { $h = [RingWin]::FindAny('${t}'); if ($h -ne [IntPtr]::Zero) { for ($k = 0; $k -lt 20 -and -not [RingWin]::IsWindowVisible($h); $k++) { [RingWin]::ShowWindow($h, 1) | Out-Null; Start-Sleep -Milliseconds 150 }; [RingWin]::MoveWindow($h, ${box.x}, ${box.y}, ${box.w}, ${box.h}, $true) | Out-Null; [RingWin]::Raise($h); $r = New-Object RingWin+RECT; [RingWin]::GetWindowRect($h, [ref]$r) | Out-Null; "rect $($r.L) $($r.T) $($r.R) $($r.B)"; if ([RingWin]::IsWindowVisible($h)) { 'ok' } else { 'hidden' }; exit }; Start-Sleep -Milliseconds 250 }
'none'`;
  return new Promise((res) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => res({ ok: out.trim().split(/\r?\n/).pop() === 'ok', rect: (out.match(/rect (-?\d+) (-?\d+) (-?\d+) (-?\d+)/) || []).slice(1).map(Number) }));
  });
}

export const windowTitle = (corner, model) => `${CORNER_RU[corner]} · ${model}`;

// A visible terminal with the contestant's agent started clean (launch/<id>.ps1, interactive), titled with its
// corner and model, on the left (red) or right (blue) half of the screen.
export async function openWindow(corner) {
  const s = loadState();
  const c = s.corners?.[corner];
  if (!c) throw new Error('сначала новый матч');
  const script = join(RING, 'launch', `${c.id}.ps1`);
  const title = windowTitle(corner, c.model);
  // Start-Process with a normal window: a server started hidden would hand Windows Terminal its hidden state, and the
  // agent's window would exist but never show (found on the console's own check)
  const q = (x) => `'${String(x).replace(/'/g, "''")}'`;
  const wtArgs = ['-w', 'new', '--title', title, '--suppressApplicationTitle', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script].map((a) => (/[\s'"·]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  // -EncodedCommand: no quoting of the title's spaces and quotes on the way through node and powershell
  const cmd = Buffer.from(`Start-Process -FilePath wt.exe -WindowStyle Normal -ArgumentList ${q(wtArgs)}`, 'utf16le').toString('base64');
  // not detached: a detached powershell of a hidden server starts no window at all (found on the console's check)
  await new Promise((r) => spawn('powershell', ['-NoProfile', '-EncodedCommand', cmd], { stdio: 'ignore', windowsHide: true }).on('close', r));
  const a = screenArea();
  const half = Math.floor(a.w / 2);
  const box = corner === 'red' ? { x: a.x, y: a.y, w: half, h: a.h } : { x: a.x + half, y: a.y, w: a.w - half, h: a.h };
  const { ok: placed, rect } = await placeWindow(title, box);
  s.windows = { ...(s.windows || {}), [corner]: { title, at: new Date().toISOString(), placed, rect } };
  s.build = { ...(s.build || {}), [corner]: s.build?.[corner] || new Date().toISOString() };
  note(s, `окно ${title}${placed ? '' : ' (не нашлось, чтобы поставить на место)'}`);
  saveState(s);
  return { title, placed, rect, box };
}

// the newest write of the agent's journal (Claude Code project folder or the contestant's Codex sessions)
const sizes = new Map();
const lastGrowth = new Map();
function journalTouched(c) {
  const dirs = [];
  if (c.agent === 'claude') {
    const slug = c.root.replace(/[\\/]/g, '\\').replace(/[^A-Za-z0-9]/g, '-');
    const base = join(homedir(), '.claude', 'projects');
    if (existsSync(base)) for (const d of readdirSync(base)) if (d.toLowerCase() === slug.toLowerCase()) dirs.push(join(base, d));
  } else if (c.agent === 'gemini') dirs.push(...geminiTranscripts(c.id).map((f) => join(f, '..')));
  else dirs.push(join(codexHome(c.id), 'sessions'));
  let t = 0;
  const walk = (d, depth = 0) => {
    if (!existsSync(d) || depth > 4) return;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (n.endsWith('.jsonl')) {
        // Windows leaves the time of a file open for appending as it was: a journal that grew counts as touched now
        const was = sizes.get(p);
        sizes.set(p, st.size);
        t = Math.max(t, st.mtimeMs, was !== undefined && was !== st.size ? Date.now() : 0, lastGrowth.get(p) || 0);
        if (was !== undefined && was !== st.size) lastGrowth.set(p, Date.now());
      }
    }
  };
  for (const d of dirs) walk(d);
  return t;
}

// Which contestants' launch scripts run now: one process scan in the background every few seconds, never inside a
// request (a synchronous scan on every poll of the console held the whole server for seconds)
let procs = { at: 0, lines: [], running: false };
function scanProcesses() {
  if (process.platform !== 'win32' || procs.running || Date.now() - procs.at < 3000) return;
  procs.running = true;
  const p = spawn('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' or Name='pwsh.exe'\" | ForEach-Object { [string]$_.CommandLine }"], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => {
    procs = { at: Date.now(), lines: out.split(/\r?\n/).filter((l) => /-File/i.test(l)), running: false };
  });
  p.on('error', () => (procs.running = false));
}

function launchAlive(id) {
  scanProcesses();
  const needle = `launch\\${id}.ps1`.toLowerCase();
  return procs.lines.some((l) => l.toLowerCase().includes(needle));
}

// The full check of a fighter takes seconds (pictures are decoded, the parts' seating measured): it runs again only
// when a file of the fighter changed (the newest change and the number of files)
const checks = new Map();
function folderStamp(dir) {
  let newest = 0;
  let n = 0;
  const walk = (d) => {
    for (const x of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, x.name);
      if (x.isDirectory()) {
        if (x.name !== 'raw') walk(p);
      } else {
        n++;
        newest = Math.max(newest, statSync(p).mtimeMs);
      }
    }
  };
  walk(dir);
  return `${n}:${newest}`;
}
function checkCached(dir) {
  const stamp = folderStamp(dir);
  const had = checks.get(dir);
  if (had && had.stamp === stamp) return had.res;
  if (!had?.running) {
    // in its own process: the server answers meanwhile with the last result
    const entry = { stamp: had?.stamp ?? null, res: had?.res ?? { ok: false, errors: ['проверяю…'], pending: true }, running: true };
    checks.set(dir, entry);
    const code = `import(${JSON.stringify(pathToFileURL(join(RING, 'kit', 'arena', 'tools', 'load.js')).href)}).then(({ readFighterDir }) => { const r = readFighterDir(${JSON.stringify(dir)}); process.stdout.write(JSON.stringify({ ok: r.ok, errors: r.errors.slice(0, 3), fighter: r.fighter ? { card: { name: r.fighter.card.name } } : null })); })`;
    const p = spawn(process.execPath, ['-e', code], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        checks.set(dir, { stamp, res: JSON.parse(out), running: false });
      } catch {
        checks.set(dir, { stamp, res: { ok: false, errors: ['проверка не ответила'] }, running: false });
      }
    });
  }
  return checks.get(dir).res;
}

// The newest change in the contestant's folder (its fighter, tools' output, the ring's ledger of pictures and voice):
// Codex in its window writes its journal in bursts and left it untouched for minutes while it worked (found on the
// second rehearsal), so the folder is the other sign of work
function rootTouched(root) {
  let newest = 0;
  const walk = (d, depth) => {
    let list = [];
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of list) {
      if (['.git', '.chrome', 'node_modules', 'raw'].includes(x.name)) continue;
      const p = join(d, x.name);
      if (x.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else {
        try {
          newest = Math.max(newest, statSync(p).mtimeMs);
        } catch {}
      }
    }
  };
  walk(root, 0);
  return newest;
}

// Each corner now: the window is open, the agent writes its journal or its folder (working) or not (waiting), the fighter passes
// the check, how long since the build started, pictures and voice from its limits.
export function cornerStatus(corner, s = loadState()) {
  const c0 = s.corners?.[corner];
  if (!c0) return null;
  let c;
  try {
    c = getContestant(c0.id);
  } catch {
    return { corner, missing: true };
  }
  const fighter = join(c.root, 'fighter');
  const res = existsSync(join(fighter, 'fighter.json')) ? checkCached(fighter) : { ok: false, errors: ['нет fighter/'] };
  const ledger = readJSON(join(c.root, '.ring', 'ledger.json'), {});
  const limits = readJSON(join(c.root, '.ring', 'limits.json'), {});
  const touched = Math.max(journalTouched(c), rootTouched(c.root));
  const alive = launchAlive(c.id);
  const working = !!(alive && touched && Date.now() - touched < 180000);
  const started = s.build?.[corner] ? Date.parse(s.build[corner]) : null;
  return {
    corner, id: c.id, model: c.model, agent: c.agent, agentModel: c.agentModel, effort: c.effort, color: c.color, title: windowTitle(corner, c.model),
    window: alive, working, lastActive: touched ? new Date(touched).toISOString() : null,
    check: res.ok, name: res.fighter?.card?.name || null, errors: (res.errors || []).slice(0, 3),
    ready: res.ok && !working,
    // a corner done with its build shows how long the build took, not the time since
    sinceStart: started ? Math.round(((res.ok && !working && touched > started ? touched : Date.now()) - started) / 1000) : null,
    pictures: [ledger.paint || 0, limits.paint ?? null], voice: [Math.round(ledger.voiceSeconds || 0), limits.voiceSeconds ?? null],
  };
}

export function prompts(n = null) {
  const s = loadState();
  const m = s.match ? loadMatch(s.match) : null;
  return {
    fighter: promptText(join(RING, 'prompts', 'fighter.md')),
    locker: m && n ? promptText(join(RING, 'prompts', 'locker.md'), { N: n, M: m.lockerMinutes }) : null,
  };
}

// ---------- step 3: a round, shown live at once, its clips and locker room made behind ----------

const busy = new Set();

// The heavy work of filming (a round's clip, the reel, the pack) goes one at a time: two at once ran 8 Chrome pages
// and 8 sessions of the video card's encoder, and both failed (found on the console's check)
let heavy = Promise.resolve();
function queued(fn) {
  const p = heavy.then(fn, fn);
  heavy = p.catch(() => {});
  return p;
}

async function job(s, name, fn) {
  if (busy.has(name)) throw new Error('уже идёт');
  busy.add(name);
  const mark = (status) => {
    const st = loadState();
    st.jobs = { ...(st.jobs || {}), [name]: { status, at: new Date().toISOString() } };
    saveState(st);
  };
  mark('queued');
  try {
    const out = await queued(async () => {
      mark('running');
      return fn();
    });
    const st2 = loadState();
    st2.jobs[name] = { status: 'done', at: new Date().toISOString(), ...(out || {}) };
    saveState(st2);
    return out;
  } catch (e) {
    const st2 = loadState();
    st2.jobs[name] = { status: 'error', at: new Date().toISOString(), error: String(e.message || e) };
    note(st2, `ошибка ${name}: ${e.message || e}`);
    saveState(st2);
    throw e;
  } finally {
    busy.delete(name);
  }
}

export async function startRound() {
  // one round at a time: a second press while the judge counts would play the same round twice
  if (busy.has('start')) throw new Error('раунд уже считается');
  busy.add('start');
  try {
    return await startRoundNow();
  } finally {
    busy.delete('start');
  }
}

async function startRoundNow() {
  const s = loadState();
  if (!s.match) throw new Error('нет матча');
  const m = loadMatch(s.match);
  if (m.over) throw new Error('матч окончен');
  const n = m.rounds.length + 1;
  // the fighters as the judge took them when the locker room's time ran out, or as they are now
  const take = s.locker?.n === n - 1 && s.locker?.taken ? s.locker.taken : null;
  const r = await runRound(s.match, { sources: take || undefined, log: () => {} });
  const st = loadState();
  st.step = r.m.over ? 'final' : 'round';
  st.round = { n: r.n, at: new Date().toISOString(), winner: r.m.rounds[r.n - 1].winner, over: r.m.over };
  st.locker = { n: r.n, ready: false };
  note(st, `раунд ${r.n}: ${r.m.rounds[r.n - 1].winner ? `победа ${r.m.models[r.m.rounds[r.n - 1].winner]}` : 'ничья'}`);
  saveState(st);
  roundMaterials(s.match, r.n, { locker: !r.m.over });
  return { n: r.n, match: s.match, over: r.m.over };
}

// The round's clips, then the locker room with them (the contestants get the video and its frames); after the last
// round of the match there is no locker room. Restarted by state() when a restart of the server cut it off.
function roundMaterials(match, n, { locker = true } = {}) {
  return job(null, `round-${n}`, async () => {
    // a clip made already (by a server before a restart) is not made again
    const rd = join(matchDir(match), `round-${n}`);
    const done = (f) => existsSync(f) && statSync(f).mtimeMs > statSync(join(rd, 'replay.json')).mtimeMs;
    if (!(done(join(rd, 'fight-16x9.mp4')) && done(join(rd, 'fight-16x9.timing.json')))) await judge(`round-${n}-render`, ['match', 'render', match, '--round', String(n)]);
    if (locker) await judge(`round-${n}-locker`, ['match', 'locker', match, '--round', String(n)]);
    const st2 = loadState();
    if (st2.match === match) {
      st2.locker = { ...(st2.locker || {}), n, ready: true };
      saveState(st2);
    }
    return { video: `/matches/${match}/round-${n}/fight-16x9.mp4` };
  }).catch(() => {});
}

// A command of the judge in its own process: a clip of a round takes the whole processor and the game's server must
// stay quick for the live round (it answered in 8 s while a clip was made in the same process). Output in ledger/.
function judge(name, args) {
  mkdirSync(join(RING, 'ledger', 'tournament'), { recursive: true });
  const log = join(RING, 'ledger', 'tournament', `${name}.log`);
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [join(RING, 'ring.mjs'), ...args], { cwd: RING, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // below the game in the processor's queue (its Chrome and ffmpeg inherit it): the round plays live meanwhile
    try {
      setPriority(p.pid, osc.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    // the process of the job, so a restarted server does not start the same work again next to it
    const st = loadState();
    st.pids = { ...(st.pids || {}), [name]: p.pid };
    saveState(st);
    let out = '';
    const keep = (d) => {
      out += d;
      if (out.length > 200000) out = out.slice(-100000);
    };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('close', (code) => {
      writeFileSync(log, out);
      if (code === 0) res(out);
      else rej(new Error(out.trim().split(/\r?\n/).pop() || `код ${code}`));
    });
  });
}

// ---------- step 4: the locker room by the clock; when it runs out, the judge takes the fighters ----------

export function startLocker() {
  const s = loadState();
  const m = loadMatch(s.match);
  if (!s.locker?.ready) throw new Error('материалы раздевалки ещё готовятся');
  const now = Date.now();
  s.step = 'locker';
  s.locker = { ...s.locker, startedAt: new Date(now).toISOString(), endsAt: new Date(now + m.lockerMinutes * 60000).toISOString(), taken: null };
  note(s, `раздевалка ${s.locker.n}: ${m.lockerMinutes} мин`);
  return saveState(s);
}

// the fighters as they are this moment, put aside for the next round (called when the clock runs out, or by hand)
export function takeFighters() {
  const s = loadState();
  if (!s.locker?.n) throw new Error('раздевалки нет');
  if (s.locker.taken) return s;
  const m = loadMatch(s.match);
  const dir = join(matchDir(s.match), `take-${s.locker.n + 1}`);
  rmSync(dir, { recursive: true, force: true });
  const taken = {};
  for (const cid of [m.red, m.blue]) {
    const src = join(getContestant(cid).root, 'fighter');
    cpSync(src, join(dir, cid, 'fighter'), { recursive: true });
    taken[cid] = join(dir, cid, 'fighter');
  }
  s.locker.taken = taken;
  s.locker.takenAt = new Date().toISOString();
  s.step = 'round';
  note(s, `судья забрал бойцов после раздевалки ${s.locker.n}`);
  return saveState(s);
}

// the clock is checked on every request: a server restarted mid-locker still takes the fighters in time
export function tick() {
  const s = loadState();
  if (s.step === 'locker' && s.locker?.endsAt && !s.locker.taken && Date.now() >= Date.parse(s.locker.endsAt)) return takeFighters();
  return s;
}

// ---------- step 5: the reel and the montage pack ----------

export async function buildReel() {
  const s = loadState();
  return job(s, 'reel', async () => {
    await judge('reel', ['match', 'reel', s.match]);
    return { dir: join(matchDir(s.match), 'reel'), video: `/matches/${s.match}/reel/match-16x9.mp4` };
  });
}

export async function buildPackJob() {
  const s = loadState();
  return job(s, 'pack', async () => {
    await judge('pack', ['match', 'pack', s.match]);
    return { dir: join(matchDir(s.match), 'pack') };
  });
}

// a background job that failed, once more: the round's clip and locker room, the reel, the pack
export function retryJob(name) {
  const s = loadState();
  if (s.jobs?.[name]?.status !== 'error') throw new Error('эта работа не упала');
  const n = Number((/^round-(\d+)$/.exec(name) || [])[1]);
  if (n) {
    roundMaterials(s.match, n, { locker: !(s.round?.n === n && s.round.over) });
    return { retried: name };
  }
  if (name === 'reel') buildReel().catch(() => {});
  else if (name === 'pack') buildPackJob().catch(() => {});
  else throw new Error('нет такой работы');
  return { retried: name };
}

// the folder of a finished reel or pack in Explorer, on this machine
export function openFolder(name) {
  const dir = loadState().jobs?.[name]?.dir;
  if (!dir || !existsSync(dir)) throw new Error('папки ещё нет');
  spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  return { dir };
}

export function state() {
  const s = tick();
  // a round whose clips were being made when the server stopped: made again
  const alive = (pid) => {
    try {
      return !!pid && process.kill(pid, 0);
    } catch {
      return false;
    }
  };
  const n = s.round?.n;
  const working = n && ['render', 'locker'].some((k) => alive(s.pids?.[`round-${n}-${k}`]));
  if (n && s.locker?.n === n && !s.locker.ready && !busy.has(`round-${n}`) && !working && !['error', 'done'].includes(s.jobs?.[`round-${n}`]?.status)) roundMaterials(s.match, n, { locker: !s.round.over });
  const m = s.match && existsSync(join(matchDir(s.match), 'match.json')) ? loadMatch(s.match) : null;
  return {
    ...s,
    matchInfo: m ? { id: m.id, score: m.score, firstTo: m.firstTo, over: m.over, winner: m.winner, rounds: m.rounds.length, next: m.over ? null : m.rounds.length + 1, sides: m.over ? null : sidesFor(m, m.rounds.length + 1), lockerMinutes: m.lockerMinutes, models: m.models, stages: m.stages } : null,
    status: Object.fromEntries(CORNERS.map((c) => [c, cornerStatus(c, s)])),
    now: new Date().toISOString(),
  };
}

export function contestantRoot(id) {
  return getContestant(id).root;
}
