// What the opponent is doing now, though the brains see him 15 ticks late: everything he has begun runs by the ring's
// numbers, so a move, a stun, a fall or a jump is counted forward exactly.
export const REACH = { short: 55, mid: 95, long: 150 };
export const ZONE_Y = { high: [200, 270], mid: [110, 230], low: [0, 70], overhead: [150, 285], air: [-30, 120] };
export const HURT = { stand: [-35, 0, 35, 290], crouch: [-40, 0, 40, 185], air: [-35, 20, 35, 250] };
export const PROJ_Y = { high: 235, mid: 170, low: 35 };
export const PROJ_SPEED = { slow: 6, mid: 9, fast: 13 };
export const PUSH = 70;
export const WALL_L = 40;
export const WALL_R = 2160;
const GRAV = 0.85;

// state → does a guard held by the brains work from its first free tick (sim.js WAKE_GUARD)
const WAKE = new Set(['getup', 'knockdown', 'hitstun', 'landing', 'staggered', 'dizzy', 'techBreak', 'throwing', 'throw', 'parry']);

export const mv = (F, id) => {
  const ms = F.moves;
  for (let i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i];
  return null;
};
export const strikeSegs = (d) => d.segments.filter((g) => g.type === 'strike');
export const isProjectileMove = (d) => d.segments.some((g) => g.type === 'projectile');
export const lastStrikeEnd = (d) => {
  let e = -1;
  for (const g of d.segments) if (g.type === 'strike') e = Math.max(e, g.activeEnd);
  return e;
};

// simulate a body in the air n ticks: returns { x, y, vy, landedAt } (landedAt: tick index 1..n it touched the floor)
export function fly(x, y, vx, vy, n) {
  for (let i = 1; i <= n; i++) {
    vy -= GRAV;
    x += vx;
    y += vy;
    if (y <= 0) return { x, y: 0, vy: 0, landedAt: i };
  }
  return { x, y, vy, landedAt: 0 };
}

// ticks until a body in the air lands
export function ticksToLand(y, vy) {
  let n = 0;
  while (y > 0 && n < 200) {
    vy -= GRAV;
    y += vy;
    n++;
  }
  return n;
}

