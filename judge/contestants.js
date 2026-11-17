// Contestants: each one lives in its own root outside the ring folder, knows nothing about the ring's location,
// the other contestant or the judge's files. The judge keeps the registry (contestants.json, not in git).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RING = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const KIT = join(RING, 'kit');
const REGISTRY = join(RING, 'contestants.json');
const AGENTS = ['claude', 'codex', 'gemini'];

const readJSON = (f, fallback = {}) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);
const writeJSON = (f, v) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};
const win = (p) => p.split('/').join('\\');

export function ringConfig() {
  return readJSON(join(RING, 'ring.config.json'));
}

export function registry() {
  return readJSON(REGISTRY);
}

export function getContestant(id) {
  const c = registry()[id];
  if (!c) throw new Error(`нет участника «${id}». Есть: ${Object.keys(registry()).join(', ') || 'никого'} (node ring.mjs new <id> …)`);
  return { id, ...c };
}

export function defaultRoot(id) {
  // relative to the ring folder: by default a sibling folder, outside the ring, so a contestant never sees the judge
  const tpl = ringConfig().contestRoot || '../ring-contest-{id}';
  return resolve(RING, tpl.replace('{id}', id));
}

export function codexHome(id) {
  return join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'fight-ring', `codex-${id}`);
}

// A clean Antigravity CLI profile for a Gemini contestant: Antigravity keeps its settings, hooks, skills, MCP servers and
// conversations under ~/.gemini and has no switch for another folder, so the contestant's agent runs with its own home
// (USERPROFILE/HOME). The login lives in the Windows credential store and works from any home (checked).
export function geminiHome(id) {
  return join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'fight-ring', `gemini-${id}`);
}

// Antigravity CLI: the winget link agy, or the binary in the winget package folder when this shell's PATH is older
export function agyExe() {
  const r = spawnSync('where', ['agy'], { encoding: 'utf8' });
  const found = (r.stdout || '').split(/\r?\n/).find((p) => /\.(exe|cmd)$/i.test(p));
  if (found) return found;
  const pkgs = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  const pkg = existsSync(pkgs) ? readdirSync(pkgs).find((d) => d.startsWith('Google.AntigravityCLI')) : null;
  if (pkg && existsSync(join(pkgs, pkg, 'agy.exe'))) return join(pkgs, pkg, 'agy.exe');
  return 'agy';
}

export function prepareGeminiHome(id) {
  const c = getContestant(id);
  if (c.agent !== 'gemini') throw new Error(`${id} — не Gemini-участник`);
  const home = geminiHome(id);
  const g = join(home, '.gemini');
  writeJSON(join(g, 'antigravity-cli', 'settings.json'), {
    ...(c.agentModel ? { model: c.agentModel } : {}),
    // the same as the other corners: the agent works without asking (Claude --dangerously-skip-permissions, Codex never)
    toolPermission: 'always-proceed',
    artifactReviewPolicy: 'always-proceed',
    trustedWorkspaces: [win(c.root)],
    showTips: false,
    showFeedbackSurvey: false,
    notifications: false,
    // with a scheme chosen the window on camera opens straight into the agent, not on «Choose your color scheme»
    colorScheme: 'dark',
  });
  // the terms of service the operator accepted in his own Antigravity CLI (agy, once): the contestant's window then
  // opens without them. Never accepted here on his behalf.
  const accepted = join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'onboarding.json');
  if (existsSync(accepted)) {
    mkdirSync(join(g, 'antigravity-cli', 'cache'), { recursive: true });
    copyFileSync(accepted, join(g, 'antigravity-cli', 'cache', 'onboarding.json'));
  }
  // Antigravity's own image generator is outside the ring's limits (Codex has image_generation = false): every
  // contestant draws through `arena paint`. Checked: the call is denied, in sub-agents too.
  writeJSON(join(g, 'config', 'hooks.json'), {
    'ring-no-image-tool': {
      PreToolUse: [{ matcher: 'generate_image', hooks: [{ type: 'command', command: 'cmd /c echo {"decision":"deny","reason":"generate_image выключен в ринге"}', timeout: 10 }] }],
    },
  });
  return { home };
}

function limitsFor(id) {
  const cfg = ringConfig();
  return { paint: 40, voiceDesigns: 3, voiceSeconds: 150, ...(cfg.limits || {}), ...(cfg.contestants?.[id]?.limits || {}) };
}

