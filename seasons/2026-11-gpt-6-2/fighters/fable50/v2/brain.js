// Главбух Зоя Павловна — мозги. Ведёт ведомость на соперника: что он делает вблизи, после блока, на подъёме,
// как отвечает на снаряды, — и выставляет счёт. Всё считается в шагах ринга по точным кадрам набора.
//
// Время. Вид `s` — состояние после шага v = s.tick; моё действие исполнится на шаге v + 1. Соперника я вижу таким,
// каким он был после шага v − LAG (LAG = 16). Приём, начатый соперником на шаге T, бьёт первым активным кадром на
// шаге T + a − 1 (a — activeStart), а увижу я его (t = 1) в виде v = T + 16.
//
// Слои, сверху вниз: (1) то, что вижу и успеваю — парирую, остальное блокирую; (2) гарантированные наказания и серии;
// (3) встреча прыжка; (4) подъём соперника; (5) тактика: «ставки» по ситуациям — какая тактика приносит больше
// здоровья против этого соперника, считается по ходу боя (ведомость).

import CFG from './cfg.js';

const LAG = 16;
const REACH = { short: 55, mid: 95, long: 150 };
const SPEED = { slow: 6, mid: 9, fast: 13 };
const GRAV = 0.85;
const WALL_L = 40;
const WALL_R = 2160;
const THROW_RANGE = 130;

let M = null;

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const abs = Math.abs;

function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- набор приёмов в удобном виде ----------
function prep(list) {
  const out = {};
  for (const m of list) {
    const r = { id: m.id, slot: m.slot, posture: m.posture, D: m.duration, fa: m.firstActive, armor: m.armor || 0, charge: m.charge || null, strikes: [], proj: null, tele: null, range: 0, dmg: 0 };
    for (const g of m.segments) {
      if (g.type === 'strike') {
        const reach = 70 + REACH[g.reach];
        r.strikes.push({ s: g.start, a: g.activeStart, e: g.activeEnd, zone: g.zone, reach, adv: g.advance || 0, dmg: g.damage, hits: g.hits || 1, launch: !!g.launch, heavy: g.push === 'heavy' });
        r.range = Math.max(r.range, reach + (g.advance || 0));
        r.dmg += g.damage * (g.hits || 1);
      } else if (g.type === 'projectile') {
        r.proj = { a: g.activeStart, speed: SPEED[g.speed], zone: g.zone, dmg: g.damage, hits: g.hits || 1 };
        r.dmg += g.damage * (g.hits || 1);
      } else if (g.type === 'teleport') r.tele = { a: g.activeStart, to: g.to, dist: g.distance || 0 };
    }
    out[m.id] = r;
  }
  return out;
}

// тактики по ситуациям и их начальная оценка (в единицах здоровья за розыгрыш)
const ARMS = {
  contact: { guard: 0, jab: 0, low: 0, twin: 0, flurry: 0, throw: 0, back: 0, heavy: 0, sweep: 0 },
  minus: { guard: 0, back: 0, jab: 0, throw: 0 },
  adv: { mlow: 0, mjab: 0, mtwin: 0, mflurry: 0, mheavy: 0, tthrow: 0, guard: 0 },
  oki: { meaty: 0, throw: 0, bait: 0, space: 0, msuper: 0 },
  mid: { hold: 0, heavy: 0, cyclone: 0, slide: 0, sweep: 0, lance: 0, band: 0, walkin: 0, walkback: 0, jump: 0 },
  far: { lance: 0, fireball: 0, approach: 0, wait: 0, prop: 0 },
};

function setup(s) {
  M.my = prep(s.me.moves);
  M.op = prep(s.opponent.moves);
  M.sup = null;
  for (const id in M.my) if (M.my[id].slot === 'super') M.sup = M.my[id];
  M.opSup = null;
  for (const id in M.op) if (M.op[id].slot === 'super') M.opSup = M.op[id];
  let fast = 0;
  let poke = 0;
  for (const id in M.op) {
    const m = M.op[id];
    if (m.posture === 'air' || m.slot === 'super' || !m.strikes.length) continue;
    if (m.strikes[0].a < 18) {
      fast = Math.max(fast, m.range);
      if (m.strikes[0].adv === 0) poke = Math.max(poke, m.range);
    }
  }
  M.opFast = fast || 225;
  M.opPoke = poke || 225;
  M.opShotFast = false;
  for (const id in M.op) if (M.op[id].proj && M.op[id].proj.speed >= 13 && M.op[id].slot !== 'super') M.opShotFast = true;
  M.lines = {};
  M.lineSets = {};
  for (const l of s.lines) {
    M.lines[l.id] = l.kind;
    const cut = l.id.lastIndexOf('_');
    const base = cut > 0 ? l.id.slice(0, cut) : l.id;
    (M.lineSets[base] || (M.lineSets[base] = [])).push(l.id);
  }
  M.B = {};
  for (const sit in ARMS) {
    M.B[sit] = {};
    for (const arm in ARMS[sit]) M.B[sit][arm] = { q: ARMS[sit][arm], n: 2 };
  }
  M.ready = true;
}

function fresh(info) {
  return {
    ready: false,
    rnd: makeRng(((info && info.seed) || 1) ^ 0x9e3779b9),
    prev: null,
    prevO: null,
    lastTouch: -999,
    lastHurt: -999,
    myLastHit: -999,
    conf: null, // моё чистое попадание: { step, guardStep, x0, push, dir, count }
    blk: null, // мой удар в блок: { step, freeStep }
    stag: null, // соперник оглушён парированием: { until }
    oFreeAt: -999, // шаг, когда соперник последний раз вышел из блокстана, хитстана или подъёма
    oInv: -999, // до какого шага соперник неуязвим (серия из 5, вырвался из давления)
    oPress: 0,
    oBreath: 0,
    myInv: -999,
    tac: null,
    bets: [],
    hMe: new Array(1024).fill(0),
    hOp: new Array(1024).fill(0),
    say: null,
    lastSay: -999,
    said: {},
    bait: info && info.opponent && info.opponent.name === 'Метроном' ? 2.2 : 0.3, // как часто мои удары вблизи уходят в пустоту и наказываются
    // ведомость привычек соперника
    C: { atk: 2, slow: 1, thr: 1, grd: 2, idle: 1, esc: 0.5 },
    A: { atk: 1.2, thr: 0.6, grd: 2, idle: 0.6, esc: 0.8 }, // что он делает, выйдя из стана рядом со мной
    Wk: { atk: 1, thr: 0.5, grd: 2.2, idle: 0.6, esc: 0.6 }, // что он делает на подъёме
    watch: null,
    gHi: 1, gLo: 1, gNo: 1,
    shots: { near: { hit: 1, blk: 1.5, par: 0.3 }, far: { hit: 0.8, blk: 1, par: 1 } }, // исходы моих снарядов: вблизи (не успеть парировать на глаз) и издали
    jumps: 0, antiAirs: 0, aaFail: 0,
    opThrows: 0,
    out: {}, // исходы моих приёмов: id → { hit, blk, whf }
    thr: { land: 1.2, whiff: 0.8, tech: 0.3, stuffed: 0.7 }, // исходы моих бросков
    myThrow: null,
    sample: 0,
    wake: null,
    okiPlan: null,
    startDone: false,
    myShot: null,
    parryTry: null,
    lastAtk: null,
    event: null,
    myWakePlan: null,
  };
}

// ---------- где соперник сейчас ----------
function airAt(o, n) {
  let x = o.x;
  let y = o.y;
  let vy = o.vy;
  for (let i = 1; i <= n; i++) {
    vy -= GRAV;
    x += o.vx;
    y += vy;
    if (y <= 0) return { x: clamp(x, WALL_L, WALL_R), y: 0, landed: i };
  }
  return { x: clamp(x, WALL_L, WALL_R), y, landed: 0 };
}

const WAKE_GUARD = { getup: 1, knockdown: 1, hitstun: 1, landing: 1, staggered: 1, dizzy: 1, techBreak: 1, throwing: 1, throw: 1, parry: 1, blockstun: 1 };

