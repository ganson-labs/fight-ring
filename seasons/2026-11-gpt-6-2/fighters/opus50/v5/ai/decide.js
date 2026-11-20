// The choice of the tick: defend what is coming, punish what is committed, then play the distance.
import { REACH, ZONE_Y, HURT, PUSH, WALL_L, WALL_R, mv, strikeReaches, fly } from './predict.js';
import { rate } from './model.js';
import { STYLE } from './style.js';

const has = (me, id) => me.moves.some((m) => m.id === id);

// can I start this move now
function ready(me, id) {
  const d = mv(me, id);
  if (!d) return null;
  if (d.slot === 'super' && me.meter < 300) return null;
  if (d.segments.some((g) => g.type === 'projectile') && me.projectileOut) return null;
  if (d.posture === 'air' ? !me.airborne : me.airborne) return null;
  return d;
}

const firstStrike = (d) => d.segments.find((g) => g.type === 'strike');

// the opponent's reach with what he can start faster than I see it (ground strikes), plus his walk meanwhile
function quickReach(op) {
  let r = 0;
  for (const d of op.moves) {
    if (d.posture === 'air' || d.slot === 'super') continue;
    const g = firstStrike(d);
    if (!g || d.segments[0].type !== 'strike') continue;
    if (g.activeStart > 16) continue;
    r = Math.max(r, 70 + REACH[g.reach] + (g.advance || 0));
  }
  return r || 220;
}

function say(M, s, act, kind, id) {
  if (s.tick - M.lastSay < 240) return;
  const lines = s.lines.filter((l) => (id ? l.id === id : l.kind === kind));
  if (!lines.length) return;
  act.say = lines[Math.floor(M.rng() * lines.length)].id;
  M.lastSay = s.tick;
}

// the guard to hold when nothing is seen coming: low, unless he jumps in more than he hits low
export function idleGuard(M, d = 999) {
  const O = M.op;
  return d > 150 && O.jumps >= 3 && O.jumps > (O.lows + 1) * 1.5 ? 'high' : 'low';
}

const G = (M) => {
  const g = idleGuard(M, M.lastDist);
  return { guard: g, crouch: g === 'low' };
};

// guard for what comes next
function guardFor(M, s, P, T, horizon = 24) {
  const me = s.me;
  for (const t of T) {
    if (t.in > horizon) break;
    if (t.kind === 'proj') {
      if (t.zone === 'low') return 'low';
      if (t.zone === 'high') return 'low'; // ducked
      return 'low';
    }
    if (t.zone === 'overhead' || t.zone === 'air') return 'high';
    if (t.zone === 'low') return 'low';
    if (t.zone === 'high') return 'low'; // a high strike misses a crouch
    return 'low';
  }
  if (P.air && P.dist < 420) return 'high';
  return idleGuard(M);
}

