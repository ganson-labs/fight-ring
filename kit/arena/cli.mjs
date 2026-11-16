#!/usr/bin/env node
// Ring workshop. Run from the contestant folder:  node arena/cli.mjs <command> [options]
import { ringVersionText } from './engine/version.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadFighter, resolveFighterDir, runFight, KIT_DIR, ARENA_DIR, BRAIN_TICK_MS } from './tools/load.js';
import { BLOCKS, STAT_POINTS, MOVE_BUDGET, deriveStats, TICK_RATE, ROUND_TICKS, ABILITY_PRIMITIVES, ABILITY_PRICE, MEASURE } from './engine/index.js';

const HELP = `Ринг моделей — мастерская бойца. Запуск из папки участника: node arena/cli.mjs <команда>

  check  [папка]                         проверить бойца (по умолчанию fighter/)
  blocks                                 блоки конструктора, их параметры и стоимость, примитивы способности
  sounds                                 звуки ринга по имени для moves.json → sounds
  spar   [папка] [--vs dummy|<папка бойца>[,<папка>…]] [--side left|right] [--dummy stand|block|crouch|jump|walk|parry|throw] [--seconds <длина раунда>]
                                         бой мозгов бойца с соперником в Node, итог и запись боя
  preview [--move id] [--sheet] [--fight] [--vertical] [--debug] [--dummy block] [--gap 300] [--stage папка]
                                         лист поз PNG и ролики MP4 приёмов в out/preview/
  paint  "<описание>" --out art/x.png [--ref файл]... [--aspect square|portrait|landscape] [--transparent]
                                         картинка генератором ринга (лимит на участника)
  parts  sheet --ref art/лист.png [--parts "часть; часть; …"] [--note "…"] [--aspect square|portrait|landscape] [--out art/parts-sheet.png]
                                         части тела слоями по листу персонажа (одна генерация) и нарезка
  parts  split <картинка> [--out parts/raw]
                                         нарезать картинку с отдельными частями на PNG по одной
  parts  guess <part.png>                подсказать pivot и tip части по её главной оси; у торса и таза
                                         ещё проймы, шею, бёдра и якоря детей
  look   <ролик.mp4> [--fps 4] [--from с] [--to с]
                                         кадры ролика подряд листами JPG, чтобы посмотреть его картинками
  voice  design | listen [N] | pick N | lines [--only id,id] | status
                                         голос по описанию из voice.json, разбор вариантов, запись реплик в fighter/voice/
  limits                                 сколько генераций и секунд голоса осталось`;

function parse(argv) {
  const opts = { _: [], ref: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const flag = next === undefined || next.startsWith('--');
      const v = flag ? true : argv[++i];
      if (k === 'ref') opts.ref.push(v);
      else opts[k] = v;
    } else opts._.push(a);
  }
  return opts;
}

const here = process.cwd();
const rel = (p) => relative(here, p) || '.';

function printCheck(dir, res) {
  console.log(`\nБоец: ${rel(dir)}`);
  if (res.errors.length) {
    console.log(`\n✗ Ошибки (${res.errors.length}):`);
    for (const e of res.errors) console.log(`  - ${e}`);
  }
  if (res.warnings.length) {
    console.log(`\n! Сведения, не ошибки (${res.warnings.length}):`);
    for (const w of res.warnings) console.log(`  - ${w}`);
  }
  if (res.budget) {
    console.log(`\nБюджет приёмов: ${res.budget.used} из ${res.budget.max}`);
    for (const m of res.budget.moves) console.log(`  ${m.id.padEnd(24)} ${m.slot.padEnd(8)} ${String(m.cost).padStart(3)} очк.  ${String(m.duration).padStart(3)} тиков  команда ${res.fighter.movesById[m.id].command}${res.fighter.movesById[m.id].ownCommand ? '' : ' (ринг)'}`);
  }
  if (res.abilities?.length) printAbilities(res.abilities);
  if (res.ok) {
    const f = res.fighter;
    const d = f.derived;
    console.log(`\nХарактеристики: здоровье ${f.stats.health}, сила ${f.stats.power}, скорость ${f.stats.speed}, защита ${f.stats.defense} (из ${STAT_POINTS})`);
    console.log(`  здоровье ${d.maxHp}, урон ×${d.damageMul.toFixed(2)}, шаг ${d.walk.toFixed(1)} ед./тик, рывок ${d.dashDistance}, получаемый урон ×${d.takenMul.toFixed(2)}`);
    console.log(`\n✓ Боец проходит проверку: ${f.card.name}`);
  } else console.log('\n✗ Боец не допускается к бою, пока есть ошибки.');
  console.log(`Версия: ${ringVersionText()}`);
}

