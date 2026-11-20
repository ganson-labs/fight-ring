#!/usr/bin/env node
// Ring judge: contestants, their clean launch, matches and the locker room between rounds. Run from the ring folder.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContestant, registry, getContestant, writeLaunchScript, launchCommand, prepareCodexHome, prepareGeminiHome, setClaudeAccount, audit, RING } from './judge/contestants.js';
import { newMatch, loadMatch, runRound, writeLocker, sidesFor, matchDir, roundInfo, changes, collectNotes } from './judge/match.js';
import { renderRound } from './judge/render.js';
import { readFighterDir } from './kit/arena/tools/load.js';

const HELP = `Ринг моделей — судья. Запуск из папки ринга: node ring.mjs <команда>

Участники
  new <id> --agent claude|codex|gemini --model "Название для экрана" [--agent-model id] [--effort high] [--color #hex] [--root путь]
                                    папка участника вне ринга (--root, иначе contestRoot из ring.config.json, иначе ~/ring-contest/<id>,
                                    в Windows C:/ring-contest-<id>) и скрипт запуска launch/<id>.sh (в Windows launch/<id>.ps1)
  list                              участники, их корни и как запускать
  launch-script <id>                пересоздать скрипт запуска участника
  claude-account <id> <имя>|--off  бой Claude-участника на другой подписке: токен claude setup-token в ~/.config/fight-ring/claude-<имя>.token
  codex-home <id> [--back]          чистый профиль Codex участника (вызывается из скрипта запуска)
  audit <id>                        журналы агента: обращался ли он к папке ринга или другого участника
  run <id> --prompt prompts/fighter.md [--minutes 90] [--resume] [--vars N=1,M=20] [--label build]
                                    без человека: промпт слово в слово через скрипт запуска, лимит времени, журнал
                                    в ledger/runs/, учёт в ledger/runs.json; --resume — продолжить прошлую сессию

Сезон и сайт
  publish <сезон> --matches a,b,c [--title "…"]   законченный турнир в репозиторий: seasons/<сезон>/ (бойцы по версиям, записи раундов)
  site [папка] [--no-pages] [--no-rating] [--kept-rating]
                                    сайт обычными файлами (по умолчанию dist/): страницы (site/, Astro) в корне, игра в play/,
                                    рядом набор, сцены, сезоны и общий набор; перед сборкой считается общий рейтинг;
                                    --no-pages — одна игра, без npm; --no-rating — без подсчёта рейтинга;
                                    --kept-rating — с таблицей из out/rating.json, как она лежит, без боёв

Общий набор и кубок
  submit <папка бойца> --model "Название модели" --agent claude|codex|gemini|… [--effort high] [--name "Имя автора"] [--login логин] [--dry]
  submit <id участника> [--name "Имя автора"] [--login логин] [--dry]
                                    отправить бойца в общий набор: запись в out/submit/<id>/, квалификация, запрос на слияние
                                    через gh; у участника этого ринга модель и агент берутся из реестра;
                                    --dry — всё до первого обращения к сети (с ним логин берётся из --login)
  qualify <roster/<id>> [--out папка] [--no-league] [--no-sheet]
                                    квалификация бойца общего набора: заявка, состав папки, правила, полнота, код, сила →
                                    out/qualify/<id>/ (qualify.json, report.md, sheet.png)
  roster-pr --repo <папка запроса> --files <список изменённых файлов> --author <логин> [--trusted] [--out папка]
                                    робот запроса на слияние: что запрос меняет, чей боец, и квалификация
                                    (вместо --files: --base <коммит> --head <коммит>, список берётся из git)
  rating [--draws 8]                общий рейтинг: бойцы сезонов, общего набора и эталоны → out/rating.json
  cup <сезон> --ids a,b,c,… [--title "…"] [--order]
                                    кубок на вылет между готовыми бойцами (общий набор и сезоны), без агентов и раздевалок:
                                    посев по рейтингу (--order — в порядке списка), матч до двух побед → seasons/<сезон>/

Матч
  league run <name> --ids a,b,c [--seeds 3] [--jobs N]   все со всеми: 5 стартов × 2 стороны × зёрна, таблица, рейтинг, тиры → leagues/<name>/
  league show <name> | league list   (лига 2.x)
  bench run <name> --ids a,b,ref:shkval,dir:<папка> [--draws 8] [--jobs N]
                                    лига 3.0: 5 стартов × розыгрыши шума × 2 стороны, рейтинг БТ с эталонами, бутстрэп,
                                    паспорт зрелищности → leagues/<name>/
  bench show <name> | bench invariants <name> [--every N] | bench ablate <name> [--draws 1]
  voices [--sweep] [--dry]          голоса «Ринг · <id> · …» на аккаунте озвучки: какие можно освободить (--sweep — удалить);
                                    другие голоса не трогаются. Судья сам освобождает голос после каждого запуска агента
  match new <match> --red <id> --blue <id> [--stage rooftop[,server,...]] [--minutes 20] [--first-to 2] [--starts draw|centre,far,…]
  match round <match> [--no-render] [--vertical] [--ads]
                                    следующий раунд: снимок бойцов, бой, запись, ролики, раздевалка участникам
  match render <match> --round N [--vertical] [--ads] [--no-intro]
  match status <match>
  match changes <match> <id>        что участник поменял в бойце между раундами (по снимкам судьи)
  match notes <match>               собрать заново ответы моделей из раздевалки (из журналов агентов) в материалы матча
  match stats <match>               статистика раундов и раздевалок (stats.json): здоровье по времени, счётчики, моменты
  match protocol <match>            протокол: версия ринга, модели, агенты, время и расход сборки и раздевалок, проверка переигровки
  match verify <match>              переиграть каждый раунд на снимке движка этого раунда и сравнить с записью
  match comment <match> [--round N] [--budget 30] [--model claude-opus-5-5] [--no-voice]
                                    озвучка (по умолчанию её нет): реплики только в паузах раунда → fight-16x9-comment.mp4,
                                    первая дорожка без неё, вторая с ней; в ролик матча — reel --comment
  match reel <match> [--shorts 3] [--no-captions] [--comment] [--model claude-opus-5-5 | --no-model] [--studio [проект]]
                                    ролик матча 16:9 с подписями ключевых моментов (без них — match-16x9-clean.mp4), шортсы 9:16,
                                    шпаргалка для озвучки notes-for-voice.md и папка для монтажа (reel/: pieces, moments.json, moments.md);
                                    --comment — со звуком озвучки раундов; --no-model — подписи и шпаргалка словами судьи;
                                    --studio — ещё и новым роликом в программе монтажа автора (vagent, в репозиторий не входит)
  match ghost <match> --round N --cid <id> [--tick T | --moment super|last|combo|new] [--seconds 4]
                                    призрак: кусок раунда N, поверх — версия бойца до раздевалки полупрозрачно в холодном цвете,
                                    от состояния того тика её мозги играют дальше против того же соперника; 16:9 и 9:16
  match pack <match> [--studio <id ролика>] [--no-render]
                                    пакет для монтажа в matches/<match>/pack/: раунды 1080p60 чистые и с подписями, экраны VS,
                                    итогов, раздевалок и финала, фигуры бойцов PNG каждой версии, листы поз и частей, правки
                                    и слова моделей, цифры CSV, мысли бойцов (SRT); --studio — материалами в ролик программы монтажа автора
  match locker <match> [--round N]  раздевалка раунда заново из его папки (её делает пульт турнира после ролика)`;