export function createContestant(id, { model, agent, color = '#e0e0e0', root = null, agentModel = null, effort = null }) {
  if (!id || !/^[a-z0-9-]+$/.test(id) || id === 'workshop') throw new Error('id участника: латиница в нижнем регистре, цифры и -, не «workshop»');
  if (!AGENTS.includes(agent)) throw new Error(`--agent: ${AGENTS.join(' | ')}`);
  if (registry()[id]) throw new Error(`участник «${id}» уже есть: ${registry()[id].root}`);
  root = resolve(root || defaultRoot(id));
  const inside = (a, b) => a === b || a.startsWith(b + sep);
  if (inside(root, RING) || inside(RING, root)) throw new Error(`корень участника не может быть внутри папки ринга или содержать её: ${root}`);
  for (const [other, c] of Object.entries(registry())) {
    if (inside(root, resolve(c.root)) || inside(resolve(c.root), root)) throw new Error(`корень ${root} пересекается с корнем участника «${other}»`);
  }
  if (existsSync(root) && readdirSync(root).length) throw new Error(`${root} уже существует и не пуст. Убери его вручную, если нужен чистый старт.`);
  const skip = new Set(['out', 'contestant.json', '.git', '.ring', 'history']);
  cpSync(KIT, root, {
    recursive: true,
    filter: (src) => {
      const top = relative(KIT, src).split(sep)[0];
      return !skip.has(top) && !src.includes(`${sep}parts${sep}raw`);
    },
  });
  writeJSON(join(root, 'contestant.json'), { id, model: model || id, color });
  writeJSON(join(root, '.ring', 'limits.json'), limitsFor(id));
  writeJSON(join(root, '.ring', 'ledger.json'), { paint: 0, voiceDesigns: 0, voiceSeconds: 0, log: [] });
  writeFileSync(join(root, '.gitignore'), 'out/\n.ring/\n.claude/\n');
  if (agent === 'claude') writeJSON(join(root, '.claude', 'settings.json'), { autoMemoryEnabled: false });
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  // the contestant's own identity: without it the agent cannot commit its work (found on the rehearsal)
  git('config', 'user.name', 'Участник ринга');
  git('config', 'user.email', 'contestant@ring.local');
  git('add', '-A');
  git('-c', 'user.name=Fight Ring', '-c', 'user.email=ring@localhost', 'commit', '-qm', 'Стартовый набор ринга');
  const reg = registry();
  reg[id] = { root: root.split(sep).join('/'), model: model || id, agent, color, agentModel: agentModel || (agent === 'claude' ? 'claude-opus-5-5' : null), effort, created: new Date().toISOString() };
  writeJSON(REGISTRY, reg);
  const script = writeLaunchScript(id);
  return { root, script };
}

// ---------- launching an agent from a clean profile ----------

// A Claude contestant can fight on another Claude subscription: its long-lived token (`claude setup-token` run
// under that account) lives outside the ring in ~/.config/fight-ring/claude-<account>.token, and the launch script
// reads it into CLAUDE_CODE_OAUTH_TOKEN at start, so the token never lands in the script, the registry or a log.
export function claudeTokenFile(account) {
  if (!/^[a-z0-9-]+$/.test(account || '')) throw new Error('имя аккаунта: латиница в нижнем регистре, цифры и -');
  return join(homedir(), '.config', 'fight-ring', `claude-${account}.token`);
}

export function setClaudeAccount(id, account) {
  const c = getContestant(id);
  if (c.agent !== 'claude') throw new Error(`${id} — не Claude-участник`);
  const reg = registry();
  if (account) claudeTokenFile(account);
  if (account) reg[id].account = account;
  else delete reg[id].account;
  writeJSON(REGISTRY, reg);
  return writeLaunchScript(id);
}