const f1 = (v) => (Math.round(v * 10) / 10).toString();

function printAbilities(list) {
  const w = ABILITY_PRICE.weights;
  const cd = ABILITY_PRICE.cooldown;
  const c = ABILITY_PRICE.cost;
  const res = MEASURE.resources.length;
  console.log(`\nСпособности: ринг сам прогнал каждую на манекене (${MEASURE.gaps.join(', ')} ед.; ${MEASURE.modes.join(', ')}; ресурс как в fighter.json и полный; зёрна ${MEASURE.seeds.join(', ')}) и взял лучший замер по каждой мере.`);
  for (const a of list) {
    const m = a.measured;
    const at = (k) => (a.where[k] ? ` (${a.where[k].gap} ед., ${a.where[k].mode})` : '');
    console.log(`\n  ${a.id} — ${a.script}, ${a.runs} прогонов`);
    console.log(`    урон ${f1(m.damage)}${at('damage')}, контроль ${f1(m.control)} тик.${at('control')}, усиление ${f1(m.buff)}, сдвиг ${f1(m.shove)} ед., объекты ${f1(m.objectTicks)} тик.`);
    console.log(`    сила = ${f1(m.damage)}·${w.damage} + ${f1(m.control)}·${w.control} + ${f1(m.buff)}·${w.buff} + ${f1(m.shove)}·${w.shove} + ${f1(m.objectTicks)}·${w.objectTicks} = ${f1(a.power)}`);
    if (a.slot === 'super') console.log(`    суперприём: перезарядки нет (нужна шкала), стоимость ${c.base} + ⌈${f1(a.power)}/${c.perPowerSuper}⌉ = ${a.cost} очк.`);
    else console.log(`    перезарядка ${cd.base} + ${f1(a.power)}·${cd.perPower} = ${a.cooldown} тиков (${(a.cooldown / TICK_RATE).toFixed(1)} с, рамки ${cd.min}…${cd.max}), стоимость ${c.base} + ⌈${f1(a.power)}/${c.perPower}⌉ = ${a.cost} очк.`);
    console.log(`    хуки: ${a.ms.calls} вызовов, в среднем ${a.ms.avg.toFixed(3)} мс, самый долгий ${a.ms.max.toFixed(2)} мс`);
    const cuts = Object.entries(a.cuts);
    if (cuts.length) {
      console.log('    ринг срезал на замере:');
      for (const [msg, n] of cuts) console.log(`      - ${msg} ×${n}`);
    }
  }
  console.log('\n  В бою каст не сделает больше замеренного (×1.25 с запасом): лишний урон, контроль и сдвиг ринг срежет.');
}

function fighterDir(opts) {
  return resolveFighterDir(opts._[1] || 'fighter', here);
}

async function cmdCheck(opts) {
  const dir = fighterDir(opts);
  const res = await loadFighter(dir, { strict: !!opts.strict });
  printCheck(dir, res);
  if (!res.ok) process.exitCode = 1;
}

