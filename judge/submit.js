// Sending a fighter to the shared roster (docs/roster.md):
//   node ring.mjs submit <папка бойца> --model "…" --agent claude|codex|gemini|… [--effort high] [--name "Имя автора"]
//                        [--login логин] [--dry] [--no-league] [--repo владелец/репозиторий]
// The record (entry.json and the fighter without its drafts) is put together in out/submit/<id>/ and qualified there
// by the same checks the robot of the repository runs. A fighter that passed goes out as a pull request: a fork, a
// branch with the single folder roster/<id>/, a commit. --dry stops before the first step that touches the network
// and prints what would be done.
// The same file holds the robot's side: what a pull request may touch (pullRequestScope).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RING } from './contestants.js';
import { DRAFTS, notDraft } from './publish.js';
import { LOGIN, ROSTER_ID, checkEntry, rosterId } from './roster.js';
import { qualify } from './qualify.js';

export const UPSTREAM = 'ganson-labs/fight-ring';
// what a model leaves beside a fighter besides the drafts a season drops: the voice's rejected takes
const ROSTER_DRAFTS = [...DRAFTS, /^voice[\\/]design$/];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const has = (cmd) => {
  try {
    sh(cmd, ['--version']);
    return true;
  } catch {
    return false;
  }
};

// The record of a fighter: <out>/entry.json and <out>/fighter/ without the drafts.
export function buildRecord(fighterDir, { model, agent, effort = null, name = null, login, date = new Date().toISOString().slice(0, 10), out = null } = {}) {
  let src = resolve(fighterDir);
  if (!existsSync(join(src, 'fighter.json')) && existsSync(join(src, 'fighter', 'fighter.json'))) src = join(src, 'fighter');
  if (!existsSync(join(src, 'fighter.json'))) throw new Error(`в ${resolve(fighterDir)} нет fighter.json: укажи папку бойца`);
  if (typeof login !== 'string' || !LOGIN.test(login)) throw new Error('нужен логин автора на GitHub: --login <логин> (его же берёт gh, если он установлен и выполнен вход)');
  if (typeof model !== 'string' || typeof agent !== 'string') throw new Error('нужны --model "название модели" и --agent claude|codex|gemini или своё название агента');
  let card;
  try {
    card = JSON.parse(readFileSync(join(src, 'fighter.json'), 'utf8'));
  } catch (err) {
    throw new Error(`fighter.json: не JSON — ${err.message}`);
  }
  const id = rosterId(login, card.name);
  const entry = { id, author: { github: login, name: name || login }, model, agent, effort: effort || null, date };
  const wrong = checkEntry(entry, { id, fighterName: card.name });
  if (wrong.length) throw new Error(wrong.join('\n'));
  const dir = resolve(out || join(RING, 'out', 'submit', id));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const keep = notDraft(src);
  cpSync(src, join(dir, 'fighter'), { recursive: true, filter: (p) => keep(p) && !ROSTER_DRAFTS.some((re) => re.test(p.slice(src.length + 1))) });
  writeFileSync(join(dir, 'entry.json'), `${JSON.stringify(entry, null, 2)}\n`);
  return { id, dir, entry, card };
}

// The steps after the record is ready, as commands. work — a clean copy of the upstream's main branch.
export function pullRequestSteps({ id, login, record, repo = UPSTREAM, name, model }) {
  const branch = `roster/${id}`;
  const name2 = repo.split('/')[1];
  const title = `Боец общего набора: ${name} (${model})`;
  const body = `Боец «${name}», модель ${model}, автор ${login}. Запись собрана командой \`node ring.mjs submit\`, квалификация на машине автора пройдена.`;
  return {
    branch,
    title,
    steps: [
      { what: 'ответвление репозитория на своём аккаунте', cmd: ['gh', 'repo', 'fork', repo, '--clone=false'] },
      { what: 'свежая основная ветка ринга', cmd: ['git', 'fetch', `https://github.com/${repo}.git`, 'main'] },
      { what: 'отдельная рабочая папка с этой веткой', cmd: ['git', 'worktree', 'add', '--detach', '<рабочая папка>', 'FETCH_HEAD'] },
      { what: `запись бойца в roster/${id}/`, copy: [record, `roster/${id}`] },
      { what: 'ветка и коммит', cmd: ['git', '-C', '<рабочая папка>', 'switch', '-c', branch] },
      { cmd: ['git', '-C', '<рабочая папка>', 'add', '--', `roster/${id}`] },
      { cmd: ['git', '-C', '<рабочая папка>', 'commit', '-m', title] },
      { what: 'ветка в своё ответвление', cmd: ['git', '-C', '<рабочая папка>', 'push', '--force', `https://github.com/${login}/${name2}.git`, `HEAD:refs/heads/${branch}`] },
      { what: 'запрос на слияние', cmd: ['gh', 'pr', 'create', '--repo', repo, '--base', 'main', '--head', `${login}:${branch}`, '--title', title, '--body', body] },
    ],
  };
}