function look(s) {
  const me = s.me;
  const o = s.opponent;
  const v = s.tick;
  const dir = o.x >= me.x ? 1 : -1; // от меня к сопернику
  const rem = Math.max(0, o.stateLength - o.stateTicks);
  let ox = o.x;
  let oy = o.y;
  let air = false;
  let freeIn = -LAG + 1; // на шаге v + freeIn он сможет действовать (<= 1 — уже может)
  let whiff = false;
  let down = false; // лежит или встаёт: неуязвим до подъёма
  const st = o.state;
  const odx = M.prevO ? o.x - M.prevO.x : 0;
  if (st === 'move' && o.move) {
    const mv = M.op[o.move.id];
    const tau = o.move.t;
    let D = o.move.duration;
    if (mv && mv.posture !== 'air') {
      if (mv.strikes.length) {
        const last = mv.strikes[mv.strikes.length - 1];
        const firstStep = v - LAG - tau + mv.strikes[0].a;
        const lastStep = v - LAG - tau + last.e - 1;
        if (lastStep < v && M.lastTouch < firstStep - 1 && D === mv.D) {
          whiff = true;
          D += 8;
        }
      }
      freeIn = D - tau - LAG + 1;
      for (const g of mv.strikes) {
        if (g.adv && tau < g.a) {
          const done = Math.min(g.a, tau + LAG);
          let step = (g.adv * (done - Math.max(tau, g.s))) / (g.a - g.s);
          if (o.facing === -dir) step = Math.min(step, Math.max(0, abs(me.x - ox) - 70));
          ox += o.facing * step;
        }
      }
      if (mv.tele && tau < mv.tele.a && tau + LAG >= mv.tele.a) {
        if (mv.tele.to === 'behind') {
          let x = me.x - dir * 90;
          if (x < WALL_L || x > WALL_R) x = me.x + dir * 90;
          ox = x;
        } else ox = clamp(o.x - o.facing * mv.tele.dist, WALL_L, WALL_R);
      }
    } else if (mv) {
      const p = airAt(o, LAG);
      ox = p.x;
      oy = p.y;
      air = !p.landed;
      freeIn = p.landed ? p.landed + 4 - LAG + 1 : 8;
    }
  } else if (st === 'air' || st === 'juggle') {
    const p = airAt(o, LAG);
    ox = p.x;
    oy = p.y;
    air = !p.landed;
    if (st === 'juggle') {
      const q = airAt(o, 90);
      freeIn = (q.landed || 40) + 64 - LAG + 1;
      down = true;
    } else if (p.landed) freeIn = p.landed + 3 - LAG + 1;
    else {
      const q = airAt(o, 80);
      freeIn = q.landed + 3 - LAG + 1;
    }
  } else if (st === 'prejump') {
    air = true;
    oy = 1;
    freeIn = 30;
  } else if (st === 'dash') {
    const len = o.stateLength || 16;
    const back = len === 18;
    const total = back ? 140 : o.derived.dashDistance;
    const k = o.stateTicks / len;
    const left = total * (1 - k) * (1 - k);
    const ddir = odx !== 0 ? sign(odx) : back ? dir : -dir;
    ox = o.x + ddir * left;
    if (ddir === -dir) ox = dir > 0 ? Math.max(ox, me.x + 70) : Math.min(ox, me.x - 70);
    freeIn = rem - LAG + 1;
  } else if (st === 'hitstun' || st === 'blockstun') {
    ox = o.x + (o.vx * (1 - Math.pow(0.82, Math.min(rem, LAG)))) / 0.18;
    freeIn = rem - LAG + 1;
  } else if (st === 'knockdown') {
    freeIn = rem + 20 - LAG + 1;
    down = true;
  } else if (st === 'getup') {
    freeIn = rem - LAG + 1;
    down = true;
  } else if (st === 'thrown') {
    freeIn = rem + 64 - LAG + 1;
    down = true;
    ox = clamp(me.x + dir * 170, WALL_L, WALL_R);
  } else if (st === 'grabbed') {
    freeIn = 13 - o.stateTicks + 22 + 64 - LAG + 1;
    down = true;
    ox = clamp(me.x + dir * 170, WALL_L, WALL_R);
  } else if (st === 'neutral') {
    let k = 0.7;
    if (sign(o.vx) === -dir) k = 0.85; // идёт на меня — считаю, что продолжает
    ox = o.x + o.vx * LAG * k;
    if (sign(o.vx) === -dir) ox = dir > 0 ? Math.max(ox, me.x + 70) : Math.min(ox, me.x - 70);
  } else if (st === 'ko') freeIn = 999;
  else freeIn = rem - LAG + 1; // landing, parry, throw, staggered, dizzy, techBreak, use, throwing
  // то, что я знаю сразу (мой удар или снаряд только что попал или ушёл в блок), важнее запоздалого вида
  let live = null;
  if (M.conf && v <= M.conf.guardStep && v - M.conf.step < LAG + 2) {
    live = 'hit';
    whiff = false;
    const pushed = (M.conf.push * (1 - Math.pow(0.82, Math.min(v - M.conf.step + 1, 40)))) / 0.18;
    ox = clamp(M.conf.x0 + M.conf.dir * pushed, WALL_L, WALL_R);
    if (M.conf.launch) {
      freeIn = M.conf.step + 36 + 64 - v;
      down = true;
      air = v - M.conf.step < 34;
    } else {
      freeIn = M.conf.guardStep + 1 - v;
      down = false;
      air = false;
    }
  } else if (M.blk && v < M.blk.freeStep && v - M.blk.step < LAG + 2) {
    live = 'blk';
    whiff = false;
    freeIn = M.blk.freeStep - v;
    down = false;
    air = false;
  }
  if (down && freeIn < 1) down = false;
  ox = clamp(ox, WALL_L, WALL_R);
  const dNow = Math.max(abs(ox - me.x), me.y > 0 || air ? 0 : 70);
  const blind = Math.max(0, Math.min(LAG, 1 - freeIn));
  const dMin = Math.max(70, dNow - Math.max(0, blind * o.derived.walk - abs(ox - o.x)));
  // gStep: первый шаг (от v), на котором он может закрыться блоком; до него попадание гарантировано
  let gStep = freeIn;
  if (WAKE_GUARD[st] || live) gStep = freeIn - 1;
  if (freeIn <= 1) gStep = 0;
  return { v, dir, ox, oy, air, freeIn, gStep, down, whiff, live, dNow, dMin, d: abs(o.x - me.x), rem, odx, blind, myWall: dir > 0 ? me.x - WALL_L : WALL_R - me.x, opWall: dir > 0 ? WALL_R - ox : ox - WALL_L };
}

// ---------- что летит в меня ----------
function threats(s, P) {
  const me = s.me;
  const o = s.opponent;
  const out = [];
  M.pr = [];
  const projHit = (x0, vx, k0, zone, dmg, id) => {
    M.pr.push({ x: x0, vx, k0, zone });
    if (zone === 'low' && me.y > 45) return;
    let x = x0;
    for (let j = k0; j <= 80; j++) {
      x += vx;
      if (j < 1) continue;
      if (abs(x - me.x) < 62) {
        out.push({ k: j, k1: j + 8, zone, kind: 'proj', dmg, id, inRange: true, sure: true });
        return;
      }
      if (sign(me.x - x) !== sign(vx)) return;
    }
  };
  if (o.state === 'move' && o.move && M.op[o.move.id]) {
    const mv = M.op[o.move.id];
    const tau = o.move.t;
    let ox = o.x;
    let facing = o.facing;
    if (mv.posture !== 'air') {
      if (mv.tele && tau < mv.tele.a) {
        if (mv.tele.to === 'behind') {
          let x = me.x - P.dir * 90;
          if (x < WALL_L || x > WALL_R) x = me.x + P.dir * 90;
          ox = x;
          facing = me.x >= ox ? 1 : -1;
        } else ox = clamp(o.x - o.facing * mv.tele.dist, WALL_L, WALL_R);
      }
      for (const g of mv.strikes) {
        const k0 = g.a - tau - LAG;
        let k1 = g.e - 1 - tau - LAG;
        let sure = true;
        if (mv.charge && tau < g.a) {
          sure = false; // заряд: момент удара выбирает он
          k1 += mv.charge.maxHold - (o.move.held || 0);
        }
        if (k1 < 1) continue;
        let ax = ox;
        if (g.adv && tau < g.a) {
          let step = (g.adv * (g.a - Math.max(tau, g.s))) / (g.a - g.s);
          if (sign(me.x - ax) === facing) step = Math.min(step, Math.max(0, abs(me.x - ax) - 70));
          ax += facing * step;
        }
        const dist = abs(me.x - ax);
        const toward = sign(me.x - ax) === facing || dist < 5;
        out.push({ k: Math.max(k0, 1), k0, k1, zone: g.zone, kind: 'strike', dmg: g.dmg, id: mv.id, inRange: toward && dist < g.reach + 14, dist, reach: g.reach, sure: sure && k0 >= 1, hits: g.hits, armor: mv.armor });
      }
      if (mv.proj && tau < mv.proj.a) projHit(ox + facing * 60, facing * mv.proj.speed, mv.proj.a - tau - LAG, mv.proj.zone, mv.proj.dmg, mv.id);
    } else {
      for (const g of mv.strikes) {
        const k0 = g.a - tau - LAG;
        const k1 = g.e - 1 - tau - LAG;
        if (k1 < 1) continue;
        const p = airAt(o, LAG + Math.max(1, k0));
        if (p.landed && p.landed < LAG + Math.max(1, k0)) continue;
        const dist = abs(me.x - p.x);
        const toward = sign(me.x - p.x) === o.facing;
        out.push({ k: Math.max(k0, 1), k0, k1, zone: 'air', kind: 'strike', dmg: g.dmg, id: mv.id, inRange: toward && dist < g.reach + 30, dist, reach: g.reach, sure: k0 >= 1, hits: g.hits, armor: 0 });
      }
    }
  }
  if (o.state === 'use' && o.stateTicks < 16) projHit(o.x + o.facing * 60, o.facing * 13, 16 - o.stateTicks - LAG + 1, 'mid', 80, 'stage');
  for (const p of s.projectiles) {
    if (p.mine) continue;
    const x = p.x + p.vx * LAG;
    if (abs(x - me.x) < 62) continue; // уже во мне: либо задел, либо погас
    if (sign(me.x - x) !== sign(p.vx)) continue;
    projHit(x, p.vx, 1, p.zone, p.damage, 'proj');
  }
  out.sort((a, b) => a.k - b.k);
  return out;
}

const guardFor = (zone) => (zone === 'overhead' || zone === 'air' ? 'high' : 'low');

// через сколько шагов меня заденет снаряд, если я за время замаха проеду вперёд на adv (вихрь, подкат, колено)
function projK(s, P, adv) {
  let best = 999;
  for (const p of M.pr) {
    let x = p.x;
    for (let j = p.k0; j <= 70; j++) {
      x += p.vx;
      if (j < 1) continue;
      const mx = s.me.x + P.dir * Math.min(adv, (adv * j) / 12);
      if (abs(x - mx) < 64) {
        if (j < best) best = j;
        break;
      }
      if (sign(mx - x) !== sign(p.vx)) break;
    }
  }
  return best;
}

// можно ли начать приём: снаряд не должен прилететь раньше, чем приём кончится (или хотя бы ударит)
function clear(s, P, id, strict) {
  const m = M.my[id];
  if (!M.pr.length) return true;
  const adv = m.strikes.length ? m.strikes[0].adv : 0;
  const k = projK(s, P, adv);
  return k > (strict ? m.D + 1 : (m.strikes.length ? m.strikes[0].a : m.D) + 3);
}

// ---------- ведомость ----------
// слом защиты соперника: 40 шагов он открыт
function crushed(s, P) {
  M.stag = { until: s.tick + 40, crush: true };
  M.stagDash = 0;
  M.blk = null;
  say(s, 'crush_1');
}

function bump(T, k, w) {
  for (const key in T) T[key] *= 0.96;
  T[k] = (T[k] || 0) + w;
}

function probs(T) {
  let sum = 0;
  for (const k in T) sum += T[k];
  const p = {};
  for (const k in T) p[k] = T[k] / sum;
  return p;
}

function outcome(id, kind) {
  const r = M.out[id] || (M.out[id] = { hit: 1, blk: 1, whf: 0.5 });
  r.hit *= 0.9;
  r.blk *= 0.9;
  r.whf *= 0.9;
  r[kind] += 1;
  if (kind === 'whf') M.bait = M.bait * 0.95 + 1;
  else if (kind === 'hit') M.bait *= 0.85;
}

