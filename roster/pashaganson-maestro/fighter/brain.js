// «Маэстро» — мозги.
// 1. Видит соперника с опозданием реакции и восстанавливает по таблице приёмов, где тот сейчас: в замахе, в
//    восстановлении, лежит, летит — и сколько тиков ещё не может действовать.
// 2. Каждое такое окно наказывает самым больным приёмом, который успевает: бросок, апперкот, подкат издалека, супер.
// 3. Защищается по зонам: присед держит середину и низ, удар сверху и прыжок видны на глаз — тогда верх.
// 4. В нейтрали выбирает из вариантов (бросок, низ, джеб, ждать в блоке, отскок, тычки, подход) и учится по ходу боя:
//    у каждого варианта копится средний итог (урон нанесён − получен), выбор — по этим итогам.

const REACH = { short: 55, mid: 95, long: 150 };
const PROJ_SPEED = { slow: 6, mid: 9, fast: 13 };
const THROW_RANGE = 126; // grab reaches 130 between centres
// temperatures of the choices (how much it trusts its estimates), ×TEMP_MUL
const TEMP_MUL = 1;

// ---------- randomness from the fight's seed ----------
let rs = 1;
function rnd() {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = Math.imul(rs ^ (rs >>> 15), rs | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------- memory ----------
let M = null;
function fresh() {
  return {
    lastMeter: 0,
    lastHp: 0,
    hpLog: [], // [tick, myHp, opHpSeen]
    confirm: null,
    intent: null,
    pending: [], // bandit choices waiting for their reward
    arms: {}, // context → option → { n, sum }
    lastSay: -9999,
    said: {},
    prevOp: null,
    opMoveUntouched: true,
    opMoveKey: '',
    wakePlan: null,
    okiPlan: null,
    st: { lowSeen: 0, midSeen: 0, ohSeen: 0, airSeen: 0, jumps: 0 },
    readSaid: 0,
    myHist: new Array(64),
    close: { G: { n: 0 }, N: { n: 0 } },
    wake: { n: 0 },
    walkIn: 0,
    midG: { n: 0, h: 0, l: 0, o: 0 },
    oki: { n: 0 },
    myWakeAt: null,
    okiCounted: false,
    wakeWatch: null,
    wakeGuardSeen: null,
  };
}

const defOf = (F, id) => F.moves.find((m) => m.id === id);
const firstStrike = (m) => m && m.segments.find((g) => g.type === 'strike');

function strikeReaches(g, d, extra = 0, crouchTarget = false) {
  return d <= 35 + REACH[g.reach] + (crouchTarget ? 40 : 35) + (g.advance || 0) + extra;
}

// the fastest threat range of a kit: strikes with startup up to `maxStartup`
function threatRange(F, maxStartup) {
  let r = 0;
  for (const m of F.moves) {
    if (m.posture === 'air' || m.slot === 'super') continue;
    for (const g of m.segments) if (g.type === 'strike' && g.activeStart <= maxStartup) r = Math.max(r, 35 + REACH[g.reach] + 35 + (g.advance || 0));
  }
  return r;
}

// ---------- the opponent now, from a view `lag` ticks old ----------
const TIMED = new Set(['hitstun', 'blockstun', 'landing', 'staggered', 'dizzy', 'parry', 'throw', 'techBreak', 'prejump', 'dash', 'throwing']);

function project(s) {
  const op = s.opponent;
  const lag = (s.reaction ?? 15) + 1; // the view is the state after the step `reaction + 1` steps ago
  const P = { lag, free: 0, open: 0, hittable: 0, threats: [], committed: false, state: op.state, move: null, x: op.x, y: op.y, vy: op.vy, air: op.airborne, knock: false, recovering: false };
  const left = (op.stateLength || 0) - (op.stateTicks || 0) - lag;
  if (op.state === 'move' && op.move) {
    const d = defOf(op, op.move.id);
    const tNow = op.move.t + lag;
    P.move = d;
    P.tNow = tNow;
    P.committed = true;
    let dur = op.move.duration;
    if (d && dur === d.duration && d.posture !== 'air' && d.segments.some((g) => g.type === 'strike') && M.opMoveUntouched) {
      const lastStrike = Math.max(...d.segments.filter((g) => g.type === 'strike').map((g) => g.activeEnd));
      if (tNow >= lastStrike) dur += 8; // R4: a whiff recovers 8 ticks longer
    }
    P.free = Math.max(0, dur - tNow);
    if (d) {
      for (const g of d.segments) {
        if (g.type === 'strike') {
          if (g.activeEnd > tNow) P.threats.push({ kind: 'strike', zone: g.zone, in: g.activeStart - tNow, end: g.activeEnd - tNow, g });
        } else if (g.type === 'projectile' && g.activeStart > op.move.t) {
          // not in the projectile list I see yet: it spawns (or spawned) in front of it and flies on
          P.threats.push({ kind: 'spawn', zone: g.zone, in: g.activeStart - tNow, g, x0: op.x + op.facing * 60, v: PROJ_SPEED[g.speed] * op.facing });
        }
        else if (g.type === 'teleport' && g.activeStart > tNow) P.threats.push({ kind: 'teleport', in: g.activeStart - tNow, g });
      }
      const lastAct = Math.max(0, ...d.segments.map((g) => g.activeEnd));
      P.recovering = tNow >= lastAct;
      if (d.slot === 'super') P.hittable = Math.max(0, d.firstActive - tNow);
      for (const g of d.segments) if (g.type === 'teleport' && tNow < g.activeStart) P.teleporting = true;
      P.open = P.free;
    }
    if (d && d.posture === 'air') P.air = true;
  } else if (['knockdown', 'getup', 'thrown', 'grabbed'].includes(op.state)) {
    let rest = left;
    if (op.state === 'knockdown') rest += 20;
    if (op.state === 'thrown') rest += 44 + 20;
    if (op.state === 'grabbed') rest = 12 - (op.stateTicks || 0) - lag + 22 + 44 + 20;
    P.free = Math.max(0, rest);
    P.wakeRaw = rest; // step offset of its first free step (≤ 0: it is up already)
    P.hittable = P.free;
    P.knock = true;
    P.committed = true;
  } else if (op.state === 'juggle') {
    let y = op.y;
    let vy = op.vy;
    let t = 0;
    while (y > 0 && t < 200) {
      vy -= 0.85;
      y += vy;
      t++;
    }
    const land = t - lag;
    P.free = Math.max(0, land) + 64;
    P.hittable = land > 0 ? 0 : P.free;
    P.knock = true;
    P.committed = true;
    P.juggleLand = land;
  } else if (op.state === 'air') {
    let y = op.y;
    let vy = op.vy;
    let x = op.x;
    for (let t = 0; t < lag && y > 0; t++) {
      vy -= 0.85;
      y += vy;
      x += op.vx;
    }
    P.x = x;
    P.y = Math.max(0, y);
    P.vy = vy;
    let tl = 0;
    let yy = y;
    let vv = vy;
    while (yy > 0 && tl < 200) {
      vv -= 0.85;
      yy += vv;
      tl++;
    }
    P.landIn = y > 0 ? tl : 0;
    P.free = P.landIn + 3;
    P.air = y > 0;
    P.committed = y > 0;
    P.jumping = true;
  } else if (TIMED.has(op.state)) {
    P.free = Math.max(0, left);
    if (['staggered', 'dizzy', 'throw', 'parry', 'landing', 'techBreak'].includes(op.state)) P.open = P.free;
    if (op.state === 'dash' && op.stateLength === 18) P.hittable = Math.max(0, 8 - (op.stateTicks || 0) - lag);
    P.committed = P.free > 0;
    if (op.state === 'prejump') {
      P.air = true;
      P.jumping = true;
    }
  }
  if (op.invulnerable && !P.knock && op.state !== 'move') P.hittable = Math.max(P.hittable, Math.max(0, left));
  return P;
}

function incomingProjectiles(s) {
  const me = s.me;
  const lag = (s.reaction ?? 15) + 1; // the view is the state after the step `reaction + 1` steps ago
  const out = [];
  for (const p of s.projectiles) {
    if (p.mine) continue;
    const x = p.x + p.vx * lag;
    const dx = me.x - x;
    if (Math.sign(dx) !== Math.sign(p.vx) && Math.abs(dx) > 55) continue;
    const k = Math.max(0, Math.ceil((Math.abs(dx) - 59) / Math.abs(p.vx)));
    out.push({ x, zone: p.zone, in: k, y: p.y, vx: p.vx, damage: p.damage });
  }
  return out;
}

// ---------- my moves ----------
function ready(me, id) {
  const m = defOf(me, id);
  if (!m) return null;
  if (m.slot === 'super' && me.meter < 300) return null;
  if (m.segments.some((g) => g.type === 'projectile') && me.projectileOut) return null;
  if (m.posture === 'air' ? !me.canAirMove : !me.canAct) return null;
  return m;
}

function landsIn(m, d, until, crouch, air) {
  const g = firstStrike(m);
  if (!g) return false;
  if (!strikeReaches(g, d, -4, crouch)) return false;
  if (crouch && g.zone === 'high') return false;
  return g.activeStart <= until;
}

// ---------- bandit: learn which choice pays against this opponent ----------
const PRIOR = {
  close: { throw: 35, jab: 12, low: 10, upper: 8, block: 4, back: 0, sweep: 0, knee: 0, shimmy: 6 },
  closeG: { throw: 45, jab: 5, low: 14, upper: -10, block: 2, back: 0, sweep: 4, shimmy: 8, overhead: 2 },
  mid: { hold: 14, approach: 3, dash: 0, heavy: 2, sweep: 0, slide: 4, cyclone: -8, spike: 6, back: 4 },
  far: { approach: 8, dash: 6, lance: 6, spike: 4, hold: 0 },
  wake: { block: 10, jab: 2, back: 4, throw: 2, upper: 0 },
  oki: { low: 18, jab: 12, throw: 25, block: 6, overhead: 6, bait: 8 },
};
const PRIOR_N = 3;

function armStat(ctx, k) {
  M.arms[ctx] ||= {};
  return (M.arms[ctx][k] ||= { n: 0, sum: 0 });
}
function armValue(ctx, k) {
  const a = armStat(ctx, k);
  const prior = PRIOR[ctx]?.[k] ?? 0;
  return (prior * PRIOR_N + a.sum) / (PRIOR_N + a.n);
}
function choose(s, ctx, opts, temp = 14) {
  temp *= TEMP_MUL;
  // opts: [{ k, bias }] — bias from what I see now
  let best = null;
  const vals = opts.map((o) => ({ ...o, v: armValue(ctx, o.k) + (o.bias || 0) }));
  const mx = Math.max(...vals.map((o) => o.v));
  let sum = 0;
  for (const o of vals) sum += o.e = Math.exp((o.v - mx) / temp);
  let r = rnd() * sum;
  for (const o of vals) {
    r -= o.e;
    if (r <= 0) {
      best = o;
      break;
    }
  }
  best ||= vals[vals.length - 1];
  M.lastChoice = `${ctx}:${best.k}@${s.tick}`;
  M.pending.push({ ctx, k: best.k, tick: s.tick, myHp: s.me.hp, opHp: null, due: s.tick + 16 + 55, win: 55 });
  return best.k;
}
function settle(s) {
  // rewards: my damage dealt (seen 15 ticks late) minus damage taken over 50 ticks
  const op = s.opponent;
  for (const p of M.pending) {
    if (p.opHp === null && s.tick >= p.tick + 16) p.opHp = op.hp; // the opponent as it was when I chose
    if (p.myHp2 === undefined && s.tick >= p.tick + (p.win || 50)) p.myHp2 = s.me.hp;
  }
  const done = M.pending.filter((p) => s.tick >= p.due);
  if (!done.length) return;
  M.pending = M.pending.filter((p) => s.tick < p.due);
  for (const p of done) {
    const dealt = Math.max(0, (p.opHp ?? op.hp) - op.hp);
    const taken = Math.max(0, p.myHp - (p.myHp2 ?? s.me.hp));
    const a = armStat(p.ctx, p.k);
    a.n++;
    a.sum += dealt - taken - (p.ev ?? 0);
  }
}

// ---------- talk ----------
function say(s, a, kind, chance = 1) {
  if (s.tick - M.lastSay < 240 || rnd() > chance || a.say) return;
  const list = s.lines.filter((l) => l.kind === kind);
  if (!list.length) return;
  const n = M.said[kind] || 0;
  a.say = list[n % list.length].id;
  M.said[kind] = n + 1;
  M.lastSay = s.tick;
}
function sayId(s, a, id) {
  if (s.tick - M.lastSay < 240 || !s.lines.some((l) => l.id === id)) return;
  a.say = id;
  M.lastSay = s.tick;
}

// what the conductor says: after a strong hit, after a hard fall, when it has read the opponent, when it is behind
// or ahead late in the round
function talk(s, a) {
  const me = s.me;
  const op = s.opponent;
  if (s.tick - M.lastSay < 300) return;
  const has = (id) => s.lines.some((l) => l.id === id);
  if (M.dm >= 9 && me.move && me.move.id !== 'finale' && rnd() < 0.35) return say(s, a, 'hit');
  if (M.dhp >= 90 && rnd() < 0.3) return say(s, a, 'hurt');
  const C = M.close.G.n + M.close.N.n;
  if (!M.saidRead && C > 220 && op.hp < op.maxHp * 0.75 && has('read_1')) {
    M.saidRead = 1;
    return sayId(s, a, 'read_1');
  }
  if (M.saidRead === 1 && C > 700 && op.hp < op.maxHp * 0.45 && has('read_2')) {
    M.saidRead = 2;
    return sayId(s, a, 'read_2');
  }
  if (!M.saidLow && me.hp < me.maxHp * 0.25 && op.hp > op.maxHp * 0.45 && has('low_hp')) {
    M.saidLow = true;
    return sayId(s, a, 'low_hp');
  }
  if (!M.saidLead && s.timeLeft < 60 * 30 && me.hp / me.maxHp - op.hp / op.maxHp > 0.15 && has('lead')) {
    M.saidLead = true;
    return sayId(s, a, 'lead');
  }
}

// ---------- observation ----------
function observe(s) {
  const op = s.opponent;
  const prev = M.prevOp;
  if (op.state === 'move' && op.move) {
    const key = op.move.id;
    const fresh = !prev || prev.state !== 'move' || !prev.move || prev.move.id !== op.move.id || prev.move.t > op.move.t;
    if (fresh) {
      M.opMoveUntouched = true;
      const d0 = defOf(op, op.move.id);
      if (d0 && s.distance < 300) for (const g of d0.segments) {
        if (g.zone === 'low') M.st.lowSeen++;
        else if (g.zone === 'overhead') M.st.ohSeen++;
        else if (g.zone === 'air') M.st.airSeen++;
        else if (g.zone) M.st.midSeen++;
      }
    }
  }
  if (op.state === 'prejump' && (!prev || prev.state !== 'prejump')) M.st.jumps++;
  // close-range habits: what it starts when it is free near me, split by what it saw of me (my guard then)
  const lag = (s.reaction ?? 15) + 1;
  const mine = M.myHist[(s.tick - 2 * lag) & 63]; // what it saw of me when it chose
  const seenD = s.distance;
  if (prev && seenD < 165 && !op.airborne && prev.state === 'neutral' && !prev.airborne) {
    const C = M.close[mine && mine.guard ? 'G' : 'N'];
    C.n++;
    let k = null;
    if (op.state === 'throw') k = 'T';
    else if (op.state === 'move' && op.move) {
      const d0 = defOf(op, op.move.id);
      const g = d0 && d0.segments.find((x) => x.type === 'strike');
      if (g) k = g.zone === 'low' ? 'L' : g.zone === 'overhead' ? 'O' : 'S';
      else k = 'X';
    } else if (op.state === 'dash') k = op.stateLength === 18 ? 'B' : 'F';
    else if (op.state === 'prejump') k = 'J';
    else if (op.state === 'parry') k = 'P';
    else if (op.state === 'neutral') {
      const away = op.vx * Math.sign(op.x - s.me.x) > 0.5;
      k = op.guard === 'high' ? 'GH' : op.guard === 'low' ? 'GL' : away ? 'W' : 'I';
    }
    if (k) C[k] = (C[k] || 0) + 1;
  }
  // its oki: what it started around my wake-up (seen late: it started `lag` steps before what I see)
  if (M.myWakeAt != null && prev) {
    const seenStep = s.tick - lag;
    const rel = seenStep - M.myWakeAt;
    const fresh = (op.state === 'move' && op.move && (prev.state !== 'move' || !prev.move || prev.move.t > op.move.t || prev.move.id !== op.move.id)) || (op.state === 'throw' && prev.state !== 'throw');
    if (fresh && rel >= -30 && rel <= 16 && !M.okiCounted) {
      let k = null;
      if (op.state === 'throw') k = rel <= 14 ? 'throw' : 'late';
      else {
        const d0 = defOf(op, op.move.id);
        const g = d0 && firstStrike(d0);
        if (g) {
          const act = rel + g.activeStart; // its first active step, relative to my wake step
          if (act >= -1 && act <= 2) k = g.zone === 'low' ? 'low' : g.zone === 'overhead' || g.zone === 'air' ? 'oh' : 'mid';
          else if (act > 2 && act <= 18) k = 'late';
        }
      }
      if (k) {
        M.oki[k] = (M.oki[k] || 0) + 1;
        M.oki.n++;
        M.okiCounted = true;
      }
    }
    if (rel > 18) {
      if (!M.okiCounted) {
        M.oki.none = (M.oki.none || 0) + 1;
        M.oki.n++;
      }
      M.myWakeAt = null;
      M.okiCounted = false;
    }
  }
  // its wake-up: the guard it holds while down, and what it does first when up
  if (['knockdown', 'getup'].includes(op.state)) M.wakeGuardSeen = op.guard || null;
  if (prev && prev.state === 'getup' && op.state !== 'getup') {
    M.wake.n++;
    M.wake['g' + (prev.guard || 'none')] = (M.wake['g' + (prev.guard || 'none')] || 0) + 1;
    M.wakeWatch = 0;
  }
  if (M.wakeWatch !== null && M.wakeWatch !== undefined) {
    M.wakeWatch++;
    let k = null;
    if (op.state === 'throw') k = 'T';
    else if (op.state === 'move') k = 'A';
    else if (op.state === 'dash') k = 'B';
    else if (op.state === 'prejump') k = 'J';
    else if (op.state === 'parry') k = 'P';
    else if (op.state !== 'neutral') k = 'X';
    else if (M.wakeWatch > 7) k = op.guard ? 'G' : 'I';
    if (k) {
      M.wake[k] = (M.wake[k] || 0) + 1;
      M.wakeWatch = null;
    }
  }
  // its guard at mid range
  if (seenD >= 135 && seenD <= 420 && op.state === 'neutral' && !op.airborne) {
    const G = M.midG;
    G.n++;
    if (op.guard === 'high') G.h++;
    else if (op.guard === 'low') G.l++;
    else G.o++;
  }
  // walking in: free, unguarded, coming at me
  const toMe = Math.sign(s.me.x - op.x);
  if (op.state === 'neutral' && !op.airborne && !op.guard && op.vx * toMe > 1) M.walkIn++;
  else M.walkIn = 0;
  M.myHist[s.tick & 63] = { guard: s.me.guard, state: s.me.state };
  M.prevOp = op;
}

// per-tick rates of its close-range choices (with a prior), given whether I am guarding as it sees me
function closeModel(guarding) {
  const C = M.close[guarding ? 'G' : 'N'];
  const O = M.close[guarding ? 'N' : 'G'];
  const prior = { T: 0.012, S: 0.02, L: 0.008, O: 0.003, B: 0.004, J: 0.003, P: 0.002, GH: 0.25, GL: 0.25, W: 0.1, I: 0.3, F: 0.003, X: 0.002 };
  const n0 = 60;
  const n = C.n + O.n * 0.3 + n0;
  const r = {};
  for (const k of Object.keys(prior)) r[k] = ((C[k] || 0) + (O[k] || 0) * 0.3 + prior[k] * n0) / n;
  return r;
}

// ---------- the guard I hold when I cannot see what comes ----------
function chooseGuard(s, P, incoming) {
  const th = threatNow(s, P, incoming);
  if (th && th.in < 20) {
    if (th.zone === 'low') return 'low';
    if (th.zone === 'high' || th.zone === 'overhead' || th.zone === 'air') return 'high';
    if (th.kind === 'proj') return 'low';
  }
  if ((P.air || P.jumping) && s.distance < 420) return 'high';
  const S = M.st;
  const tot = S.lowSeen + S.midSeen + S.ohSeen + 4;
  if ((S.ohSeen + 1) / tot > 0.4 && (S.lowSeen + 1) / tot < 0.15) return 'high';
  return 'low';
}
const guardAct = (g) => ({ guard: g, crouch: g === 'low' });

function threatNow(s, P, incoming) {
  const me = s.me;
  const d = s.distance;
  let best = null;
  const add = (t) => {
    if (!best || t.in < best.in) best = t;
  };
  for (const t of P.threats) {
    if (t.kind === 'strike') {
      const crouch = me.posture === 'crouch';
      if (!strikeReaches(t.g, d, 30, crouch)) continue;
      if (t.in > 24) continue;
      if (crouch && t.zone === 'high') continue;
      add({ ...t, sure: strikeReaches(t.g, d, -10, crouch) });
    } else if (t.kind === 'spawn') {
      const dx0 = Math.abs(me.x - t.x0);
      if (Math.sign(me.x - t.x0) !== Math.sign(t.v) && dx0 > 55) continue;
      const k = t.in + Math.max(0, Math.ceil((dx0 - 59) / Math.abs(t.v)));
      if (k < -1) continue;
      add({ kind: 'proj', zone: t.zone, in: Math.max(0, k), end: k + 2, sure: true });
    } else if (t.kind === 'teleport') add({ kind: 'teleport', zone: 'mid', in: t.in + 4, end: t.in + 20, sure: false, g: t.g });
  }
  for (const p of incoming) if (p.in < 40) add({ kind: 'proj', zone: p.zone, in: p.in, end: p.in + 2, sure: true, p });
  return best;
}

// ---------- punish ----------
function bestPunish(s, P, win, d) {
  const me = s.me;
  const op = s.opponent;
  const crouch = op.posture === 'crouch';
  const opts = [];
  const sup = ready(me, 'finale');
  if (sup && landsIn(sup, d, win - 1, crouch, false)) opts.push({ id: 'finale', v: 480 });
  if (d <= THROW_RANGE - 8 && win >= 9 && ['move', 'staggered', 'dizzy', 'throw', 'parry', 'landing', 'techBreak'].includes(P.state)) opts.push({ throw: true, v: 119 * ((me.stale?.throw ?? 1)) + 25 });
  const list = [['upper', 95], ['heavy', 65], ['ram', 70], ['sweep', 80], ['cyclone', 80], ['slide', 72], ['knee', 45], ['low', 35], ['jab', 30], ['overhead', 60]];
  for (const [id, v] of list) {
    const m = ready(me, id);
    if (!m || !landsIn(m, d, win - 1, crouch, false)) continue;
    opts.push({ id, v: v * (me.stale?.[id] ?? 1) });
  }
  for (const id of ['spike', 'lance']) {
    const m = ready(me, id);
    if (!m) continue;
    const g = m.segments[0];
    const k = Math.max(0, Math.ceil((d - 60 - 59) / PROJ_SPEED[g.speed]));
    if (g.activeStart + k <= win - 1 && !(g.zone === 'high' && crouch)) opts.push({ id, v: g.damage * (me.stale?.[id] ?? 1) });
  }
  opts.sort((a, b) => b.v - a.v);
  return opts[0] || null;
}

// ---------- main ----------
function act(s) {
  const me = s.me;
  const op = s.opponent;
  settle(s);
  observe(s);
  const P = project(s);
  const d = s.distance;

  const dm = me.meter - M.lastMeter;
  const dhp = M.lastHp - me.hp;
  M.lastMeter = me.meter;
  M.lastHp = me.hp;
  if (me.move && dm > 0.5) {
    const m = defOf(me, me.move.id);
    const g = firstStrike(m);
    if (g) M.confirm = { tick: s.tick, kind: dm >= g.damage * 0.12 ? 'hit' : 'block', id: me.move.id };
  }
  M.dm = dm;
  M.dhp = dhp;
  if (me.state === 'blockstun' || me.state === 'hitstun' || dhp > 0) M.opMoveUntouched = false;
  if (me.state === 'parry' && me.stateTicks <= 1) M.opMoveUntouched = false;

  const incoming = incomingProjectiles(s);
  const a = {};

  // ---- not free ----
  if (me.state === 'move') return a;
  if (me.state === 'air') return airAct(s, P);
  if (me.state === 'blockstun') return guardAct(chooseGuard(s, P, incoming));
  if (!me.canAct) {
    // the guard I hold now holds from my first free tick (getup, stun, landing)
    if (me.state === 'getup' || me.state === 'knockdown') return wakeUp(s, P, incoming);
    return guardAct(chooseGuard(s, P, incoming));
  }

  // ---- a wake-up plan for the first free tick ----
  if (M.wakePlan) {
    const w = M.wakePlan;
    M.wakePlan = null;
    if (w === 'jab' && ready(me, 'jab')) return { attack: 'jab' };
    if (w === 'upper' && ready(me, 'upper')) return { attack: 'upper' };
    if (w === 'back') return { dash: 'back' };
    if (w === 'finale' && ready(me, 'finale')) return { attack: 'finale' };
    if (w === 'throw') M.intent = { kind: 'throwAt', at: s.tick + 6, until: s.tick + 10 };
  }

  // ---- hit-confirm ----
  if (M.confirm && s.tick - M.confirm.tick < 20 && M.confirm.kind === 'hit' && M.confirm.id === 'jab') {
    M.confirm = null;
    if (op.posture !== 'crouch' && d < 125 && ready(me, 'upper')) return { attack: 'upper' };
    if (d < 160 && ready(me, 'low')) return { attack: 'low' };
  }
  M.confirm = null;

  // ---- seen threats ----
  const th = threatNow(s, P, incoming);
  if (th && th.in <= 22) {
    const r = defend(s, P, th, incoming);
    if (r) {
      M.intent = null;
      return r;
    }
  }

  // ---- punish ----
  if (P.committed && !P.knock && !P.air && P.hittable === 0 && !P.teleporting) {
    let win = P.open;
    if (P.state === 'move' && !P.recovering) {
      const st = P.threats.find((t) => t.kind === 'strike');
      if (st && st.end > 0) win = 0;
    }
    if (win > 0) {
      const pun = bestPunish(s, P, win, d);
      if (pun) {
        M.intent = null;
        if (pun.throw) return { throw: true };

        return { ...a, attack: pun.id };
      }
      if (win > 18 && d > 200) return { dash: 'forward' };
      if (win > 6 && d > 120) return { walk: 1 };
    }
  }

  // ---- down: the wake-up game ----
  if (P.knock) {
    const r = oki(s, P, incoming);
    if (r) {
      r.dbg = `oki ${M.okiPlan} wake=${P.wakeRaw}`;
      return r;
    }
  } else M.okiPlan = null;

  // ---- anti-air ----
  if (P.air || P.jumping) {
    const r = antiAir(s, P);
    if (r) return r;
  }

  // ---- neutral ----
  return neutral(s, P, incoming);
}

function defend(s, P, th, incoming) {
  const me = s.me;
  const d = s.distance;
  const zone = th.zone;
  let guard = zone === 'low' ? 'low' : zone === 'mid' ? chooseGuard(s, P, incoming) : 'high';
  if (th.kind === 'proj') {
    if (th.in > 26) return null;
    if (th.in >= 1 && th.in <= 4 && (M.parryOk ?? true)) return { parry: true };
    // a pause through it: the teleport is invulnerable on its ticks 10–15 and lands behind the shooter
    if (th.in >= 11 && th.in <= 15 && d > 330 && ready(me, 'blink') && rnd() < 0.7) {
      M.lastChoice = `blink-through@${s.tick}`;
      return { attack: 'blink' };
    }
    if (zone === 'high') return guardAct('low'); // flies over a crouch
    if (zone === 'low') return guardAct('low');
    // cancel with mine when far
    if (ready(me, 'lance') && th.in > 12 && d > 300) return { attack: 'lance' };
    return guardAct(guard === 'high' ? 'high' : 'low');
  }
  if (th.kind === 'teleport') return guardAct(chooseGuard(s, P, incoming));
  // super through it: invulnerable startup
  const sup = ready(me, 'finale');
  if (sup && P.move && P.move.slot !== 'super') {
    const g = firstStrike(sup);
    if (P.free >= g.activeStart + 1 && strikeReaches(g, d, -10) && (th.end <= g.activeStart || th.in > g.activeStart)) {
      const a = { attack: 'finale' };
      // the ring says the super's line itself
      return a;
    }
  }
  // parry a strike seen in advance, on the tick
  if (th.sure && th.in >= 1 && th.in <= 4 && P.move && P.move.slot !== 'super') return { parry: true };
  // armor: a throw goes through it
  if (P.move && P.move.armor > 0 && th.in >= 7 && d <= THROW_RANGE - 6) return { throw: true };
  // beat a slow startup with a fast hit
  if (!(P.move && P.move.armor) && th.in >= 6 && d < 120 && ready(me, 'jab')) return { attack: 'jab' };
  if (!(P.move && P.move.armor) && th.in >= 9 && strikeReaches(firstStrike(defOf(me, 'heavy')), d, -10) && ready(me, 'heavy')) return { attack: 'heavy' };
  if (th.in > 20) return null;
  return guardAct(guard);
}

function antiAir(s, P) {
  const me = s.me;
  const op = s.opponent;
  if (P.state === 'prejump') return guardAct('high');
  let x = P.x;
  let y = P.y;
  let vy = P.vy ?? op.vy;
  const up = ready(me, 'upper');
  if (up && P.air) {
    for (let t = 1; t <= 11; t++) {
      vy -= 0.85;
      y += vy;
      x += op.vx;
      if (t < 5) continue;
      const dx = Math.abs(x - me.x);
      if (y > 0 && y + 20 < 270 && y + 250 > 200 && dx <= 120) return { attack: 'upper' };
    }
  }
  if (Math.abs(P.x - me.x) < 360) return guardAct('high');
  return null;
}

function airAct(s, P) {
  const me = s.me;
  if (!me.canAirMove) return {};
  const dx = Math.abs(P.x - me.x);
  if (me.vy < 3 && dx < 150 && me.y < 170 && ready(me, 'air_kick')) return { attack: 'air_kick' };
  return {};
}

// my own wake-up: what I do on the first free tick
// My wake-up. Its oki habits (what it did around my earlier wake-ups) pick the guard for my wake step and my first
// action: a meaty lands before I can act, a throw comes 6 ticks later at the earliest.
function wakeUp(s, P, incoming) {
  const me = s.me;
  const left = me.stateLength - me.stateTicks + (me.state === 'knockdown' ? 20 : 0); // my wake step offset
  M.myWakeAt = s.tick + left;
  const O = M.oki;
  const n = O.n + 3;
  const pLow = ((O.low || 0) + 0.8) / n;
  const pOH = ((O.oh || 0) + 0.3) / n;
  const pMid = ((O.mid || 0) + 0.6) / n;
  const pT = ((O.throw || 0) + 0.6) / n;
  const pLate = ((O.late || 0) + 0.4) / n;
  const pNone = Math.max(0.05, 1 - pLow - pOH - pMid - pT - pLate);
  const guard = pOH > pLow * 1.2 ? 'high' : 'low';
  if (left === 1 && !M.wakePlan) {
    const near = s.distance < 220;
    const opts = [];
    const add = (k, ev, ok = true) => ok && opts.push({ k, ev });
    add('block', pLate * 25 - pT * 119 + pNone * 0);
    add('jab', pT * 45 + pNone * 8 - pLate * 15, near);
    add('back', pT * 70 + pLate * 10 - pNone * 4, me.x - s.stage.left > 100 && s.stage.right - me.x > 100);
    add('throw', pT * 5 + pNone * 30 - pLate * 40, near);
    add('finale', (pT + pLate) * 420 + pNone * 60 - 60, near && me.meter >= 300);
    const vals = opts.map((o) => {
      const a = armStat('wakeR', o.k);
      return { ...o, v: o.ev + (a.n ? (a.sum / a.n) * (a.n / (a.n + 3)) : 0) };
    });
    const mx = Math.max(...vals.map((o) => o.v));
    let sum = 0;
    for (const o of vals) sum += o.e = Math.exp((o.v - mx) / (12 * TEMP_MUL));
    let x = rnd() * sum;
    let pick = vals[vals.length - 1];
    for (const o of vals) {
      x -= o.e;
      if (x <= 0) {
        pick = o;
        break;
      }
    }
    M.lastChoice = `wake:${pick.k}@${s.tick} ev=${Math.round(pick.ev)}`;
    M.pending.push({ ctx: 'wakeR', k: pick.k, tick: s.tick, myHp: me.hp, opHp: null, due: s.tick + 16 + 60, win: 60, ev: pick.ev });
    M.wakePlan = pick.k === 'block' ? null : pick.k;
  }
  // what I can see coming decides the guard (a slow meaty is seen in time)
  const th = threatNow(s, P, incoming);
  if (th && th.in <= left + 3 && th.zone && left <= 18) {
    const z = th.zone === 'low' ? 'low' : th.zone === 'mid' ? guard : 'high';
    if (left <= 2 || th.in <= left + 1) return guardAct(z);
  }
  // a decoy while down: it sees my guard late, so it sees the high one; the real guard goes up on the last step
  if (left <= 2) return guardAct(guard);
  return { guard: guard === 'low' ? 'high' : 'low', crouch: false };
}

// the opponent is down: a meaty on its first free step, a throw after its throw protection, or a bait
function oki(s, P, incoming) {
  const me = s.me;
  const op = s.opponent;
  const d = s.distance;
  const raw = P.wakeRaw ?? P.free; // step offset of its first free step
  // a new knockdown: a new plan
  const wakeAt = raw === undefined ? null : s.tick + raw;
  if (wakeAt !== null && (M.okiWake == null || Math.abs(wakeAt - M.okiWake) > 4)) {
    M.okiPlan = null;
    M.okiWake = wakeAt;
  }
  if (raw === undefined || P.juggleLand > 0) {
    M.okiPlan = null;
    M.okiWake = null;
    if (d > 110) return { walk: 1 };
    return guardAct('low');
  }
  if (op.bars >= 3 && raw < 30 && d < 260) {
    M.okiPlan = 'block';
    return guardAct('low');
  }
  if (raw > 8 && d > 100) {
    if (d > 300 && raw > 24) return { dash: 'forward' };
    return { walk: 1 };
  }
  if (!M.okiPlan && raw <= 21) M.okiPlan = okiChoice(s, P);
  const plan = M.okiPlan;
  if (!plan || plan === 'block') return raw < -12 ? null : guardAct('low');
  if (plan === 'throw') {
    if (raw <= -5 && d <= THROW_RANGE) {
      M.okiPlan = 'done';
      return { throw: true };
    }
    if (d > THROW_RANGE - 25) return { walk: 1 };
    return guardAct('low');
  }
  if (plan === 'bait') {
    if (raw < -16) return null;
    return guardAct('low');
  }
  if (plan === 'done') return raw < -2 ? null : guardAct('low');
  const m = defOf(me, plan);
  const g = firstStrike(m);
  if (!g) return guardAct('low');
  if (raw === g.activeStart && strikeReaches(g, d, -8) && ready(me, plan)) {
    M.okiPlan = 'done';
    return { attack: plan };
  }
  if (raw > g.activeStart && d > 90) return { walk: 1 };
  if (raw < g.activeStart) {
    M.okiPlan = 'done';
  }
  return guardAct('low');
}

// The wake-up guess: the guard it holds while down (seen now, and its habit) and what it does first when up.
function okiChoice(s, P) {
  const me = s.me;
  const W = M.wake;
  const n = W.n + 2;
  // the guard it will hold on its first free step
  let gh = ((W.ghigh || 0) + 0.6) / n;
  let gl = ((W.glow || 0) + 0.6) / n;
  let gn = ((W.gnone || 0) + 0.8) / n;
  const seen = M.wakeGuardSeen;
  const wSeen = 0.3; // what I see of its guard while it is down can be a decoy
  gh = gh * (1 - wSeen) + (seen === 'high' ? wSeen : 0);
  gl = gl * (1 - wSeen) + (seen === 'low' ? wSeen : 0);
  gn = gn * (1 - wSeen) + (!seen ? wSeen : 0);
  const tot = gh + gl + gn;
  gh /= tot;
  gl /= tot;
  gn /= tot;
  // its first action when up
  const an = (W.T || 0) + (W.A || 0) + (W.B || 0) + (W.J || 0) + (W.G || 0) + (W.I || 0) + (W.P || 0) + 3;
  const aT = ((W.T || 0) + 0.6) / an;
  const aA = ((W.A || 0) + 0.8) / an;
  const aB = ((W.B || 0) + (W.J || 0) + 0.3) / an;
  const aStay = ((W.G || 0) + (W.I || 0) + 1.3) / an;
  const aP = (W.P || 0) / an;
  const crouchWake = gl > 0.5;
  const opts = [];
  const add = (k, ev, ok = true) => ok && opts.push({ k, ev });
  add('upper', gn * 95 * (1 - aP * 0.5) - gh * 45 - gl * 60, ready(me, 'upper') || me.state !== 'neutral');
  add('sweep', (gn + gh) * 78 - gl * 75 - 10);
  add('jab', gn * 55 - (gh + gl) * 3);
  add('low', (gn + gh) * 35 - gl * 3);
  add('overhead', (gn + gl) * 60 - gh * 28 - 25);
  add('heavy', gn * 65 - (gh + gl) * 20);
  add('throw', aStay * 119 - aA * 40 - aB * 60 + aT * 5);
  add('block', aA * 30 - aT * 119 - aStay * 5);
  const vals = opts.map((o) => {
    const a = armStat('okiR', o.k);
    return { ...o, v: o.ev + (a.n ? (a.sum / a.n) * (a.n / (a.n + 3)) : 0) };
  });
  const mx = Math.max(...vals.map((o) => o.v));
  let sum = 0;
  for (const o of vals) sum += o.e = Math.exp((o.v - mx) / (10 * TEMP_MUL));
  let x = rnd() * sum;
  let pick = vals[vals.length - 1];
  for (const o of vals) {
    x -= o.e;
    if (x <= 0) {
      pick = o;
      break;
    }
  }
  M.lastChoice = `oki:${pick.k}@${s.tick} ev=${Math.round(pick.ev)}`;
  M.pending.push({ ctx: 'okiR', k: pick.k, tick: s.tick, myHp: me.hp, opHp: null, due: s.tick + 16 + 80, win: 80, ev: pick.ev });
  return pick.k;
}

function neutral(s, P, incoming) {
  const me = s.me;
  const op = s.opponent;
  const d = s.distance;
  const a = {};
  const opFree = op.state === 'neutral' && !op.airborne;
  const opGuard = op.guard;
  const opCrouch = op.posture === 'crouch';
  const lead = me.hp / me.maxHp - op.hp / op.maxHp;
  const R = (M.opRange ||= threatRange(op, 15));

  // it walks in unguarded: meet it with the hit that reaches where it will be
  if (M.walkIn >= 4 && opFree && !opGuard && d < 470) {
    const lag = (s.reaction ?? 15) + 1;
    const v = Math.abs(op.vx);
    const dNow = d - v * lag;
    let best = null;
    const cands = [['upper', 95], ['jab', 50], ['heavy', 65], ['sweep', 75], ['cyclone', 78], ['slide', 70], ['finale', 400], ['knee', 45]];
    for (const [id, val] of cands) {
      const m = ready(me, id);
      if (!m) continue;
      const g = firstStrike(m);
      const dHit = dNow - v * g.activeStart;
      if (dHit < 60 || !strikeReaches(g, dHit, -12)) continue;
      // a long startup gives it time to stop and guard
      const vv = val * (me.stale?.[id] ?? 1) - g.activeStart * 1.5;
      if (!best || vv > best.v) best = { id, v: vv };
    }
    if (best && rnd() < 0.6) {
      M.intent = null;
      M.lastChoice = `walkin:${best.id}@${s.tick}`;

      return { ...a, attack: best.id };
    }
  }

  // a running intent
  const it = M.intent;
  if (it && s.tick <= it.until) {
    if (it.kind === 'hold') return guardAct(chooseGuard(s, P, incoming));
    if (it.kind === 'throwAt') {
      if (s.tick >= it.at && d <= THROW_RANGE) {
        M.intent = null;
        return { throw: true };
      }
      if (d > THROW_RANGE - 20) return { walk: 1 };
      return guardAct('low');
    }
    if (it.kind === 'approach') {
      if (d > it.to) return { walk: 1 };
      M.intent = null;
    }
    if (it.kind === 'back') {
      if (d < 400) return { walk: -1 };
      M.intent = null;
    }
    if (it.kind === 'shimmy') {
      if (s.tick < it.mid) return { walk: -1 };
      return guardAct('low');
    }
  } else M.intent = null;

  if (d > 500 && rnd() < 0.003) say(s, a, 'taunt');

  // the super, when it walks in unguarded
  if (ready(me, 'finale') && opFree && !opGuard && d < 200 && op.vx * Math.sign(me.x - op.x) > 0) {
    // the ring says the super's line itself
    return { ...a, attack: 'finale' };
  }

  // ---- far ----
  if (d > 420) {
    const opts = [{ k: 'approach' }, { k: 'dash', bias: d > 600 ? 4 : -6 }];
    if (ready(me, 'lance')) opts.push({ k: 'lance', bias: me.passive > 200 ? -10 : 0 });
    if (ready(me, 'spike') && !opCrouch && d < 750) opts.push({ k: 'spike' });
    if (rnd() < 0.12) {
      const k = choose(s, 'far', opts);
      if (k === 'dash') return { dash: 'forward' };
      if (k === 'lance' || k === 'spike') return { attack: k };
      M.intent = { kind: 'approach', to: 300, until: s.tick + 40 };
    }
    return { walk: 1 };
  }

  // ---- mid: 135..420 ----
  if (d > 135) {
    if (rnd() < 0.18) {
      // its mid-range guard habit and what I see of it now
      const G = M.midG;
      const n = G.n + 20;
      let gl = (G.l + 6) / n;
      let gh = (G.h + 6) / n;
      let go = (G.o + 8) / n;
      const w = 0.4;
      gl = gl * (1 - w) + (opGuard === 'low' ? w : 0);
      gh = gh * (1 - w) + (opGuard === 'high' ? w : 0);
      go = go * (1 - w) + (!opGuard ? w : 0);
      // late in the round the lead decides how much to risk
      const late = s.timeLeft < 60 * 40;
      const safe = late && lead > 0.06 ? 10 : 0;
      const push = late && lead < -0.03 ? 8 : 0;
      const opts = [{ k: 'hold', bias: safe - push }, { k: 'approach', bias: push - safe }, { k: 'dash', bias: (d > 330 ? -8 : 0) + push - safe }];
      const lowBias = (go + gh) * 16 - gl * 30 - 4 - safe;
      if (d <= 215) opts.push({ k: 'heavy', bias: go * 16 - (gh + gl) * 10 - safe });
      if (d <= 218 && ready(me, 'sweep')) opts.push({ k: 'sweep', bias: lowBias });
      if (d <= 355 && ready(me, 'slide')) opts.push({ k: 'slide', bias: lowBias });
      if (d <= 280 && ready(me, 'cyclone')) opts.push({ k: 'cyclone', bias: go * 16 - (gh + gl) * 14 - safe });
      if (ready(me, 'spike') && !opCrouch) opts.push({ k: 'spike', bias: go * 8 - gl * 12 - safe * 0.5 });
      if (d < 300) opts.push({ k: 'back', bias: safe });
      const k = choose(s, 'mid', opts, 8);
      if (k === 'hold') {
        M.intent = { kind: 'hold', until: s.tick + 10 + Math.floor(rnd() * 12) };
        return guardAct(chooseGuard(s, P, incoming));
      }
      if (k === 'approach') {
        M.intent = { kind: 'approach', to: 110, until: s.tick + 30 };
        return { walk: 1 };
      }
      if (k === 'dash') return { dash: 'forward' };
      if (k === 'back') {
        M.intent = { kind: 'back', until: s.tick + 14 };
        return { walk: -1 };
      }
      return { attack: k };
    }
    // between choices: stay guarded inside its range, walk in outside it
    if (d <= R + 20) return guardAct(chooseGuard(s, P, incoming));
    return { walk: 1 };
  }

  // ---- close ----
  return closeGame(s, P, incoming);
}

// Close range is rock-paper-scissors: a guard loses to a throw, a throw to a jab, a jab to a guard (and a backdash
// makes a throw whiff). Its habits here, counted on what it did when it saw me guarding or not, give the odds; the
// payoff of each choice is its expected damage over the next few ticks; the bandit corrects what the model misses.
function closeGame(s, P, incoming) {
  const me = s.me;
  const op = s.opponent;
  const d = s.distance;
  const it = M.intent;
  const r = closeModel(!!me.guard);
  const W = 8;
  const p = (k) => 1 - Math.exp(-(r[k] || 0) * W);
  const pT = p('T');
  const pS = p('S') + p('X') * 0.5;
  const pL = p('L');
  const pO = p('O');
  const pB = p('B') + p('J') * 0.7;
  const pP = p('P');
  const act = pT + pS + pL + pO + pB + pP;
  const rest = Math.max(0.05, 1 - act);
  const gTot = (r.GH || 0) + (r.GL || 0) + (r.I || 0) + (r.W || 0) + 1e-6;
  const pGH = rest * (r.GH || 0) / gTot;
  const pGL = rest * (r.GL || 0) / gTot;
  const pI = rest * ((r.I || 0) + (r.W || 0) * 0.5) / gTot;
  const pW = rest * (r.W || 0) * 0.5 / gTot;
  // what I see now: a guard it holds right now (seen late) shifts the odds a little
  const seenG = op.guard;
  const crouch = op.posture === 'crouch';
  const cornered = me.x - s.stage.left < 110 || s.stage.right - me.x < 110;
  const opts = [];
  const add = (k, ev, ok = true) => ok && opts.push({ k, ev });
  const thr = (me.stale?.throw ?? 1) * 119;
  const jabV = crouch ? 40 : 60; // jab, then the upper or the low on a confirm
  add('throw', (pGH + pGL + pI) * thr + pP * thr - pS * 45 - pL * 35 - pB * 70 - pO * 10 + (seenG ? 10 : 0), d <= THROW_RANGE);
  add('jab', (pI + pT + pO + pW * 0.5) * jabV - pS * 8 - pB * 15 - pP * 50 - (pGH + pGL) * 3, d <= 118);
  add('low', (pI + pGH + pT + pO * 0.5) * 35 - pS * 30 - pGL * 4 - pB * 15 - pP * 45 + (seenG === 'high' ? 8 : seenG === 'low' ? -8 : 0), d <= 160);
  add('upper', (pI + pT) * 95 * (crouch ? 0 : 1) - (pGH + pGL) * 30 - pS * 40 - pL * 50 - pB * 40 - pP * 60, d <= 118 && !crouch);
  add('block', (pS + pL + pO) * 22 - pT * 119 + pB * 0 - pP * 0, true);
  add('back', pT * 75 + (pS + pL) * 12 - (pGH + pGL + pI) * 3, !cornered);
  add('tech', pT * 20 + (pGH + pGL + pI) * thr * 0.9 - pS * 45 - pL * 35 - pB * 70, d <= THROW_RANGE + 30 && d > THROW_RANGE);
  add('sweep', (pI + pGH + pT) * 60 - pGL * 50 - pS * 35 - pB * 30, d <= 210 && d > 110);
  // the super: invulnerable through its startup, it beats every attack and throw; a guard blocks it and punishes
  add('finale', (pS + pL + pT + pO + pP + pI * 0.6) * 460 - (pGH + pGL) * 160 - pB * 120 - 40, !!ready(me, 'finale') && d <= 205);
  // 20 ticks of startup: a brain that watches blocks or parries it on sight, so it pays only against one that does not
  add('overhead', (pGL + pI) * 60 - pGH * 25 - (pS + pT + pL) * 60 - 45, d <= 160 && pGL > 0.25);
  // its super is ready: an invulnerable reversal beats anything I start, a guard waits it out
  const opSuper = op.meter >= 300 && op.moves.some((m) => m.slot === 'super' && m.posture !== 'air' && m.firstActive <= 12);
  if (opSuper) for (const o of opts) o.ev += o.k === 'block' || o.k === 'back' ? 20 : o.k === 'finale' ? 0 : -45;
  // the bandit's correction
  const vals = opts.map((o) => {
    const a = armStat('closeR', o.k);
    return { ...o, v: o.ev + (a.n ? (a.sum / a.n) * (a.n / (a.n + 4)) : 0) };
  });
  const mx = Math.max(...vals.map((o) => o.v));
  const temp = 12 * TEMP_MUL;
  let sum = 0;
  for (const o of vals) sum += o.e = Math.exp((o.v - mx) / temp);
  let x = rnd() * sum;
  let pick = vals[vals.length - 1];
  for (const o of vals) {
    x -= o.e;
    if (x <= 0) {
      pick = o;
      break;
    }
  }
  const k = pick.k;
  M.lastChoice = `close:${k}@${s.tick} ev=${Math.round(pick.ev)}`;
  M.pending.push({ ctx: 'closeR', k, tick: s.tick, myHp: me.hp, opHp: null, due: s.tick + 16 + 50, win: 50, ev: pick.ev });
  if (k === 'block') {
    M.intent = { kind: 'hold', until: s.tick + 5 + Math.floor(rnd() * 6) };
    return guardAct(chooseGuard(s, P, incoming));
  }
  if (k === 'throw') return { throw: true };
  if (k === 'tech') return { walk: 1 };
  if (k === 'back') return { dash: 'back' };
  if (k === 'finale') {
    const a = { attack: 'finale' };
    // the ring says the super's line itself
    return a;
  }
  if (ready(me, k)) return { attack: k };
  return guardAct(chooseGuard(s, P, incoming));
}

export default {
  init(info) {
    M = fresh();
    rs = ((info?.seed ?? 1) ^ 0x9e3779b9) >>> 0 || 1;
    const v = info?.view;
    if (v) {
      M.lastMeter = v.me.meter;
      M.lastHp = v.me.hp;
    }
  },
  tick(s) {
    if (!M) {
      M = fresh();
      M.lastHp = s.me.hp;
    }
    const r = act(s) || {};
    if (!r.say && !r.attack) talk(s, r);
    if (!r.dbg) r.dbg = M.lastChoice;
    return r;
  },
};
