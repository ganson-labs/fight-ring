// Мозги Цугцванга.
// Идея: соперник видит всё и отвечает в тот же тик, поэтому бить «в лоб» бессмысленно.
// Я бью только тогда, когда ответить он уже не успевает:
//  1) фигура-страж бьёт в зону, которую блок не держит, — и я продолжаю серию сам;
//  2) каждый следующий удар «Вилки» приходится ровно на тик, когда соперник выходит из
//     оглушения ударом: он уже уязвим, но ещё не успел подумать («вечный шах»);
//  3) всё, что летит в меня, парирую или блокирую по точному расчёту тика попадания.

const REACH = { short: 55, mid: 95, long: 150 };
const ZONE_Y = { high: [200, 270], mid: [110, 230], low: [0, 70], overhead: [150, 285], air: [-30, 120] };
const GRAVITY = 0.85;
const GUARDS = ['queen', 'rook', 'pawn'];

// виды «занятости» соперника
const FREE = 0; // может действовать
const EXACT = 1; // в хитстане: следующий удар — ровно в тик выхода
const WINDOW = 2; // занят и уязвим: бить, пока не освободился
const WAKE = 3; // неуязвим до подъёма: удар ровно к подъёму
const AIR = 4; // в прыжке
const NOPE = 5; // трогать нельзя или незачем

let K = null; // мои приёмы
let foe = null; // что известно о сопернике
let lockFree = 0;
let lockKind = FREE;
let learn = null;
let opt = {};
let prevMove = null; // мой приём на прошлом тике, если он был ещё в замахе
let stall = 0;

