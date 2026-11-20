// A match between two contestants: rounds until one has firstTo wins. Every round the judge takes a snapshot of
// both fighters, runs the fight on its own engine copy, records it, renders it and fills each contestant's
// locker room (history/round-N/) with the recording, their own summary and the opponent's card.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RING, KIT, getContestant, lockerReply } from './contestants.js';
import { readFighterDir, loadFighter, runFight, expandSteps } from '../kit/arena/tools/load.js';
import { createFight, stepFight, brainView, ROUND_TICKS, TICK_RATE, STAT_KEYS, RING_SEED, RING_VERSION, STARTS } from '../kit/arena/engine/index.js';

export const MATCHES = join(RING, 'matches');
const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb);
const writeJSON = (f, v, pretty = true) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, (pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v)) + '\n');
};
const sec = (t) => (t / TICK_RATE).toFixed(1);
const clock = (t) => {
  const s = t / TICK_RATE;
  return `${String(Math.floor(s / 60)).padStart(1, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

export function matchDir(id) {
  return join(MATCHES, id);
}

export function loadMatch(id) {
  const m = readJSON(join(matchDir(id), 'match.json'));
  if (!m) throw new Error(`нет матча «${id}» (node ring.mjs match new ${id} --red <участник> --blue <участник>)`);
  return m;
}

function saveMatch(m) {
  writeJSON(join(matchDir(m.id), 'match.json'), m);
}

// starts: the start of each round (constants.js → STARTS). 'draw' — round 1 from the centre, the rest by lot
// (seeded by the match id, so the draw is the same if the match is created again).
export function newMatch(id, { red, blue, stage = 'rooftop', firstTo = 2, maxRounds = 5, minutes = 20, starts = null }) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('id матча: латиница, цифры и -');
  if (existsSync(join(matchDir(id), 'match.json'))) throw new Error(`матч «${id}» уже есть: ${matchDir(id)}`);
  if (red === blue) throw new Error('нужны два разных участника');
  for (const c of [red, blue]) getContestant(c);
  for (const c of [red, blue]) if (existsSync(join(getContestant(c).root, 'history'))) throw new Error(`у участника «${c}» уже есть history/ от прошлого матча: убери её перед новым матчем`);
  const m = { id, created: new Date().toISOString(), ring: RING_VERSION, red, blue, models: { [red]: getContestant(red).model || red, [blue]: getContestant(blue).model || blue }, stages: Array.isArray(stage) ? stage : [stage], ...(starts ? { starts: drawStarts(id, starts) } : {}), firstTo, maxRounds, lockerMinutes: minutes, rounds: [], score: { [red]: 0, [blue]: 0 }, over: false, winner: null };
  saveMatch(m);
  return m;
}

export function drawStarts(id, starts) {
  if (Array.isArray(starts)) {
    for (const s of starts) if (!STARTS[s]) throw new Error(`старт «${s}» не знаю: ${Object.keys(STARTS).join(', ')}`);
    return starts;
  }
  const rest = Object.keys(STARTS).filter((s) => s !== 'centre');
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  for (let i = rest.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    const j = h % (i + 1);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return ['centre', ...rest];
}

// Round 1: red starts on the left; the sides swap every round.
export function sidesFor(m, n) {
  return n % 2 === 1 ? [m.red, m.blue] : [m.blue, m.red];
}

function gitInfo(root) {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'fighter'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
    return { head, dirty };
  } catch {
    return { head: null, dirty: null };
  }
}

// What goes into the judge's snapshot: the fighter without the working pieces of `parts split` (parts/raw), except
// the pictures body.json actually uses from there (`parts split` cuts into fighter/parts/raw by default, and a model
// may seat those files as they are: the snapshot then failed the check the contestant's own folder passed).
export function snapshotFilter(src) {
  let used = new Set();
  try {
    const body = JSON.parse(readFileSync(join(src, 'body.json'), 'utf8'));
    for (const p of Object.values(body.parts || {})) if (typeof p?.image === 'string') used.add(resolve(src, p.image).toLowerCase());
  } catch {}
  const raw = resolve(src, 'parts', 'raw').toLowerCase();
  return (p) => {
    const a = resolve(p).toLowerCase();
    if (a !== raw && !a.startsWith(raw + sep)) return true;
    return a === raw || used.has(a);
  };
}

// The fighter as it is right now, plus the judge's own engine for its brain to import (../arena/engine/).
// src: the fighter folder to take (by default the contestant's own fighter/; the tournament console passes the copy
// it took when the locker room's time ran out)
export function snapshot(cid, dir, src = null) {
  const c = getContestant(cid);
  src ||= join(c.root, 'fighter');
  if (!existsSync(join(src, 'fighter.json'))) throw new Error(`у участника «${cid}» нет fighter/fighter.json`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(src, join(dir, 'fighter'), { recursive: true, filter: snapshotFilter(src) });
  cpSync(join(KIT, 'arena', 'engine'), join(dir, 'arena', 'engine'), { recursive: true });
  return { fighter: join(dir, 'fighter'), git: gitInfo(c.root), at: new Date().toISOString() };
}

// the engine the judge plays a round on: a hash of its files (the same code — the same hash)
export function engineHash(dir = join(KIT, 'arena', 'engine')) {
  const h = createHash('sha1');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(dir, p).split(sep).join('/')).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 12);
}

// ---------- analysis of a recorded fight ----------

// Re-simulates the recording and returns per-tick samples, events with positions, and per-side summaries.
export function analyze(fighters, replay) {
  const fight = createFight({ fighters, seed: replay.seed ?? RING_SEED, start: replay.start });
  const steps = expandSteps(replay.steps);
  const samples = [];
  const events = [];
  let lastTick = -1;
  for (let i = 0; i < steps.length; i++) {
    const ev = stepFight(fight, steps[i]);
    const dist = Math.abs(fight.f[0].x - fight.f[1].x);
    for (const e of ev) events.push({ tick: fight.tick, dist: Math.round(dist), ...e });
    if (fight.tick !== lastTick) {
      lastTick = fight.tick;
      samples.push([fight.tick, ...fight.f.flatMap((F) => [Math.round(F.x), Math.round(F.y), F.state, F.state === 'move' ? F.move.def.id : null, F.hp, Math.round(F.meter), F.guard || null])]);
    }
  }
  // move instances and what came of them
  const sides = [0, 1].map((s) => ({ uses: [], throwsTried: 0 }));
  const open = [[], []];
  let prevState = [null, null];
  for (const smp of samples) {
    for (let s = 0; s < 2; s++) {
      const st = smp[1 + s * 7 + 2];
      if (st === 'throw' && prevState[s] !== 'throw') sides[s].throwsTried++;
      prevState[s] = st;
    }
  }
  for (const e of events) {
    if (e.type === 'move') {
      const use = { id: e.move, slot: e.slot, tick: e.tick, dist: e.dist, hits: 0, blocked: 0, parried: 0, armored: 0, damage: 0 };
      sides[e.side].uses.push(use);
      open[e.side].push(use);
      continue;
    }
    const A = e.attacker;
    if (A === undefined || !['hit', 'block', 'parry', 'armor'].includes(e.type)) continue;
    const list = open[A];
    let use = null;
    for (let i = list.length - 1; i >= 0; i--) if ((!e.move || list[i].id === e.move) && e.tick - list[i].tick < 400) {
      use = list[i];
      break;
    }
    if (!use) continue;
    if (e.type === 'hit') {
      use.hits++;
      use.damage += e.damage;
    } else if (e.type === 'block') use.blocked++;
    else if (e.type === 'parry') use.parried++;
    else if (e.type === 'armor') {
      use.armored++;
      use.damage += e.damage;
    }
  }
  const summary = [0, 1].map((s) => {
    const o = 1 - s;
    const F = fight.f[s];
    const moves = {};
    for (const u of sides[s].uses) {
      const m = (moves[u.id] ||= { id: u.id, name: fighters[s].movesById[u.id]?.name || u.id, slot: u.slot, used: 0, landed: 0, blocked: 0, parried: 0, armored: 0, whiffed: 0, damage: 0, hits: 0, distSum: 0, whiffDistSum: 0 });
      m.used++;
      m.distSum += u.dist;
      m.hits += u.hits;
      m.damage += u.damage;
      if (u.hits) m.landed++;
      else if (u.blocked) m.blocked++;
      else if (u.parried) m.parried++;
      else if (u.armored) m.armored++;
      else {
        m.whiffed++;
        m.whiffDistSum += u.dist;
      }
    }
    const taken = {};
    for (const e of events) {
      if (e.type === 'hit' && e.attacker === o) {
        const t = (taken[e.move] ||= { id: e.move, name: fighters[o].movesById[e.move]?.name || e.move, hits: 0, damage: 0, counter: 0 });
        t.hits++;
        t.damage += e.damage;
        if (e.counter) t.counter++;
      }
    }
    const blockedOpp = {};
    for (const e of events) if (e.type === 'block' && e.attacker === o) blockedOpp[e.move] = (blockedOpp[e.move] || 0) + 1;
    const count = (pred) => events.filter(pred).length;
    return {
      side: s,
      name: fighters[s].card.name,
      hp: F.hp,
      maxHp: F.maxHp,
      tally: F.tally,
      throwsTried: sides[s].throwsTried,
      throwsLanded: count((e) => e.type === 'throw' && e.side === s),
      thrownBy: count((e) => e.type === 'throw' && e.side === o),
      techs: count((e) => e.type === 'tech'),
      knockdowns: count((e) => e.type === 'knockdown' && e.side === s),
      dizzied: count((e) => e.type === 'dizzy' && e.side === s),
      parriedOpp: count((e) => e.type === 'parry' && e.side === s),
      supers: { used: sides[s].uses.filter((u) => u.slot === 'super').length, landed: sides[s].uses.filter((u) => u.slot === 'super' && u.hits).length },
      moves: Object.values(moves).map((m) => ({ ...m, avgDist: Math.round(m.distSum / m.used), whiffAvgDist: m.whiffed ? Math.round(m.whiffDistSum / m.whiffed) : null, distSum: undefined, whiffDistSum: undefined })),
      taken: Object.values(taken).sort((a, b) => b.damage - a.damage),
      blockedFromOpponent: blockedOpp,
    };
  });
  return { fight, samples, events, summary, result: { winner: fight.winner, reason: fight.endReason, ticks: fight.endTick ?? fight.tick, hp: fight.f.map((F) => F.hp), maxHp: fight.f.map((F) => F.maxHp) } };
}

// ---------- locker-room materials ----------

function opponentCard(fighters, side) {
  const def = fighters[side];
  const view = brainView(createFight({ fighters: side === 0 ? fighters : [fighters[1], fighters[0]] }), 0).me;
  return {
    name: def.card.name,
    motto: def.card.motto,
    colors: def.card.colors,
    stats: def.stats,
    derived: def.derived,
    // what the brains see, minus file names of the opponent's code
    moves: view.moves.map((m) => ({ ...m, segments: m.segments.map(({ script, ...seg }) => seg) })),
  };
}

function opponentMd(card) {
  const d = card.derived;
  const lines = [
    `# Соперник: ${card.name}`,
    '',
    `Девиз: ${card.motto}`,
    '',
    `Характеристики: здоровье ${card.stats.health}, сила ${card.stats.power}, скорость ${card.stats.speed}, защита ${card.stats.defense}.`,
    `Здоровье ${d.maxHp}, урон ×${d.damageMul.toFixed(2)}, шаг ${d.walk.toFixed(1)} ед./тик, рывок ${d.dashDistance} ед., прыжок вбок ${d.jumpVx.toFixed(1)} ед./тик, получаемый урон ×${d.takenMul.toFixed(2)}.`,
    '',
    '## Приёмы',
    '',
    'Те же данные, что мозги видят в бою в `opponent.moves`. Тики — от начала приёма.',
    '',
  ];
  for (const m of card.moves) {
    const a = m.ability;
    const dmg = a ? `способность кодом, замер ринга: урон ${a.measured.damage}, контроль ${a.measured.control} тиков, усиление ${a.measured.buff}, сдвиг ${a.measured.shove} ед., объекты ${a.measured.objectTicks} тиков; перезарядка ${a.cooldown} тиков` : `урон за всё ${Math.round(m.totalDamage)}`;
    lines.push(`### ${m.name} (\`${m.id}\`, ${m.slot}, ${m.posture}) — ${m.duration} тиков, первый активный тик ${m.firstActive}, ${dmg}`);
    const extra = [];
    if (m.armor) extra.push(`броня на замахе: ${m.armor}`);
    if (m.charge) extra.push(`заряд: до ${m.charge.maxHold} тиков, +${Math.round(m.charge.bonus * 100)} %`);
    for (const [k, v] of Object.entries(m)) if (!['id', 'name', 'slot', 'posture', 'duration', 'firstActive', 'totalDamage', 'armor', 'charge', 'segments', 'ability', 'cooldown'].includes(k) && v !== null && v !== undefined && typeof v !== 'function') extra.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (extra.length) lines.push(extra.join('; '));
    for (const s of m.segments) {
      const params = Object.entries(s).filter(([k]) => !['type', 'start', 'activeStart', 'activeEnd', 'end', 'script', 'measuredCost'].includes(k)).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
      lines.push(`- ${s.type}: тики ${s.start}–${s.end}, активен ${s.activeStart}–${s.activeEnd}${params ? `; ${params}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function reportMd(sum, oppSum, res, side, stats) {
  const L = [];
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '—');
  L.push(`# Твоя сводка за раунд: ${sum.name}`, '');
  L.push(`Здоровье в конце: ${sum.hp} из ${sum.maxHp}. Соперник: ${oppSum.hp} из ${oppSum.maxHp}.`);
  L.push(`Нанесено урона ${sum.tally.damageDealt}, получено ${sum.tally.damageTaken}. Самая длинная серия, которую ты пропустил: ${sum.tally.maxCombo}; которую пропустил соперник: ${oppSum.tally.maxCombo}.`, '');
  L.push('## Чем ты попадал и где мазал', '');
  L.push('| приём | запусков | попал | в блок | парирован | в броню | мимо | урон | средняя дистанция | дистанция промахов |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const m of [...sum.moves].sort((a, b) => b.used - a.used)) L.push(`| ${m.name} (\`${m.id}\`) | ${m.used} | ${m.landed} | ${m.blocked} | ${m.parried} | ${m.armored} | ${m.whiffed} | ${m.damage} | ${m.avgDist} | ${m.whiffAvgDist ?? '—'} |`);
  if (!sum.moves.length) L.push('| — | 0 | | | | | | | | |');
  L.push('');
  L.push(`Броски: попыток ${sum.throwsTried}, удалось ${sum.throwsLanded}. Суперприём: запусков ${sum.supers.used}, попал ${sum.supers.landed}. Парировал ударов соперника: ${sum.parriedOpp}. Ушёл от бросков: ${sum.techs}.`, '');
  L.push('## Что ты пропустил', '');
  if (sum.taken.length) {
    L.push('| приём соперника | попаданий по тебе | урон | из них контрударом |');
    L.push('|---|---|---|---|');
    for (const t of sum.taken) L.push(`| ${t.name} (\`${t.id}\`) | ${t.hits} | ${t.damage} | ${t.counter} |`);
  } else L.push('По тебе не попал ни один удар.');
  L.push('');
  const blocked = Object.entries(sum.blockedFromOpponent);
  L.push(`Заблокировал: ${blocked.length ? blocked.map(([k, v]) => `\`${k}\` ×${v}`).join(', ') : 'ничего'}. Тебя бросили: ${sum.thrownBy}. Падений: ${sum.knockdowns}. Оглушений: ${sum.dizzied}.`, '');
  L.push('## Мозги', '');
  const avg = stats.calls ? stats.msSum / stats.calls : 0;
  L.push(`Вызовов ${stats.calls}, в среднем ${avg.toFixed(3)} мс, максимум ${stats.msMax.toFixed(2)} мс, пропущено по лимиту 5 мс: ${stats.slow}, ошибок: ${stats.errors}.${stats.lastError ? `\nПоследняя ошибка: ${stats.lastError.split('\n').slice(0, 3).join(' | ')}` : ''}`);
  L.push('');
  void res;
  void side;
  void pct;
  return L.join('\n');
}

function timelineMd(an, side, names) {
  const who = (s) => (s === side ? 'ты' : 'соперник');
  const L = [`# Хронология раунда`, '', `Ты — сторона ${side} (${side === 0 ? 'старт слева' : 'старт справа'}). Время — от начала боя, мм:сс.д. Дистанция — между центрами бойцов.`, ''];
  for (const e of an.events) {
    const t = clock(e.tick);
    const moveName = (s, id) => an.fight.f[s].def.movesById[id]?.name || id;
    let line = null;
    switch (e.type) {
      case 'move': line = `${who(e.side)}: ${moveName(e.side, e.move)} (\`${e.move}\`), дистанция ${e.dist}`; break;
      case 'hit': line = `  попадание: ${who(e.attacker)} → ${who(e.side)}, \`${e.move}\`, урон ${e.damage}${e.counter ? ', контрудар' : ''}${e.combo > 1 ? `, серия ${e.combo}` : ''}${e.launch ? ', подброс' : ''}`; break;
      case 'block': line = `  в блок: ${who(e.side)} держит \`${e.move}\` (${e.zone})`; break;
      case 'parry': line = `  парирование: ${who(e.side)}`; break;
      case 'armor': line = `  броня: ${who(e.side)} выдержал удар, урон ${e.damage}`; break;
      case 'grab': line = `${who(e.side)}: захват`; break;
      case 'throw': line = `  бросок: ${who(e.side)} → ${who(e.victim)}, урон ${e.damage}`; break;
      case 'tech': line = '  уход от броска'; break;
      case 'knockdown': line = `  ${who(e.side)} падает`; break;
      case 'dizzy': line = `  ${who(e.side)} оглушён`; break;
      case 'super': line = `${who(e.side)}: СУПЕРПРИЁМ \`${e.move}\``; break;
      case 'end': line = `КОНЕЦ: ${e.winner === null ? 'ничья' : `победа — ${who(e.winner)}`} (${e.reason === 'ko' ? 'нокаут' : 'время'})`; break;
      default: break;
    }
    if (line) L.push(`${t}  ${line}`);
  }
  void names;
  return L.join('\n') + '\n';
}

function frameSheets(video, outDir) {
  mkdirSync(outDir, { recursive: true });
  // two frames a second, 4×4 per sheet: 8 seconds of the fight per picture
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vf', 'fps=2,scale=480:-1,tile=4x4', join(outDir, 'sheet-%02d.jpg')], { stdio: 'ignore' });
  return readdirSync(outDir).filter((f) => f.endsWith('.jpg')).length;
}

export function writeLocker(m, n, roundDir, an, fighters, stats, sides) {
  const out = [];
  for (let s = 0; s < 2; s++) {
    const cid = sides[s];
    const c = getContestant(cid);
    const dir = join(c.root, 'history', `round-${n}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const o = 1 - s;
    const res = an.result;
    const myWins = m.score[cid];
    const oppWins = m.score[sides[o]];
    const outcome = res.winner === null ? 'ничья' : res.winner === s ? 'победа' : 'поражение';
    const next = m.over ? 'Матч окончен.' : `Следующий раунд: ${n + 1}, ты начинаешь ${sidesFor(m, n + 1)[0] === cid ? 'слева' : 'справа'}. Время на доработку — ${m.lockerMinutes} минут; когда оно выйдет, судья заберёт папку fighter/ как есть.`;
    writeFileSync(join(dir, 'result.md'), [
      `# Раунд ${n}: ${outcome}${res.winner === null ? (res.reason === 'ko' ? ', двойной нокаут' : '') : res.reason === 'ko' ? ' нокаутом' : ' по времени'}`,
      '',
      `Ты: ${fighters[s].card.name}, сторона ${s} (${s === 0 ? 'слева' : 'справа'}). Соперник: ${fighters[o].card.name}.`,
      `Бой длился ${sec(res.ticks)} с. Здоровье в конце: у тебя ${res.hp[s]} из ${res.maxHp[s]}, у соперника ${res.hp[o]} из ${res.maxHp[o]}.`,
      `Счёт матча: ${myWins} : ${oppWins} (ты : соперник), матч до ${m.firstTo} побед.`,
      '',
      next,
      '',
      'Файлы: `fight.mp4` — запись боя со звуком, `frames/` — кадры записи (2 в секунду), `timeline.md` — хронология, `fight.json` — покадровая запись, `report.md` — твоя сводка, `opponent.md` — карточка соперника.',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'report.md'), reportMd(an.summary[s], an.summary[o], res, s, stats[s]));
    writeJSON(join(dir, 'report.json'), { you: an.summary[s], opponent: { name: an.summary[o].name, hp: an.summary[o].hp, maxHp: an.summary[o].maxHp, tally: an.summary[o].tally }, brain: stats[s] });
    const card = opponentCard(fighters, o);
    writeJSON(join(dir, 'opponent.json'), card);
    writeFileSync(join(dir, 'opponent.md'), opponentMd(card));
    writeFileSync(join(dir, 'timeline.md'), timelineMd(an, s, fighters.map((f) => f.card.name)));
    writeJSON(join(dir, 'fight.json'), {
      about: 'Покадровая запись раунда. me — твоя сторона (0 — старт слева). samples: [тик, x0, y0, state0, move0, hp0, meter0, guard0, x1, y1, state1, move1, hp1, meter1, guard1]. events — события ринга с тиком и дистанцией.',
      me: s,
      names: fighters.map((f) => f.card.name),
      result: res,
      samples: an.samples,
      events: an.events,
    }, false);
    const video = join(roundDir, 'fight-16x9.mp4');
    if (existsSync(video)) {
      cpSync(video, join(dir, 'fight.mp4'));
      frameSheets(video, join(dir, 'frames'));
    }
    out.push(dir);
  }
  return out;
}

// ---------- a round ----------

export async function runRound(id, { log = console.log, sources = null } = {}) {
  const m = loadMatch(id);
  if (m.over) throw new Error(`матч «${id}» окончен: ${m.winner ? `победил ${m.winner}` : 'ничья'}`);
  const n = m.rounds.length + 1;
  const sides = sidesFor(m, n);
  const roundDir = join(matchDir(id), `round-${n}`);
  mkdirSync(roundDir, { recursive: true });
  const snaps = {};
  for (const cid of sides) snaps[cid] = snapshot(cid, join(roundDir, cid), sources?.[cid] || null);
  // what each model said in the locker room after the previous round, next to the version it produced
  if (n > 1) for (const cid of sides) {
    const note = lockerReply(cid, n - 1);
    if (note) writeJSON(join(roundDir, cid, 'locker.json'), note);
  }
  const fighters = [];
  for (const cid of sides) {
    const r = await loadFighter(snaps[cid].fighter);
    if (!r.ok) throw new Error(`боец участника «${cid}» не проходит проверку:\n${r.errors.slice(0, 12).join('\n')}`);
    if (r.warnings.length) log(`  ! ${cid}: ${r.warnings.join('; ')}`);
    for (const a of r.abilities || []) log(`  способность ${cid}/${a.id || a.move || ''}: ${JSON.stringify(a).slice(0, 200)}`);
    // the ring's measurement of each ability next to the snapshot: the game shows a super made in code by it
    writeJSON(join(roundDir, cid, 'abilities.json'), (r.abilities || []).map((a) => ({ id: a.id, slot: a.slot, measured: a.measured })));
    fighters.push(r.fighter);
  }
  log(`Раунд ${n}: ${fighters[0].card.name} (${sides[0]}) слева против ${fighters[1].card.name} (${sides[1]}) справа`);
  const run = await runFight({ dirs: sides.map((cid) => snaps[cid].fighter), fighters, options: { round: n }, seed: (RING_SEED + n - 1) >>> 0, start: m.starts ? STARTS[m.starts[(n - 1) % m.starts.length]] : null, maxTicks: ROUND_TICKS + 900, log: (s) => log(s) });
  const replay = { ...run.replay, fighters: sides.map((cid) => `${cid}/fighter`), round: n, stats: run.stats };
  writeJSON(join(roundDir, 'replay.json'), replay, false);
  const an = analyze(fighters, run.replay);
  const res = an.result;
  const winner = res.winner === null ? null : sides[res.winner];
  if (winner) m.score[winner]++;
  const stage = m.stages[(n - 1) % m.stages.length];
  m.rounds.push({ n, ring: RING_VERSION, engine: engineHash(join(roundDir, sides[0], 'arena', 'engine')), left: sides[0], right: sides[1], stage, start: m.starts ? m.starts[(n - 1) % m.starts.length] : null, winner, reason: res.reason, ticks: res.ticks, hp: res.hp, maxHp: res.maxHp, snapshot: Object.fromEntries(sides.map((cid) => [cid, { git: snaps[cid].git, at: snaps[cid].at, name: fighters[sides.indexOf(cid)].card.name }])), hash: run.replay.hash });
  const wonOut = Object.entries(m.score).find(([, v]) => v >= m.firstTo);
  if (wonOut) {
    m.over = true;
    m.winner = wonOut[0];
  } else if (m.rounds.length >= m.maxRounds) {
    m.over = true;
    const [a, b] = [m.score[m.red], m.score[m.blue]];
    m.winner = a > b ? m.red : b > a ? m.blue : null;
  }
  saveMatch(m);
  writeJSON(join(roundDir, 'analysis.json'), { result: res, summary: an.summary });
  // stats of the round and of the locker rooms so far (the game's match page, the reel, the commentator)
  await (await import('./moments.js')).matchStats(id).catch((e) => log(`  ! статистика: ${e.message}`));
  log(`Итог: ${winner ? `${winner} (${fighters[res.winner].card.name})` : 'ничья'}, ${res.reason === 'ko' ? 'нокаут' : 'по времени'}, ${sec(res.ticks)} с. Здоровье ${res.hp[0]}/${res.maxHp[0]} — ${res.hp[1]}/${res.maxHp[1]}. Счёт ${m.red} ${m.score[m.red]} : ${m.score[m.blue]} ${m.blue}${m.over ? `. Матч окончен${m.winner ? `, победил ${m.winner}` : ''}.` : ''}`);
  for (let s = 0; s < 2; s++) {
    const st = run.stats[s];
    if (st.slow || st.errors) log(`  ! мозги ${sides[s]}: пропущено ${st.slow}, ошибок ${st.errors}${st.lastError ? ` — ${st.lastError.split('\n')[0]}` : ''}`);
  }
  return { m, n, roundDir, sides, fighters, an, stats: run.stats };
}

// The round as the show names it: a draw is replayed under the same number (num), marked as a rerun.
export function roundOrder(rounds, i) {
  return { num: 1 + rounds.slice(0, i).filter((x) => x.winner).length, rerun: i > 0 && !rounds[i - 1].winner };
}

export function roundInfo(m, n) {
  const r = m.rounds[n - 1];
  if (!r) throw new Error(`в матче «${m.id}» нет раунда ${n}`);
  const before = { [m.red]: 0, [m.blue]: 0 };
  for (const x of m.rounds.slice(0, n - 1)) if (x.winner) before[x.winner]++;
  const final = m.over && n === m.rounds.length && !!m.winner;
  return { r, wins: [before[r.left], before[r.right]], final, ...roundOrder(m.rounds, n - 1) };
}

export function relRing(p) {
  return relative(RING, p).split('\\').join('/');
}

export { resolve };

// ---------- before and after: what a contestant changed between rounds ----------

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

function filesOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = { hash: createHash('sha1').update(readFileSync(p)).digest('hex'), size: statSync(p).size, lines: /\.(js|json|md)$/.test(n) ? readFileSync(p, 'utf8').split('\n').length : null };
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// What changed in a fighter between two snapshots: card, stats, moves, abilities and files.
export function diffFighters(a, b) {
  const fa = filesOf(a);
  const fb = filesOf(b);
  const added = Object.keys(fb).filter((f) => !fa[f]);
  const removed = Object.keys(fa).filter((f) => !fb[f]);
  const changed = Object.keys(fb).filter((f) => fa[f] && fa[f].hash !== fb[f].hash).map((f) => ({ file: f, lines: fa[f].lines !== null ? `${fa[f].lines} → ${fb[f].lines} строк` : `${fa[f].size} → ${fb[f].size} байт` }));
  const ra = readFighterDir(a, { quick: true }).fighter;
  const rb = readFighterDir(b, { quick: true }).fighter;
  const STAT_RU = { health: 'здоровье', power: 'сила', speed: 'скорость', defense: 'защита' };
  const stats = ra && rb ? STAT_KEYS.filter((k) => ra.stats[k] !== rb.stats[k]).map((k) => `${STAT_RU[k] || k} ${ra.stats[k]} → ${rb.stats[k]}`) : [];
  const card = [];
  if (ra && rb) {
    if (ra.card.name !== rb.card.name) card.push(`имя: ${ra.card.name} → ${rb.card.name}`);
    if (ra.card.motto !== rb.card.motto) card.push(`девиз: ${rb.card.motto}`);
    if (ra.card.story !== rb.card.story) card.push('предыстория переписана');
    if (JSON.stringify(ra.card.colors) !== JSON.stringify(rb.card.colors)) card.push('цвета');
  }
  const ma = new Map((ra?.moves || []).map((x) => [x.id, x]));
  const mb = new Map((rb?.moves || []).map((x) => [x.id, x]));
  const scriptOf = (mv) => mv.ability?.script || null;
  const kind = (mv) => (scriptOf(mv) ? 'способность кодом' : mv.segments.map((sg) => sg.type).join('+'));
  const moves = [
    ...[...mb.keys()].filter((k) => !ma.has(k)).map((k) => `+ ${mb.get(k).name} (${k})`),
    ...[...ma.keys()].filter((k) => !mb.has(k)).map((k) => `− ${ma.get(k).name} (${k})`),
    ...[...mb.keys()].filter((k) => ma.has(k) && JSON.stringify(ma.get(k).segments) !== JSON.stringify(mb.get(k).segments)).map((k) => {
      const [x, y] = [ma.get(k), mb.get(k)];
      return `~ ${y.name} (${k}): ${kind(x)} → ${kind(y)}, ${x.duration} → ${y.duration} тиков`;
    }),
  ];
  // an ability whose script changed counts even when its move stayed the same
  const abilities = [];
  for (const [k, y] of mb) {
    const sc = scriptOf(y);
    if (!sc) continue;
    const x = ma.get(k);
    if (!x || !scriptOf(x)) abilities.push(`+ ${y.name}`);
    else if (fa[sc]?.hash !== fb[sc]?.hash || scriptOf(x) !== sc) abilities.push(`~ ${y.name}: код изменён`);
  }
  for (const [k, x] of ma) if (scriptOf(x) && !(mb.get(k) && scriptOf(mb.get(k)))) abilities.push(`− ${x.name}`);
  const brain = fa['brain.js']?.hash !== fb['brain.js']?.hash;
  return { added, removed, changed, stats, card, moves, abilities, brain, brainLines: brain ? brainLines(join(a, 'brain.js'), join(b, 'brain.js')) : null, name: [ra?.card.name, rb?.card.name] };
}

// The lines of the brain that changed, for the screen: what went out and what came in (at most 3 each, trimmed;
// blank lines and comment-only lines do not count), and how many lines changed in all.
export function brainLines(a, b) {
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()) : []);
  const [la, lb] = [read(a), read(b)];
  const code = (l) => l && !/^\/\//.test(l);
  const sa = new Set(la);
  const sb = new Set(lb);
  const out = la.filter((l) => code(l) && !sb.has(l));
  const inn = lb.filter((l) => code(l) && !sa.has(l));
  const cut = (l) => (l.length > 140 ? `${l.slice(0, 138)}…` : l);
  return { removed: out.slice(0, 3).map(cut), added: inn.slice(0, 3).map(cut), count: Math.max(out.length, inn.length), lines: [la.length, lb.length] };
}

