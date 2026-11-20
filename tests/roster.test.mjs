// The shared roster (docs/roster.md): a fighter sent by a stranger is put together, read, qualified, shown in the
// game with its author, played in a cup — and its brains cannot talk to anyone from the visitor's browser.
// The trial fighter is the season's «Лоция Ноль» under another name: a whole fighter with pictures, a voice and
// brains that beat the references.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { loadFighter, replayFight } from '../kit/arena/tools/load.js';
import { launch } from '../kit/arena/tools/browser.js';
import { latin, rosterId, checkEntry } from '../judge/roster.js';
import { scanSource, scanFighterCode } from '../judge/safety.js';
import { buildRecord, submit, pullRequestScope } from '../judge/submit.js';
import { qualify, STRENGTH } from '../judge/qualify.js';
import { checkPullRequest } from '../judge/robot.js';
import { pairLeague, leagueTable } from '../judge/rating.js';
import { gameData } from '../judge/gamedata.js';
import { runCup, seedOrder } from '../judge/cup.js';
import { siteHeaders, sitePolicy, parseHeaders, headersFor, WORKER_POLICY } from '../judge/site.js';
import { serveSite } from '../scripts/serve-site.mjs';

E.setRuleset('standard'); // the roster is ring 4

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SEASON = join(root, 'seasons', '2026-11-gpt-6-2', 'fighters');
const base = mkdtempSync(join(tmpdir(), 'ring-roster-'));
test.after(() => rmSync(base, { recursive: true, force: true }));
const quiet = () => {};
const who = { model: 'GPT-6.2 Sol', agent: 'codex', effort: 'high', name: 'Тест Тестов', login: 'Test-User' };
const ID = 'test-user-probnyy-shturman';
const cache = join(base, 'pairs');
// the leagues of this file leave the processors to the tests that film clips beside it
const JOBS = 2;

// the contestant's folder as a model leaves it: the fighter and the drafts beside it
function trialSource(name = 'src', from = 'sol50/v1') {
  const dir = join(base, name);
  cpSync(join(SEASON, from), dir, { recursive: true });
  const card = JSON.parse(readFileSync(join(dir, 'fighter.json'), 'utf8'));
  card.name = 'Пробный Штурман';
  writeFileSync(join(dir, 'fighter.json'), JSON.stringify(card, null, 2));
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(join(dir, 'work', 'notes.txt'), 'черновик');
  writeFileSync(join(dir, 'art', 'portrait.paint.json'), '{}');
  mkdirSync(join(dir, 'voice', 'design'), { recursive: true });
  writeFileSync(join(dir, 'voice', 'design', 'preview-1.mp3'), 'ID3');
  return dir;
}
// a record of the trial fighter in a roster of its own, changed by `spoil`
function record(tag, spoil = null, from = undefined) {
  const r = buildRecord(trialSource(`src-${tag}`, from), { ...who, out: join(base, `roster-${tag}`, ID) });
  spoil?.(join(r.dir, 'fighter'), r.dir);
  return r;
}
const check = (q, id) => q.checks.find((c) => c.id === id);

test('имя папки бойца: логин автора и имя бойца латиницей', () => {
  assert.equal(latin('Главбух Зоя Павловна'), 'glavbukh-zoya-pavlovna');
  assert.equal(rosterId('Test-User', 'Пробный Штурман'), ID);
  assert.throws(() => rosterId('anna', '!!!'), /не получается имя папки/);
  const good = { id: ID, author: { github: 'Test-User', name: 'Тест Тестов' }, model: 'GPT-6.2 Sol', agent: 'codex', effort: null, date: '2026-11-20' };
  assert.deepEqual(checkEntry(good, { id: ID, fighterName: 'Пробный Штурман' }), []);
  assert.match(checkEntry({ ...good, id: 'chuzhoy-boets' }, { id: 'chuzhoy-boets', fighterName: 'Пробный Штурман' }).join('\n'), /получает имя «test-user-probnyy-shturman»/);
  assert.match(checkEntry({ ...good, author: { github: 'Test-User', name: '<b>Тест</b>' } }).join('\n'), /author\.name/);
  assert.match(checkEntry({ ...good, date: 'вчера' }).join('\n'), /date/);
});