export function launchCommand(id) {
  const c = getContestant(id);
  const root = win(c.root);
  if (c.agent === 'claude') {
    // the agent runs with --dangerously-skip-permissions; its window on camera does not stop on the «bypass
    // permissions?» question, which stands on «No, exit» (Claude Code takes this one key only from --settings, not
    // from the project's settings: checked on the console's window)
    const flags = join(c.root, '.claude', 'launch-settings.json');
    writeJSON(flags, { skipDangerousModePermissionPrompt: true });
    const args = ['--settings', win(flags), '--setting-sources', 'project', '--strict-mcp-config', '--dangerously-skip-permissions'];
    if (c.agentModel) args.push('--model', c.agentModel);
    if (c.effort) args.push('--effort', c.effort);
    return { root, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, exe: 'claude', args };
  }
  if (c.agent === 'gemini') {
    const args = ['--dangerously-skip-permissions'];
    if (c.agentModel) args.push('--model', c.agentModel);
    // Gemini 4 ids carry the effort (gemini-4-carbon-high), and agy refuses --effort next to them
    if (c.effort && !/-(low|medium|high|xhigh|max)$/.test(c.agentModel || '')) args.push('--effort', c.effort);
    const home = geminiHome(id);
    // the ring's tools read the operator's services and the paint profile from the operator's home, not the agent's
    return { root, env: { USERPROFILE: home, HOME: home, RING_OPERATOR_HOME: homedir() }, exe: agyExe(), args };
  }
  const args = ['-C', root];
  if (c.agentModel) args.push('-m', c.agentModel);
  if (c.effort) args.push('-c', `model_reasoning_effort="${c.effort}"`);
  return { root, env: { CODEX_HOME: codexHome(id) }, exe: 'codex', args };
}

// Everything the agent starts lives in one Windows job that closes its processes when the launch script ends: a
// background `preview` or a sleep loop left by the agent used to outlive it, hold the journal open and could still
// change fighter/ after the judge took it (found on the rehearsal). Works for an interactive window too.
export const JOB_LINES = [
  '# всё, что запустит агент, живёт в одном задании Windows: когда скрипт заканчивается, его оставшиеся процессы закрываются',
  "Add-Type -TypeDefinition @'",
  'using System; using System.Runtime.InteropServices;',
  'public static class RingJob {',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);',
  '  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, uint l);',
  '  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);',
  '  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();',
  '  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A, B; public uint Flags; public UIntPtr C, D; public uint E; public UIntPtr F; public uint G, H; }',
  '  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }',
  '  [StructLayout(LayoutKind.Sequential)] struct Ext { public Basic B; public Io I; public UIntPtr P, J, PP, PJ; }',
  '  public static IntPtr Start() {',
  '    IntPtr j = CreateJobObject(IntPtr.Zero, null);',
  '    Ext x = new Ext(); x.B.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
  '    int n = Marshal.SizeOf(typeof(Ext)); IntPtr m = Marshal.AllocHGlobal(n); Marshal.StructureToPtr(x, m, false);',
  '    SetInformationJobObject(j, 9, m, (uint)n); AssignProcessToJobObject(j, GetCurrentProcess());',
  '    return j;',
  '  }',
  '}',
  "'@",
  '$ringJob = [RingJob]::Start()',
];

export function writeLaunchScript(id) {
  const c = getContestant(id);
  const cmd = launchCommand(id);
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const lines = [
    `# Запуск участника «${id}» (${c.model}) с чистого листа. Создан судьёй: node ring.mjs new / node ring.mjs launch-script ${id}`,
    `# Дополнительные аргументы передаются агенту, например: .\\launch\\${id}.ps1 -p "текст промпта"`,
    "$ErrorActionPreference = 'Stop'",
    '# окружение без следов чужой сессии агента (терминал Claude Code или Codex оператора): иначе участник наследует её',
    "Get-ChildItem env: | Where-Object { $_.Name -match '^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK|CODEX_|T3CODE_)' -and $_.Name -ne 'CLAUDE_CODE_GIT_BASH_PATH' } | ForEach-Object { Remove-Item -LiteralPath \"env:$($_.Name)\" }",
    ...JOB_LINES,
  ];
  if (c.agent === 'codex') lines.push(`node ${ps(join(RING, 'ring.mjs'))} codex-home ${id}`);
  if (c.agent === 'gemini') lines.push(`node ${ps(join(RING, 'ring.mjs'))} gemini-home ${id}`);
  for (const [k, v] of Object.entries(cmd.env)) lines.push(`$env:${k} = ${ps(v)}`);
  if (c.agent === 'claude' && c.account) {
    const f = ps(claudeTokenFile(c.account));
    lines.push(`# бой на подписке «${c.account}»: токен из claude setup-token этого аккаунта`);
    lines.push(`if (-not (Test-Path -LiteralPath ${f})) { throw "нет токена аккаунта «${c.account}»: ${claudeTokenFile(c.account).replace(/"/g, '')}" }`);
    lines.push(`$env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content -Raw -LiteralPath ${f}).Trim()`);
  }
  lines.push(`Set-Location -LiteralPath ${ps(cmd.root)}`);
  lines.push(`& ${cmd.exe} ${cmd.args.map(ps).join(' ')} @args`);
  lines.push('$code = $LASTEXITCODE');
  if (c.agent === 'codex') lines.push(`node ${ps(join(RING, 'ring.mjs'))} codex-home ${id} --back`);
  lines.push('exit $code');
  const file = join(RING, 'launch', `${id}.ps1`);
  mkdirSync(join(RING, 'launch'), { recursive: true });
  writeFileSync(file, '\ufeff' + lines.join('\r\n') + '\r\n');
  return file;
}