const NO_EVAL = '--disallow-code-generation-from-strings';
const FOREIGN = ['submit', 'qualify', 'roster-pr', 'rating', 'cup', 'site'];

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
      o[k] = v;
    } else o._.push(a);
  }
  return o;
}

function printStatus(m) {
  console.log(`Матч ${m.id}: ${m.red} (красный угол) против ${m.blue} (синий), до ${m.firstTo} побед. Счёт ${m.score[m.red]} : ${m.score[m.blue]}${m.over ? ` — окончен, ${m.winner ? `победил ${m.winner}` : 'ничья'}` : ''}`);
  for (const r of m.rounds) console.log(`  раунд ${r.n}: слева ${r.left}, справа ${r.right}, сцена ${r.stage} — ${r.winner ? `победа ${r.winner}` : 'ничья'} (${r.reason === 'ko' ? 'нокаут' : 'время'}, ${(r.ticks / 60).toFixed(1)} с)`);
  if (!m.over) {
    const n = m.rounds.length + 1;
    const [l, r] = sidesFor(m, n);
    console.log(`  дальше раунд ${n}: слева ${l}, справа ${r}`);
  }
  console.log(`  папка: ${matchDir(m.id)}`);
}

async function main() {
  const o = parse(process.argv.slice(2));
  const [cmd, sub, arg] = o._;
  if (!cmd || cmd === 'help' || o.help) return console.log(HELP);
  // These commands run brains written by strangers. The process is started again with code from strings switched
  // off: a brain that reaches Function through a property name put together on the run gets an error, not a function.
  if (FOREIGN.includes(cmd) && !process.execArgv.includes(NO_EVAL)) {
    const r = spawnSync(process.execPath, [NO_EVAL, ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (cmd === 'new') {
    const id = sub;
    const r = createContestant(id, { model: o.model, agent: o.agent, color: o.color, root: o.root, agentModel: o['agent-model'], effort: o.effort });
    console.log(`Готово: участник «${id}» в ${r.root}`);
    console.log(`Запуск агента с чистого листа: ${process.platform === 'win32' ? 'powershell -ExecutionPolicy Bypass -File' : 'bash'} ${r.script}`);
    return;
  }
  if (cmd === 'list') {
    for (const [id, c] of Object.entries(registry())) {
      const cmdl = launchCommand(id);
      const res = readFighterDir(join(c.root, 'fighter'));
      console.log(`${id}: ${c.model} (${c.agent}${c.agentModel ? `, ${c.agentModel}` : ''}) — ${c.root}; боец ${res.ok ? `«${res.fighter.card.name}» проходит проверку` : 'не проходит проверку'}`);
      const env = Object.entries(cmdl.env);
      if (process.platform === 'win32') console.log(`   ${env.map(([k, v]) => `$env:${k}='${v}'; `).join('')}cd '${cmdl.root}'; ${cmdl.exe} ${cmdl.args.join(' ')}`);
      else console.log(`   cd '${cmdl.root}'; ${env.map(([k, v]) => `${k}='${v}' `).join('')}${cmdl.exe} ${cmdl.args.join(' ')}`);
    }
    return;
  }
  if (cmd === 'launch-script') return console.log(writeLaunchScript(sub));
  if (cmd === 'claude-account') {
    const file = setClaudeAccount(sub, o.off ? null : arg);
    console.log(o.off ? `«${sub}» снова на подписке оператора: ${file}` : `«${sub}» дерётся на подписке «${arg}»: ${file}`);
    return;
  }
  if (cmd === 'codex-home') {
    const r = prepareCodexHome(sub, { back: !!o.back });
    if (o.back) console.log(r.synced ? 'Вход Codex обновлён в основном профиле.' : '');
    return;
  }
  if (cmd === 'gemini-home') return void prepareGeminiHome(sub);
  if (cmd === 'run') {
    const { runAgent } = await import('./judge/run.js');
    if (typeof o.prompt !== 'string') throw new Error('нужен --prompt prompts/<файл>.md');
    const vars = Object.fromEntries(String(o.vars || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
    const r = await runAgent(sub, { prompt: resolve(o.prompt), vars, minutes: Number(o.minutes || 90), label: typeof o.label === 'string' ? o.label : o.resume ? 'locker' : 'build', resume: o.resume || false, ...(o.stall !== undefined ? { stall: Number(o.stall) } : {}) });
    if (r.exit && !r.timedOut) process.exitCode = 1;
    return;
  }
  if (cmd === 'audit') {
    const r = audit(sub);
    console.log(`Журналы «${sub}»: ${r.files.length} файл(ов).`);
    if (!r.files.length) return console.log('Журналов нет: агент ещё не запускался или журналы удалены.');
    if (!r.hits.length) return console.log('✓ Ни одного обращения к папке ринга, корзине, папке другого участника и к ~/.agents, ~/.claude, ~/.codex, ~/.gemini оператора.');
    console.log(`✗ Найдено упоминаний: ${r.hits.length}`);
    for (const h of r.hits.slice(0, 40)) console.log(`  ${h.what}: ${h.file}:${h.line}\n    …${h.text.replace(/\s+/g, ' ')}…`);
    process.exitCode = 1;
    return;
  }
  if (cmd === 'league') {
    const L = await import('./judge/league.js');
    if (sub === 'run') {
      const ids = String(o.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
      const league = await L.runLeague(arg, { ids, seeds: Number(o.seeds || 3), ...(o.jobs ? { jobs: Number(o.jobs) } : {}) });
      console.log(`\nГотово: leagues/${arg}/README.md (${league.fights.length} боёв${league.errors.length ? `, ошибок ${league.errors.length}` : ''})`);
      return;
    }
    if (sub === 'show') return void console.log(L.leagueMarkdown(L.loadLeague(arg)));
    if (sub === 'list') return void console.log(L.listLeagues().join('\n') || 'лиг нет');
    throw new Error('league run <имя> --ids a,b,c [--seeds 3] [--jobs N] | league show <имя> | league list');
  }
  if (cmd === 'voices') {
    const V = await import('./judge/voices.js');
    const { runs } = await import('./judge/run.js');
    const active = V.activeContestants(runs());
    const s = await V.sweepVoices({ active, dry: !o.sweep || !!o.dry });
    console.log(`Голоса на аккаунте озвучки: занято ${s.used} из ${s.limit}.`);
    console.log(`Голоса участников ринга ${o.sweep && !o.dry ? 'удалены' : 'к удалению (--sweep удалит)'}: ${s.deleted.length ? s.deleted.join('; ') : 'нет'}`);
    if (s.kept.length) console.log(`Оставлены (участник работает сейчас): ${s.kept.join('; ')}`);
    return;
  }
  if (cmd === 'bench') {
    const B = await import('./judge/bench.js');
    if (sub === 'run') {
      const specs = String(o.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
      const league = await B.runBench(arg, { specs, draws: Number(o.draws || 8), ...(o.jobs ? { jobs: Number(o.jobs) } : {}) });
      console.log(`\nГотово: leagues/${arg}/README.md (${league.fights.length} боёв${league.errors.length ? `, ошибок ${league.errors.length}` : ''}, ${league.seconds} с). Паспорт ${league.passport.pass ? 'пройден' : 'не пройден'}.`);
      return;
    }
    if (sub === 'show') return void console.log(B.benchMarkdown(B.loadBench(arg)));
    if (sub === 'invariants') {
      const r = await B.verifyInvariants(arg, { every: Number(o.every || 1) });
      console.log(`Инварианты правил на ${r.fights} записях лиги «${arg}»: ${r.ok ? 'все соблюдены' : 'НАРУШЕНЫ'}`);
      for (const [k, v] of Object.entries(r.bad)) console.log(`  ${k}: ${v.length ? `${v.length} — ${v.slice(0, 3).join('; ')}` : 'ок'}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (sub === 'ablate') {
      const r = await B.ablateMoves(arg, { draws: Number(o.draws || 1), ...(o.jobs ? { jobs: Number(o.jobs) } : {}) });
      for (const x of r.rows) console.log(`  ${x.flagged ? '!' : ' '} ${x.id} без ${x.move} (${x.slot}): ${Math.round(x.base * 100)} % → ${Math.round(x.off * 100)} %`);
      console.log(`Отмечено: ${r.rows.filter((x) => x.flagged).length} из ${r.rows.length}; leagues/${arg}/ablation.json`);
      return;
    }
    throw new Error('bench run <имя> --ids a,b,ref:shkval,dir:<папка> [--draws 8] [--jobs N] | bench show <имя> | bench invariants <имя> [--every N] | bench ablate <имя> [--draws 1]');
  }
  if (cmd === 'submit') {
    if (!sub) throw new Error('node ring.mjs submit <папка бойца> --model "…" --agent claude|codex|gemini|… [--effort …] [--name "…"] [--login …] [--dry]');
    const str = (v) => (typeof v === 'string' ? v : null);
    // a contestant of this ring by its id: the fighter is in its folder, the model and the agent are in the registry
    const own = !existsSync(resolve(sub)) ? registry()[sub] : null;
    const r = await (await import('./judge/submit.js')).submit(own ? join(own.root, 'fighter') : sub, { model: str(o.model) || own?.model || null, agent: str(o.agent) || own?.agent || null, effort: str(o.effort) || own?.effort || null, name: str(o.name), login: str(o.login), dry: !!o.dry, league: !o['no-league'], sheet: !o['no-sheet'], ...(str(o.repo) ? { repo: o.repo } : {}) });
    if (!r.qualified && !o['no-league']) process.exitCode = 1;
    return;
  }
  if (cmd === 'qualify') {
    if (!sub) throw new Error('node ring.mjs qualify roster/<id> [--out папка] [--no-league] [--no-sheet]');
    const r = await (await import('./judge/qualify.js')).qualify(sub, { out: typeof o.out === 'string' ? o.out : null, league: !o['no-league'], sheet: !o['no-sheet'], ...(o.draws ? { draws: Number(o.draws) } : {}), ...(o.jobs ? { jobs: Number(o.jobs) } : {}) });
    if (!r.passed) process.exitCode = 1;
    return;
  }
  if (cmd === 'roster-pr') {
    const files = typeof o.files === 'string' ? readFileSync(o.files, 'utf8').split(/\r?\n/).filter(Boolean) : null;
    const r = await (await import('./judge/robot.js')).checkPullRequest({ repo: o.repo, base: o.base, head: o.head, files, author: o.author, trusted: !!o.trusted, out: typeof o.out === 'string' ? o.out : null });
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'rating') {
    await (await import('./judge/rating.js')).commonRating({ ...(o.draws ? { draws: Number(o.draws) } : {}), ...(o.jobs ? { jobs: Number(o.jobs) } : {}) });
    return;
  }
  if (cmd === 'cup') {
    if (!sub || typeof o.ids !== 'string') throw new Error('node ring.mjs cup <сезон> --ids a,b,c,… [--title "…"] [--order]');
    await (await import('./judge/cup.js')).runCup(sub, { ids: o.ids.split(',').map((x) => x.trim()).filter(Boolean), title: typeof o.title === 'string' ? o.title : null, order: !!o.order, ...(o.jobs ? { jobs: Number(o.jobs) } : {}) });
    return;
  }
  if (cmd === 'publish') {
    if (!sub || !o.matches) throw new Error('node ring.mjs publish <сезон> --matches a,b,c [--title "…"]');
    const { publishSeason } = await import('./judge/publish.js');
    return void publishSeason(sub, { matches: String(o.matches).split(','), title: o.title || null });
  }
  if (cmd === 'site') {
    const { buildSite } = await import('./judge/site.js');
    return void (await buildSite(resolve(sub || 'dist'), { pages: !process.argv.includes('--no-pages'), rating: process.argv.includes('--kept-rating') ? 'kept' : !process.argv.includes('--no-rating') }));
  }
  if (cmd === 'match') {
    if (sub === 'new') {
      const stage = typeof o.stage === 'string' ? o.stage.split(',') : ['rooftop'];
      for (const s of stage) if (!existsSync(join(RING, 'stages', s, 'stage.json'))) throw new Error(`нет сцены stages/${s}`);
      const m = newMatch(arg, { red: o.red, blue: o.blue, stage, minutes: Number(o.minutes || 20), firstTo: Number(o['first-to'] || 2), starts: o.starts === 'draw' ? 'draw' : typeof o.starts === 'string' ? o.starts.split(',') : null });
      return printStatus(m);
    }
    if (sub === 'status') return printStatus(loadMatch(arg));
    if (sub === 'notes') {
      const list = collectNotes(arg);
      if (!list.length) return console.log('Ответов из раздевалки в журналах агентов не нашлось.');
      for (const x of list) console.log(`раунд ${x.round}, ${x.cid}: ответ раздевалки, ${x.chars} знаков`);
      return;
    }
    if (sub === 'changes') {
      const cid = o._[3];
      const list = changes(arg, cid);
      if (!list.length) return console.log(`У «${cid}» пока один раунд в матче: сравнивать не с чем.`);
      for (const c of list) {
        console.log(`Раунд ${c.from} → ${c.to}${c.name[0] !== c.name[1] ? ` (${c.name[0]} → ${c.name[1]})` : ''}:`);
        if (c.stats.length) console.log(`  характеристики: ${c.stats.join(', ')}`);
        for (const mv of c.moves) console.log(`  приём ${mv}`);
        for (const x of c.abilities) console.log(`  способность ${x}`);
        for (const x of c.card) console.log(`  карточка: ${x}`);
        if (c.note) console.log(`  модель после раунда ${c.note.round}: ${c.note.text.replace(/\n/g, '\n    ')}`);
        for (const f of c.changed) console.log(`  изменён ${f.file}: ${f.lines}`);
        for (const f of c.added) console.log(`  новый ${f}`);
        for (const f of c.removed) console.log(`  удалён ${f}`);
        if (!c.stats.length && !c.moves.length && !c.changed.length && !c.added.length && !c.removed.length) console.log('  без изменений');
      }
      return;
    }
    if (sub === 'round') {
      const r = await runRound(arg);
      if (!o['no-render']) {
        await renderRound(arg, r.n, { ads: !!o.ads });
        if (o.vertical) await renderRound(arg, r.n, { vertical: true, ads: !!o.ads });
      }
      const dirs = writeLocker(r.m, r.n, r.roundDir, r.an, r.fighters, r.stats, r.sides);
      console.log(`Раздевалка: ${dirs.join(', ')}`);
      printStatus(r.m);
      if (!r.m.over) console.log(`\nДай обоим участникам промпт раздевалки (prompts/locker.md) на ${r.m.lockerMinutes} минут, затем: node ring.mjs match round ${arg}`);
      return;
    }
    if (sub === 'stats') {
      const st = await (await import('./judge/moments.js')).matchStats(arg);
      for (const r of st.rounds) console.log(`Раунд ${r.n}: ${r.names.join(' — ')}; лучшие моменты: ${r.top.map((x) => x.text).join(' · ')}`);
      for (const l of st.lockers) console.log(`Раздевалка ${l.cid}, ${l.from} → ${l.to}: урон ${l.effect.damage.before} → ${l.effect.damage.after}, ${l.wonBefore ? 'выиграл' : 'проиграл'} → ${l.wonAfter ? 'выиграл' : 'проиграл'}`);
      return console.log(`→ ${join(matchDir(arg), 'stats.json')}`);
    }
    if (sub === 'verify' || sub === 'protocol') {
      const P = await import('./judge/protocol.js');
      const v = await P.verifyMatch(arg);
      for (const x of v) console.log(`Раунд ${x.n}: движок ${x.engine}, запись ${x.recorded}, переигровка ${x.replayed} — ${x.same ? 'совпала' : 'НЕ СОВПАЛА'}`);
      if (sub === 'protocol') {
        P.writeProtocol(arg, v);
        console.log(readFileSync(join(matchDir(arg), 'protocol.md'), 'utf8'));
      }
      if (v.some((x) => !x.same)) process.exitCode = 2;
      return;
    }
    if (sub === 'comment') {
      const C = await import('./judge/commentator.js');
      const list = o.round ? [Number(o.round)] : loadMatch(arg).rounds.map((r) => r.n);
      for (const n of list) await C.commentRound(arg, n, { budget: Number(o.budget || 30), model: o.model || 'claude-opus-5-5', voice: !o['no-voice'] });
      const l = C.commentatorLedger();
      return console.log(`Комментаторы всего: речи ${l.voiceSeconds} с, голосов ${l.voiceDesigns}, вызовов модели ${l.modelCalls}`);
    }
    if (sub === 'locker') {
      const n = Number(o.round || loadMatch(arg).rounds.length);
      const dirs = await (await import('./judge/match.js')).lockerFor(arg, n);
      return console.log(`Раздевалка раунда ${n}: ${dirs.join(', ')}`);
    }
    if (sub === 'ghost') {
      if (!o.round || typeof o.cid !== 'string') throw new Error('match ghost <матч> --round N --cid <участник> [--tick T | --moment super|last|combo|new|juicy] [--seconds 4]');
      const r = await (await import('./judge/ghost.js')).buildGhost(arg, { round: o.round, cid: o.cid, tick: o.tick ?? null, moment: typeof o.moment === 'string' ? o.moment : null, seconds: Number(o.seconds || 4) });
      return console.log(`Готово: ${r.clips.map((x) => x.file).join(', ')}`);
    }
    if (sub === 'pack') {
      const r = await (await import('./judge/pack.js')).buildPack(arg, { studio: typeof o.studio === 'string' ? o.studio : null, render: !o['no-render'] });
      return console.log(`Готово: ${r.dir}${r.studio ? `; в программе монтажа ролик ${r.studio.video}: ${r.studio.added} материалов` : ''}`);
    }
    if (sub === 'reel') {
      const r = await (await import('./judge/reel.js')).buildReel(arg, { studio: o.studio || false, shorts: Number(o.shorts ?? 3), captions: !o['no-captions'], comment: !!o.comment, model: o['no-model'] ? null : typeof o.model === 'string' ? o.model : 'claude-opus-5-5' });
      return console.log(`Готово: ${r.dir}`);
    }
    if (sub === 'render') {
      const n = Number(o.round || loadMatch(arg).rounds.length);
      roundInfo(loadMatch(arg), n);
      return renderRound(arg, n, { vertical: !!o.vertical, ads: !!o.ads, intro: !o['no-intro'] });
    }
  }
  console.log(HELP);
  throw new Error(`нет команды «${o._.join(' ')}»`);
}

main().catch((err) => {
  console.error(`\nОшибка: ${err.message || err}`);
  process.exit(1);
});
void readFileSync;
void getContestant;