function observe(s, P) {
  const me = s.me;
  const o = s.opponent;
  const v = s.tick;
  const pm = M.prev;
  M.event = null;
  M.hMe[v & 1023] = me.hp;
  M.hOp[(v - LAG) & 1023] = o.hp;
  if (pm) {
    // пропуск шагов в записи (стоп-кадр не меняет tick, но на всякий случай)
    for (let t = pm.v + 1; t < v; t++) {
      M.hMe[t & 1023] = pm.hp;
      M.hOp[(t - LAG) & 1023] = M.prevO ? M.prevO.hp : o.hp;
    }
    const dm = me.meter - pm.meter;
    const hurtNow = me.state === 'hitstun' || me.state === 'juggle' || me.state === 'grabbed' || me.state === 'thrown';
    const wasHurt = pm.state === 'hitstun' || pm.state === 'juggle' || pm.state === 'grabbed' || pm.state === 'thrown';
    if (hurtNow && (!wasHurt || me.combo > pm.combo || me.hp < pm.hp)) {
      M.lastTouch = v;
      M.lastHurt = v;
      M.event = me.state === 'grabbed' && pm.state !== 'grabbed' ? 'grabbed' : 'hurt';
    } else if (me.state === 'blockstun' && (pm.state !== 'blockstun' || me.stateTicks < pm.stateTicks || me.guardGauge > pm.guardGauge + 0.01)) {
      M.lastTouch = v;
      M.event = 'block';
    } else if (pm.state === 'parry' && me.state === 'neutral' && pm.stateTicks < 7 && dm > 11.5) {
      M.lastTouch = v;
      M.event = 'parry';
    } else if (me.state === 'staggered' && pm.state !== 'staggered') {
      M.event = pm.state === 'move' ? 'parried' : 'crushed';
      M.lastTouch = v;
      if (pm.state === 'move' && pm.move) outcome(pm.move.id, 'blk');
    }
    // мой удар: попал или в блок — видно по шкале сразу
    if (pm.state === 'move' && pm.move && dm > 0.01 && !hurtNow && M.event !== 'block') {
      const mv = M.my[pm.move.id];
      const t = me.state === 'move' && me.move ? me.move.t : pm.move.t + 1;
      let seg = null;
      if (mv) for (const g of mv.strikes) if (t >= g.a && t <= g.e) seg = g;
      if (seg && mv.slot !== 'super') {
        const ratio = (dm >= 30 ? dm - 30 : dm) / seg.dmg;
        if (dm >= 30) crushed(s, P);
        if (ratio > 0.11) {
          const hs = 14 + Math.floor(seg.dmg / 6);
          const cnt = M.conf && v - M.conf.step < 40 ? M.conf.count + 1 : 1;
          const x0 = M.conf && cnt > 1 ? clamp(M.conf.x0 + M.conf.dir * (M.conf.push * (1 - Math.pow(0.82, v - M.conf.step))) / 0.18, WALL_L, WALL_R) : P.ox;
          M.conf = { step: v, guardStep: v + hs, launch: seg.launch || P.air, x0, push: seg.heavy ? 9 : 5, dir: P.dir, count: cnt, id: mv.id, dmg: seg.dmg };
          M.myLastHit = v;
          M.event = 'hit';
          if (cnt === 1 || mv.id !== M.lastOutId) outcome(mv.id, 'hit');
          M.lastOutId = mv.id;
          if (cnt >= 5) M.oInv = v + hs + 30;
        } else if (ratio > 0.05) {
          const total = me.state === 'move' && me.move ? me.move.duration : mv.D;
          const stun = Math.max(1, Math.min(10 + Math.floor(seg.dmg / 10), total - t - 2));
          M.blk = { step: v, freeStep: v + stun + 1, id: mv.id };
          M.oFreeAt = v + stun;
          M.myLastHit = v;
          M.event = 'blocked';
          if (!M.lastBlkStep || v - M.lastBlkStep > 30 || mv.id !== M.lastOutId) outcome(mv.id, 'blk');
          M.lastOutId = mv.id;
          M.lastBlkStep = v;
        }
      }
    }
    // мой приём кончился и никого не задел
    if (pm.state === 'move' && pm.move && me.state !== 'move' && M.lastAtk && M.lastAtk.id === pm.move.id && M.myLastHit < M.lastAtk.step && M.my[pm.move.id] && M.my[pm.move.id].strikes.length && !hurtNow) outcome(pm.move.id, 'whf');
    if (pm.state === 'throw' && me.state !== 'throw') {
      let k = 'whiff';
      if (me.state === 'throwing') {
        k = 'land';
        M.event = 'threw';
        M.myLastHit = v;
      } else if (me.state === 'techBreak') k = 'tech';
      else if (hurtNow) k = 'stuffed';
      for (const key in M.thr) M.thr[key] *= 0.88;
      M.thr[k] += 1;
      if (k === 'whiff') M.bait = M.bait * 0.95 + 1.2;
    }
    if (pm.projectileOut && !me.projectileOut && M.myShot) {
      const T = M.shots[M.myShot.near ? 'near' : 'far'];
      let k = null;
      if (dm > 0.01) {
        k = (dm >= 30 ? dm - 30 : dm) / M.myShot.dmg > 0.11 ? 'hit' : 'blk';
        M.myLastHit = v;
        if (k === 'hit') {
          const hs = 14 + Math.floor(M.myShot.dmg / 6);
          M.conf = { step: v, guardStep: v + hs, launch: P.air, x0: P.ox, push: 5, dir: P.dir, count: M.conf && v - M.conf.step < 40 ? M.conf.count + 1 : 1, id: M.myShot.id, dmg: M.myShot.dmg, proj: true };
          M.event = 'hit';
        } else {
          const stun = 10 + Math.floor(M.myShot.dmg / 10);
          M.blk = { step: v, freeStep: v + stun + 1, id: M.myShot.id, proj: true };
          M.oFreeAt = v + stun;
        }
        if (dm >= 30) crushed(s, P);
      } else if (v - M.myShot.step < 140) k = 'par';
      if (k) {
        for (const key in T) T[key] *= 0.9;
        T[k] += 1;
      }
      M.myShot = null;
    }
    // я неуязвим после того, как вырвался
    if (me.invulnerable && me.state === 'neutral' && !(pm.invulnerable && pm.state === 'neutral')) M.myInv = v + (pm.state === 'hitstun' || pm.state === 'dizzy' ? 55 : 20);
    if (!me.invulnerable) M.myInv = -999;
  }
  // давление на соперника: 120 шагов в хитстане подряд — вырвется и будет неуязвим
  const inStun = (M.conf && v <= M.conf.guardStep) || o.state === 'hitstun' || o.state === 'juggle' || o.state === 'dizzy';
  if (inStun) {
    M.oPress++;
    M.oBreath = 0;
  } else if (++M.oBreath >= 30) M.oPress = 0;
  if (o.pressure > M.oPress) M.oPress = o.pressure;

  // привычки соперника: что он начал делать (вижу с опозданием)
  const po = M.prevO;
  if (po) {
    const started = o.state !== po.state || (o.state === 'move' && o.move && (!po.move || po.move.id !== o.move.id || o.move.t < po.move.t));
    const dObs = abs(o.x - me.x);
    let cls = null;
    if ((po.state === 'hitstun' || po.state === 'blockstun' || po.state === 'getup') && o.state !== po.state) M.oFreeAt = Math.max(M.oFreeAt, v - LAG);
    if (o.invulnerable && (o.state === 'neutral' || o.state === 'move' || o.state === 'dash') && !(o.state === 'move' && o.move && M.op[o.move.id] && (M.op[o.move.id].slot === 'super' || M.op[o.move.id].tele))) M.oInv = Math.max(M.oInv, v + 4);
    if (started) {
      if (o.state === 'move' && o.move && M.op[o.move.id]) {
        const mv = M.op[o.move.id];
        if (mv.strikes.length && mv.posture !== 'air') cls = mv.strikes[0].a < 10 ? 'atk' : 'slow';
        else if (mv.proj) cls = 'slow';
        else if (mv.tele) cls = 'esc';
      } else if (o.state === 'throw') {
        cls = 'thr';
        M.opThrows++;
      } else if (o.state === 'prejump') {
        cls = 'esc';
        M.jumps++;
      } else if (o.state === 'dash' && sign(P.odx) === P.dir) cls = 'esc';
    }
    const idle = o.state === 'neutral' && po.state === 'neutral';
    if (idle && dObs < 230) {
      M.sample++;
      if (M.sample % 8 === 0) {
        if (o.guard) {
          cls = 'grd';
          if (o.guard === 'high') M.gHi = M.gHi * 0.97 + 1;
          else M.gLo = M.gLo * 0.97 + 1;
          M.gNo *= 0.97;
        } else {
          cls = sign(o.vx) === P.dir ? 'esc' : 'idle';
          M.gNo = M.gNo * 0.97 + 1;
          M.gHi *= 0.97;
          M.gLo *= 0.97;
        }
      }
    }
    if (cls && (dObs < 230 || cls === 'thr')) bump(M.C, cls, cls === 'grd' || cls === 'idle' ? 0.5 : 1);
    // первое действие после стана или подъёма рядом со мной
    const seen = v - LAG;
    const wasLocked = po.state === 'hitstun' || po.state === 'blockstun' || po.state === 'getup' || po.state === 'move' || po.state === 'landing' || po.state === 'techBreak';
    const leftStun = wasLocked && o.state === 'neutral';
    if (leftStun && dObs < 260) M.watch = { table: po.state === 'getup' ? 'Wk' : 'A', from: seen, done: false };
    if (M.watch && !M.watch.done) {
      let c = null;
      if (o.state === 'move' && o.move && M.op[o.move.id]) c = M.op[o.move.id].tele ? 'esc' : 'atk';
      else if (o.state === 'throw') c = 'thr';
      else if (o.state === 'dash' && sign(P.odx) === P.dir) c = 'esc';
      else if (o.state === 'prejump' || o.state === 'air') c = 'esc';
      else if (o.state === 'neutral' && sign(o.vx) === P.dir && seen - M.watch.from >= 4) c = 'esc';
      else if (o.state === 'neutral' && seen - M.watch.from >= 9) c = o.guard ? 'grd' : 'idle';
      else if (o.state !== 'neutral' && o.state !== 'dash') c = 'x';
      if (c) {
        M.watch.done = true;
        if (c !== 'x') bump(M[M.watch.table], c, 1);
        if (c !== 'x' && M.watch.table === 'Wk') M.wkSeen = (M.wkSeen || 0) + 1;
      }
    }
  }
  if (M.conf && v >= M.conf.guardStep + 8) M.conf = null;
  if (M.blk && v > M.blk.freeStep + 14) M.blk = null;
  if (M.stag && v >= M.stag.until) M.stag = null;
  credit(s);
}