// The best punish that lands while he is still committed. Returns { id, crouch } or null.
function bestPunish(M, s, P, T) {
  const me = s.me;
  const op = s.opponent;
  if (P.free) return null;
  if (P.state === 'blockstun') return null;
  // in the air with his air move still in hand he is not committed: that is the anti-air's business
  if (P.air && !P.juggle && (P.canAirMove || s.opponent.canAirMove) && !P.airMove) return null;
  const open = P.busy - (P.wake ? 1 : 0);
  if (open <= 0) return null;
  const dir = P.dir;
  let best = null;
  for (const d of me.moves) {
    if (d.posture === 'air') continue;
    if (!ready(me, d.id)) continue;
    const g = firstStrike(d);
    if (!g) continue;
    // teleports make positions hard; only plain strikes, advancing strikes and the super
    if (d.segments[0].type !== 'strike') continue;
    const S = g.activeStart; // ticks until my first active tick lands (inclusive)
    if (S > open) continue;
    if (P.invuln >= S) continue;
    // where he is when it lands: in the air he keeps flying
    let opts = {};
    if (P.air) {
      const f = fly(P.x, P.y, P.vxNow ?? P.vx ?? 0, P.vyNow ?? 0, S);
      if (f.landedAt) continue;
      opts = { x: f.x, y: f.y, air: true };
      if (P.juggle) continue; // a falling body: leave it
    }
    if ((g.hits || 1) > 1) opts.margin = 22;
    if (!strikeReaches(g, me, P, dir, opts)) continue;
    // his hits still to come before mine lands
    if (d.slot !== 'super' && hisStrikesCatch(s, P, d, g, S, T)) continue;
    // his armour soaks a hit that lands before his strike comes out
    if (P.def && P.def.armor && op.move && op.move.armorLeft > 0 && P.t + S < P.def.firstActive) continue;
    let dmg = 0;
    let k = 1;
    for (const x of d.segments) if (x.type === 'strike') for (let h = 0; h < (x.hits || 1); h++) {
      dmg += x.damage * k;
      k *= 0.8;
    }
    if (d.slot === 'super') dmg = Math.min(dmg * 1.8 * (P.state === 'hitstun' ? 0.8 : 1), 0.25 * op.maxHp);
    dmg *= me.stale[d.id] ?? 1;
    // what is left after it lands: a launch is a knockdown, anything else must not leave me open
    let last = null;
    for (const x of d.segments) if (x.type === 'strike') last = x;
    const lastHitT = last.activeStart + Math.max(0, (last.hits || 1) - 1) * Math.max(1, Math.floor((last.activeEnd - last.activeStart) / (last.hits || 1)));
    const adv = last.launch ? 25 : 14 + Math.floor(last.damage / 6) - (d.duration - lastHitT);
    dmg += adv >= 0 ? Math.min(adv, 10) : adv * 2.5;
    // keep the super for big openings when he is healthy; spend it when it wins the round
    if (d.slot === 'super') {
      if (op.hp <= 460) dmg += 300;
      if (open < 12 && op.hp > 600) dmg -= 0;
    }

    if (!best || dmg > best.v) best = { id: d.id, v: dmg, crouch: d.posture === 'crouch' };
  }
  // a throw: when he is grounded and not in a stun, it beats his guard after the protection
  if (!P.air && open >= 6 && P.dist <= 125 && !['hitstun', 'blockstun', 'knockdown', 'getup', 'juggle'].includes(P.state) && P.invuln < 6) {
    const v = 91 * (me.stale.throw ?? 1) + 20;
    if (!best || v > best.v) best = { id: null, throw: true, v };
  }
  return best;
}

// Would his remaining active strikes touch me while my move starts (my advance carries me in)?
function hisStrikesCatch(s, P, d, g, S, T) {
  for (const t of T) if (t.kind === 'strike' && t.in < S && t.last >= 0) return true;
  // a projectile on its way: moving into it only makes it arrive sooner
  for (const t of T) {
    if (t.kind !== 'proj' || !(t.hitsCrouch || d.posture !== 'crouch')) continue;
    // with an advance I run at it: the gap closes at both speeds
    let inn = t.in;
    if (g.advance && t.speed) inn = Math.floor((t.in * t.speed) / (t.speed + g.advance / Math.max(1, g.activeStart)));
    if (inn <= d.duration) return true;
  }
  if (!P.def || s.opponent.state !== 'move') return false;
  const me = s.me;
  const gap = Math.abs(P.x - me.x);
  const adv = g.advance ? Math.min(g.advance, Math.max(0, gap - PUSH)) : 0;
  if (!adv) return false;
  const myX = me.x + P.dir * adv;
  for (const h of P.def.segments) {
    if (h.type !== 'strike') continue;
    const inn = h.activeStart - P.t - 1;
    const last = h.activeEnd - P.t - 2;
    if (last < 0 || inn > S) continue;
    const reach = 35 + REACH[h.reach] + (h.advance && P.t < h.activeStart ? h.advance : 0);
    if (Math.abs(P.x - myX) - 40 < reach) return true;
  }
  return false;
}