test('проверка кода: ловит обращения к сети, окружению и коду из строки вместе с обходами, честный код пропускает', () => {
  const caught = [
    "fetch('https://example.com')", 'new WebSocket(u)', "self['fe' + 'tch'](u)", 'globalThis.x', 'window.top', 'document.cookie', 'process.env', "require('fs')",
    "eval('1')", "new Function('return 1')", "[].constructor.constructor('return 1')()", "x['constructor']", "x['\\x63onstructor']", 'f\\u0065tch(u)', 'x.__proto__', 'Object.getPrototypeOf(x)',
    "import('./a.js')", 'import.meta.url', 'importScripts(u)', 'postMessage(1)', 'indexedDB.open(n)', 'localStorage.a', 'const t = `${a}prototype`', "String.fromCharCode(102)", 'Reflect.get(a, b)',
    'Math.random()', 'Date.now()', 'setTimeout(f, 1)', 'const f = async () => 1', 'navigator.sendBeacon(u)',
  ];
  for (const src of caught) assert.ok(scanSource(src).length > 0, `не пойман: ${src}`);
  const honest = "// fetch и eval в комментарии не код\nconst seen = [1, 2];\nconst re = /constructor/;\nexport default { tick(view) { const i = view.tick % 2; return { move: seen[i] > 1 ? 'left' : 'right', guard: 'high' }; } };";
  assert.deepEqual(scanSource(honest), []);
  assert.match(scanSource('const a = 1;\nfetch(u);', 'brain.js')[0], /^brain\.js:2: «fetch»/, 'названы файл и строка');
  // every fighter of the season, the template and the sparring partners are honest by this scan
  const dirs = [join(root, 'kit', 'fighter'), ...readdirSync(join(root, 'kit', 'arena', 'sparring')).filter((n) => n !== '_core').map((n) => join(root, 'kit', 'arena', 'sparring', n))];
  for (const c of readdirSync(SEASON)) for (const v of readdirSync(join(SEASON, c))) dirs.push(join(SEASON, c, v));
  for (const d of dirs) assert.deepEqual(scanFighterCode(d).errors, [], d);
  // a file the brains do not import is read too, and has to go
  const dir = join(base, 'code');
  cpSync(join(root, 'kit', 'fighter'), dir, { recursive: true });
  writeFileSync(join(dir, 'spare.js'), "export const leak = () => fetch('https://example.com');\n");
  writeFileSync(join(dir, 'brain.js'), `import { step } from '../arena/engine/index.js';\n${readFileSync(join(dir, 'brain.js'), 'utf8')}`);
  const text = scanFighterCode(dir).errors.join('\n');
  assert.match(text, /spare\.js:1: «fetch»/);
  assert.match(text, /spare\.js: мозги \(brain\.js\) этот файл не подключают/);
  assert.match(text, /импорт «\.\.\/arena\/engine\/index\.js»/);
});