// ---------- ставки: какая тактика сколько приносит ----------
function credit(s) {
  const v = s.tick;
  for (let i = M.bets.length - 1; i >= 0; i--) {
    const b = M.bets[i];
    if (b.t1 === null && v - b.t0 > 110) b.t1 = b.t0 + 110;
    if (b.t1 === null || v < b.t1 + LAG + 1) continue;
    const t1 = Math.max(b.t1, b.t0 + 16);
    if (v < t1 + LAG + 1) continue;
    const r = M.hOp[b.t0 & 1023] - M.hOp[t1 & 1023] - (M.hMe[b.t0 & 1023] - M.hMe[t1 & 1023]);
    const cell = M.B[b.sit][b.arm];
    cell.n += 1;
    const alpha = Math.max(0.15, 1 / cell.n);
    cell.q += alpha * (clamp(r, -200, 200) - cell.q);
    M.bets.splice(i, 1);
  }
}

function pick(s, sit, opts, temp) {
  // opts: [[arm, bonus], …]
  const v = s.tick;
  let best = -1e9;
  const vals = [];
  for (const [arm, bonus] of opts) {
    const cell = M.B[sit][arm];
    const val = cell.q + bonus + 4 / Math.sqrt(cell.n);
    vals.push(val);
    if (val > best) best = val;
  }
  let sum = 0;
  const w = [];
  for (const val of vals) {
    const x = Math.exp((val - best) / temp);
    w.push(x);
    sum += x;
  }
  let r = M.rnd() * sum;
  let idx = 0;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) { idx = i; break; }
  }
  const arm = opts[idx][0];
  for (const b of M.bets) if (b.t1 === null) b.t1 = v;
  M.bets.push({ sit, arm, t0: v, t1: null });
  if (M.bets.length > 12) M.bets.shift();
  return arm;
}

// ---------- удары ----------
function atk(s, id, why) {
  const m = M.my[id];
  if (m.proj) M.myShot = { step: s.tick, dmg: m.proj.dmg, id, near: M.dNowLast < (m.proj.speed >= 13 ? 236 : 160) };
  M.lastAtk = { id, step: s.tick };
  return { attack: id, crouch: m.posture === 'crouch', _why: why };
}

const stale = (s, id) => (s.me.stale && s.me.stale[id] !== undefined ? s.me.stale[id] : 1);
const supReady = (s) => M.sup && s.me.meter >= 300;
const throwOk = (s) => s.tick + 1 - M.oFreeAt >= 6;

// Лучшее гарантированное наказание: первый активный кадр должен прийтись на шаг <= v + avail.
function punish(s, P, avail, dist, opts) {
  const me = s.me;
  const o = s.opponent;
  let best = null;
  const add = (id, val, why) => {
    if (id !== 'throw' && M.my[id] && M.my[id].slot !== 'super' && !clear(s, P, id, false)) return;
    if (!best || val > best.val) best = { id, val, why };
  };
  if (supReady(s) && M.sup.posture !== 'air') {
    const g = M.sup.strikes[0];
    if (g && !M.sup.proj && M.sup.fa <= avail && (M.sup.tele || dist < g.reach + g.adv - 8)) add(M.sup.id, Math.min(450, o.hp) + 30, 'super');
    if (M.sup.proj && M.sup.fa + Math.ceil(Math.max(0, dist - 120) / M.sup.proj.speed) + 1 <= avail) add(M.sup.id, Math.min(360, o.hp) + 30, 'super');
  }
  const kd = M.oPress > 70 ? 40 : 16; // нокдаун: время, позиция и сброс давления
  if (!opts.air) {
    if (opts.throwable && avail >= 6 && dist <= THROW_RANGE - 4 && throwOk(s)) add('throw', 91 * stale(s, 'throw') + kd + 2, 'throw');
    if (avail >= 4 && dist <= 96 && !opts.crouch) add('jab', 25 * stale(s, 'jab') + 56 * stale(s, 'upper') + kd, 'jab>upper');
    else if (avail >= 4 && dist <= 118) add('jab', 25 * stale(s, 'jab') + 4, 'jab');
    if (avail >= 5 && dist <= 116 && !opts.crouch) add('upper', 70 * stale(s, 'upper') + kd, 'upper');
    if (avail >= 7 && dist <= 158) add('low', 35 * stale(s, 'low'), 'low');
    if (M.my.twin && avail >= 8 && dist <= 158) add('twin', 59 * stale(s, 'twin'), 'twin');
    if (avail >= 10 && dist <= 200) add('knee', 45 * stale(s, 'knee') + 8, 'knee');
    if (M.my.cyclone && avail >= 12 && dist <= 272) add('cyclone', 58 * stale(s, 'cyclone') + kd, 'cyclone');
    if (avail >= 12 && dist <= 212) add('sweep', 55 * stale(s, 'sweep') + kd, 'sweep');
    if (avail >= 13 && dist <= 212) add('heavy', 65 * stale(s, 'heavy'), 'heavy');
    if (M.my.slide && avail >= 14 && dist <= 350) add('slide', 50 * stale(s, 'slide') + kd, 'slide');
    if (M.my.flurry && avail >= 9 && dist <= 158) add('flurry', 55 * stale(s, 'flurry'), 'flurry');
    if (M.my.smash && avail >= 12 && dist <= 212) add('smash', 53 * stale(s, 'smash'), 'smash');
    if (M.my.rush && avail >= 18 && dist <= 430) add('rush', 60 * stale(s, 'rush'), 'rush');
    if (avail >= 20 && dist <= 92 && !opts.crouch) add('overhead', 60 * stale(s, 'overhead') + 20 * stale(s, 'jab') + 40, 'overhead>jab');
  } else {
    if (avail >= 5 && dist <= 116) add('upper', 70 * stale(s, 'upper') + 14, 'aa-upper');
    if (avail >= 13 && dist <= 212) add('heavy', 65 * stale(s, 'heavy') + 14, 'aa-heavy');
    if (avail >= 4 && dist <= 118) add('jab', 25 * stale(s, 'jab') + 14, 'aa-jab');
  }
  for (const id of ['lance', 'spike', 'fireball']) {
    const m = M.my[id];
    if (!m || me.projectileOut) continue;
    if (id === 'spike' && opts.crouch) continue;
    const fly = Math.ceil(Math.max(0, dist - 120) / m.proj.speed) + 1;
    if (m.proj.a + fly <= avail) add(id, m.proj.dmg * stale(s, id) - 2, id);
  }
  if (!best) return null;
  if (best.id === 'throw') return { throw: true, _why: 'punish:throw' };
  return atk(s, best.id, 'punish:' + best.why);
}

// ---------- реплики ----------
function say(s, id) {
  if (s.tick - M.lastSay < 320 || M.say) return;
  // у реплики могут быть варианты (parry_1, parry_2…): беру тот, что давно не звучал
  const cut = id.lastIndexOf('_');
  const set = M.lineSets[cut > 0 ? id.slice(0, cut) : id];
  if (!set) return;
  let pickId = null;
  let oldest = 1e9;
  for (const x of set) {
    const t = M.said[x] === undefined ? -1e6 + M.rnd() : M.said[x];
    if (t < oldest) { oldest = t; pickId = x; }
  }
  if (!pickId || (M.said[pickId] !== undefined && s.tick - M.said[pickId] < 1200)) return;
  M.say = pickId;
  M.said[pickId] = s.tick;
}

// реплики по ходу боя: ведомость вслух
function chatter(s, P) {
  const me = s.me;
  const o = s.opponent;
  const v = s.tick;
  if (M.event === 'hurt' && me.hp < me.maxHp * 0.3 && !M.flagLow) { M.flagLow = true; say(s, 'lowhp_1'); }
  else if (M.event === 'hurt' && M.rnd() < 0.12) say(s, 'hurt_1');
  if (o.hp < o.maxHp * 0.2 && !M.flagFin && me.hp > o.hp) { M.flagFin = true; say(s, 'finish_1'); }
  if (s.timeLeft < 1200 && !M.flagTime) { M.flagTime = true; say(s, 'time_1'); }
  if (M.event === 'threw') say(s, 'throw_1');
  if (P.down && P.freeIn > 40 && P.freeIn < 60 && M.rnd() < 0.02) say(s, 'knockdown_1');
  // соперник повторяется, и я его на этом ловлю
  if (M.event === 'hit' || M.event === 'parry' || M.event === 'threw') {
    M.streak = (M.streak || 0) + 1;
    if (M.streak >= 3 && M.rnd() < 0.5) { say(s, 'read_1'); M.streak = 0; }
  } else if (M.event === 'hurt' || M.event === 'grabbed') M.streak = 0;
  if (v > 600 && v - M.lastSay > 900 && me.canAct && P.dNow > 300 && M.rnd() < 0.004) say(s, 'taunt_1');
}