function rhythmParry(M, s, P, T) {
  const me = s.me;
  const op = s.opponent;
  const ps = M.op.projStarts;
  if (!STYLE.parry || !me.canAct || !ps || ps.length < 3) return false;
  if (T.some((t) => t.in <= 30 && t.kind === 'strike')) return false;
  const n = ps.length;
  const gaps = [];
  for (let i = Math.max(1, n - 3); i < n; i++) gaps.push(ps[i].t - ps[i - 1].t);
  const lo = Math.min(...gaps);
  const hi = Math.max(...gaps);
  if (hi - lo > 4 || hi > 70) return false;
  const last = ps[n - 1];
  if (s.tick - last.t > hi + 20) return false; // the rhythm stopped
  const dm = mv(op, last.id);
  if (!dm) return false;
  const g = dm.segments.find((x) => x.type === 'projectile');
  const spd = { slow: 6, mid: 9, fast: 13 }[g.speed];
  const period = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  let next = last.t + period;
  while (next + g.activeStart < s.tick) next += period;
  const gap = Math.abs(P.x - me.x) - 120;
  // the shot moves on the tick it spawns; contact when its box first overlaps me
  const contact = next + g.activeStart - 1 + Math.max(1, Math.ceil(gap / spd));
  const inn = contact - s.tick - 1;
  if (g.zone === 'high' && me.posture === 'crouch') return false;
  const tries = (M.rpTries ||= 0);
  if (tries >= 4 && M.me.parries < tries * 0.4) return false;
  if (inn >= 1 && inn <= 3) {
    M.rpTries = tries + 1;
    return true;
  }
  return false;
}

// should I parry this threat now
function parryNow(M, s, P, T) {
  const me = s.me;
  if (!me.canAct) return false;
  const t = T[0];
  if (!t || !t.sure) return false;
  // the window covers this tick's resolution and the 5 after
  if (t.in < 1 || t.in > 4) return false;
  // a second threat right after the window would land in the parry's recovery
  for (let i = 1; i < T.length; i++) if (T[i].in <= t.in + 30 && !(T[i].kind === 'strike' && T[i].move === t.move)) return false;
  if (t.kind === 'proj' && t.zone === 'high' && me.posture === 'crouch') return false;
  // parries that failed: trust them less
  if (M.me.parryFails > 2 && M.me.parryFails > M.me.parries) return false;
  return true;
}