function findMove(list, id) {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function setup(view) {
  const me = view.me;
  const fork = findMove(me.moves, 'fork');
  const castle = findMove(me.moves, 'castle');
  K = {
    forkStartup: fork ? fork.segments[0].activeStart : 6,
    forkReach: fork ? 35 + REACH[fork.segments[0].reach] + 35 : 165,
    castleTicks: castle ? castle.duration : 0,
    castTicks: 11,
    walk: me.derived.walk,
    dash: me.derived.dashDistance,
  };
  const op = view.opponent;
  let reach = 0;
  let airFast = 99;
  let superFar = false;
  const strikes = [];
  const shots = [];
  for (let i = 0; i < op.moves.length; i++) {
    const m = op.moves[i];
    let lead = 0; // тики приёма до этого действия
    for (let j = 0; j < m.segments.length; j++) {
      const sg = m.segments[j];
      if (sg.type === 'strike') {
        if (m.posture === 'air') airFast = Math.min(airFast, sg.activeStart);
        else {
          reach = Math.max(reach, 35 + REACH[sg.reach] + 35);
          strikes.push({ reach: 35 + REACH[sg.reach] + 35, startup: sg.activeStart, tele: lead > 0 });
        }
      } else if (sg.type === 'projectile') {
        shots.push({ startup: sg.activeStart, speed: sg.speed === 'fast' ? 13 : sg.speed === 'mid' ? 9 : 6 });
        if (m.slot === 'super') superFar = true;
      } else if (sg.type === 'teleport') lead = sg.end;
      else if (m.slot === 'super') superFar = true;
    }
  }
  foe = {
    reach: reach || 130,
    airFast,
    superFar,
    strikes,
    shots,
    walk: op.derived.walk,
    dash: op.derived.dashDistance,
    jumpVx: op.derived.jumpVx,
  };
  learn = { ability: {}, countered: 0, counteredAt: -99999, cleanStarts: 0 };
  prevMove = null;
  stall = 0;
}

function landTicks(y, vy) {
  let n = 0;
  while (n < 90) {
    vy -= GRAVITY;
    y += vy;
    n++;
    if (y <= 0) break;
  }
  return n;
}

// Сколько тиков соперник ещё не сможет действовать и как его можно бить.
function lockOf(op) {
  const left = op.stateLength - op.stateTicks;
  switch (op.state) {
    case 'neutral':
      lockFree = 0;
      lockKind = FREE;
      return;
    case 'hitstun':
      lockFree = left;
      lockKind = EXACT;
      return;
    case 'staggered':
    case 'dizzy':
    case 'techBreak':
    case 'landing':
    case 'parry':
    case 'throw':
    case 'dash':
      lockFree = left;
      lockKind = WINDOW;
      return;
    case 'move':
      lockFree = op.move ? op.move.duration - op.move.t : 0;
      lockKind = WINDOW;
      return;
    case 'prejump':
      lockFree = 3 - op.stateTicks + 43;
      lockKind = AIR;
      return;
    case 'air':
      lockFree = landTicks(op.y, op.vy) + 3;
      lockKind = AIR;
      return;
    case 'juggle':
      lockFree = landTicks(op.y, op.vy) + 64;
      lockKind = WAKE;
      return;
    case 'knockdown':
      lockFree = left + 20;
      lockKind = WAKE;
      return;
    case 'getup':
      lockFree = left;
      lockKind = WAKE;
      return;
    case 'thrown':
      lockFree = left + 64;
      lockKind = WAKE;
      return;
    default:
      lockFree = 0;
      lockKind = NOPE;
  }
}

// ---------- защита ----------

function overlap1(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

// Удар соперника: через сколько тиков он попадёт (0 — в этот тик), зона; -1 — не попадёт.
let thrZone = 'mid';
let thrCharge = false;
let thrMulti = false;
function strikeThreat(me, op) {
  const mv = op.move;
  if (op.state !== 'move' || !mv) return -1;
  const def = findMove(op.moves, mv.id);
  if (!def) return -1;
  const air = def.posture === 'air';
  // где соперник окажется после телепорта, если тот ещё впереди
  let bx = op.x;
  let bf = op.facing;
  for (let i = 0; i < def.segments.length; i++) {
    const sg = def.segments[i];
    if (sg.type === 'teleport') {
      if (mv.t < sg.activeStart) {
        if (sg.to === 'behind') {
          const dir = me.x >= bx ? 1 : -1;
          let x = me.x + dir * 90;
          if (x < 40 || x > 2160) x = me.x - dir * 90;
          bx = x;
          bf = me.x >= bx ? 1 : -1;
        } else if (sg.to === 'forward') {
          const gap = Math.max(0, Math.abs(me.x - bx) - 70);
          bx += bf * Math.min(sg.distance || 250, gap);
        } else bx -= bf * (sg.distance || 250);
      }
      continue;
    }
    const charge = !!(def.charge && i === firstHitSeg(def) && mv.held < def.charge.maxHold && mv.t <= sg.activeStart - 1);
    if (sg.type === 'projectile') {
      if (mv.t + 1 > sg.activeStart) continue; // уже вылетел: его видно среди снарядов
      const k0 = sg.activeStart - mv.t - 1;
      const v = (sg.speed === 'fast' ? 13 : sg.speed === 'mid' ? 9 : 6) * bf;
      const px = bx + bf * 60;
      for (let j = 0; j <= 4; j++) {
        if (Math.abs(px + v * (j + 1) - me.x) < 62) {
          thrZone = sg.zone;
          thrCharge = charge;
          thrMulti = false;
          return k0 + j;
        }
      }
      continue;
    }
    if (sg.type !== 'strike') continue;
    if (mv.t + 1 >= sg.activeEnd) continue;
    let k = sg.activeStart - mv.t - 1;
    const active = k <= 0;
    if (k < 0) k = 0;
    // где будет коробка удара в тик попадания
    let ox = bx;
    let oy = op.y;
    if (air) {
      let vy = op.vy;
      for (let n = 0; n <= k; n++) {
        vy -= GRAVITY;
        oy += vy;
        ox += op.vx;
      }
      if (oy <= 0) continue; // приземлится раньше
    }
    const xa = ox + bf * 20;
    const xb = ox + bf * (35 + REACH[sg.reach]);
    const zy = ZONE_Y[sg.zone];
    const m = 6; // запас на сдвиги
    if (!overlap1(Math.min(xa, xb) - m, Math.max(xa, xb) + m, me.x - 35, me.x + 35)) continue;
    if (!overlap1(oy + zy[0], oy + zy[1], me.y, me.y + 290)) continue;
    thrZone = sg.zone;
    thrCharge = charge;
    thrMulti = active && (sg.hits || 1) > 1;
    return k;
  }
  return -1;
}

function firstHitSeg(def) {
  for (let i = 0; i < def.segments.length; i++) if (def.segments[i].type === 'strike' || def.segments[i].type === 'projectile') return i;
  return -1;
}

// Снаряд или объект соперника: через сколько тиков коснётся (0 — в этот тик); -1 — не скоро.
function flyThreat(me, x, y, vx, vy, hw, hh, horizon) {
  for (let k = 0; k <= horizon; k++) {
    const px = x + vx * (k + 1);
    const py = y + vy * (k + 1);
    if (Math.abs(px - me.x) < hw + 35 && py - hh < me.y + 290 && py + hh > me.y) return k;
  }
  return -1;
}

const ACT = { walk: 0, crouch: false, jump: null, dash: null, guard: null, parry: false, attack: null, hold: false, throw: false, tech: false, say: null };
function act() {
  ACT.walk = 0;
  ACT.crouch = false;
  ACT.jump = null;
  ACT.dash = null;
  ACT.guard = null;
  ACT.parry = false;
  ACT.attack = null;
  ACT.hold = false;
  ACT.throw = false;
  ACT.tech = false;
  ACT.say = null;
  return ACT;
}

function defend(s, me, op) {
  // удары
  const k = strikeThreat(me, op);
  if (k >= 0) {
    const a = act();
    if (thrCharge || thrMulti) {
      a.guard = thrZone === 'low' ? 'low' : 'high';
      return a;
    }
    if (k <= 2) {
      a.parry = true;
      return a;
    }
    if (k <= 13) return a; // ждать на месте, не начиная ничего долгого
  }
  // снаряды
  const ps = s.projectiles;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.mine) continue;
    const t = flyThreat(me, p.x, p.y, p.vx, 0, 25, 25, 12);
    if (t < 0) continue;
    const a = act();
    if (t <= 2) a.parry = true;
    return a;
  }
  // объекты соперника с ударом при касании
  const os = s.objects;
  for (let i = 0; i < os.length; i++) {
    const o = os[i];
    if (o.mine || !o.touch) continue;
    const t = flyThreat(me, o.x, o.y, o.vx, o.vy, o.w / 2, o.h / 2, 12);
    if (t < 0) continue;
    const a = act();
    if (t <= 1) a.parry = true;
    return a;
  }
  return null;
}