// The opponent now. busy: ticks of his current commitment left (he acts on the tick after); wake: his guard works
// from the first free tick; invuln: ticks he cannot be hit; x, y, air, crouch: where he is.
export function project(M, s) {
  const op = s.opponent;
  const me = s.me;
  const L = s.reaction + 1; // the view is the state after the step 16 before the one my action goes into
  const P = {
    state: op.state, x: op.x, y: op.y, vx: op.vx, air: op.airborne, crouch: op.posture === 'crouch', busy: 0, wake: false, invuln: 0,
    def: null, t: 0, dur: 0, free: false, landIn: 0, airMove: false, juggle: false, recovering: false, startup: false, charging: false,
  };
  const st = op.stateTicks + L;
  const len = op.stateLength;
  switch (op.state) {
    case 'move': {
      const d = mv(op, op.move.id);
      P.def = d;
      let t = op.move.t + L;
      // a charge being held: we cannot know how long it is held
      if (d.charge && op.move.held > 0 && op.move.held < d.charge.maxHold) {
        P.charging = true;
        const seg = d.segments[0].type === 'strike' ? d.segments[0] : d.segments.find((g) => g.type === 'strike' || g.type === 'projectile');
        const heldMore = Math.min(d.charge.maxHold - op.move.held, L);
        t = Math.max(op.move.t, t - heldMore);
        if (t > seg.activeStart - 1) t = seg.activeStart - 1;
      }
      let dur = op.move.duration;
      const hasStrike = d.segments.some((g) => g.type === 'strike');
      if (dur === d.duration && hasStrike && d.posture !== 'air') {
        const startTick = s.tick - L - op.move.t;
        const touched = M.touchedAt >= startTick;
        if (!touched && lastStrikeEnd(d) <= t) dur += 8;
        else if (!touched) P.mayWhiff = true;
      }
      P.t = t;
      P.dur = dur;
      if (d.posture === 'air') {
        const f = fly(op.x, op.y, op.vx, op.vy, L);
        P.x = f.x;
        P.y = f.y;
        P.air = !f.landedAt;
        if (f.landedAt) {
          // landed: 4 ticks of landing after an air move, counted from the landing
          P.state = 'landing';
          P.busy = Math.max(0, 4 - (L - f.landedAt));
          P.wake = true;
          P.air = false;
        } else {
          P.landIn = ticksToLand(f.y, f.vy);
          P.busy = P.landIn + 4;
          P.airMove = true;
          P.vyNow = f.vy;
        }
        break;
      }
      P.busy = Math.max(0, dur - t);
      // where the move puts him: advance during startup
      let x = op.x;
      for (const g of d.segments) {
        if (g.type === 'strike' && g.advance) {
          const from = Math.max(op.move.t, g.start);
          const to = Math.min(t, g.activeStart);
          if (to > from) {
            const step = g.advance / (g.activeStart - g.start);
            const gap = Math.max(0, Math.abs(me.x - x) - PUSH);
            x += op.facing * Math.min(gap, step * (to - from));
          }
        }
        if (g.type === 'teleport' && t >= g.activeStart && op.move.t < g.activeStart) {
          // he is behind us now (or back)
          if (g.to === 'behind') {
            const dir = Math.sign(me.x - op.x) || op.facing;
            let nx = me.x + dir * 90;
            if (nx < WALL_L || nx > WALL_R) nx = me.x - dir * 90;
            x = Math.min(WALL_R, Math.max(WALL_L, nx));
          } else x = Math.min(WALL_R, Math.max(WALL_L, x - op.facing * (g.distance || 300)));
        }
      }
      P.x = x;
      P.crouch = d.posture === 'crouch';
      const seg = segAt(d, t);
      P.recovering = !seg || t >= seg.activeEnd;
      P.startup = !!seg && t < seg.activeStart;
      if (d.slot === 'super' && t < d.firstActive) P.invuln = d.firstActive - t;
      for (const g of d.segments) if (g.type === 'teleport' && t >= g.activeStart - 6 && t < g.activeStart) P.invuln = Math.max(P.invuln, g.activeStart - t);
      break;
    }
    case 'hitstun':
    case 'blockstun': {
      P.busy = Math.max(0, len - st);
      P.wake = op.state === 'hitstun';
      // the slide of the push
      let x = op.x;
      let vx = op.vx;
      for (let i = 0; i < Math.min(L, len - op.stateTicks); i++) {
        x += vx;
        vx *= 0.82;
      }
      P.x = Math.min(WALL_R, Math.max(WALL_L, x));
      break;
    }
    case 'knockdown':
      P.busy = Math.max(0, len - st + 20);
      P.invuln = P.busy;
      P.wake = true;
      break;
    case 'getup':
      P.busy = Math.max(0, len - st);
      P.invuln = P.busy;
      P.wake = true;
      break;
    case 'juggle': {
      const f = fly(op.x, op.y, op.vx, op.vy, L);
      P.x = Math.min(WALL_R, Math.max(WALL_L, f.x));
      P.juggle = true;
      if (f.landedAt) {
        P.state = 'knockdown';
        P.busy = Math.max(0, 44 + 20 - (L - f.landedAt));
        P.invuln = P.busy;
        P.air = false;
        P.y = 0;
        P.wake = true;
      } else {
        P.y = f.y;
        P.vyNow = f.vy;
        P.landIn = ticksToLand(f.y, f.vy);
        P.busy = P.landIn + 64;
        P.air = true;
      }
      break;
    }
    case 'prejump':
    case 'air': {
      // a jump: flies on a known arc; one air move may come
      let x = op.x;
      let y = op.y;
      let vx = op.vx;
      let vy = op.vy;
      let n = L;
      if (op.state === 'prejump') {
        const wait = Math.max(0, 3 - op.stateTicks);
        n -= wait;
        vy = 17;
        vx = 0; // direction unknown from the view until it leaves the ground: assume up
        if (M.opJumpDir) vx = M.opJumpDir * op.facing * op.derived.jumpVx;
      }
      if (n > 0) {
        const f = fly(x, y, vx, vy, n);
        x = f.x;
        y = f.y;
        vy = f.vy;
        if (f.landedAt) {
          P.state = 'landing';
          P.busy = Math.max(0, 3 - (n - f.landedAt));
          P.air = false;
          P.wake = true;
          P.x = x;
          P.y = 0;
          break;
        }
      }
      P.x = Math.min(WALL_R, Math.max(WALL_L, x));
      P.y = y;
      P.vyNow = vy;
      P.vxNow = vx;
      P.air = true;
      P.landIn = ticksToLand(y, vy);
      P.busy = P.landIn + 3;
      P.canAirMove = op.canAirMove || op.state === 'prejump';
      break;
    }
    case 'dash': {
      const back = op.vx === 0 ? null : null;
      P.busy = Math.max(0, len - st);
      // a forward dash carries him in
      const dir = op.stateLength === 16 ? 1 : -1;
      const dist = dir > 0 ? op.derived.dashDistance : 140;
      const e = (k) => 1 - (1 - k) * (1 - k);
      const k0 = Math.min(1, op.stateTicks / len);
      const k1 = Math.min(1, st / len);
      P.x = op.x + op.facing * dir * dist * (e(k1) - e(k0));
      if (dir > 0) {
        const gap = Math.abs(me.x - op.x) - PUSH;
        if (op.facing * (me.x - op.x) > 0) P.x = op.x + op.facing * Math.min(gap, dist * (e(k1) - e(k0)));
      }
      if (dir < 0 && st <= 7) P.invuln = 8 - st;
      P.dashDir = dir;
      void back;
      break;
    }
    case 'landing':
    case 'staggered':
    case 'dizzy':
    case 'techBreak':
    case 'throw':
    case 'parry':
    case 'use':
    case 'throwing':
      P.busy = Math.max(0, len - st);
      P.wake = op.state !== 'use';
      if (op.state === 'parry') P.parryLeft = Math.max(0, 6 - st + 1);
      break;
    case 'grabbed':
    case 'thrown': {
      // he lands 170 in front of me and lies down
      const left = op.state === 'grabbed' ? 12 - op.stateTicks + 22 : 22 - op.stateTicks;
      P.busy = Math.max(1, left + 64 - L);
      P.invuln = P.busy;
      P.x = Math.min(WALL_R, Math.max(WALL_L, me.x + (Math.sign(op.x - me.x) || me.facing) * 170));
      P.wake = true;
      P.downed = true;
      break;
    }
    default:
      break;
  }
  // my own hits that landed after the view was taken: he is in hitstun from them
  if (M.myHitTick > s.tick - L && M.myHitStun > 0) {
    const left = M.myHitStun - (s.tick - M.myHitTick);
    if (M.myHitLaunch) {
      P.juggle = true;
      P.busy = Math.max(P.busy, 64);
      P.invuln = Math.max(P.invuln, 0);
    } else {
      // my hit stopped whatever he was doing
      P.busy = Math.max(0, left);
      P.wake = true;
      P.state = 'hitstun';
      P.def = null;
      P.recovering = false;
      P.startup = false;
      P.free = false;
      P.crouch = false;
      if (M.myHitOx != null) {
        const n = s.tick - M.myHitTick;
        const slide = (M.myHitPush * (1 - Math.pow(0.82, n))) / 0.18;
        P.x = Math.min(WALL_R, Math.max(WALL_L, M.myHitOx + M.myHitDir * slide));
      }
    }
  }
  if (P.busy <= 0) P.free = true;
  P.dist = Math.abs(P.x - me.x);
  P.dir = Math.sign(P.x - me.x) || me.facing;
  return P;
}