export function decide(M, s, P, T) {
  okiSettle(M, s);
  const me = s.me;
  const op = s.opponent;
  const act = {};
  const L = s.reaction + 1; // the view is the state after the step 16 before the one my action goes into
  if (M.justParried === s.tick) say(M, s, act, 'other', M.rng() < 0.5 ? 'parry_1' : 'parry_2');
  // a few words now and then: never more than one line in four seconds
  else if (me.state === 'throwing' && me.stateTicks === 1 && M.rng() < 0.35) say(M, s, act, 'hit');
  else if ((me.state === 'knockdown' && me.stateTicks === 1) && M.rng() < 0.25) say(M, s, act, 'hurt');
  else if (P.state === 'knockdown' && op.state === 'knockdown' && op.stateTicks === 2 && me.hp / me.maxHp - op.hp / op.maxHp > 0.2 && M.rng() < 0.3) say(M, s, act, 'taunt');
  else if (M.myHitTick === s.tick && M.myHitLaunch && M.rng() < 0.12) say(M, s, act, 'hit');

  // ---- not free ----
  if (me.state === 'grabbed') return act;
  if (me.airborne) return airDecision(M, s, P, T, act);
  if (me.state === 'move') {
    return act;
  }
  if (!me.canAct) {
    // down on the floor my guard is seen: show a high one while he plans his wake-up play, hold low when it counts
    if (me.state === 'knockdown' || me.state === 'getup') {
      const left = me.state === 'knockdown' ? me.stateLength - me.stateTicks + 20 : me.stateLength - me.stateTicks;
      const near = T.find((t) => t.in <= left + 4);
      if (near) {
        const g = guardFor(M, s, P, T);
        return { ...act, guard: g, crouch: g === 'low' };
      }
      return left > 14 ? { ...act, guard: 'high' } : { ...act, guard: 'low', crouch: true };
    }
    const g = guardFor(M, s, P, T);
    return { ...act, guard: g, crouch: g === 'low' };
  }

  // ---- free ----
  const d = P.dist;
  const dir = P.dir;

  // 1. a hit is coming: parry what I can time, block the rest
  const near = T.find((t) => t.in <= 18);
  if (near) {
    if (STYLE.parry && parryNow(M, s, P, T)) {
      M.parryKind = T[0].kind;
      return { ...act, parry: true };
    }
    // a counter-hit into his slow startup beats waiting (not into armour or a super)
    if (near.kind === 'strike' && !near.armor && !near.super && near.in >= 5) {
      const c = counterPoke(M, s, P, near);
      if (c) return { ...act, attack: c };
    }
    if (near.in <= 12) {
      const g = guardFor(M, s, P, T);
      return { ...act, guard: g, crouch: g === 'low' };
    }
  }

  // 1b. he shoots on a beat faster than I can see: parry the next shot where the rhythm puts it
  const rp = rhythmParry(M, s, P, T);
  if (rp) {
    M.parryKind = 'proj';
    return { ...act, parry: true, why: 'rhythm parry' };
  }

  // 2. punish what is committed
  const pun = bestPunish(M, s, P, T);
  if (pun) {
    const pw = 'punish ' + (pun.id || 'throw') + ' open' + (P.busy - (P.wake ? 1 : 0)) + ' ' + P.state + (P.def ? ':' + P.def.id + '@' + P.t : '') + ' d' + Math.round(P.dist);
    if (pun.throw) return { ...act, throw: true, why: pw };
    M.me.punishes++;
    if (P.recovering && pun.id !== 'finale' && !mv(me, pun.id)?.slot?.startsWith('super') && M.rng() < 0.3) say(M, s, act, 'other', M.rng() < 0.5 ? 'punish_1' : 'punish_2');
    return { ...act, attack: pun.id, crouch: pun.crouch, why: pw };
  }

  // 3. he is in the air: anti-air or block
  if (P.air && !P.juggle) {
    const aa = antiAir(M, s, P, T);
    if (aa) return { ...act, ...aa };
    if (d < 380) return { ...act, guard: 'high' };
  }

  // 4. he is down: set up for his getup
  if (!P.free && (P.state === 'knockdown' || P.state === 'getup' || P.juggle || P.downed)) return { ...act, ...oki(M, s, P) };

  // 5. he is busy and out of my reach: close in while it lasts, else hold
  if (!P.free) {
    if (P.busy > 8 && d > 200 && d < 650) return { ...act, walk: 1, why: 'busy approach' };
    if (T.length && T[0].in < 25) return { ...act, guard: guardFor(M, s, P, T), crouch: guardFor(M, s, P, T) === 'low', why: 'busy guard' };
    if (P.busy > 3 && d > 150) return { ...act, walk: 1, why: 'busy step' };
    return { ...act, guard: 'low', crouch: true, why: 'busy hold' };
  }

  // 6. neutral
  return { ...act, ...neutral(M, s, P, T) };
}

// a fast strike that lands while his slow move is still starting
function counterPoke(M, s, P, t) {
  const me = s.me;
  for (const id of ['jab', 'upper', 'low', 'knee', 'heavy']) {
    const d = ready(me, id);
    if (!d) continue;
    const g = firstStrike(d);
    if (g.activeStart > t.in) continue;
    if (g.zone === 'high' && P.crouch) continue;
    if (!strikeReaches(g, me, P, P.dir)) continue;
    return id;
  }
  return null;
}

function antiAir(M, s, P, T) {
  const me = s.me;
  const op = s.opponent;
  // only when his air move is spent (seen) and nothing of it is still to land on me; else the guard is the answer
  if (op.canAirMove || op.state === 'prejump') return null;
  if (T.some((t) => t.kind === 'strike' && t.last >= 0)) return null;
  // upper: active 6 ticks from its 5th; find a tick his body crosses the box
  const up = ready(me, 'upper');
  if (up) {
    const g = firstStrike(up);
    for (let k = g.activeStart; k < g.activeEnd; k++) {
      const f = fly(P.x, P.y, P.vxNow ?? 0, P.vyNow ?? 0, k);
      if (f.landedAt) break;
      if (strikeReaches(g, me, P, Math.sign(f.x - me.x) || me.facing, { x: f.x, y: f.y, air: true })) {
        // his air strike may come first; upper is still the answer if he is in my box early
        return { attack: 'upper' };
      }
    }
  }
  return null;
}