function cmdBlocks() {
  console.log(`Блоки конструктора (бюджет на все приёмы — ${MOVE_BUDGET} очков):\n`);
  for (const [type, b] of Object.entries(BLOCKS)) {
    console.log(`${type} — ${b.title}`);
    console.log(`  ${b.about}`);
    for (const [k, s] of Object.entries(b.params)) {
      const range = s.type === 'enum' ? s.values.join(' | ') : s.type === 'bool' ? 'true | false' : `${s.min}…${s.max}`;
      console.log(`    ${k.padEnd(10)} ${s.type === 'path' ? 'путь к модулю .js в папке бойца' : range}${s.required ? '' : `  (по умолчанию ${JSON.stringify(s.default)})`}`);
    }
  }
  console.log('\nПримитивы способности (api в хуках start, tick, passive и в поведении объектов):');
  for (const [sig, about] of ABILITY_PRIMITIVES) console.log(`  ${sig}\n      ${about}`);
  console.log('\nПодробно: ARENA.md, раздел «Способность кодом».');
}

async function loadOk(dir) {
  const res = await loadFighter(dir);
  if (!res.ok) {
    printCheck(dir, res);
    throw new Error(`${rel(dir)}: исправь ошибки и повтори`);
  }
  return res.fighter;
}

// One spar: fighter `me` on side `side` (0 — starts on the left) against `foe`, a round of `seconds`.
async function sparOnce(me, foe, side, round, seconds, options) {
  const dirs = side === 0 ? [me.dir, foe.dir] : [foe.dir, me.dir];
  const fighters = side === 0 ? [me.def, foe.def] : [foe.def, me.def];
  const run = await runFight({ dirs, fighters, options: { ...options, round }, maxTicks: Math.round(seconds * TICK_RATE) });
  const f = run.fight;
  const M = f.f[side];
  const O = f.f[1 - side];
  const result = f.winner === side ? 'победа' : f.winner === 1 - side ? 'поражение' : f.endReason === 'limit' ? 'время спарринга вышло' : f.endReason === 'ko' ? 'двойной нокаут' : 'ничья';
  return { run, f, M, O, side, result, seconds: f.tick / TICK_RATE, dirs };
}