const show = (step) => (step.copy ? `скопировать ${step.copy[0]} → ${step.copy[1]}` : step.cmd.map((a) => (/[\s"'()«»]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '));

export async function submit(fighterDir, { model, agent, effort = null, name = null, login = null, dry = false, league = true, sheet = true, repo = UPSTREAM, out = null, jobs, cache, log = console.log } = {}) {
  const gh = has('gh');
  // asking gh who is signed in is a call to the network: a dry run takes the login from --login
  if (!login && gh && !dry) {
    try {
      login = sh('gh', ['api', 'user', '--jq', '.login']);
    } catch {}
  }
  const record = buildRecord(fighterDir, { model, agent, effort, name, login, out });
  log(`Запись бойца «${record.card.name}»: ${record.dir}`);
  const q = await qualify(record.dir, { out: join(record.dir, '..', `${record.id}.qualify`), league, sheet, jobs, cache, log });
  if (q.checks.some((c) => c.ok === false)) {
    log(`\nБоец не прошёл квалификацию, запрос не отправлен. Что исправить: ${join(q.out, 'report.md')}`);
    return { ...record, qualified: false, sent: false, report: join(q.out, 'report.md') };
  }
  const plan = pullRequestSteps({ id: record.id, login: record.entry.author.github, record: record.dir, repo, name: record.card.name, model });
  const result = { ...record, qualified: q.passed, report: join(q.out, 'report.md'), sheet: q.sheet ? join(q.out, q.sheet) : null, plan };
  if (dry || !gh || !has('git')) {
    log(dry ? '\nПробный запуск (--dry): дальше команда сделала бы это сама.' : '\nGitHub CLI (gh) не установлен, поэтому запрос на слияние нужно отправить руками:');
    for (const s of plan.steps) log(`  ${s.what ? `${s.what}:\n    ` : '  '}${show(s)}`);
    if (!dry) log(`\nБез gh: сделай ответвление https://github.com/${repo} на сайте GitHub, положи папку ${record.dir} в roster/${record.id}/ своего ответвления одной веткой и открой запрос на слияние в main.`);
    return { ...result, sent: false };
  }
  const work = mkdtempSync(join(tmpdir(), 'ring-submit-'));
  rmSync(work, { recursive: true, force: true });
  const run = (cmd) => sh(cmd[0], cmd.slice(1).map((a) => (a === '<рабочая папка>' ? work : a)), { cwd: RING });
  let url = null;
  try {
    for (const s of plan.steps) {
      if (s.what) log(`  ${s.what}`);
      if (s.copy) cpSync(s.copy[0], join(work, s.copy[1]), { recursive: true });
      else url = run(s.cmd) || url;
    }
  } finally {
    try {
      sh('git', ['worktree', 'remove', '--force', work], { cwd: RING });
    } catch {}
  }
  log(`\nЗапрос на слияние отправлен: ${url}`);
  return { ...result, sent: true, url };
}

// ---------- the robot's side ----------

// What a pull request that brings a fighter may touch. files — the paths it changes; author — the login of the
// one who opened it; read(path) — the text of a file of the request. A stranger changes exactly one folder
// roster/<id>/ and is the author written in its entry.json. Returns { ids, problems }.
export function pullRequestScope(files, { author, read, trusted = false }) {
  const problems = [];
  const ids = [...new Set(files.filter((f) => f.startsWith('roster/') && f.split('/').length > 2).map((f) => f.split('/')[1]))];
  const outside = files.filter((f) => !ids.some((id) => f.startsWith(`roster/${id}/`)));
  for (const id of ids) if (!ROSTER_ID.test(id)) problems.push(`roster/${id}: имя папки — латиница, цифры и дефис`);
  if (!trusted) {
    if (ids.length > 1) problems.push(`запрос меняет несколько папок общего набора (${ids.join(', ')}): один запрос — один боец`);
    if (outside.length) problems.push(`запрос с бойцом меняет только папку roster/<id>/, а здесь ещё: ${outside.slice(0, 8).join(', ')}${outside.length > 8 ? '…' : ''}`);
    for (const id of ids.filter((x) => ROSTER_ID.test(x))) {
      let entry = null;
      try {
        entry = JSON.parse(read(`roster/${id}/entry.json`));
      } catch {}
      if (!entry) continue; // a removed fighter or a broken entry: the qualification says the rest
      const login = entry?.author?.github;
      if (typeof login !== 'string' || login.toLowerCase() !== String(author).toLowerCase()) problems.push(`roster/${id}/entry.json: автор «${login}», а запрос открыл ${author}: бойца присылает его автор`);
    }
  }
  return { ids, problems };
}