// He is down: be where the chosen wake-up play needs me when he gets up, and start it on the tick that lands it
// on his first vulnerable tick. His guard while he lies there is seen: a held high guard loses to a low, none to anything.
function okiSettle(M, s) {
  const p = M.okiPending;
  if (!p || s.tick < p.at + 30) return;
  const st = (M.okiStats ||= {});
  const x = (st[p.plan] ||= { n: 0, w: 0 });
  x.n++;
  if (M.me.hits > p.hits || M.me.throwsLanded > p.throws) x.w += 1;
  else if (s.me.hp < p.hp) x.w -= 0.5;
  else if (p.plan === 'bait') x.w += 0.3;
  M.okiPending = null;
}

function oki(M, s, P) {
  const me = s.me;
  const op = s.opponent;
  const d = P.dist;
  const W = P.busy;
  if (W > 24) {
    M.okiPlan = null;
    const want0 = 150;
    if (d > want0 + 6) return { walk: 1, why: 'oki step in' };
    if (d < want0 - 30) return { walk: -1, why: 'oki step out' };
    return { ...G(M), why: 'oki wait' };
  }
  if (!M.okiPlan || s.tick > M.okiUntil) {
    const g = op.guard;
    const O = M.op;
    const wakeHit = (O.wakeAttack + 0.3) / (O.wakes + 1);
    // what can work against the guard he holds, scored by how it went so far (a small bandit)
    const arms = g === 'high' ? ['low', 'sweep', 'throw'] : !g ? ['sweep', 'low', 'throw'] : ['overhead', 'throw', 'bait'];
    if (wakeHit > 0.5) arms.push('bait');
    const st = (M.okiStats ||= {});
    let plan = 'bait';
    let best = -1;
    for (const a of arms) {
      if (!['throw', 'bait'].includes(a) && !ready(me, a)) continue;
      const x = st[a] || { n: 0, w: 0 };
      const prior = a === 'bait' ? 0.3 : a === 'overhead' ? 0.3 : 0.5;
      const v = (x.w + prior * 2) / (x.n + 2) + M.rng() * 0.25;
      if (v > best) {
        best = v;
        plan = a;
      }
    }
    M.okiPending = { plan, at: s.tick + W, hits: M.me.hits, throws: M.me.throwsLanded, hp: me.hp };
    M.okiPlan = plan;
    M.okiUntil = s.tick + W + 12;
  }
  const plan = M.okiPlan;
  const want = { low: 128, sweep: 185, overhead: 130, throw: 105, bait: 150 }[plan];
  if (plan !== 'bait' && plan !== 'throw') {
    const dm = mv(me, plan);
    const S = firstStrike(dm).activeStart;
    if (W === S && Math.abs(d - want) < 40) return { attack: plan, crouch: dm.posture === 'crouch', why: 'oki ' + plan };
  }
  if (d > want + 6 && W > 3) return { walk: 1, why: 'oki step in' };
  if (d < want - 20 && W > 3) return { walk: -1, why: 'oki step out' };
  if (plan === 'throw') M.okiThrowAt = s.tick + W + 6;
  return { ...G(M), why: 'oki wait' };
}

function airDecision(M, s, P, T, act) {
  const me = s.me;
  if (me.canAirMove && !P.air) {
    for (const id of ['meteor', 'dive', 'air_kick']) {
      const d = ready(me, id);
      if (!d) continue;
      const g = firstStrike(d);
      // land the kick when he is in its box
      const f = fly(me.x, me.y, me.vx, me.vy, g.activeStart);
      const fake = { x: f.x, y: f.y, airborne: true, facing: me.facing };
      if (strikeReaches(g, fake, P, Math.sign(P.x - f.x) || me.facing)) return { ...act, attack: id };
    }
  }
  return act;
}


const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// attacks he starts per second of free time (seen), with a prior
function aggression(M) {
  const O = M.op;
  const secs = O.freeTicks / 60;
  return (O.starts + O.throws + 1) / (secs + 3);
}