export function segAt(d, t) {
  for (const g of d.segments) if (t < g.end) return g;
  return null;
}

// Will my strike segment g, started now from x0 facing dir (toward P), touch the opponent at the tick it is active?
// Returns the number of ticks after its first active tick it first touches (0..), or -1.
export function strikeReaches(g, me, P, dir, opts = {}) {
  const reach = REACH[g.reach];
  const gap = Math.abs(P.x - me.x);
  let x = me.x;
  if (g.advance) x += dir * Math.min(g.advance, Math.max(0, gap - PUSH));
  const x0 = x + dir * 20;
  const x1 = x + dir * (35 + reach);
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const zy = ZONE_Y[g.zone];
  const yBase = me.y;
  const y0 = yBase + zy[0];
  const y1 = yBase + zy[1];
  const air = opts.air ?? P.air;
  const crouch = opts.crouch ?? P.crouch;
  const h = air ? HURT.air : crouch ? HURT.crouch : HURT.stand;
  const oy = opts.y ?? P.y;
  const ox = opts.x ?? P.x;
  const margin = opts.margin ?? 0;
  const hx0 = ox - 35 - (crouch && !air ? 5 : 0) + margin;
  const hx1 = ox + 35 + (crouch && !air ? 5 : 0) - margin;
  const hy0 = oy + h[1];
  const hy1 = oy + h[3];
  return lo < hx1 && hx0 < hi && y0 < hy1 && hy0 < y1;
}