test('submit --dry: запись без черновиков, квалификация и шаги запроса, сеть не тронута', async () => {
  const src = trialSource('src-submit');
  const lines = [];
  const r = await submit(src, { ...who, dry: true, league: false, sheet: false, out: join(base, 'submit', ID), log: (s) => lines.push(s) });
  assert.equal(r.id, ID);
  assert.equal(r.sent, false);
  assert.deepEqual(JSON.parse(readFileSync(join(r.dir, 'entry.json'), 'utf8')), { id: ID, author: { github: 'Test-User', name: 'Тест Тестов' }, model: 'GPT-6.2 Sol', agent: 'codex', effort: 'high', date: r.entry.date });
  assert.match(r.entry.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(readdirSync(r.dir).sort(), ['entry.json', 'fighter']);
  for (const draft of ['work', 'art/portrait.paint.json', 'voice/design']) assert.ok(!existsSync(join(r.dir, 'fighter', draft)), `черновик ${draft} не попал в запись`);
  for (const own of ['brain.js', 'art/portrait.png', 'voice/intro.mp3', 'parts/head.png']) assert.ok(existsSync(join(r.dir, 'fighter', own)), own);
  const steps = r.plan.steps.filter((s) => s.cmd).map((s) => s.cmd.join(' '));
  assert.ok(steps.some((s) => s.startsWith('gh repo fork ganson-labs/fight-ring')));
  assert.ok(steps.some((s) => s.includes(`push --force https://github.com/Test-User/fight-ring.git HEAD:refs/heads/roster/${ID}`)));
  assert.ok(steps.some((s) => s.startsWith('gh pr create --repo ganson-labs/fight-ring --base main --head Test-User:roster/')));
  assert.match(lines.join('\n'), /Пробный запуск \(--dry\)/);
  assert.ok(existsSync(r.report));
  assert.throws(() => buildRecord(src, { ...who, login: null }), /нужен логин автора/);
});

test('квалификация: хороший боец проходит все шесть проверок, отчёт и лист с картинками на месте', { timeout: 600000 }, async () => {
  const r = record('good');
  const q = await qualify(r.dir, { out: join(base, 'q-good'), roster: join(r.dir, '..'), draws: 1, jobs: JOBS, cache, log: quiet });
  assert.deepEqual(q.checks.map((c) => [c.id, c.ok]), [['entry', true], ['files', true], ['rules', true], ['complete', true], ['code', true], ['strength', true]], JSON.stringify(q.checks.filter((c) => !c.ok)));
  assert.equal(q.passed, true);
  const s = check(q, 'strength');
  assert.equal(s.fights, 40, 'четыре эталона × пять стартов × две стороны');
  assert.ok(s.share >= STRENGTH.share && s.per.length === 4 && s.errors === 0);
  const saved = JSON.parse(readFileSync(join(q.out, 'qualify.json'), 'utf8'));
  assert.equal(saved.passed, true);
  const report = readFileSync(join(q.out, 'report.md'), 'utf8');
  assert.match(report, /Боец прошёл квалификацию/);
  assert.match(report, /Автор: Тест Тестов \(Test-User\)\. Модель: GPT-6\.2 Sol/);
  const sheet = readFileSync(join(q.out, 'sheet.png'));
  assert.equal(sheet.readUInt32BE(0), 0x89504e47);
  assert.deepEqual([sheet.readUInt32BE(16), sheet.readUInt32BE(20)], [1536, 864]);
  assert.ok(!JSON.stringify(saved).includes(base), 'в результате нет путей диска');
});

test('квалификация называет причину: картинки шаблона, запрещённый код, лишние файлы, слабый боец', { timeout: 600000 }, async () => {
  const run = async (tag, spoil, opts = {}) => {
    const r = record(tag, spoil);
    const q = await qualify(r.dir, { out: join(base, `q-${tag}`), roster: join(r.dir, '..'), league: false, sheet: false, jobs: JOBS, cache, log: quiet, ...opts });
    assert.equal(q.passed, false, tag);
    return q;
  };
  // the template's pictures and words
  let q = await run('stock', (f) => {
    cpSync(join(root, 'kit', 'fighter', 'parts', 'head.png'), join(f, 'parts', 'head.png'));
    const card = JSON.parse(readFileSync(join(f, 'fighter.json'), 'utf8'));
    Object.assign(card, { motto: 'Девиз бойца', portrait: undefined });
    writeFileSync(join(f, 'fighter.json'), JSON.stringify(card));
    rmSync(join(f, 'voice', 'intro.mp3'));
  });
  let text = check(q, 'complete').problems.join('\n');
  assert.match(text, /картинки частей тела взяты из набора ринга.*parts\/head\.png/);
  assert.match(text, /нет портрета/);
  assert.match(text, /девиз остался от шаблона/);
  assert.match(text, /голос не записан для 1 из/);
  assert.equal(check(q, 'code').ok, true);

  // forbidden code: named with its line, and the brains are not started
  q = await run('code', (f) => writeFileSync(join(f, 'brain.js'), `${readFileSync(join(f, 'brain.js'), 'utf8')}\nconst leak = () => fetch('https://example.com/' + 1);\n`), { league: true });
  assert.match(check(q, 'code').problems[0], /^brain\.js:\d+: «fetch» мозгам недоступно \(сеть и потоки\)/);
  assert.equal(check(q, 'strength').ok, null);
  assert.match(check(q, 'strength').skipped, /мозги запускаются только после проверок/);
  assert.match(readFileSync(join(q.out, 'report.md'), 'utf8'), /Боец не прошёл квалификацию/);

  // files that are not a fighter
  q = await run('files', (f, dir) => {
    writeFileSync(join(f, 'tool.py'), 'print(1)\n');
    writeFileSync(join(f, 'art', 'fake.png'), 'это не картинка');
    writeFileSync(join(f, 'имя с пробелом.json'), '{}');
    writeFileSync(join(dir, 'notes.md'), 'лишнее');
  });
  text = check(q, 'files').problems.join('\n');
  assert.match(text, /tool\.py: файлы такого типа в общий набор не принимаются/);
  assert.match(text, /art\/fake\.png: содержимое не похоже на \.png/);
  assert.match(text, /имя с пробелом\.json: в именах файлов и папок только латиница/);
  assert.match(text, /notes\.md: в папке бойца общего набора лежат только entry\.json и fighter\//);

  // a link is not followed: nothing else of the folder is read
  q = await run('link', (f) => symlinkSync(join(root, 'package.json'), join(f, 'art', 'link.json')));
  assert.match(check(q, 'files').problems[0], /fighter\/art\/link\.json: ссылка на другой файл/);
  assert.ok(q.checks.filter((c) => c.id !== 'files').every((c) => c.ok === null));

  // a weak fighter: everything is in place, but the brains stand still
  q = await run('weak', (f) => writeFileSync(join(f, 'brain.js'), 'export default { tick() { return {}; } };\n'), { league: true, draws: 1 });
  assert.deepEqual(q.checks.filter((c) => !c.ok).map((c) => c.id), ['strength']);
  assert.match(check(q, 'strength').problems[0], /набрано 0 % очков в боях с четырьмя эталонами, нужно не меньше 80 %/);

  // an author that is not the one who sends: the folder's name does not fit
  q = await run('entry', (f, dir) => {
    const e = JSON.parse(readFileSync(join(dir, 'entry.json'), 'utf8'));
    e.author.github = 'Drugoy';
    writeFileSync(join(dir, 'entry.json'), JSON.stringify(e));
  });
  assert.match(check(q, 'entry').problems.join('\n'), /у автора Drugoy боец «Пробный Штурман» получает имя «drugoy-probnyy-shturman»/);
});

test('робот запроса: посторонний меняет одну свою папку бойца и ничего больше', async () => {
  const entry = JSON.stringify({ author: { github: 'Test-User' } });
  const read = () => entry;
  const own = [`roster/${ID}/entry.json`, `roster/${ID}/fighter/brain.js`];
  assert.deepEqual(pullRequestScope(own, { author: 'test-user', read }), { ids: [ID], problems: [] });
  assert.match(pullRequestScope([...own, 'judge/qualify.js'], { author: 'Test-User', read }).problems[0], /меняет только папку roster\/<id>\/, а здесь ещё: judge\/qualify\.js/);
  assert.match(pullRequestScope([...own, 'roster/drugoy-boets/fighter/brain.js'], { author: 'Test-User', read }).problems[0], /один запрос — один боец/);
  assert.match(pullRequestScope(own, { author: 'Zloy', read }).problems[0], /автор «Test-User», а запрос открыл Zloy/);
  assert.match(pullRequestScope(['roster/../x/entry.json'], { author: 'a', read }).problems.join('\n'), /имя папки/);
  assert.deepEqual(pullRequestScope([...own, 'judge/qualify.js'], { author: 'Owner', read, trusted: true }).problems, [], 'владельцу можно');
  assert.deepEqual(pullRequestScope(['README.md'], { author: 'a', read }), { ids: [], problems: ['запрос с бойцом меняет только папку roster/<id>/, а здесь ещё: README.md'] });

  // the whole robot on a copy of a request: a stranger's fighter with an edit of the judge is not even started
  const repo = join(base, 'pr');
  const r = buildRecord(trialSource('src-pr'), { ...who, out: join(repo, 'roster', ID) });
  const bad = await checkPullRequest({ repo, files: [`roster/${ID}/entry.json`, 'ring.mjs'], author: 'Test-User', out: join(base, 'pr-out-bad'), log: quiet });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.reports, []);
  assert.match(readFileSync(join(bad.out, 'summary.md'), 'utf8'), /Запрос не принят к проверке/);
  const good = await checkPullRequest({ repo, files: [`roster/${ID}/entry.json`, `roster/${ID}/fighter/brain.js`], author: 'Test-User', out: join(base, 'pr-out'), league: false, sheet: false, log: quiet });
  assert.equal(good.reports.length, 1);
  assert.equal(good.reports[0].id, r.id);
  assert.match(readFileSync(join(good.out, 'summary.md'), 'utf8'), /## Квалификация бойца «Пробный Штурман»/);
});

test('данные игры: боец общего набора с автором, моделью и агентом; пустой набор ничего не меняет', () => {
  const r = record('game');
  const data = gameData({ live: false, roster: join(r.dir, '..') });
  const f = data.fighters.find((x) => x.cid === ID);
  assert.ok(f, 'боец набора в данных игры');
  assert.deepEqual({ id: f.id, roster: f.roster, model: f.model, author: f.author, authorGithub: f.authorGithub, agent: f.agent, effort: f.effort, name: f.name }, { id: `c/${ID}`, roster: true, model: 'GPT-6.2 Sol', author: 'Тест Тестов', authorGithub: 'Test-User', agent: 'codex', effort: 'high', name: 'Пробный Штурман' });
  assert.equal(f.versions.length, 1);
  assert.equal(f.versions[0].url, `/roster/${ID}/fighter/`);
  assert.ok(!f.training, 'боец набора стоит среди бойцов, а не среди спарринг-партнёров');
  assert.ok(!JSON.stringify(data).includes(base), 'путей диска в данных игры нет');
  const empty = gameData({ live: false, roster: join(base, 'no-such-roster') });
  assert.deepEqual(empty.fighters.map((x) => x.id), data.fighters.filter((x) => x.cid !== ID).map((x) => x.id));
  assert.ok(empty.fighters.some((x) => x.cid === 'astra50') && empty.fighters.some((x) => x.training));
});

test('лига по парам: сыгранная пара второй раз берётся из запаса, новый боец добавляет только свои пары', { timeout: 300000 }, async () => {
  const sp = (n) => ({ id: n, kind: n === 'skala' ? 'ref' : 'probe', dir: join(root, 'kit', 'arena', 'sparring', n) });
  const store = join(base, 'pairs-2');
  const first = await pairLeague([sp('skala'), sp('dummy')], { draws: 1, jobs: JOBS, cache: store, log: quiet });
  assert.deepEqual([first.played, first.cached, first.errors.length], [10, 0, 0]);
  const second = await pairLeague([sp('dummy'), sp('skala'), sp('krug')], { draws: 1, jobs: JOBS, cache: store, log: quiet });
  assert.deepEqual([second.played, second.cached], [20, 10]);
  const key = (f) => `${f.left}|${f.right}|${f.cluster}|${f.winner}|${f.hash}`;
  const again = second.fights.filter((f) => [f.left, f.right].sort().join() === 'dummy,skala');
  assert.deepEqual(again.map(key).sort(), first.fights.map(key).sort(), 'из запаса пришли те же бои');
  const table = leagueTable([sp('skala'), sp('dummy'), sp('krug')], second.fights, { boot: 50 });
  assert.equal(table.find((e) => e.id === 'skala').rating, 1000, 'эталон держит шкалу');
  assert.ok(table.find((e) => e.id === 'dummy').rating < 1000);
});

test('кубок: сетка по посеву, сезон в формате publish, раунды переигрываются с тем же хэшем', { timeout: 600000 }, async () => {
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  // the roster's fighter here is another fighter of the season under the trial name: two copies of one brain
  // mirror each other into draws, and a match of draws is decided by the seeding, not by a fight
  const r = record('cup', null, 'astra50/v5');
  const seasons = join(base, 'seasons');
  // three fighters: the top seed waits in the final; one of them comes from the roster
  const { game, champion } = await runCup('test-cup', { ids: ['sol50', 'carbon50', ID], title: 'Пробный кубок', ratings: { carbon50: 1700, sol50: 1600, [ID]: 1500 }, roster: join(r.dir, '..'), seasons, log: quiet });
  assert.deepEqual(JSON.parse(readFileSync(join(seasons, 'test-cup', 'game.json'), 'utf8')), JSON.parse(JSON.stringify(game)));
  assert.equal(game.season.title, 'Пробный кубок');
  assert.equal(game.season.cup, true);
  assert.deepEqual(game.season.seeds.map((s) => s.cid), ['carbon50', 'sol50', ID]);
  assert.deepEqual(game.matches.map((m) => m.id), ['test-cup-final', 'test-cup-semi-2']);
  const semi = game.matches[1];
  assert.deepEqual([semi.red, semi.blue], ['sol50', ID], 'второй и третий номера посева играют полуфинал');
  const final = game.matches[0];
  assert.equal(final.red, 'carbon50');
  assert.equal(final.blue, semi.winner);
  assert.equal(champion, final.winner);
  for (const m of game.matches) {
    assert.ok(m.over && m.winner && m.firstTo === 2);
    assert.equal(Math.max(...Object.values(m.score)), 2, 'матч до двух побед');
    assert.deepEqual([m.rounds[0].left, m.rounds[1].left], [m.red, m.blue], 'стороны меняются');
    assert.notEqual(m.rounds[0].stage, m.rounds[1].stage, 'сцена меняется');
    assert.equal(m.rounds.at(-1).final, true);
    assert.ok(m.stats.rounds.length === m.rounds.length && m.roundStats[1].hp.length > 0);
  }
  // fighters: a season fighter is pointed at where it lies, a roster fighter is frozen into the cup with its author
  const byCid = Object.fromEntries(game.fighters.map((f) => [f.cid, f]));
  assert.equal(byCid.sol50.versions[0].url, '/seasons/2026-11-gpt-6-2/fighters/sol50/v1/');
  assert.equal(byCid.carbon50.versions[0].v, 3);
  assert.equal(byCid[ID].versions[0].url, `/seasons/test-cup/fighters/${ID}/v1/`);
  assert.equal(byCid[ID].author, 'Тест Тестов');
  assert.ok(existsSync(join(seasons, 'test-cup', 'fighters', ID, 'v1', 'brain.js')));
  assert.ok(!existsSync(join(seasons, 'test-cup', 'fighters', 'sol50')));
  const mine = byCid[ID].versions[0].rounds;
  assert.equal(mine.length, game.matches.flatMap((m) => m.rounds).filter((x) => x.left === ID || x.right === ID).length, 'у версии записан каждый её раунд');
  assert.ok(mine.filter((x) => x.match === 'test-cup-semi-2').length >= 2 && mine.every((x) => x.num >= 1 && typeof x.rerun === 'boolean'));
  // every round replays to the hash the cup wrote down, as tests/season.test.mjs asks of a season
  const local = (url) => (url.startsWith('/seasons/test-cup/') ? join(seasons, ...url.split('/').filter(Boolean).slice(1)) : join(root, ...url.split('/').filter(Boolean)));
  let seen = 0;
  for (const m of game.matches) for (const round of m.rounds) {
    const replay = JSON.parse(readFileSync(local(round.replay), 'utf8'));
    const fighters = [];
    for (const d of round.dirs) fighters.push((await loadFighter(local(d))).fighter);
    const fight = replayFight(fighters, replay);
    assert.equal(E.fightHash(fight), replay.hash, `${m.id} раунд ${round.n}`);
    assert.deepEqual(fight.f.map((x) => Math.max(0, Math.round(x.hp))), round.hp);
    seen++;
  }
  assert.ok(seen >= 4);
  assert.ok(!JSON.stringify(game).includes(base), 'путей диска в сезоне нет');
  await assert.rejects(() => runCup('2026-11-gpt-6-2', { ids: ['sol50', 'carbon50'], order: true, log: quiet }), /это не кубок/);
});

test('заголовки сайта: правило страницы и второе правило потока мозгов складываются', () => {
  const dir = join(base, 'headers');
  mkdirSync(join(dir, 'play'), { recursive: true });
  writeFileSync(join(dir, 'play', 'index.html'), '<script type="importmap">{ "imports": {} }</script><script type="module" src="game/game.js"></script>');
  const text = siteHeaders(dir);
  const rules = parseHeaders(text);
  const page = headersFor(rules, '/play/index.html')['Content-Security-Policy'];
  assert.match(page, /connect-src 'self' data: blob:;/);
  assert.match(page, /script-src 'self' 'unsafe-eval' 'sha256-[A-Za-z0-9+/]{43}=';/, 'встроенный скрипт разрешён по хэшу, а не весь разом');
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(page) && !/script-src[^;]*https?:/.test(page));
  assert.equal(page, sitePolicy([page.match(/'(sha256-[^']+)'/)[1]]));
  assert.equal(headersFor(rules, '/play/brain-worker.js')['Content-Security-Policy'], `${page}, ${WORKER_POLICY}`, 'как у Cloudflare Pages: через запятую, браузер применяет обе');
  assert.match(WORKER_POLICY, /connect-src 'none'/);
  assert.ok(!WORKER_POLICY.includes('unsafe-eval'));
});

// A page that runs the game's own brain host against brains that misbehave, served with the site's headers.
test('в браузере: поток мозгов не достаёт до чужого адреса и до кода из строки, а зависшие, медленные и шумные мозги отключаются', { timeout: 180000 }, async () => {
  let hits = 0;
  const other = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'access-control-allow-origin': '*' }).end('ok');
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const outside = `http://127.0.0.1:${other.address().port}/leak`;
  const site = (name, headers) => {
    const dir = join(base, name);
    mkdirSync(join(dir, 'play'), { recursive: true });
    for (const f of ['brain-host.js', 'brain-worker.js']) cpSync(join(root, 'viewer', f), join(dir, 'play', f));
    const brain = (n, src) => {
      mkdirSync(join(dir, 'b', n), { recursive: true });
      writeFileSync(join(dir, 'b', n, 'brain.js'), src);
    };
    // reaches out the way a brain that got past the reading would
    brain('net', `let net = 'ждёт'; fetch('${outside}').then(() => { net = 'ушёл'; }, () => { net = 'закрыт'; });
      let code = 'закрыт'; try { code = [].constructor.constructor('return "выполнен"')(); } catch {}
      let sub = 'закрыт'; try { new Worker('${outside}'); sub = 'создан'; } catch {}
      export default { tick() { return { net, code, sub }; } };`);
    brain('hang', 'export default { tick() { for (;;) {} } };');
    brain('slow', 'export default { tick() { const t = performance.now(); while (performance.now() - t < 1500) {} return { ok: 1 }; } };');
    brain('noise', 'export default { tick() { for (let i = 0; i < 400; i++) postMessage({ id: -1 }); return { ok: 1 }; } };');
    brain('long', "export default { tick() { return { text: 'я'.repeat(100000) }; } };");
    writeFileSync(join(dir, 'play', 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="run.js"></script>');
    writeFileSync(join(dir, 'play', 'run.js'), `import { BrainHost } from './brain-host.js';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const run = async (n, ticks, gap = 0) => {
        const h = new BrainHost(new URL('../b/' + n + '/', import.meta.url).href + 'brain.js', n);
        await h.load();
        let last = null;
        for (let i = 0; i < ticks && !h.stats.cut; i++) { last = await h.tick({ tick: i }); if (gap) await sleep(gap); }
        h.dispose();
        return { last, cut: h.stats.cut, why: h.stats.lastError, calls: h.stats.calls };
      };
      window.result = (async () => ({ net: await run('net', 8, 150), hang: await run('hang', 3), slow: await run('slow', 200), noise: await run('noise', 50), long: await run('long', 2) }))();`);
    if (headers) writeFileSync(join(dir, '_headers'), siteHeaders(dir));
    return dir;
  };
  const browser = await launch({ width: 800, height: 600 });
  const play = async (dir) => {
    const server = await serveSite(dir);
    try {
      const page = await browser.open(`${server.url}/play/`);
      return await page.evaluate('window.result', { timeout: 120000 });
    } finally {
      await server.close();
    }
  };
  try {
    const guarded = await play(site('csp', true));
    assert.deepEqual(guarded.net.last, { net: 'закрыт', code: 'закрыт', sub: 'закрыт' });
    assert.equal(hits, 0, 'до чужого адреса не дошёл ни один запрос');
    assert.equal(guarded.hang.cut, true);
    assert.match(guarded.hang.why, /не отвечали 3 с/);
    assert.equal(guarded.slow.cut, true);
    assert.match(guarded.slow.why, /слишком медленно/);
    assert.ok(guarded.slow.calls < 60, `медленные мозги отключены за ${guarded.slow.calls} ходов`);
    assert.equal(guarded.noise.cut, true);
    assert.match(guarded.noise.why, /шлют сообщения/);
    assert.deepEqual([guarded.long.last, guarded.long.cut], [null, false], 'слишком длинный ответ не передаётся странице');
    // the same page without the headers: the brain does reach out — so the first half proves the headers work
    const open = await play(site('open', false));
    assert.deepEqual(open.net.last, { net: 'ушёл', code: 'выполнен', sub: 'закрыт' });
    assert.ok(hits >= 1);
  } finally {
    await browser.close();
    await new Promise((r) => other.close(r));
  }
});
