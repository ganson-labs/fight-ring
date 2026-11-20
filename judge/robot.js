// The robot of a pull request that brings a fighter (.github/workflows/roster.yml):
//   node ring.mjs roster-pr --repo <папка запроса> --files <список> --author <логин> [--trusted]
// The judge that runs is the one of the main branch; the request's copy of the repository is only read: which files
// it changes, whose fighter it is, and the fighter itself for the qualification. The report goes to the job's
// summary, the sheet with the fighter's pictures to the artifacts. The owner merges by hand.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RING } from './contestants.js';
import { pullRequestScope } from './submit.js';
import { qualify } from './qualify.js';

export async function checkPullRequest({ repo, base, head, author, trusted = false, out = null, files = null, league = true, sheet = true, jobs, cache, log = console.log }) {
  if (!repo || !author || (!files && (!base || !head))) throw new Error('node ring.mjs roster-pr --repo <папка запроса> --files <список изменённых файлов> --author <логин> [--trusted]');
  repo = resolve(repo);
  out = resolve(out || join(RING, 'out', 'roster-pr'));
  mkdirSync(out, { recursive: true });
  files ||= execFileSync('git', ['-C', repo, 'diff', '--name-only', '--no-renames', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const scope = pullRequestScope(files, { author, trusted, read: (p) => readFileSync(join(repo, p), 'utf8') });
  const L = ['# Приём бойца в общий набор', ''];
  let ok = scope.problems.length === 0;
  const reports = [];
  if (!scope.ids.length) L.push('Запрос не меняет ни одного бойца общего набора: проверять нечего.', '');
  else if (!ok) L.push('**Запрос не принят к проверке.** Бойца никто не запускал.', '', ...scope.problems.map((p) => `- ${p}`), '');
  else {
    for (const id of scope.ids) {
      const dir = join(repo, 'roster', id);
      if (!existsSync(dir)) {
        L.push(`Папка \`roster/${id}\` удалена этим запросом.`, '');
        continue;
      }
      log(`\nКвалификация roster/${id}`);
      const r = await qualify(dir, { out: join(out, id), roster: join(repo, 'roster'), league, sheet, jobs, cache, log });
      reports.push(r);
      if (!r.passed) ok = false;
      L.push(readFileSync(join(r.out, 'report.md'), 'utf8').replace(/^# /m, '## ').replace(/^## (?!Квалификация)/gm, '### '), '');
    }
  }
  L.push(ok ? 'Сливает запрос владелец репозитория: посмотрите лист с картинками в артефактах задания.' : '');
  const summary = L.join('\n');
  writeFileSync(join(out, 'summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  log(`\n${ok ? 'Запрос прошёл проверку' : 'Запрос не прошёл проверку'}: ${join(out, 'summary.md')}`);
  return { ok, scope, reports, out };
}