// Hits that can come at me soon. Each: { in: ticks until it can first touch (0 = this tick), last, zone, kind, dmg, sure }
export function threats(M, s, P) {
  const me = s.me;
  const op = s.opponent;
  const out = [];
  const myCrouch = me.posture === 'crouch';
  const myH = me.airborne ? HURT.air : myCrouch ? HURT.crouch : HURT.stand;
  // his move in progress
  if (op.state === 'move' && P.def) {
    const d = P.def;
    const t = P.t;
    for (const g of d.segments) {
      if (g.type === 'strike') {
        if (g.activeEnd <= t + 1) continue;
        const inn = Math.max(0, g.activeStart - t - 1);
        const last = g.activeEnd - t - 2;
        // where he will stand when it is active
        let ox = P.x;
        if (g.advance && t < g.activeStart) {
          const rem = Math.min(g.activeStart - Math.max(t, g.start), g.activeStart - g.start);
          const step = g.advance / (g.activeStart - g.start);
          const gap = Math.max(0, Math.abs(me.x - ox) - PUSH);
          ox += P.dir * -1 * 0 + (Math.sign(me.x - ox) || op.facing) * Math.min(gap, step * rem);
        }
        let face = Math.sign(me.x - ox) || op.facing;
        const reach = REACH[g.reach];
        const bx0 = ox + face * 20;
        const bx1 = ox + face * (35 + reach);
        const lo = Math.min(bx0, bx1);
        const hi = Math.max(bx0, bx1);
        const oy = d.posture === 'air' ? (P.y || 0) : 0;
        const zy = ZONE_Y[g.zone];
        // reach me if I stay; a little slack for my own drift
        const slack = 12;
        const touchX = lo < me.x + 40 + slack && me.x - 40 - slack < hi;
        const touchY = oy + zy[0] < me.y + 290 && me.y < oy + zy[1];
        const hitsCrouch = oy + zy[0] < me.y + 185;
        if (!touchX || (!touchY && d.posture !== 'air')) {
          if (d.posture === 'air' && touchX) out.push({ in: inn, last, zone: g.zone, kind: 'strike', dmg: g.damage * (g.hits || 1), sure: false, hitsCrouch: true, move: d.id, seg: g });
          continue;
        }
        out.push({ in: inn, last, zone: g.zone, kind: 'strike', dmg: g.damage * (g.hits || 1), sure: true, hitsCrouch, move: d.id, seg: g, armor: d.armor && t < d.firstActive, hits: g.hits || 1, super: d.slot === 'super' });
      } else if (g.type === 'projectile' && op.move.t < g.activeStart) {
        // a projectile thrown after the view was taken: not in the list yet, count it from the move
        const spd = PROJ_SPEED[g.speed];
        const face = Math.sign(me.x - P.x) || op.facing;
        const x0 = P.x + face * 60;
        let inn;
        let px;
        if (t < g.activeStart) {
          const startIn = g.activeStart - t - 1;
          const gap = Math.abs(me.x - x0) - 60;
          inn = startIn + Math.max(0, Math.ceil(gap / spd) - 1);
          px = x0;
        } else {
          px = x0 + face * spd * (t - g.activeStart + 1);
          if (Math.sign(me.x - px) !== face && Math.abs(me.x - px) > 60) continue;
          const gap = Math.abs(me.x - px) - 60;
          inn = Math.max(0, Math.ceil(gap / spd) - 1);
        }
        out.push({ in: inn, last: inn + 2, zone: g.zone, kind: 'proj', dmg: g.damage * (g.hits || 1), sure: true, hitsCrouch: g.zone !== 'high', move: d.id, speed: spd, hits: g.hits || 1, px });
      }
    }
  }
  // a stage object he is about to hurl
  if (op.state === 'use' && op.stateTicks < 16) {
    const st = op.stateTicks + s.reaction + 1;
    const face = Math.sign(me.x - P.x) || op.facing;
    const x0 = P.x + face * 60;
    let inn;
    if (st < 16) inn = 16 - st - 1 + Math.max(0, Math.ceil((Math.abs(me.x - x0) - 60) / 13) - 1);
    else {
      const px = x0 + face * 13 * (st - 16 + 1);
      inn = Math.max(0, Math.ceil((Math.abs(me.x - px) - 60) / 13) - 1);
    }
    out.push({ in: inn, last: inn + 2, zone: 'mid', kind: 'proj', dmg: 80, sure: true, hitsCrouch: true, move: 'stage', speed: 13, hits: 1 });
  }
  // projectiles in flight (his as seen 15 ticks ago, flown on since)
  for (const p of s.projectiles) {
    if (p.mine) continue;
    const L = s.reaction + 1; // the view is the state after the step 16 before the one my action goes into
    const x = p.x + p.vx * L;
    const toMe = me.x - x;
    if (Math.sign(toMe) !== Math.sign(p.vx) && Math.abs(toMe) > 60) continue;
    const gap = Math.abs(toMe) - 25 - 35;
    // the projectile moves first, then checks: it touches on the first tick its box overlaps
    const inn = Math.max(0, Math.ceil(gap / Math.abs(p.vx)) - 1);
    const y0 = p.y - 25;
    const hitsCrouch = y0 < 185;
    const hitsStand = y0 < 290 && p.y + 25 > 0;
    if (!hitsStand) continue;
    out.push({ in: inn, last: inn + 2, zone: p.zone, kind: 'proj', dmg: p.damage, sure: true, hitsCrouch, speed: Math.abs(p.vx), hits: p.hitsLeft || 1, px: x });
  }
  out.sort((a, b) => a.in - b.in);
  return out;
}