// ---------- главное решение ----------
function decide(s, P) {
  const me = s.me;
  const o = s.opponent;
  const v = s.tick;
  const all = threats(s, P);
  const th = all.filter((t) => t.inRange);
  const t0 = th[0] || null;

  // --- я не свободен ---
  if (!me.canAct) {
    if (me.state === 'move') {
      const mv = me.move && M.my[me.move.id];
      if (mv && mv.charge) return { hold: holdCharge(s, P), _why: 'hold' };
      return { _why: 'busy' };
    }
    if (me.state === 'air') return airAct(s, P);
    let g = 'low';
    if (t0 && t0.k <= 30) g = guardFor(t0.zone);
    else if (P.air && P.dNow < 260 && o.state !== 'juggle') g = 'high';
    return { guard: g, _why: 'stun-guard' };
  }

  // --- угроза, которую вижу ---
  if (t0) {
    if (t0.sure && t0.k >= 1 && t0.k <= 3) {
      M.parryTry = { step: v, kind: t0.kind, id: t0.id };
      return { parry: true, _why: 'parry:' + t0.id + '@' + t0.k };
    }
    if (t0.k <= 9 || !t0.sure) {
      if (!t0.sure && t0.kind === 'strike' && supReady(s) && M.sup.strikes[0] && !M.sup.tele && M.sup.posture !== 'air' && P.dNow < M.sup.strikes[0].reach - 10) return atk(s, M.sup.id, 'super-vs-charge');
      // броня на замахе: бросок её пробивает
      if (t0.kind === 'strike' && t0.armor && t0.k >= 6 && P.dNow <= THROW_RANGE - 6 && throwOk(s) && t0.sure) return { throw: true, _why: 'throw-vs-armor' };
      return { guard: guardFor(t0.zone), _why: 'guard:' + t0.id + '@' + t0.k };
    }
  }
  const commit = t0 ? t0.k - 4 : 999; // на сколько шагов можно занять себя

  // --- я неуязвим (вырвался из давления): бью первым ---
  if (v < M.myInv - 8 && P.freeIn <= 1 && !P.air) {
    if (P.dNow <= THROW_RANGE - 6 && throwOk(s)) return { throw: true, _why: 'inv-throw' };
    if (P.dNow <= 116) return atk(s, 'jab', 'inv-jab');
    if (P.dNow <= 156 && v < M.myInv - 12) return atk(s, 'low', 'inv-low');
    if (P.dNow <= 208 && v < M.myInv - 18) return atk(s, 'heavy', 'inv-heavy');
  }

  const oInv = v < M.oInv;

  // --- серия после подтверждённого попадания ---
  if (M.conf && !M.conf.launch && !oInv) {
    const lim = M.conf.guardStep - 1 - v; // стартап, который ещё успевает
    const pushed = (M.conf.push * (1 - Math.pow(0.82, Math.min(v - M.conf.step + 5, 30)))) / 0.18;
    let ox = clamp(M.conf.x0 + M.conf.dir * pushed, WALL_L, WALL_R);
    if (v - M.conf.step >= LAG + 2) ox = P.ox;
    const dist = Math.max(abs(ox - me.x), M.conf.proj ? P.dNow : 0);
    const crouch = o.posture === 'crouch';
    if (lim >= 4 && M.conf.count < 5) {
      if (supReady(s) && M.sup.fa <= lim && M.sup.posture !== 'air' && M.sup.strikes[0] && !M.sup.tele && !M.sup.proj && dist < M.sup.strikes[0].reach + M.sup.strikes[0].adv - 10) return atk(s, M.sup.id, 'combo:super');
      if (lim >= 5 && dist <= 117 && !crouch) return atk(s, 'upper', 'combo:upper');
      if (dist <= 118 && M.conf.count < 4) return atk(s, 'jab', 'combo:jab');
    }
  }

  // --- соперник оглушён или завис в восстановлении: гарантированное наказание ---
  if (!oInv && !P.down && !P.air) {
    let avail = -1;
    let onlyProj = false;
    if (M.stag) avail = M.stag.until - 1 - v;
    else if (P.live) avail = -1;
    else if (o.state === 'staggered' || o.state === 'dizzy' || o.state === 'throw' || o.state === 'parry' || o.state === 'landing' || o.state === 'use') avail = P.gStep - 1;
    else if (o.state === 'move' && o.move && M.op[o.move.id] && M.op[o.move.id].posture !== 'air') {
      const mv = M.op[o.move.id];
      const strikeComing = all.some((t) => t.kind === 'strike' && (t.inRange || t.dist < t.reach + 150));
      if (!strikeComing && !(mv.slot === 'super' && o.move.t + LAG < mv.fa + 2)) {
        avail = P.gStep - 1;
        onlyProj = th.length > 0;
      }
    }
    if (avail >= 14 && (M.stag || o.state === 'dizzy') && commit > avail) {
      // он открыт надолго: подойти и взять больше
      const sup = supReady(s) && M.sup.strikes[0] && !M.sup.tele && !M.sup.proj && M.sup.posture !== 'air';
      const want = sup ? M.sup.strikes[0].reach + M.sup.strikes[0].adv - 14 : THROW_RANGE - 8;
      const need = sup ? M.sup.fa : 6;
      if (P.dNow > want) {
        const walkT = Math.ceil((P.dNow - want) / me.derived.walk);
        if (walkT + need + 2 <= avail) return { walk: 1, _why: 'punish-walk' };
        if (P.dNow - want > 60 && 16 + need + 3 <= avail && P.dNow - want < me.derived.dashDistance + 30 && !M.stagDash) {
          M.stagDash = v;
          return { dash: 'forward', _why: 'punish-dash' };
        }
      }
    }
    if (avail >= 4) {
      const crouch = o.posture === 'crouch' && o.state === 'move';
      const a = punish(s, P, Math.min(avail, onlyProj ? Math.min(commit, avail) : avail), P.dNow, { throwable: true, crouch, air: false });
      if (a && !(onlyProj && commit < 12 && !(a.attack && M.sup && a.attack === M.sup.id))) {
        if (M.stag) say(s, 'punish_1');
        else if (P.whiff) say(s, 'punish_2');
        return a;
      }
    }
  }

  // --- соперник в воздухе ---
  if ((o.state === 'air' || (o.state === 'move' && o.move && M.op[o.move.id] && M.op[o.move.id].posture === 'air')) && !oInv) {
    const a = antiAir(s, P, commit);
    if (a) return a;
  }

  // --- соперник лежит ---
  if (P.down || (M.wake && M.wake.plan === 'throw' && v <= M.wake.step + 9 && !P.air)) {
    const a = oki(s, P, commit);
    if (a) return a;
  }

  return tactic(s, P, commit, oInv);
}

function holdCharge(s, P) {
  const me = s.me;
  const mv = M.my[me.move.id];
  const g = mv.strikes[0];
  if (me.move.t < g.a - 1) return true;
  if (me.move.held >= mv.charge.maxHold - 1) return false;
  if (P.dMin < g.reach - 12) return false;
  return true;
}

function airAct(s, P) {
  const me = s.me;
  if (!me.canAirMove) return { _why: 'air' };
  const o = s.opponent;
  const dist = abs(P.ox - me.x);
  const toward = sign(P.ox - me.x) === me.facing;
  if (toward && dist < 158 && me.vy < 3 && !P.down) {
    if (M.sup && M.sup.posture === 'air' && me.meter >= 300) return atk(s, M.sup.id, 'air-super');
    if (M.my.dive && me.y > 90) return atk(s, 'dive', 'dive');
    if (me.y < 110) return atk(s, 'air_kick', 'air_kick');
  }
  return { _why: 'air' };
}

// Соперник в воздухе: встречаю дальним ударом по дуге его прыжка, вплотную — апперкотом; иначе верхний блок.
function antiAir(s, P, commit) {
  const me = s.me;
  const o = s.opponent;
  const at = (n) => airAt(o, LAG + n);
  const facingMe = sign(me.x - o.x) === o.facing || abs(me.x - o.x) < 20;
  const land = airAt(o, 90);
  const landStep = land.landed - LAG;
  if (landStep <= 0) return null;
  const meteor = M.opSup && M.opSup.posture === 'air' && o.meter >= 300;
  const canHitMe = facingMe && (o.canAirMove || (o.move && o.state === 'move'));
  const tryMove = (id, reach, a, act) => {
    if (a + 2 > commit) return null;
    let okSteps = 0;
    for (let j = a; j < a + act; j++) {
      const p = at(j);
      if (p.landed) break;
      if (abs(p.x - me.x) < reach - 6 && (sign(p.x - me.x) === me.facing || abs(p.x - me.x) < 20)) okSteps++;
    }
    if (okSteps < Math.min(2, act)) return null;
    if (canHitMe) {
      for (let j = 1; j < a; j++) {
        const p = at(j);
        if (!p.landed && abs(p.x - me.x) < 152) return null;
      }
    }
    return id;
  };
  let id = null;
  if (!meteor) {
    if (supReady(s) && M.sup.posture !== 'air' && M.sup.strikes[0] && !M.sup.tele && !M.sup.proj) id = tryMove(M.sup.id, M.sup.strikes[0].reach + M.sup.strikes[0].adv, M.sup.fa, M.sup.strikes[0].e - M.sup.strikes[0].a);
    if (!id && stale(s, 'heavy') > 0.6) id = tryMove('heavy', 220, 13, 4);
    if (!id && M.my.smash) id = tryMove('smash', 220, 12, 4);
    if (!id) id = tryMove('heavy', 220, 13, 4);
    if (!id) {
      let ok = 0;
      for (let j = 5; j < 11; j++) {
        const p = at(j);
        if (!p.landed && abs(p.x - me.x) < 118 && p.y < 240 && (sign(p.x - me.x) === me.facing || abs(p.x - me.x) < 20)) ok++;
      }
      let danger = false;
      if (canHitMe) for (let j = 1; j < 5; j++) { const p = at(j); if (!p.landed && abs(p.x - me.x) < 160) danger = true; }
      if (ok >= 2 && !danger && commit > 8) id = 'upper';
    }
  }
  if (id) {
    M.antiAirs++;
    say(s, 'antiair_1');
    return atk(s, id, 'antiair');
  }
  const now = at(1);
  const soon = at(6);
  if (canHitMe && (abs(now.x - me.x) < 195 || abs(soon.x - me.x) < 195) && landStep < 30) {
    if (meteor && P.myWall > 200 && abs(land.x - me.x) > 60) return { walk: -1, guard: 'high', _why: 'aa-back' };
    return { guard: 'high', _why: 'aa-guard' };
  }
  return null;
}

function nearProp(s) {
  if (!s.props) return null;
  for (const p of s.props) if (p.in <= 0 && abs(p.x - s.me.x) <= p.reach - 2) return p;
  return null;
}