// ---------- мои фигуры ----------

let liveGuards = 0;
let liveMid = 0;
let kingUp = false;
let objCount = 0;
let foeObj = 0;
function countObjects(s) {
  liveGuards = 0;
  liveMid = 0;
  kingUp = false;
  objCount = 0;
  foeObj = 0;
  const os = s.objects;
  for (let i = 0; i < os.length; i++) {
    const o = os[i];
    if (!o.mine) {
      if (!o.solid) foeObj++;
      continue;
    }
    objCount++;
    if (o.vy < -20) continue; // уже ударила и падает
    if (o.move === 'mate') kingUp = true;
    else {
      liveGuards++;
      if (o.move !== 'pawn') liveMid++;
    }
  }
}

function readyGuard(me, preferMid) {
  for (let i = 0; i < GUARDS.length; i++) {
    const id = GUARDS[preferMid ? i : GUARDS.length - 1 - i];
    if (!(me.cooldowns[id] > 0) && findMove(me.moves, id)) return id;
  }
  return null;
}

function incoming(s, me, horizon) {
  const ps = s.projectiles;
  for (let i = 0; i < ps.length; i++) if (!ps[i].mine && flyThreat(me, ps[i].x, ps[i].y, ps[i].vx, 0, 25, 25, horizon) >= 0) return true;
  const os = s.objects;
  for (let i = 0; i < os.length; i++) if (!os[i].mine && os[i].touch && flyThreat(me, os[i].x, os[i].y, os[i].vx, os[i].vy, os[i].w / 2, os[i].h / 2, horizon) >= 0) return true;
  return false;
}

// Через сколько тиков свободный соперник самое раннее достанет меня ударом или снарядом.
function foeHitTime(op, dist) {
  let best = 999;
  const pace = foe.walk * op.mods.speed;
  const dash = foe.dash * op.mods.speed;
  for (let i = 0; i < foe.strikes.length; i++) {
    const st = foe.strikes[i];
    const gap = dist - st.reach + 8;
    let go = 0;
    if (st.tele) go = 0;
    else if (gap > 0) {
      go = Math.ceil(gap / pace);
      if (gap <= dash && go > 16) go = 16;
    }
    const t = go + st.startup;
    if (t < best) best = t;
  }
  for (let i = 0; i < foe.shots.length; i++) {
    const sh = foe.shots[i];
    const t = sh.startup + Math.max(0, (dist - 120) / sh.speed);
    if (t < best) best = t;
  }
  if (foe.airFast < 99) {
    const t = 3 + Math.max(foe.airFast, (dist - 165) / (foe.jumpVx * op.mods.speed));
    if (t < best) best = t;
  }
  return best;
}