function neutral(M, s, P, T) {
  const me = s.me;
  const op = s.opponent;
  const O = M.op;
  const L = s.reaction + 1; // the view is the state after the step 16 before the one my action goes into
  const dSeen = P.dist;
  const opVx = op.state === 'neutral' ? op.vx : 0;
  // where he is now if he kept walking; he stops where he usually starts his attack or throw
  let xNow = clamp(P.x + opVx * L, WALL_L, WALL_R);
  const stopAt = Math.max(PUSH, Math.min(O.throwTrig ?? 125, O.atkTrig ?? 220) - 5);
  if (opVx * P.dir < 0 && Math.abs(xNow - me.x) < stopAt && dSeen > stopAt) xNow = me.x + P.dir * stopAt;
  const d = Math.abs(xNow - me.x);
  // just free from a stun or a getup: he may have walked in since
  const freeFor = Math.max(0, Math.min(L, s.tick - M.opFreeSince));
  const dMin = op.state === 'neutral' ? Math.min(d, dSeen - Math.max(0, opVx * P.dir * -1) * L) : dSeen - freeFor * op.derived.walk;
  const Rq = quickReach(op);
  const aggr = aggression(M);
  const hpLead = me.hp / me.maxHp - op.hp / op.maxHp;
  const rnd = M.rng();
  const backWall = P.dir > 0 ? me.x - WALL_L : WALL_R - me.x;
  const cornered = backWall < 70;
  const shot = ['fireball', 'lance', 'spike', 'wave'].find((id) => ready(me, id) && !(id === 'spike' && P.crouch));
  // my shots he parries feed his meter: stop shooting at a parrier
  const shotsThrown = ['fireball', 'lance', 'spike', 'wave'].reduce((a, id) => a + (((M.me.moveRes || {})[id] || {}).n || 0), 0);
  // he shoots back: my shots meet his and vanish, while my recovery is his opening
  const duel = O.projectiles > 2 && shotsThrown > 6 && (M.me.moveRes?.fireball?.n || 0) > 2 * (O.blocks + O.hitsTaken + 1) ? 0.4 : 1;
  const fbOk = !!shot && (O.parries + 0.5) / (shotsThrown + 3) < 0.3 && (me.stale[shot] ?? 1) > 0.7 && M.rng() < duel;

  // stage objects: hurl one when he is far
  if (s.props && dSeen > 330) {
    const pr = s.props.find((o) => !o.in && Math.abs(o.x - me.x) <= o.reach - 5);
    if (pr) return { use: true, why: 'prop' };
  }

  // keep the plan for a few ticks
  if (M.plan && s.tick < M.planUntil) {
    const p = runPlan(M, s, P, d);
    if (p) return p;
  }
  M.plan = null;

  // a jump-in now and then (a style of the lab's sparring variants)
  if (STYLE.jumpIn && d > 180 && d < 330 && P.free && rnd < STYLE.jumpIn) return { jump: 1, why: 'jump in' };
  // far: close in, shoot now and then
  if (d > 560) {
    if (fbOk && rnd < 0.03 * STYLE.fb) return { attack: shot, crouch: shot === 'wave', why: 'far fb' };
    if (d > 760 && rnd < 0.06) return { dash: 'forward' };
    return { walk: 1, why: 'far' };
  }
  if (me.passive > 200) return { walk: 1, why: 'passive' };


  const throwy = (O.throws + 0.3) / (O.starts + O.throws + 1.5);
  // he walks in (and a walking fighter holds no guard): meet him with a poke that is out when he arrives
  const inV = op.state === 'neutral' && opVx * P.dir < -1 ? Math.abs(opVx) : 0;
  if (P.free && inV) {
    const at = (k) => Math.max(PUSH, d - inV * k);
    const meetOk = throwy > 0.35 || (M.me.meetTries >= 2 && M.me.meetHits / M.me.meetTries > 0.4) || M.me.meetTries < 1;
    if (meetOk && at(7) <= 158 && at(7) > 110 && ready(me, 'low')) {
      M.me.meetTries++;
      M.meetTick = s.tick;
      return { attack: 'low', crouch: true, why: 'meet low' };
    }
    if (throwy > 0.35 && at(4) <= 120 && d >= 112 && ready(me, 'jab')) {
      M.me.meetTries++;
      M.meetTick = s.tick;
      return { attack: 'jab', why: 'meet jab' };
    }
  }
  // the oki throw: right after his throw protection runs out
  if (M.okiPlan === 'throw' && M.okiThrowAt && s.tick >= M.okiThrowAt && s.tick <= M.okiThrowAt + 2 && dSeen <= 118) {
    M.okiThrowAt = 0;
    return { throw: true, why: 'oki throw' };
  }
  // my turn after a block: he is at least 2 behind, a jab beats whatever he presses next
  if (s.tick - (M.bsEnd ?? -99) <= 1 && Math.max(d, dSeen) <= 112 && P.free && STYLE.close.jab > 0) {
    const r = M.rng();
    if (r < 0.6) return { attack: 'jab', why: 'turn jab' };
    if (r < 0.75 && Math.max(d, dSeen) <= 112 && s.tick - M.opFreeSince >= 1) return { attack: 'low', crouch: true, why: 'turn low' };
  }
  if (Math.min(d, dMin) <= 145 && P.free) return closeGame(M, s, P, Math.max(d, dSeen), Math.min(d, dMin));

  // the mode: bait his attacks at the edge of his reach, or press him when he waits
  const opBack = P.dir > 0 ? WALL_R - P.x : P.x - WALL_L;
  if (s.tick - Math.max(O.lastAttackSeen, M.pressUntil - 300) > 300) M.pressUntil = s.tick + 300; // he does not bite: go to him
  if (hpLead < 0 && s.timeLeft < 3600) M.pressUntil = s.tick + 60;
  const press = !STYLE.neverPress && (STYLE.alwaysPress || aggr < STYLE.press || s.tick < M.pressUntil || opBack < 90);
  const safe = (hpLead > 0.15 && s.timeLeft < 1800) || (hpLead > 0.04 && s.timeLeft < 900);

  if (!press || safe) {
    const lo = Rq + 10 + STYLE.keepAway;
    const hi = Rq + 55 + STYLE.keepAway;
    if (d < lo && d > 135) {
      if (cornered) return { ...G(M), why: 'corner hold' };
      return { walk: -1, guard: 'high', why: 'bait back' };
    }
    if (d <= 135) return closeGame(M, s, P, Math.max(d, dSeen), d);
    if (d > hi) {
      if (fbOk && d > 330 && rnd < 0.015 * STYLE.fb) return { attack: shot, crouch: shot === 'wave', why: 'edge fb' };
      return { walk: 1, why: 'edge in' };
    }
    // in the band: sway in and out
    const phase = Math.floor((s.tick + M.swaySeed) / 14) % 3;
    if (fbOk && d > 330 && rnd < 0.01 * STYLE.fb) return { attack: shot, crouch: shot === 'wave', why: 'band fb' };
    if (phase === 0) return { walk: 1, why: 'sway in' };
    if (phase === 1) return cornered ? { ...G(M) } : { walk: -1, guard: 'high', why: 'sway out' };
    return { ...G(M), why: 'sway hold' };
  }

  // press: walk in to throw range and play the close game
  if (d > 135) {
    if (fbOk && d > 380 && rnd < 0.02 * STYLE.fb) return { attack: shot, crouch: shot === 'wave', why: 'press fb' };
    if (d > Rq + 15) {
      if (d > Rq + 180 && rnd < 0.04) return { dash: 'forward', why: 'press dash' };
      return { walk: 1, why: 'press in' };
    }
    // inside his reach: step in only while he cannot answer yet
    if (s.tick <= M.opFreeSince + 2) return { walk: 1, why: 'press in (safe)' };
    if (me.guardGauge > 45 && !cornered) return { walk: -1, guard: 'high', why: 'gauge out' };
    if (fbOk && d > 240 && rnd < 0.05 * STYLE.fb) return { attack: shot, crouch: shot === 'wave', why: 'press cover fb' };
    if (rnd < 0.012) return { dash: 'forward', why: 'press dash in' };
    return { ...G(M), why: 'press wait' };
  }
  return closeGame(M, s, P, Math.max(d, dSeen), d);
}