// Соперник лежит: готовлю встречу к его подъёму.
function oki(s, P, commit) {
  const me = s.me;
  const o = s.opponent;
  const v = s.tick;
  let wakeIn = P.gStep; // на шаге v + wakeIn он уязвим (и может держать блок), с шага v + wakeIn + 1 действует
  if (P.down) {
    const wakeStep = v + wakeIn;
    if (!M.wake || abs(M.wake.step - wakeStep) > 3) M.wake = { step: wakeStep, plan: null };
    else M.wake.step = wakeStep;
    M.oFreeAt = Math.max(M.oFreeAt, wakeStep);
  } else wakeIn = M.wake.step - v;
  const wakeStep = M.wake.step;
  if (wakeIn > 90) return { guard: 'low', _why: 'oki-far' };
  const prop = nearProp(s);
  if (prop && wakeIn > 20 && P.dNow > 150) {
    const fly = Math.ceil(Math.max(0, P.dNow - 120) / 13);
    if (17 + fly >= wakeIn - 1 && 17 + fly <= wakeIn + 5) {
      say(s, 'prop_1');
      return { use: true, _why: 'oki-prop' };
    }
    if (17 + fly < wakeIn - 1) return { guard: 'low', _why: 'oki-wait-prop' };
  }
  const supDanger = M.opSup && o.meter >= 300 && M.opSup.posture !== 'air';
  if (!M.wake.plan) {
    const gSum = M.gHi + M.gLo + M.gNo;
    const opts = [];
    const allow = (arm) => !CFG.only || !CFG.only.oki || CFG.only.oki.indexOf(arm) >= 0;
    const W = probs(M.Wk);
    const gz = M.gHi + M.gLo + 0.01;
    const actW = W.atk + W.thr;
    if (allow('meaty')) opts.push(['meaty', supDanger ? -40 : (actW + W.idle + W.grd * (M.gHi / gz)) * 35 - W.grd * (M.gLo / gz) * 4 - W.esc * 14]);
    if (allow('throw')) opts.push(['throw', supDanger ? -30 : (W.grd + W.idle) * 100 - W.atk * 65 - W.esc * 70 - 6]);
    if (allow('bait')) opts.push(['bait', (supDanger ? 12 : 0) + W.atk * 30 + W.thr * 40]);
    if (allow('space')) opts.push(['space', supDanger ? 8 : 0]);
    M.wkN = M.wkN || 0;
    if (supReady(s) && M.sup.posture !== 'air' && M.sup.strikes[0] && !M.sup.tele && !M.sup.proj && !supDanger && M.wkSeen >= 3 && actW + W.idle > 0.7 && allow('meaty')) opts.push(['msuper', (actW + W.idle) * 300 - (W.grd + W.esc) * 220]);
    for (const o2 of opts) if (o2[0] === 'meaty' || o2[0] === 'throw' || o2[0] === 'msuper') o2[1] -= M.bait * 14;
    if (!opts.length) opts.push(['space', 0]);
    M.wake.plan = pick(s, 'oki', opts, 5);
  }
  const kind = M.wake.plan;
  const wantDist = kind === 'throw' ? 100 : kind === 'meaty' ? 135 : kind === 'msuper' ? 150 : kind === 'bait' ? 150 : 255;
  if (kind === 'msuper') {
    if (!supReady(s)) M.wake.plan = 'bait';
    else if (P.dNow <= 200 && wakeIn - M.sup.fa <= 2 && wakeIn - M.sup.fa >= 0) {
      M.wake.plan = 'done';
      return atk(s, M.sup.id, 'oki-super');
    }
  }
  if (kind === 'meaty') {
    // низкий удар: активные кадры (3 шага) накрывают шаг подъёма
    const a = 7;
    if (P.dNow <= 154 && wakeIn - a <= 1 && wakeIn - a >= 0 && commit > 26) {
      M.wake.plan = 'done';
      return atk(s, 'low', 'oki-meaty');
    }
  }
  if (kind === 'throw') {
    if (P.dNow <= THROW_RANGE - 6 && v + 1 >= wakeStep + 6 && v + 1 <= wakeStep + 9 && commit > 36) {
      M.wake.plan = 'done';
      say(s, 'throw_1');
      return { throw: true, _why: 'oki-throw' };
    }
    if (v + 1 > wakeStep + 9) return null;
  } else if (wakeIn < 0 || !P.down) return null;
  if (P.dNow > wantDist + 10 && wakeIn > 1) return { walk: 1, _why: 'oki-walk' };
  if (P.dNow < wantDist - 30 && wakeIn > 6 && P.myWall > 60) return { walk: -1, _why: 'oki-back' };
  if (me.passive > 240 && P.dNow > 480) return { walk: 1, _why: 'oki-walk' };
  return { guard: 'low', _why: 'oki-wait:' + kind };
}

// ---------- тактика ----------
// Каждая тактика оценивается так: ожидаемая выгода по кадрам и привычкам соперника (модель) плюс поправка из
// ведомости ставок (сколько она на самом деле принесла против этого соперника).

// что будет, если мой удар заблокируют (сколько здоровья я за это отдам)
function blockLoss(id, d, oSupNear, s) {
  let l = 4;
  if (id === 'twin') l = 30;
  else if (id === 'flurry') l = d <= 132 ? 26 : 60;
  else if (id === 'heavy' || id === 'smash') l = d >= 186 ? 3 : 32;
  else if (id === 'sweep') l = 85;
  else if (id === 'cyclone' || id === 'slide') l = 95;
  else if (id === 'knee') l = 8;
  if (oSupNear && l >= 8) l += 240;
  // в блок — но шкала защиты растёт
  const m = M.my[id];
  let add = 0;
  for (const g of m.strikes) add += (8 + g.dmg * 0.2) * g.hits;
  add = Math.min(34, add);
  l -= add * GAUGE_HP;
  if (s && s.opponent.guardGauge + add >= 100) l -= 70;
  if (m.slot === 'special') l -= m.dmg * 0.1;
  return l;
}

function gainOf(s, id) {
  const m = M.my[id];
  let g = 0;
  let k = 1;
  for (const seg of m.strikes) for (let i = 0; i < seg.hits; i++) { g += seg.dmg * k; k *= 0.75; }
  g *= stale(s, id);
  if (m.strikes.some((x) => x.launch)) g += 14;
  if (id === 'jab') g += 18;
  return g;
}