// Можно ли потратить ticks тиков на приём и не получить за это.
function safeFor(s, me, op, dist, ticks) {
  if (lockKind !== FREE && lockKind !== AIR && lockFree >= ticks + 1) return true;
  if (incoming(s, me, ticks + 3)) return false;
  if (op.meter >= 300 && (foe.superFar || dist < foe.reach + foe.dash + 60)) return false;
  if (liveGuards > 0) return true;
  const free = lockKind === FREE ? 0 : lockFree;
  return free + foeHitTime(op, dist) > ticks + 1;
}

// ---------- атака ----------

// Соперник занят: веду удар к нужному тику.
function pursue(s, me, op, dist) {
  const su = K.forkStartup;
  let budget;
  if (lockKind === EXACT) budget = lockFree - su;
  else if (lockKind === WAKE) budget = lockFree - su - 1;
  else budget = lockFree - su;
  if (lockKind === WAKE && budget < 0 && lockFree - su >= 0) budget = 0;
  if (budget < 0) return null;
  if (lockKind === WINDOW) {
    if (op.invulnerable && op.state !== 'dash') return null;
    if (op.state === 'parry' && op.stateTicks + su <= 6) return null;
    if (op.state === 'dash' && op.stateLength === 18 && op.stateTicks + su <= 8) return null;
    if (op.state === 'throw' && op.stateTicks < 7 && dist <= 140) return null;
    if (op.state === 'move' && op.move.armorLeft > 0) return null;
  }
  // куда соперника ещё снесёт
  const slide = Math.abs(op.vx) > 0.1 && (op.state === 'hitstun' || op.state === 'techBreak') ? Math.abs(op.vx) * 4.4 : 0;
  const d = dist + slide;
  const reach = K.forkReach - 22;
  const a = act();
  const wait = lockKind === EXACT || lockKind === WAKE;
  const pace = K.walk * me.mods.speed;
  const need = d <= reach ? 0 : Math.ceil((d - reach) / pace);

  if (kingUp && wait) {
    // король сам ударит в нужный тик: просто подхожу
    a.walk = dist > 112 ? 1 : 0;
    return a;
  }
  if (need === 0 || need <= budget) {
    if (!wait && need === 0) {
      a.attack = 'fork';
      return a;
    }
    if (wait && budget === 0) {
      if (need === 0) a.attack = 'fork';
      else a.walk = 1;
      return a;
    }
    const slack = budget - need;
    if (wait) {
      if (me.meter >= 300 && lockFree >= 5 && op.hp > 600) {
        a.attack = 'mate';
        return a;
      }
      if (slack >= K.castTicks && objCount < 3 && liveGuards < 2) {
        const g = readyGuard(me, true);
        if (g) {
          a.attack = g;
          return a;
        }
      }
    }
    a.walk = dist > 112 ? 1 : 0;
    return a;
  }
  // пешком не успеть
  if (budget >= 16 && d - K.dash * me.mods.speed <= reach + pace * (budget - 16)) {
    a.dash = 'forward';
    return a;
  }
  if (K.castleTicks && budget >= K.castleTicks) {
    a.attack = 'castle';
    return a;
  }
  return null;
}

// Соперник в прыжке: удар к приземлению, если он не успеет ударить первым.
function antiAir(me, op, dist) {
  if (op.state !== 'air') return null;
  const land = lockFree - 3;
  const su = K.forkStartup;
  if (land < su - 3 || land > su) return null;
  if (op.canAirMove && foe.airFast <= land - 1) return null;
  if (op.move) return null;
  const dx = Math.abs(op.x + op.vx * land - me.x);
  if (dx > K.forkReach - 22) return null;
  const a = act();
  a.attack = 'fork';
  return a;
}