// A clean Codex profile for a contestant: no user AGENTS.md, memories, skills, plugins or MCP servers.
// Login is shared with the operator's main profile: auth.json is copied in before a session and the
// fresher copy is written back after it, so token refresh in either profile never logs the other one out.
export function prepareCodexHome(id, { back = false } = {}) {
  const c = getContestant(id);
  if (c.agent !== 'codex') throw new Error(`${id} — не Codex-участник`);
  const home = codexHome(id);
  const main = process.env.RING_MAIN_CODEX_HOME || join(homedir(), '.codex');
  mkdirSync(home, { recursive: true });
  const fresh = (f) => {
    try {
      return Date.parse(JSON.parse(readFileSync(f, 'utf8')).last_refresh || 0) || 0;
    } catch {
      return 0;
    }
  };
  const mainAuth = join(main, 'auth.json');
  const ownAuth = join(home, 'auth.json');
  if (back) {
    if (existsSync(ownAuth) && fresh(ownAuth) > fresh(mainAuth)) {
      copyFileSync(ownAuth, mainAuth);
      return { home, synced: 'back' };
    }
    return { home, synced: null };
  }
  if (!existsSync(mainAuth)) throw new Error(`нет входа Codex в ${main} (codex login)`);
  if (!existsSync(ownAuth) || fresh(mainAuth) >= fresh(ownAuth)) copyFileSync(mainAuth, ownAuth);
  const root = win(c.root);
  const toml = [
    '# Чистый профиль участника ринга: без AGENTS.md пользователя, памяти, навыков, плагинов и MCP.',
    c.agentModel ? `model = "${c.agentModel}"` : null,
    c.effort ? `model_reasoning_effort = "${c.effort}"` : null,
    'approval_policy = "never"',
    // no «update available» question in the contestant's window on camera
    'check_for_update_on_startup = false',
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'memories = false',
    // the account's remote plugins (Canva, data analytics, security…) were downloaded into the contestant's profile and
    // their MCP servers started (found on the second rehearsal); no image generation past the ring's limits either
    'plugins = false',
    'image_generation = false',
    'tool_suggest = false',
    '',
    // Codex finds the user's own skills in ~/.agents/skills whatever CODEX_HOME is (on the rehearsal a contestant read
    // the operator's skills): no skills in the contestant's context, its own or bundled
    '[skills]',
    'include_instructions = false',
    '',
    `[projects.'${root.toLowerCase()}']`,
    'trust_level = "trusted"',
    '',
  ].filter((l) => l !== null);
  writeFileSync(join(home, 'config.toml'), toml.join('\n'));
  return { home, synced: 'in' };
}

// ---------- audit: did the agent touch anything outside its root? ----------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Claude Code keeps a contestant's sessions in ~/.claude/projects/<its folder as a slug>
function claudeProjectDirs(c) {
  const slug = win(c.root).replace(/[^A-Za-z0-9]/g, '-');
  const base = join(homedir(), '.claude', 'projects');
  return existsSync(base) ? readdirSync(base).filter((d) => d.toLowerCase() === slug.toLowerCase()).map((d) => join(base, d)) : [];
}

export function transcriptFiles(id) {
  const c = getContestant(id);
  if (c.agent === 'claude') return claudeProjectDirs(c).flatMap((d) => walk(d));
  if (c.agent === 'gemini') return geminiTranscripts(id);
  return walk(join(codexHome(id), 'sessions'));
}