function runPlan(M, s, P, d) {
  if (M.plan === 'block') return { ...G(M), why: 'plan block' };
  if (M.plan === 'backoff') return { walk: -1, guard: 'high', why: 'plan back' };
  return null;
}

function closeGame(M, s, P, dExp, dWorst) {
  const me = s.me;
  const O = M.op;
  const dd = dExp ?? P.dist;
  const dw = dWorst ?? dd;
  const op = s.opponent;
  const leaving = op.state === 'neutral' && op.vx * P.dir > 0.5;
  // what he does up close: throws, strikes, or waits in guard
  const ct = O.closeThrows + 0.6;
  const cs = O.closeStrikes + 1.0;
  const cg = O.closeGuardTicks / 25 + 0.8;
  const tot = ct + cs + cg;
  const pT = ct / tot;
  const pS = cs / tot;
  const pG = cg / tot;
  // how my throws went so far (a prior of a fair coin), and what a whiff costs: his super if he has it
  const TR = M.me.throwRes || { land: 0, tech: 0, whiff: 0, stuffed: 0 };
  const tn = TR.land + TR.tech + TR.whiff + TR.stuffed;
  const thrLand = (TR.land + 1.2) / (tn + 2);
  const thrWhiff = (TR.whiff + 0.4) / (tn + 2);
  const opSuper = op.moves.find((m) => m.slot === 'super');
  const whiffCost = op.meter >= 300 && opSuper ? 250 : 60;
  const canThrow = dd <= 115 && s.tick - M.opFreeSince >= 7 && !P.air;
  // how often my close pokes whiffed: a whiffed poke is a free punish for him
  const wr = (id) => {
    const R = (M.me.moveRes || {})[id] || { n: 0, whiff: 0 };
    return (R.whiff + 0.3) / (R.n + 2);
  };
  const pokeCost = op.meter >= 300 && opSuper ? 120 : 45;
  const backWallNear = P.dir > 0 ? me.x - WALL_L < 160 : WALL_R - me.x < 160;
  const sup = me.moves.find((m) => m.slot === 'super' && m.posture !== 'air' && m.segments[0].type === 'strike');
  const superId = sup && ready(me, sup.id) ? sup.id : null;
  const opts = [
    // a throw grabs on its 6th tick: a jab (out on the 4th) beats it, it beats anything slower and any guard
    ['block', pS * 8 - pT * 91],
    ['low', dd > 118 && dd <= 140 && !leaving ? pT * 25 - pS * 10 - pG * 4 - wr('low') * pokeCost : -99],
    ['jab', dd <= 108 && !leaving ? pT * 30 + pS * 12 - pG * 3 - wr('jab') * pokeCost : -99],
    ['throw', canThrow && !leaving ? pG * 91 * thrLand - pS * 35 - thrWhiff * whiffCost : -99],
    ['back', pT * 20 + pS * 5 - pG * 5 - (backWallNear ? 40 : 0) - (dd > 140 ? 10 : 0)],
    ['walkback', dd > 125 && !backWallNear ? pT * 25 - pS * 5 : -99],
    ['super', superId && dd <= 190 && !P.air ? (pS + pT) * 380 - pG * 160 - Math.min(1, O.backdashes / (O.starts + 4)) * 150 + (s.timeLeft < 1500 && me.hp / me.maxHp < op.hp / op.maxHp ? 120 : 0) : -99],
    ['flurry', ready(me, 'flurry') && dd <= 135 && !leaving && (s.opponent.guardGauge ?? 0) >= 60 ? pG * 40 - pS * 20 : -99],
  ];
  let sum = 0;
  const w = opts.map(([k, v]) => {
    const x = Math.exp(Math.max(-60, Math.min(60, v)) / 15) * (STYLE.close[k] ?? 1);
    sum += x;
    return [k, x];
  });
  let r = M.rng() * sum;
  let pick = 'block';
  for (const [k, x] of w) if ((r -= x) <= 0) {
    pick = k;
    break;
  }
  switch (pick) {
    case 'throw':
      M.me.throwsTried++;
      return { throw: true, why: 'close throw' };
    case 'jab':
      return { attack: 'jab', why: 'close jab' };
    case 'low':
      return { attack: 'low', crouch: true, why: 'close low' };
    case 'back':
      return { dash: 'back', why: 'close back' };
    case 'walkback':
      M.plan = 'backoff';
      M.planUntil = s.tick + 6;
      return { walk: -1, guard: 'high', why: 'close walkback' };
    case 'flurry':
      return { attack: 'flurry', why: 'close flurry' };
    case 'super':
      return { attack: superId, why: 'close super' };
    default:
      M.plan = 'block';
      M.planUntil = s.tick + 6;
      return { ...G(M), why: 'close block' };
  }
}