function think(s) {
  const me = s.me;
  const op = s.opponent;
  if (me.state === 'grabbed') {
    const a = act();
    a.tech = true;
    return a;
  }
  if (op.state === 'ko' || me.state === 'ko') return act();
  const dist = s.distance;
  lockOf(op);
  countObjects(s);
  // чужие фигуры сорвали мой замах? запоминаю
  if (prevMove) {
    if ((me.state === 'hitstun' || me.state === 'juggle') && foeObj + prevMove.foeObj > 0 && !prevMove.near) {
      learn.countered++;
      learn.counteredAt = s.tick;
    }
    else if (me.state === 'move' && me.move && me.move.id === prevMove.id && me.move.phase !== 'startup' && prevMove.foeObj > 0) learn.cleanStarts++;
  }
  prevMove = me.state === 'move' && me.move && me.move.phase === 'startup' && me.move.slot !== 'super' ? { id: me.move.id, foeObj, near: dist < foe.reach + 10 } : null;

  if (opt.passive) return defend(s, me, op) || act();

  // «Холодная война»: чужие фигуры уже срывали мой замах и снова на поле. Пока они висят,
  // любой мой приём — подарок. Жду: их фигуры кончатся раньше моего терпения.
  const cold = foeObj > 0 && s.tick - learn.counteredAt < 1500 && !opt.bold;

  // 1. Соперник занят — добиваю связку.
  if (!cold && (lockKind === EXACT || lockKind === WAKE || lockKind === WINDOW)) {
    const threat = lockKind === WINDOW ? strikeThreat(me, op) : -1;
    if (threat < 0) {
      const a = pursue(s, me, op, dist);
      if (a) return a;
    }
  }

  // 2. Защита.
  const d = defend(s, me, op);
  if (d) return d;

  // 3. Прыгнул — встречаю.
  if (lockKind === AIR && !cold) {
    const a = antiAir(me, op, dist);
    if (a) return a;
  }

  // 4. Полная шкала — мат.
  if (me.meter >= 300 && !kingUp && op.hp > 0) {
    const a = act();
    a.attack = 'mate';
    return a;
  }

  // 5. Фигуры на доску.
  if (!opt.noopen && !cold && objCount < 3 && liveGuards < 3) {
    const g = readyGuard(me, liveMid === 0);
    if (g && safeFor(s, me, op, dist, K.castTicks)) {
      const a = act();
      a.attack = g;
      return a;
    }
  }

  // 6. Сближение. Шаг вперёд — знак фигурам: одна ударит, как только я смогу продолжить сам.
  //    Пока у соперника на поле не меньше фигур, чем у меня, первым не лезу.
  const a = act();
  if (liveGuards > 0) {
    // чужие фигуры дважды дали мне спокойно начать приём — значит, не сторожат
    const harmless = learn.countered === 0 && learn.cleanStarts >= 2;
    if (!cold && (foeObj === 0 || liveGuards > foeObj || harmless || opt.bold)) a.walk = 1;
  } else if (dist > foe.reach + 60) a.walk = 1;
  return a;
}

// ---------- реплики ----------

const SAY_LOOP = ['hit_3', 'hit_1', 'taunt_2', 'hit_2', 'hit_4'];
const SAY_WAIT = ['taunt_1', 'taunt_3'];
const SAY_HURT = ['hurt_1', 'hurt_2'];
let sayAt = -9999;
let sayN = 0;
let prevMine = '';
function chatter(s, a) {
  const me = s.me;
  const op = s.opponent;
  const t = s.tick;
  let line = null;
  if (prevMine === 'parry' && me.state === 'neutral' && op.state === 'staggered') line = 'parry_1';
  else if (me.state === 'hitstun' && prevMine !== 'hitstun' && t - sayAt > 300) line = SAY_HURT[sayN % SAY_HURT.length];
  else if (t - sayAt > 400) {
    if (op.state === 'hitstun' && op.combo >= 3) line = SAY_LOOP[sayN % SAY_LOOP.length];
    else if (op.state === 'neutral' && me.state === 'neutral' && liveGuards > 0 && s.distance > 240 && t > 200) line = SAY_WAIT[sayN % SAY_WAIT.length];
  }
  prevMine = me.state;
  if (line) {
    a.say = line;
    sayAt = t;
    sayN++;
  }
}

export default {
  init(info) {
    K = null;
    sayAt = -9999;
    sayN = info && info.options && info.options.round ? info.options.round : 0;
    prevMine = '';
    opt = (info && info.options) || {};
    if (info && info.view) setup(info.view);
  },
  tick(s) {
    if (!K) setup(s);
    const a = think(s);
    chatter(s, a);
    return a;
  },
};