function tactic(s, P, commit, oInv) {
  const me = s.me;
  const o = s.opponent;
  const v = s.tick;
  const d = P.dNow;
  const dMin = P.dMin;
  const free = P.freeIn <= 1;
  const oSup = M.opSup && o.meter >= 276;
  const supReach = oSup ? (M.opSup.tele ? 9999 : M.opSup.proj ? 520 : M.opSup.posture === 'air' ? 0 : (M.opSup.strikes[0] ? M.opSup.strikes[0].reach + M.opSup.strikes[0].adv : 0) + 25) : 0;
  const oSupNear = oSup && supReach > dMin - 20;
  const lead = me.hp / me.maxHp - o.hp / o.maxHp;
  const C = probs(M.C);
  const walkingIn = o.state === 'neutral' && sign(o.vx) === -P.dir && !o.guard;
  const dashingIn = o.state === 'dash' && sign(P.odx) === -P.dir;
  const guarding = o.state === 'neutral' && !!o.guard;
  const gauge = me.guardGauge;
  const dangerR = Math.min(M.opFast + 12, 385);

  if (!M.startDone) {
    M.startDone = true;
    if (v < 12 && P.d < (CFG.startD || 215) && P.myWall > 150 && !CFG.noStart) return { dash: 'back', _why: 'start-backdash' };
  }

  if (oInv) {
    if (d < 200 && P.myWall > 100) return { walk: -1, guard: 'high', _why: 'vs-inv' };
    return { guard: 'low', _why: 'vs-inv' };
  }

  if (s.timeLeft < 240 && lead < 0 && supReady(s) && M.sup.posture !== 'air' && commit > 20) {
    const g = M.sup.strikes[0];
    if (M.sup.tele || M.sup.proj || (g && d < g.reach + g.adv - 12)) return atk(s, M.sup.id, 'last-super');
  }
  const prop = nearProp(s);
  if (prop && commit > 32 && dMin > Math.max(290, dangerR) && !P.air && !(oSup && supReach > dMin)) {
    say(s, 'prop_1');
    return { use: true, _why: 'prop' };
  }

  // --- ситуация ---
  const lock = P.gStep;
  let sit;
  if (lock >= 2 && d <= 250 && !P.air) sit = 'adv';
  else if (M.blk && v <= M.blk.freeStep + 2 && d <= 185) sit = 'minus';
  else if (d <= 172 || ((walkingIn || dashingIn) && dMin <= 172)) sit = 'contact';
  else if (d <= Math.max(dangerR, 350)) sit = 'mid';
  else sit = 'far';
  const key = sit + (walkingIn ? 'w' : '') + (dashingIn ? 'd' : '') + (guarding ? 'g' : '') + (P.air ? 'a' : '');

  if (M.tac && v < M.tac.until && (M.tac.key === key || M.tac.sticky)) {
    const a = runArm(s, P, commit, M.tac);
    if (a) return a;
  }

  // после своего приёма: он мог ответить на его начало, а я этого ещё не вижу — блок, пока не увижу
  if (sit === 'mid' && free && d <= dangerR && M.lastAtk && v + 1 < M.lastAtk.step + 34 && M.myLastHit < M.lastAtk.step) return { guard: 'low', _why: 'post-guard' };

  // --- оценки ---
  const gSum = M.gHi + M.gLo + M.gNo;
  let pHi = M.gHi / gSum;
  let pLo = M.gLo / gSum;
  let pNo = M.gNo / gSum;
  if (guarding) {
    // вижу блок (16 шагов назад): скорее всего, он всё ещё стоит в нём
    const w = 0.75;
    pHi = pHi * (1 - w) + (o.guard === 'high' ? w : 0);
    pLo = pLo * (1 - w) + (o.guard === 'low' ? w : 0);
    pNo = pNo * (1 - w);
  }
  const moving = walkingIn || dashingIn;
  // вероятность, что удар попадёт: зона против его блока, движение — без блока
  const pHit = (id, zone) => {
    let p;
    if (moving) p = 0.72;
    else if (zone === 'low') p = pNo * 0.9 + pHi * 0.9 + pLo * 0.05;
    else if (zone === 'overhead') p = pNo * 0.9 + pLo * 0.9 + pHi * 0.05;
    else p = pNo * 0.9 + 0.04;
    const r = M.out[id];
    if (r) {
      const n = r.hit + r.blk;
      const w = Math.min(0.6, (n - 2) / 8);
      if (w > 0) p = p * (1 - w) + (r.hit / n) * w;
    }
    return p;
  };
  // вероятность, что удар вообще коснётся (попадёт или в блок): запас по дальности и то, как он двигался
  const still = o.state === 'neutral' && abs(o.vx) < 0.5;
  const away = o.state === 'neutral' && sign(o.vx) === P.dir;
  const whiffCost = (M.opFast >= 280 ? 58 : 34) + (oSup ? 80 : 0);
  const pTouch = (id, dist) => {
    const m = M.my[id];
    const margin = m.range - 4 - dist;
    let p;
    if (margin < 0) p = 0.05;
    else if (!free) p = 0.9;
    else if (dashingIn) p = 0.8;
    else if (walkingIn) p = margin >= 12 ? 0.62 : 0.4;
    else if (away) p = 0.15;
    else if (still) p = clamp(0.35 + margin / 60, 0.2, 0.93);
    else p = clamp(0.3 + margin / 80, 0.15, 0.8);
    const r = M.out[id];
    if (r) {
      const n = r.hit + r.blk + r.whf;
      const w = Math.min(0.5, (n - 2.5) / 8);
      if (w > 0) p = p * (1 - w) + ((r.hit + r.blk) / n) * w;
    }
    return p;
  };
  const ev = (id, dist, extra) => {
    const m = M.my[id];
    const zone = m.strikes[m.strikes.length - 1].zone;
    const p = pHit(id, zone);
    const t = pTouch(id, dist);
    return t * (p * gainOf(s, id) - (1 - p) * blockLoss(id, dist, oSupNear, s)) - (1 - t) * whiffCost + (extra || 0);
  };
  const speed = abs(o.vx) || o.derived.walk;
  const dAt = (a) => (walkingIn ? Math.max(105, P.d - speed * (LAG + a) * 0.9) : d);
  const wallBack = P.myWall > 170;
  const opts = [];
  const allow = (arm) => !CFG.only || !CFG.only[sit] || CFG.only[sit].indexOf(arm) >= 0;
  const add = (arm, val) => { if (allow(arm)) opts.push([arm, val]); };

  if (sit === 'adv') {
    // он занят ещё lock шагов: удар на его первый свободный шаг (успеет только блок) или бросок сразу после
    const A = probs(M.A);
    const act = A.atk + A.thr; // выйдя из стана, жмёт кнопки: удар на его первый свободный шаг их перебивает
    const gz = pHi + pLo + 0.01;
    // удар зоны z на его первый свободный шаг: попадёт, если он не в блоке под эту зону и не отскочил
    const meaty = (id, z, gain) => {
      const open = act + A.idle + A.grd * (z === 'low' ? pHi / gz : 0);
      const blocked = A.grd * (z === 'low' ? pLo / gz : 1);
      return open * gain * stale(s, id) - blocked * blockLoss(id, d, oSupNear, s) - A.esc * (M.my[id].D > 30 ? whiffCost : 12);
    };
    if (d <= 154 && lock <= 9) add('mlow', meaty('low', 'low', 35));
    if (d <= 116 && lock <= 6) add('mjab', meaty('jab', 'mid', 43));
    if (M.my.twin && d <= 154 && lock <= 10) add('mtwin', meaty('twin', 'low', 55));
    if (M.my.flurry && d <= 128 && lock <= 11) add('mflurry', meaty('flurry', 'mid', 50));
    if (d > 125 && d <= 208 && lock <= 15) add('mheavy', meaty('heavy', 'mid', 65));
    if (d <= 170) add('tthrow', (A.grd + A.idle) * 100 - A.atk * 60 - A.esc * (oSupNear ? 250 : 70) - 6);
    add('guard', (gauge > 60 ? -12 : 0) + A.atk * 12);
  } else if (sit === 'minus') {
    add('guard', (gauge > 60 ? -10 : 0) + C.atk * 4 + C.slow * 40 - C.thr * 95);
    if (wallBack) add('back', C.thr * 55 + C.atk * 4 - C.slow * 15);
    if (d <= 116) add('jab', C.thr * 20 - C.atk * 30 + C.slow * 40 + C.idle * 30);
    if (d <= THROW_RANGE - 6) add('throw', throwValue() * 0.6 + C.thr * 30 - C.atk * 40 - 10);
  } else if (sit === 'contact') {
    const g = guarding ? 0.7 : 0;
    const cg = C.grd * (1 - g) + g;
    const k = 1 - g;
    add('guard', (gauge > 60 ? -15 : 0) + k * (C.slow * 45 + C.atk * 3 - C.thr * 95));
    if (d <= 116) add('jab', k * ((C.thr + C.idle) * 50 + C.slow * 45 - C.atk * 8 - C.esc * 10) * stale(s, 'jab') - cg * 4 + (moving ? 20 : 0));
    if (d <= 154) add('low', (k * ((C.idle + C.thr * 0.4 + C.slow * 0.5) * 35 - C.atk * 25 - C.esc * 12) + cg * ((pHi / (pHi + pLo + 0.01)) * 38 - (pLo / (pHi + pLo + 0.01)) * 5)) * stale(s, 'low') + (moving ? 14 : 0));
    if (M.my.twin && d <= 154) add('twin', (k * ((C.idle + C.thr * 0.3 + C.slow * 0.3) * 55 - C.atk * 35 - C.esc * 45) + cg * ((pHi / (pHi + pLo + 0.01)) * 55 - (pLo / (pHi + pLo + 0.01)) * blockLoss('twin', d, oSupNear, s))) * stale(s, 'twin') + (moving ? 14 : 0));
    if (M.my.flurry && d <= 128) add('flurry', k * ((C.idle + C.thr * 0.3 + C.slow * 0.3) * 50 - C.atk * 30 - C.esc * 45) * stale(s, 'flurry') + cg * (pNo * 50 - (1 - pNo) * blockLoss('flurry', d, oSupNear, s)) + (moving ? 12 : 0));
    if (d <= 160 && free) add('throw', throwValue() + (cg - 0.4) * 40 - k * (C.atk * 40 + C.esc * 30) - (d > 124 ? 8 : 0) - (oSupNear ? 60 : 0));
    if (wallBack) add('back', k * (C.thr * 60 + C.atk * 3 - C.slow * 15) - 2);
    if (d >= 132 && d <= 208) add('heavy', ev('heavy', d) - C.atk * 15 - C.esc * 30);
    if (d <= 208) add('sweep', ev('sweep', d) - C.atk * 15 - C.esc * 30);
  } else if (sit === 'mid') {
    add('hold', (gauge > 70 ? -10 : 0) + (lead > 0.05 ? 2 : 0) - (M.opShotFast && d < 240 ? 3 : 0));
    const dh = dAt(13);
    if (dh <= 212 && dh >= 120) add('heavy', ev('heavy', dh));
    if (M.my.cyclone && dAt(12) <= 272) add('cyclone', ev('cyclone', dAt(12)));
    if (M.my.slide && dAt(14) <= 350) add('slide', ev('slide', dAt(14)));
    if (dAt(12) <= 212) add('sweep', ev('sweep', dAt(12)));
    if (M.my.lance && !me.projectileOut && d > 185) add('lance', shotValue(s, 'lance', d, moving) - (d <= dangerR ? 2 : 0) - (oSupNear ? 60 : 0) + (o.hp <= 40 ? 15 : 0));
    // в полосу 205–232: оттуда депеша не парируется на глаз и безопасна в блок
    if (M.my.lance && (d > 236 || d < 200) && !moving && !oSup) add('band', shotValue(s, 'lance', 220, false) - 4 - (lead > 0.05 && s.timeLeft < 3000 ? 6 : 0));
    add('walkin', (C.grd + C.idle > 0.6 ? 4 : 0) + (lead < -0.02 ? 4 : 0) + (moving ? -12 : 0) + (oSupNear ? -14 : 0) + (me.passive > 200 ? 10 : 0) - 2);
    const inHisBand = M.opShotFast && d < 240;
    if (wallBack) add('walkback', (lead > 0.05 ? 3 : 0) + (oSup ? 8 : 0) - 1 + (inHisBand ? 5 : 0));
  } else {
    const supBad = oSup && supReach > dMin - 30;
    if (M.my.lance && !me.projectileOut) add('lance', shotValue(s, 'lance', d, moving) + (me.passive > 220 ? 12 : 0) + (supBad ? -30 : 0));
    if (M.my.fireball && !me.projectileOut) add('fireball', shotValue(s, 'fireball', d, moving) + (me.passive > 220 ? 12 : 0) + (oSup ? -40 : 0));
    add('approach', (lead <= 0.02 ? 5 : 0) + (me.passive > 120 ? 25 : 0) + (s.timeLeft < 1800 && lead <= 0 ? 12 : 0) + (d > dangerR + 60 ? 3 : -4));
    add('wait', (lead > 0.02 ? 3 : -2) + (me.passive > 120 ? -40 : 0) + (d > 520 ? -8 : 0));
    if (s.props && !oSup) {
      for (const pr of s.props) {
        const to = pr.x - me.x;
        if (pr.in < 150 && abs(to) < 300 && abs(to) > pr.reach - 4 && abs(pr.x - P.ox) > dangerR + 60) {
          const T = M.shots.far;
          const n = T.hit + T.blk + T.par;
          M.propGo = pr.x;
          add('prop', (T.hit / n) * 80 + (T.blk / n) * 30 - (T.par / n) * 14 - 6);
          break;
        }
      }
    }
  }
  // он уходит из-под ударов вблизи и наказывает промах: чем чаще я мазал, тем меньше бью первым
  if (M.bait > 0.4 && sit !== 'far') {
    const calm = { guard: 1, hold: 1, back: 1, walkback: 1, lance: 1, band: 1, walkin: 1, wait: 1 };
    const light = { jab: 1, mjab: 1, low: 1, mlow: 1 };
    const k = sit === 'mid' ? 8 : 22;
    const b = Math.min(M.bait, 3);
    for (const o2 of opts) if (!calm[o2[0]]) o2[1] -= b * (light[o2[0]] ? k * 0.35 : k);
  }
  // моя шкала защиты близка к слому: не стоять в блоке под его ударами — уйти или отбить ход
  if (gauge >= 55 && sit !== 'far') {
    const g = (gauge - 45) * 0.9;
    for (const o2 of opts) {
      if (o2[0] === 'guard' || o2[0] === 'hold') o2[1] -= g;
      else if (o2[0] === 'walkback' || o2[0] === 'back') o2[1] += g * 0.6;
    }
  }
  // веду — меньше риска, отстаю — больше
  if (!CFG.noLead) {
    const risky = { heavy: 1, cyclone: 1, slide: 1, sweep: 1, twin: 1, flurry: 1, throw: 1, tthrow: 1, walkin: 1, band: 1, mtwin: 1, mflurry: 1, mheavy: 1 };
    const calm = { hold: 1, guard: 1, walkback: 1, wait: 1 };
    // осторожничать есть смысл только с тем, кто умеет делать больно
    const hurt = clamp((1 - me.hp / me.maxHp) / 0.2, 0, 1);
    const ahead = clamp(lead * 100 - 3, 0, 12) * hurt;
    const behind = clamp(-lead * 100 - 3, 0, 10);
    for (const o2 of opts) {
      if (risky[o2[0]]) o2[1] += behind * 0.6 - ahead;
      else if (calm[o2[0]]) o2[1] += ahead * 0.4 - behind * 0.5;
    }
  }
  // конец раунда: веду — не рискую, отстаю — иду вперёд
  if (s.timeLeft < 1500) {
    const safe = { guard: 1, hold: 1, wait: 1, walkback: 1, back: 1, space: 1 };
    const push = { approach: 1, walkin: 1, band: 1, throw: 1, tthrow: 1 };
    const k = s.timeLeft < 600 ? 2 : 1;
    for (const o2 of opts) {
      if (lead > 0.02 && safe[o2[0]]) o2[1] += 8 * k;
      else if (lead > 0.02 && !safe[o2[0]] && o2[0] !== 'lance' && o2[0] !== 'jab' && o2[0] !== 'low') o2[1] -= 6 * k;
      else if (lead < -0.005 && push[o2[0]]) o2[1] += 8 * k;
      else if (lead < -0.005 && safe[o2[0]]) o2[1] -= 8 * k;
    }
  }
  if (!opts.length) return { guard: 'low', _why: 'idle' };
  const arm = pick(s, sit, opts, CFG.temp || 5);
  const dur = { guard: 8 + Math.floor(M.rnd() * 9), hold: 10 + Math.floor(M.rnd() * 12), wait: 14 + Math.floor(M.rnd() * 14), walkin: 34, band: 30, prop: 70, walkback: 22, approach: 30, tthrow: 40, mlow: 30, mjab: 30, mtwin: 30, mheavy: 30, throw: 16, back: 2, jump: 3 }[arm] || 2;
  M.tac = { sit, arm, key, t0: v, until: v + dur, sticky: arm === 'tthrow' || arm === 'throw' || arm[0] === 'm' || arm === 'walkin' || arm === 'band' || arm === 'prop', dangerR };
  const a = runArm(s, P, commit, M.tac);
  return a || { guard: 'low', _why: 'idle' };
}