async function cmdSpar(opts) {
  const meDir = resolveFighterDir(opts._[1] || 'fighter', here);
  const me = { dir: meDir, def: await loadOk(meDir) };
  // any fighter folder (several, comma-separated) or a training partner of the ring by name
  const foes = [];
  for (const spec of String(opts.vs || 'dummy').split(',').map((x) => x.trim()).filter(Boolean)) {
    const dir = resolveFighterDir(spec, here);
    foes.push({ dir, spec, def: await loadOk(dir) });
  }
  const sides = opts.side === 'left' ? [0] : opts.side === 'right' ? [1] : [0, 1];
  const seconds = Number(opts.seconds || ROUND_TICKS / TICK_RATE);
  const options = { dummy: opts.dummy || 'stand' };
  const outDir = join(here, 'out', 'spar');
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  let last = null;
  let round = 0;
  for (const foe of foes) {
    for (const side of sides) {
      round++;
      const r = await sparOnce(me, foe, side, round, seconds, options);
      const { f, M, O } = r;
      const where = side === 0 ? 'слева' : 'справа';
      console.log(`\n${me.def.card.name} (${where}) против ${foe.def.card.name}${foe.dir.includes('sparring') ? ` (режим «${options.dummy}»)` : ''} (${rel(foe.dir)}), до ${seconds} с`);
      console.log(`Итог: ${r.result}${f.endReason === 'ko' ? ' нокаутом' : ''}, ${r.seconds.toFixed(1)} с. Здоровье: ${Math.ceil(M.hp)}/${M.maxHp} против ${Math.ceil(O.hp)}/${O.maxHp}`);
      for (const F of [M, O]) {
        const t = F.tally;
        console.log(`  ${F.def.card.name}: урон ${t.damageDealt}, попаданий ${t.hits}, в блок ${t.blocked}, парирований ${t.parries}, бросков ${t.throws}, суперов ${t.supers}, броня ${t.armorHits}`);
        const st = f.abilityStats[F.side];
        if (st.hooks) {
          const cuts = Object.entries(st.cuts);
          console.log(`    способности: ${st.hooks} вызовов хуков${cuts.length ? `, срезано: ${cuts.map(([m, n]) => `${m} ×${n}`).join('; ')}` : ''}`);
          for (const e of st.errors) console.log(`    ! отключена ${e.script} на тике ${e.tick}: ${e.message}`);
        }
      }
      const counts = {};
      for (const e of r.run.events) counts[e.type] = (counts[e.type] || 0) + 1;
      console.log(`  События: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      const s = r.run.stats[side];
      const avg = s.calls ? s.msSum / s.calls : 0;
      console.log(`  Мозги ${me.def.card.name}: ход в среднем ${avg.toFixed(3)} мс, максимум ${s.msMax.toFixed(2)} мс, пропущено ${s.slow} (дольше ${BRAIN_TICK_MS} мс), ошибок ${s.errors}${s.lastError ? `\n    последняя: ${s.lastError.split('\n')[0]}` : ''}`);
      const name = `${String(foe.spec).replace(/[^\w.-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'foe'}-${side === 0 ? 'left' : 'right'}.json`;
      const save = join(outDir, name);
      writeFileSync(save, JSON.stringify({ ...r.run.replay, fighters: r.dirs.map(rel), me: side }) + '\n');
      console.log(`  Запись: ${rel(save)} (показать: node arena/cli.mjs preview --fight ${rel(save)})`);
      rows.push({ foe: foe.def.card.name, where, result: r.result, ko: f.endReason === 'ko' && f.winner !== null, seconds: r.seconds, hp: [Math.ceil(M.hp), M.maxHp], foeHp: [Math.ceil(O.hp), O.maxHp], dealt: M.tally.damageDealt, taken: O.tally.damageDealt });
      last = save;
    }
  }
  // the last one also as out/spar.json: `preview --fight` without a file shows it
  const save = opts.save === true || opts.save === undefined ? join(here, 'out', 'spar.json') : resolve(here, opts.save);
  mkdirSync(join(save, '..'), { recursive: true });
  writeFileSync(save, readFileSync(last));
  if (rows.length > 1) {
    console.log('\nСводка:');
    for (const x of rows) console.log(`  ${x.foe}, ты ${x.where}: ${x.result}${x.ko ? ' нокаутом' : ''}, ${x.seconds.toFixed(1)} с, здоровье ${x.hp[0]}/${x.hp[1]} против ${x.foeHp[0]}/${x.foeHp[1]}, урон ${x.dealt} : ${x.taken}`);
    const won = rows.filter((x) => x.result === 'победа').length;
    console.log(`  побед ${won} из ${rows.length}`);
  }
  return { save, me: me.dir, foe: foes[foes.length - 1].dir, rows };
}

async function cmdPreview(opts) {
  const { renderSheet, renderClip, hasFfmpeg } = await import('./tools/preview.js');
  const me = resolveFighterDir(opts._[1] || 'fighter', here);
  const foe = resolveFighterDir(opts.vs || 'dummy', here);
  const def = await loadOk(me);
  await loadOk(foe);
  const outDir = join(here, 'out', 'preview');
  const vertical = !!opts.vertical;
  const [w, h] = vertical ? [720, 1280] : [1280, 720];
  const stageFolder = opts.stage ? resolve(here, opts.stage) : null;
  const folders = { '/f/0/': me, '/f/1/': foe, ...(stageFolder ? { '/stage/': stageFolder } : {}) };
  const common = { a: '/f/0/', b: '/f/1/', dummy: opts.dummy || 'stand', ...(opts.gap ? { gap: opts.gap } : {}), ...(opts.debug ? { debug: 1 } : {}), ...(stageFolder ? { stage: '/stage/' } : {}) };
  const onlySheet = opts.sheet && !opts.move && !opts.fight;
  if (!opts.move && !opts.fight || opts.sheet) {
    const r = await renderSheet({ fighterDir: me, out: join(outDir, 'sheet.png') });
    console.log(`Лист поз: ${rel(r.out)} (${r.cells} кадров)`);
    for (const w of r.warnings || []) console.log(`  ! ${w}`);
    for (const c of r.console) console.log(`  консоль: ${c}`);
  }
  if (onlySheet) return;
  if (!hasFfmpeg()) throw new Error('нет ffmpeg в PATH: ролики не собрать (лист поз готов)');
  const voiceDirs = [join(me, 'voice'), join(foe, 'voice')];
  if (opts.fight) {
    let replay = typeof opts.fight === 'string' ? resolve(here, opts.fight) : join(here, 'out', 'spar.json');
    if (!existsSync(replay)) replay = (await cmdSpar({ ...opts, _: ['spar', opts._[1] || 'fighter'] })).save;
    // the fighters of the recording, left and right as they stood (spar writes them)
    const rec = JSON.parse(readFileSync(replay, 'utf8'));
    if (Array.isArray(rec.fighters) && rec.fighters.length === 2) {
      const [l, r] = rec.fighters.map((x) => resolveFighterDir(x, here));
      folders['/f/0/'] = l;
      folders['/f/1/'] = r;
      voiceDirs.splice(0, 2, join(l, 'voice'), join(r, 'voice'));
    }
    folders['/rep/'] = join(replay, '..');
    const out = join(outDir, `fight${vertical ? '-9x16' : ''}.mp4`);
    console.log('Снимаю бой…');
    const r = await renderClip({ folders, query: { ...common, mode: 'replay', replay: `/rep/${replay.split(/[\\/]/).pop()}` }, out, w, h, voiceDirs, log: console.log });
    console.log(`Бой: ${rel(out)} (${r.seconds.toFixed(1)} с${r.voiced ? `, реплик со звуком ${r.voiced}` : ''})`);
    for (const e of [...r.errors, ...r.console]) console.log(`  консоль: ${e}`);
    return;
  }
  const ids = opts.move ? String(opts.move).split(',') : def.moves.map((m) => m.id);
  for (const id of ids) {
    if (!def.movesById[id]) throw new Error(`нет приёма «${id}». Есть: ${def.moves.map((m) => m.id).join(', ')}`);
    const out = join(outDir, `${id}${vertical ? '-9x16' : ''}.mp4`);
    const r = await renderClip({ folders, query: { ...common, mode: 'move', move: id }, out, w, h, voiceDirs });
    console.log(`Приём ${id}: ${rel(out)} (${r.seconds.toFixed(1)} с)`);
    for (const e of [...r.errors, ...r.console]) console.log(`  консоль: ${e}`);
  }
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const cmd = opts._[0];
  if (!cmd || cmd === 'help' || opts.help) return console.log(HELP);
  switch (cmd) {
    case 'check': return cmdCheck(opts);
    case 'blocks': return cmdBlocks();
    case 'sounds': {
      const { catalogueText } = await import('./tools/sounds.js');
      console.log('Звуки ринга (moves.json → "sounds": { "start" | "active" | "hit" | "block" | "projectile" | "ability": имя }):');
      console.log(catalogueText());
      return;
    }
    case 'spar': return cmdSpar(opts);
    case 'preview': return cmdPreview(opts);
    case 'paint': return (await import('./tools/paint.js')).cmdPaint(opts, here);
    case 'parts': return (await import('./tools/parts.js')).cmdParts(opts, here);
    case 'voice': return (await import('./tools/voice.js')).cmdVoice(opts, here);
    case 'look': return (await import('./tools/look.js')).cmdLook(opts, here);
    case 'limits': return (await import('./tools/ring.js')).cmdLimits();
    default:
      console.log(HELP);
      throw new Error(`нет команды «${cmd}»`);
  }
}

main().catch((err) => {
  console.error(`\nОшибка: ${err.message || err}`);
  process.exit(1);
});