export function changes(id, cid) {
  const m = loadMatch(id);
  const rounds = m.rounds.filter((r) => r.left === cid || r.right === cid);
  const out = [];
  for (let i = 1; i < rounds.length; i++) {
    const a = join(matchDir(id), `round-${rounds[i - 1].n}`, cid, 'fighter');
    const b = join(matchDir(id), `round-${rounds[i].n}`, cid, 'fighter');
    out.push({ from: rounds[i - 1].n, to: rounds[i].n, ...diffFighters(a, b), note: readJSON(join(matchDir(id), `round-${rounds[i].n}`, cid, 'locker.json')) });
  }
  return out;
}

// The locker-room replies again, for every round after the first (a reply written after the round started counts too).
export function collectNotes(id) {
  const m = loadMatch(id);
  const out = [];
  for (const r of m.rounds) {
    if (r.n === 1) continue;
    for (const cid of [r.left, r.right]) {
      const note = lockerReply(cid, r.n - 1);
      if (!note) continue;
      writeJSON(join(matchDir(id), `round-${r.n}`, cid, 'locker.json'), note);
      out.push({ round: r.n, cid, chars: note.text.length });
    }
  }
  return out;
}

// The locker room of a round already played, from its folder (the tournament console writes it after the clip)
export async function lockerFor(id, n) {
  const m = loadMatch(id);
  const { r } = roundInfo(m, n);
  const roundDir = join(matchDir(id), `round-${n}`);
  const sides = [r.left, r.right];
  const fighters = [];
  for (const cid of sides) {
    const res = await loadFighter(join(roundDir, cid, 'fighter'));
    if (!res.ok) throw new Error(`снимок «${cid}» раунда ${n} не проходит проверку`);
    fighters.push(res.fighter);
  }
  const replay = JSON.parse(readFileSync(join(roundDir, 'replay.json'), 'utf8'));
  const an = analyze(fighters, replay);
  return writeLocker(m, n, roundDir, an, fighters, replay.stats || [{}, {}], sides);
}
