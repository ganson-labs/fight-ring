#!/usr/bin/env node
// Ring judge: contestants, their clean launch, matches and the locker room between rounds. Run from the ring folder.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContestant, registry, getContestant, writeLaunchScript, launchCommand, prepareCodexHome, prepareGeminiHome, setClaudeAccount, audit, RING } from './judge/contestants.js';
import { newMatch, loadMatch, runRound, writeLocker, sidesFor, matchDir, roundInfo, changes, collectNotes } from './judge/match.js';
import { renderRound } from './judge/render.js';
import { readFighterDir } from './kit/arena/tools/load.js';

const HELP = `Ринг моделей — судья. Запуск из папки ринга: node ring.mjs <команда>

Участники
  new <id> --agent claude|codex|gemini --model "Название для экрана" [--agent-model id] [--effort high] [--color #hex] [--root путь]
                                    папка участника вне ринга (по умолчанию contestRoot из ring.config.json) и скрипт запуска launch/<id>.ps1
  list                              участники, их корни и как запускать
  launch-script <id>                пересоздать launch/<id>.ps1
  claude-account <id> <имя>|--off  бой Claude-участника на другой подписке: токен claude setup-token в ~/.config/fight-ring/claude-<имя>.token
  codex-home <id> [--back]          чистый профиль Codex участника (вызывается из launch/<id>.ps1)
  audit <id>                        журналы агента: обращался ли он к папке ринга или другого участника
  run <id> --prompt prompts/fighter.md [--minutes 90] [--resume] [--vars N=1,M=20] [--label build]
                                    без человека: промпт слово в слово через launch/<id>.ps1, лимит времени, журнал
                                    в ledger/runs/, учёт в ledger/runs.json; --resume — продолжить прошлую сессию

Матч
  match new <match> --red <id> --blue <id> [--stage rooftop[,server,...]] [--minutes 20] [--first-to 2]
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
                                    шпаргалка для озвучки notes-for-pasha.md и папка для монтажа (reel/: pieces, moments.json, moments.md);
                                    --comment — со звуком озвучки раундов; --no-model — подписи и шпаргалка словами судьи;
                                    --studio — ещё и новым роликом «гансон: Студии» с этими материалами (проект ring, создаётся сам)
  match ghost <match> --round N --cid <id> [--tick T | --moment super|last|combo|new] [--seconds 4]
                                    призрак: кусок раунда N, поверх — версия бойца до раздевалки полупрозрачно в холодном цвете,
                                    от состояния того тика её мозги играют дальше против того же соперника; 16:9 и 9:16
  match pack <match> [--studio <id ролика>] [--no-render]
                                    пакет для монтажа в matches/<match>/pack/: раунды 1080p60 чистые и с подписями, экраны VS,
                                    итогов, раздевалок и финала, фигуры бойцов PNG каждой версии, листы поз и частей, правки
                                    и слова моделей, цифры CSV, мысли бойцов (SRT); --studio — материалами в ролик Студии
  match locker <match> [--round N]  раздевалка раунда заново из его папки (её делает пульт турнира после ролика)`;

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
  if (cmd === 'new') {
    const id = sub;
    const r = createContestant(id, { model: o.model, agent: o.agent, color: o.color, root: o.root, agentModel: o['agent-model'], effort: o.effort });
    console.log(`Готово: участник «${id}» в ${r.root}`);
    console.log(`Запуск агента с чистого листа: powershell -ExecutionPolicy Bypass -File ${r.script}`);
    return;
  }
  if (cmd === 'list') {
    for (const [id, c] of Object.entries(registry())) {
      const cmdl = launchCommand(id);
      const res = readFighterDir(join(c.root, 'fighter'));
      console.log(`${id}: ${c.model} (${c.agent}${c.agentModel ? `, ${c.agentModel}` : ''}) — ${c.root}; боец ${res.ok ? `«${res.fighter.card.name}» проходит проверку` : 'не проходит проверку'}`);
      console.log(`   ${Object.entries(cmdl.env).map(([k, v]) => `$env:${k}='${v}'; `).join('')}cd '${cmdl.root}'; ${cmdl.exe} ${cmdl.args.join(' ')}`);
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
    const r = await runAgent(sub, { prompt: resolve(o.prompt), vars, minutes: Number(o.minutes || 90), label: typeof o.label === 'string' ? o.label : o.resume ? 'locker' : 'build', resume: o.resume || false });
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
  if (cmd === 'match') {
    if (sub === 'new') {
      const stage = typeof o.stage === 'string' ? o.stage.split(',') : ['rooftop'];
      for (const s of stage) if (!existsSync(join(RING, 'stages', s, 'stage.json'))) throw new Error(`нет сцены stages/${s}`);
      const m = newMatch(arg, { red: o.red, blue: o.blue, stage, minutes: Number(o.minutes || 20), firstTo: Number(o['first-to'] || 2) });
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
      return console.log(`Готово: ${r.dir}${r.studio ? `; в Студии ролик ${r.studio.video}: ${r.studio.added} материалов` : ''}`);
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