// Antigravity writes each conversation (and each sub-agent's) to brain/<id>/.system_generated/logs/transcript_full.jsonl
export function geminiTranscripts(id) {
  const brain = join(geminiHome(id), '.gemini', 'antigravity-cli', 'brain');
  if (!existsSync(brain)) return [];
  return readdirSync(brain).map((d) => join(brain, d, '.system_generated', 'logs', 'transcript_full.jsonl')).filter((f) => existsSync(f));
}

// Every spelling of a path in a journal: native, with forward slashes, JSON-escaped; matched case-insensitively
// (Windows paths are).
function pathVariants(p) {
  const a = resolve(p);
  return [...new Set([a, a.split(sep).join('/'), a.split(sep).join('\\\\')].map((x) => x.toLowerCase()))];
}

// One journal line against the needles. `own` — spellings of the agent's own session folder: Claude Code saves a long
// tool output there (…/.claude/projects/<the contestant's folder>/<session>/tool-results) and the agent reads it back,
// which is its own work, not the operator's ~/.claude (flagged as such twice on 17.11.2026).
export function auditLine(line, needles, own = []) {
  let text = line.toLowerCase();
  for (const o of own) text = text.split(o).join('');
  const out = [];
  for (const { what, n } of needles) {
    const k = text.indexOf(n);
    if (k >= 0) out.push({ what, text: text.slice(Math.max(0, k - 80), k + n.length + 80) });
  }
  return out;
}

export function audit(id) {
  const me = getContestant(id);
  const needles = [];
  const add = (what, p) => needles.push(...pathVariants(p).map((n) => ({ what, n })));
  add('папка ринга', RING);
  for (const [other, c] of Object.entries(registry())) if (other !== id) add(`участник «${other}»`, c.root);
  needles.push({ what: 'корзина', n: '.trash-' });
  // the operator's own skills, settings and memory: never in a contestant's context
  for (const d of ['.agents', '.claude', '.codex', '.gemini']) add(`~/${d} оператора`, join(homedir(), d));
  const own = me.agent === 'claude' ? claudeProjectDirs(me).flatMap(pathVariants) : [];
  const files = transcriptFiles(id);
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const h of auditLine(line, needles, own)) hits.push({ file: f, line: i + 1, ...h });
    });
  }
  return { id, root: me.root, files, hits };
}

// ---------- the locker-room reply: what the model said it changed ----------

// Messages of an agent session as { role, text, at }: Claude Code, Codex and Antigravity journals.
function sessionMessages(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // Antigravity: USER_INPUT (the prompt inside <USER_REQUEST>) and PLANNER_RESPONSE steps with text
    if (o.type === 'USER_INPUT' || (o.type === 'PLANNER_RESPONSE' && o.content)) {
      const text = String(o.content || '').replace(/<\/?USER_REQUEST>/g, '').trim();
      if (text) out.push({ role: o.type === 'USER_INPUT' ? 'user' : 'assistant', text, at: o.created_at || '' });
      continue;
    }
    const msg = o.message?.role ? o.message : o.payload?.type === 'message' ? o.payload : null;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const parts = typeof msg.content === 'string' ? [msg.content] : (msg.content || []).filter((c) => ['text', 'input_text', 'output_text'].includes(c.type)).map((c) => c.text);
    const text = parts.join('\n').trim();
    if (text) out.push({ role: msg.role, text, at: o.timestamp || '' });
  }
  return out;
}

// The agent's last answer to the locker prompt of round n (prompts/locker.md starts with «Раунд N окончен»).
export function lockerReply(id, n) {
  return lockerReplyIn(transcriptFiles(id), n);
}

// the same over given journal files (tests feed their own)
export function lockerReplyIn(files, n) {
  const mark = `Раунд ${n} окончен`;
  let best = null;
  for (const f of files) {
    const msgs = sessionMessages(f);
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'user' || !msgs[i].text.includes(mark)) continue;
      let reply = null;
      for (let j = i + 1; j < msgs.length && msgs[j].role !== 'user'; j++) reply = msgs[j];
      if (reply && (!best || reply.at > best.at)) best = reply;
    }
  }
  return best ? { round: n, text: best.text.slice(0, 4000), at: best.at } : null;
}