// сколько приносит бросок против этого соперника: по тому, чем кончались прошлые
function throwValue() {
  const t = M.thr;
  const n = t.land + t.whiff + t.tech + t.stuffed;
  return (t.land * 105 - t.whiff * 75 - t.stuffed * 65) / n;
}

// сколько приносит снаряд против этого соперника: вблизи его не парировать на глаз, издали — можно
const GAUGE_HP = 0.9; // цена единицы шкалы защиты соперника в здоровье (слом = открытый удар и 30 шкалы супера)
function shotValue(s, id, d, moving) {
  const m = M.my[id];
  const near = d < (m.proj.speed >= 13 ? 236 : 160);
  const T = M.shots[near ? 'near' : 'far'];
  const n = T.hit + T.blk + T.par;
  let hit = T.hit / n;
  let blk = T.blk / n;
  let par = T.par / n;
  if (moving) { hit = hit * 0.4 + 0.6; blk *= 0.4; par *= 0.4; }
  const o = s.opponent;
  const add = 8 + m.proj.dmg * 0.2;
  const crush = o.guardGauge + add >= 100 ? 60 : 0;
  return hit * m.proj.dmg * stale(s, id) + blk * (m.proj.dmg * 0.1 + add * GAUGE_HP + crush) - par * 14;
}

function runArm(s, P, commit, T) {
  const me = s.me;
  const v = s.tick;
  const d = P.dNow;
  const end = () => { T.until = 0; };
  const fire = (id, why) => {
    if (M.my[id].D + 2 > commit || !clear(s, P, id, true)) { end(); return { guard: 'low', _why: 'commit' }; }
    end();
    return atk(s, id, why);
  };
  switch (T.arm) {
    case 'guard':
    case 'hold':
    case 'wait':
      if (T.arm === 'wait' && me.passive > 250) { end(); return null; }
      return { guard: 'low', _why: T.sit + ':' + T.arm };
    case 'jab':
    case 'low':
    case 'twin':
    case 'flurry':
    case 'heavy':
    case 'sweep':
    case 'cyclone':
    case 'slide':
      return fire(T.arm, T.sit + ':' + T.arm);
    case 'lance':
    case 'fireball':
      if (me.projectileOut) { end(); return null; }
      say(s, 'shot_1');
      return fire(T.arm, T.sit + ':' + T.arm);
    case 'back':
      end();
      return { dash: 'back', _why: T.sit + ':back' };
    case 'jump':
      end();
      if (commit < 46) return { guard: 'low', _why: 'commit' };
      return { jump: 1, _why: T.sit + ':jump' };
    case 'throw': {
      if (commit < 36) return { guard: 'low', _why: 'commit' };
      if (d <= THROW_RANGE - 6) {
        if (!throwOk(s)) return { guard: 'low', _why: 'throw-wait' };
        end();
        say(s, 'throw_1');
        return { throw: true, _why: T.sit + ':throw' };
      }
      if (d > 175) { end(); return null; }
      return { walk: 1, _why: T.sit + ':throw-walk' };
    }
    case 'tthrow': {
      if (commit < 36) return { guard: 'low', _why: 'commit' };
      if (d <= THROW_RANGE - 6 && throwOk(s) && P.freeIn <= 1) {
        end();
        say(s, 'throw_1');
        return { throw: true, _why: 'adv:tthrow' };
      }
      if (d > 175 || v - T.t0 > 34) { end(); return null; }
      if (d > THROW_RANGE - 8) return { walk: 1, _why: 'adv:tthrow-walk' };
      return { guard: 'low', _why: 'adv:tthrow-wait' };
    }
    case 'mlow':
    case 'mjab':
    case 'mtwin':
    case 'mflurry':
    case 'mheavy': {
      const id = { mlow: 'low', mjab: 'jab', mtwin: 'twin', mflurry: 'flurry', mheavy: 'heavy' }[T.arm];
      const a = M.my[id].strikes[0].a;
      const reach = M.my[id].strikes[0].reach - 12;
      if (P.gStep <= a) {
        if (d > reach || P.gStep < -3) { end(); return null; }
        return fire(id, 'adv:' + T.arm);
      }
      if (d > reach - 6) return { walk: 1, _why: 'adv:walk' };
      return { guard: 'low', _why: 'adv:wait' };
    }
    case 'walkin': {
      // шаг — блок: иду не дольше 11 шагов подряд, потом блок, пока не увижу, чем он ответил
      if (P.dMin <= 150 || d <= 160) { end(); return null; }
      const t = v - T.t0;
      if (d > T.dangerR) return { walk: 1, _why: 'mid:walkin' };
      if (t < 11) return { walk: 1, _why: 'mid:walkin' };
      return { guard: 'low', _why: 'mid:step-guard' };
    }
    case 'band': {
      // встать в полосу 206–232: шаг — блок
      if (d >= 206 && d <= 232) { end(); return null; }
      const t = v - T.t0;
      if (d < 206) {
        if (P.myWall < 100) { end(); return null; }
        return { walk: -1, guard: 'high', _why: 'mid:band-back' };
      }
      if (d > T.dangerR || t < 11) return { walk: 1, _why: 'mid:band' };
      return { guard: 'low', _why: 'mid:band-guard' };
    }
    case 'walkback':
      if (P.myWall < 120 || d > Math.max(M.opPoke + 26, 248)) { end(); return null; }
      return { walk: -1, guard: 'high', _why: 'mid:walkback' };
    case 'prop': {
      const to = M.propGo - me.x;
      if (abs(to) <= 60 || abs(M.propGo - P.ox) < 300 || P.dMin < 300) { end(); return null; }
      return { walk: sign(to) === P.dir ? 1 : -1, _why: 'far:prop' };
    }
    case 'approach':
      if (d < Math.max(T.dangerR, 350) - 8) { end(); return null; }
      return { walk: 1, _why: 'far:approach' };
    default:
      end();
      return null;
  }
}

function install(info) {
  M = fresh(info);
}

export default {
  init(info) {
    install(info);
  },
  tick(s) {
    if (!M) install(null);
    if (!M.ready) setup(s);
    const P = look(s);
    M.dNowLast = P.dNow;
    observe(s, P);
    if (M.event === 'parry' && M.parryTry && M.parryTry.kind === 'strike') {
      M.stag = { until: s.tick + 24 };
      say(s, 'parry_1');
    }
    chatter(s, P);
    let act;
    try {
      act = decide(s, P) || {};
    } catch (e) {
      act = { guard: 'low', _why: 'error' };
      M.tac = null;
    }
    if (M.say) {
      act.say = M.say;
      M.lastSay = s.tick;
      M.say = null;
    }
    const me = s.me;
    const o = s.opponent;
    M.prev = { v: s.tick, state: me.state, stateTicks: me.stateTicks, meter: me.meter, hp: me.hp, combo: me.combo, move: me.move ? { id: me.move.id, t: me.move.t } : null, projectileOut: me.projectileOut, guardGauge: me.guardGauge, x: me.x, invulnerable: me.invulnerable };
    M.prevO = { state: o.state, x: o.x, move: o.move ? { id: o.move.id, t: o.move.t } : null, hp: o.hp, guard: o.guard };
    return act;
  },
};
