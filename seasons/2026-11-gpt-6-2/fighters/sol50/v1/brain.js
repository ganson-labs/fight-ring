// All estimates start from the delayed opponent snapshot. Only our own body and
// shots are available in real time. Unknown input after the snapshot stays uncertain.
const REACH = { short: 55, mid: 95, long: 150 };
const ZONE = { low: [0, 70], mid: [110, 230], high: [200, 270], overhead: [150, 285], air: [-30, 120] };
const SPEED = { slow: 6, mid: 9, fast: 13 };
const HEIGHT = { low: 35, mid: 170, high: 235 };
const ATTACKS = ['finale', 'upper', 'heavy', 'jab', 'low', 'sweep', 'overhead', 'knee', 'slide', 'breaker', 'cyclone'];
const LOCKED = ['hitstun', 'blockstun', 'parry', 'staggered', 'dizzy', 'throw', 'landing', 'use'];
const SAFE = ['knockdown', 'getup', 'thrown', 'throwing', 'grabbed', 'techBreak'];
const IDLE = {};
let memory;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const guardOf = zone => zone === 'overhead' || zone === 'air' ? 'high' : 'low';

function observe(s) {
  const op = s.opponent;
  const m = memory;
  if (!m.myMoves) {
    m.myMoves = Object.fromEntries(s.me.moves.map(move => [move.id, move]));
    m.foeMoves = Object.fromEntries(op.moves.map(move => [move.id, move]));
  }
  const recent = m.last;
  if (!recent || (s.tick <= s.reaction && op.waiting)) {
    m.last = op;
    return;
  }
  if (op.state === 'neutral') {
    const toward = Math.sign(s.me.x - op.x) * op.vx;
    m.guard += ((op.guard ? 1 : 0) - m.guard) * 0.018;
    m.approach += ((toward > 1 ? 1 : toward < -1 ? -1 : 0) - m.approach) * 0.025;
  }
  const started = op.state !== recent.state || (op.move && (!recent.move || op.move.t < recent.move.t));
  if (started) {
    const def = op.move ? m.foeMoves[op.move.id] : null;
    if (def || ['throw', 'prejump', 'parry', 'dash'].includes(op.state)) {
      const key = def ? def.id : op.state;
      const old = m.pattern[key] || { weight: 0, at: s.tick };
      const period = s.tick - old.at;
      old.weight = Math.min(8, old.weight * Math.exp(-period / 420) + 1);
      old.at = s.tick;
      m.pattern[key] = old;
      if (key === 'dash' && op.stateLength === 18) m.lastRetreat = s.tick;
      if (key === 'fireball' || key === 'lance' || key === 'spike' || key === 'wave') m.shotsSeen++;
      if (def) m.offense = Math.min(1, m.offense + 0.16);
      if (key === 'throw') m.offense *= 0.82;
    }
    if (['getup', 'blockstun', 'hitstun'].includes(recent.state) && op.state === 'neutral') {
      m.foeFree = s.tick - s.reaction;
    }
  }
  if (m.lastParry && s.tick - m.lastParry.tick <= 7 && s.me.state === 'neutral'
    && ((m.prevState === 'parry') || s.me.meter - m.lastMeter >= 11.9)) {
    m.erasedShot = m.lastParry;
    m.erasedAt = s.tick;
  }
  if (m.prevState === 'move' && s.me.state === 'neutral') m.recoveredAt = s.tick;
  if (m.prevState === 'getup' && s.me.state === 'neutral') m.wokeAt = s.tick;
  if (m.prevState === 'blockstun' && s.me.state === 'neutral') m.lastBlockEnd = s.tick;
  m.prevState = s.me.state;
  m.lastMeter = s.me.meter;
  if (s.me.hp < m.lastHP && m.lastHP - s.me.hp > 28) m.hurtAt = s.tick;
  m.lastHP = s.me.hp;
  m.last = op;
}

function habit(id, tick) {
  const p = memory.pattern[id];
  return p ? p.weight * Math.exp(-(tick - p.at) / 300) : 0;
}

// Project committed movement, then allow only a limited continuation of
// neutral footwork. Future attacks are scored separately as risks.
function project(s, horizon) {
  const op = s.opponent;
  const lag = Math.min(s.reaction, s.tick);
  const count = lag + horizon;
  const def = op.move ? memory.foeMoves[op.move.id] : null;
  const trajectory = [];
  const toward = Math.sign(op.x - s.me.x) || s.me.facing;
  let { x, y, vx, vy, state, facing, posture } = op;
  let t = op.move?.t ?? op.stateTicks;
  let free = 0;
  let immunity = 0;
  let wake = memory.foeFree;
  let dashBack = false;
  if (state === 'dash') {
    const last = memory.dashX;
    if (op.stateTicks < 2) memory.dashX = op.x;
    dashBack = op.stateLength === 18 || (last != null && (op.x - last) * facing < -1);
  }
  if (op.invulnerable && !SAFE.includes(state) && (state === 'neutral' || state === 'hitstun')) {
    immunity = state === 'hitstun' ? op.stateLength - t + 30 : 24;
  }
  for (let i = 1; i <= count; i++) {
    t++;
    if (state === 'neutral') {
      const move = op.state === 'neutral' && i < lag + 6 ? op.vx : 0;
      x += move;
      free++;
    } else if (state === 'dash') {
      const len = op.stateLength;
      const distance = dashBack ? -140 : op.derived.dashDistance;
      x += facing * distance * (2 * (1 - (t - 1) / len) / len - 1 / (len * len));
      if (t >= len) state = 'neutral';
    } else if (state === 'prejump' && t >= 3) {
      state = 'air';
      vy = 17;
      vx = facing * op.derived.jumpVx * (memory.approach < -0.25 ? -1 : 1);
      t = 0;
    } else if (state === 'move' || state === 'air' || state === 'juggle') {
      if (state !== 'move' || def?.posture === 'air') {
        vy -= 0.85;
        y += vy;
        x += vx;
        if (y <= 0) {
          y = 0;
          if (state === 'juggle') state = 'knockdown';
          else state = 'landing';
          t = 0;
        }
      }
      if (state === 'move' && def) {
        for (const seg of def.segments) {
          if (seg.advance && t > seg.start && t <= seg.activeStart) {
            x += facing * seg.advance / (seg.activeStart - seg.start);
          }
          if (seg.type === 'teleport' && t === seg.activeStart) {
            const dir = Math.sign(s.me.x - x) || facing;
            x = seg.to === 'behind' ? s.me.x + dir * 90 : x - dir * (seg.distance || 300);
            if (seg.to === 'behind' && (x < s.stage.left || x > s.stage.right)) x = s.me.x - dir * 90;
            facing = Math.sign(s.me.x - x) || facing;
          }
        }
        if (t >= op.move.duration) {
          state = y > 0 ? 'air' : 'neutral';
          t = 0;
        }
      }
    } else if (state === 'knockdown' && t >= 44) {
      state = 'getup';
      t = 0;
    } else if (state === 'getup' && t >= 20) {
      state = 'neutral';
      wake = s.tick + i - lag;
    } else if (state === 'thrown' && t >= op.stateLength) {
      x = s.me.x + s.me.facing * 170;
      state = 'knockdown';
      t = 0;
    } else if (LOCKED.includes(state) || state === 'techBreak' || state === 'throwing') {
      if (state === 'hitstun' || state === 'blockstun' || state === 'techBreak') {
        x += vx;
        vx *= 0.82;
      }
      if (t >= (op.state === state ? op.stateLength : 3)) {
        if (state === 'hitstun' || state === 'blockstun') wake = s.tick + i - lag;
        state = 'neutral';
        t = 0;
      }
    }
    x = clamp(x, s.stage.left, s.stage.right);
    if (y < 120 && s.me.y < 120 && Math.abs(x - s.me.x) < 70 && state !== 'thrown' && def?.id !== 'cross' && def?.id !== 'ambush') {
      x = clamp(s.me.x + toward * 70, s.stage.left, s.stage.right);
    }
    if (i < lag) continue;
    const moving = state === 'move';
    const seg = moving ? def?.segments.find(part => part.end > t) : null;
    const active = seg?.type === 'strike' && t >= seg.activeStart && t < seg.activeEnd;
    const extended = seg?.type === 'strike' && t >= seg.activeStart && t < seg.activeEnd + Math.ceil((seg.end - seg.activeEnd) / 2);
    const air = y > 0 || state === 'air' || state === 'juggle';
    const inv = i < immunity || SAFE.includes(state) || (state === 'dash' && dashBack && t <= 7)
      || (moving && ((def?.slot === 'super' && t < def.firstActive)
        || (seg?.type === 'teleport' && t >= seg.activeStart - 6 && t < seg.activeStart)));
    trajectory[i - lag] = {
      x, y, state, t, free, facing, air, inv, wake, active, extended, seg,
      posture, def: moving ? def : null,
      guard: (state === 'blockstun' || (state === 'neutral' && op.state === 'neutral')) ? op.guard : null,
    };
  }
  return trajectory;
}

function targetBox(me, op, mx, my, zone, reach) {
  const [lo, hi] = ZONE[zone];
  const dx = (op.x - mx) * me.facing;
  const width = !op.air && op.posture === 'crouch' ? 40 : 35;
  const bottom = op.y + (op.air ? 20 : 0);
  const top = op.y + (op.air ? 250 : op.posture === 'crouch' ? 185 : 290);
  const edge = 35 + REACH[reach];
  if (dx + width > 20 && dx - width < edge && my + lo < top && my + hi > bottom) return edge + width - dx;
  if (op.extended && op.facing === -me.facing) {
    const [otherLo, otherHi] = ZONE[op.seg.zone];
    const otherEdge = 35 + REACH[op.seg.reach];
    if (dx - 20 > 20 && dx - otherEdge < edge && my + lo < op.y + otherHi && my + hi > op.y + otherLo) {
      return Math.min(16, edge + otherEdge - dx);
    }
  }
  return 0;
}

function incoming(s, path) {
  const me = s.me;
  const lag = Math.min(s.reaction, s.tick);
  let best = null;
  const consider = (x, vx, y, zone, damage, inferred) => {
    if (memory.erasedShot && s.tick - memory.erasedAt < lag + 2 && vx === memory.erasedShot.vx
      && y === memory.erasedShot.y && Math.abs(x - memory.erasedShot.x - vx * (s.tick - memory.erasedShot.tick)) < Math.abs(vx) * 4) return;
    const direction = Math.sign(vx);
    const gap = (me.x - x) * direction;
    if (gap < -48) return;
    const eta = Math.max(1, Math.floor((gap - 58) / Math.abs(vx)) + 1);
    for (const own of s.projectiles) {
      if (!own.mine || Math.abs(y - own.y) >= 50) continue;
      if (Math.abs(own.x - x) < 50) return;
      const relativeSpeed = (vx - own.vx) * direction;
      const collision = ((own.x - x) * direction - 48) / Math.max(1, relativeSpeed);
      if (relativeSpeed > 0 && collision >= 0 && collision < eta - 1) return;
    }
    if (!best || eta < best.eta) best = { eta, zone, damage, shot: { x, vx, y }, exact: true, inferred };
  };
  for (const p of s.projectiles) {
    if (!p.mine) consider(p.x + p.vx * lag, p.vx, p.y, p.zone, p.damage, false);
  }
  // A committed windup may already have released a shot inside the blind
  // interval. Estimate the shot until we actually see its first frame.
  const op = s.opponent;
  if (op.move) {
    const move = memory.foeMoves[op.move.id];
    const segment = move?.segments.find(seg => seg.type === 'projectile');
    if (segment && op.move.t < segment.activeStart && op.move.t + lag >= segment.activeStart) {
      const vx = op.facing * SPEED[segment.speed];
      const x = op.x + op.facing * 60 + vx * (op.move.t + lag - segment.activeStart + 1);
      if ((me.x - x) * op.facing >= 0) consider(x, vx, HEIGHT[segment.zone], segment.zone, segment.damage, true);
    }
  }
  for (let i = 1; i <= 22; i++) {
    const o = path[i];
    if (o.active && targetBox(o, { ...me, air: me.airborne }, o.x, o.y, o.seg.zone, o.seg.reach) > 0) {
      if (!best || best.eta > i) best = { eta: i, zone: o.seg.zone, damage: o.seg.damage, exact: true, swing: true };
      break;
    }
    if (o.def && o.seg?.type === 'projectile' && o.t === o.seg.activeStart) {
      const distance = (me.x - o.x) * o.facing;
      if (distance > 0) {
        const eta = i + Math.max(0, Math.floor((distance - 118) / SPEED[o.seg.speed]));
        if (!best || eta < best.eta) best = { eta, zone: o.seg.zone, damage: o.seg.damage, exact: false };
      }
    }
  }
  return best;
}

// Compare reach at the first possible contact with startup, recovery, guard
// and interruption risk. The stale multiplier rewards using a fresh move.
function chooseStrike(s, path, threat, airOnly = false) {
  const me = s.me;
  const op = s.opponent;
  const distance = Math.abs(path[1].x - me.x);
  const still = memory.guard;
  const nearWall = me.x < s.stage.left + 135 || me.x > s.stage.right - 135;
  let best = null;
  let bestScore = airOnly ? 13 : 14;
  const projectiles = threat?.shot;
  const candidates = airOnly ? ['dive', 'air_kick'] : ATTACKS;
  for (const id of candidates) {
    const def = memory.myMoves[id];
    if (!def || (def.slot === 'super' && me.bars < 3)) continue;
    const seg = def.segments.find(part => part.type === 'strike');
    if (!seg) continue;
    let contact = null;
    for (let t = seg.activeStart; t < seg.activeEnd; t++) {
      const o = path[t];
      if (o.inv) continue;
      let mx = me.x + me.facing * (seg.advance || 0);
      let my = 0;
      if (airOnly) {
        mx = me.x + me.vx * t;
        my = me.y + t * (me.vy - 0.425 * (t + 1));
        if (my <= 0) break;
      }
      if (seg.advance && !o.air && (o.x - me.x) * me.facing > 0) mx = me.x + me.facing * Math.min(seg.advance, Math.max(0, Math.abs(o.x - me.x) - 70));
      mx = clamp(mx, s.stage.left, s.stage.right);
      const margin = targetBox(me, o, mx, my, seg.zone, seg.reach);
      if (margin > 4) {
        contact = { o, t, margin };
        break;
      }
    }
    if (!contact) continue;
    const { o, t, margin } = contact;
    const isSuper = def.slot === 'super';
    const grounded = !o.air;
    const locked = o.state !== 'neutral' && o.state !== 'blockstun' && o.state !== 'parry';
    const armor = o.def?.armor && op.move?.armorLeft && o.t < o.def.firstActive;
    const guard = o.guard;
    const beatsGuard = seg.zone === 'low' ? guard === 'high' : ['overhead', 'air', 'high'].includes(seg.zone) && guard === 'low';
    const blockRisk = grounded && !locked && !beatsGuard && !airOnly ? (guard ? 0.68 : still * 0.62) : 0;
    const reachRisk = clamp((34 - margin) / 50, 0, 0.65) * (locked ? 0.23 : 1);
    const slowRisk = !locked ? Math.max(0, t - 9) * (distance < 230 ? 1.25 : 0.57) : 0;
    const damage = Math.min(130, seg.damage * (seg.hits === 3 ? 1.48 : 1) * (me.stale[id] || 1));
    let score = damage * (1 - blockRisk - reachRisk) - def.duration * 0.37 - slowRisk;
    if (locked) score += 12;
    if (seg.launch) score += o.air ? 10 : 7;
    else if (o.air && !airOnly) score += 13;
    if (beatsGuard) score += 12;
    if (seg.zone === 'low' && habit('overhead', s.tick) < 1) score += 2;
    if (guard && !beatsGuard) score += op.guardGauge * 0.08;
    if (armor && !isSuper) score -= 40;
    if (id === 'breaker') {
      const urgent = threat?.swing || habit('jab', s.tick) > 1.4 || habit('low', s.tick) > 1.4 || habit('knee', s.tick) > 1.4;
      score += urgent && distance > 129 ? 14 : -9;
      if (distance < 132 && habit('throw', s.tick) > 1) score -= 65;
    }
    if (o.air && Math.abs(o.x - me.x) < 160 && t > 13 && !airOnly) score -= 14;
    if (o.state === 'parry' && o.t <= 6) score -= 100;
    if (threat && threat.eta <= t + (projectiles ? 7 : 0) && !isSuper) {
      const avoids = def.posture === 'crouch' && threat.zone === 'high';
      if (!avoids && !def.armor) score -= Math.min(100, (threat.damage || 40) * (threat.eta <= t ? 1.2 : 0.75));
    }
    if (isSuper) {
      if (o.air && (margin < 22 || op.state === 'neutral')) score -= 75;
      if (!locked && (guard || still > 0.48 || op.bars >= 3) && !threat?.swing) score -= 150;
      if (o.free > 12 && !threat?.swing && s.timeLeft > 600) score -= 35;
      if (distance < 135 && habit('throw', s.tick) > 1.2) score -= 58;
      if (s.timeLeft < 230 && !guard) score += 30;
    }
    // A short strike can trade favourably for initiative against a rushdown.
    if (id === 'jab' && !locked && !guard && distance < 125) score += 10 + habit('throw', s.tick) * 3;
    if (id === 'upper' && o.air) score += 15;
    if (id === 'slide' && !locked && distance < 225) score -= 9;
    if (id === 'slide' && distance > 234 && memory.approach > 0.30) score -= 12;
    if (nearWall && seg.advance && distance > 179) score += 4;
    if (airOnly && id === 'air_kick') score += 8 * (1 - (me.stale.dive || 1));
    if (score > bestScore) {
      best = { attack: id, score, contact };
      bestScore = score;
    }
  }
  return best;
}

function shoot(s, path, threat, lead) {
  const me = s.me;
  if (me.projectileOut) return null;
  const distance = Math.abs(path[1].x - me.x);
  if (distance < 275 || distance > 1860 || path[1].inv || (path[1].air && path[1].y > 100 && distance < 500)) return null;
  const incomingSoon = threat && threat.eta <= 43;
  if (incomingSoon) return null;
  if (distance < 475 && memory.approach > 0.35 && !path[1].def) return null;
  const pressure = path[1].def?.segments.some(seg => seg.advance || seg.type === 'teleport');
  if ((pressure && distance < 525) || (distance < 680 && habit('cross', s.tick) + habit('blink', s.tick) > 2.2)) return null;
  const id = 'fireball';
  const def = memory.myMoves[id];
  const seg = def.segments[0];
  const travel = (distance - 110) / SPEED[seg.speed];
  if (travel >= 149) return null;
  const parryRisk = habit('parry', s.tick) * travel * 0.06;
  const urgent = lead < -0.1 && distance > 800 ? 7 : 0;
  const value = seg.damage * (me.stale[id] || 1) - travel * 0.38 - def.duration * 0.37 - parryRisk + urgent;
  return value > 0 ? id : null;
}

function defend(s, path, threat, attack) {
  const me = s.me;
  const p = path[1];
  const distance = Math.abs(p.x - me.x);
  const projectile = threat?.shot;
  const eta = threat?.eta ?? 100;
  if (!me.canAct) {
    return { guard: eta < 9 ? guardOf(threat.zone) : p.air && distance < 240 ? 'high' : 'low' };
  }
  if (me.invulnerable) return null;
  if (eta <= 7) {
    if (attack?.attack === 'finale' && !projectile) return null;
    if (eta <= 5 && threat.exact && (!threat.inferred || eta <= 3)) {
      // Parry the projected arrival only once. A parried projectile remains
      // visible in delayed snapshots for another reaction window.
      const tooLate = projectile && (me.x - projectile.x) * Math.sign(projectile.vx) < -37;
      if (!tooLate && (!projectile || projectile.y < 290)) {
        memory.lastParry = projectile ? { ...projectile, tick: s.tick } : null;
        return { parry: true };
      }
    }
    if (projectile && threat.zone === 'high' && attack && memory.myMoves[attack.attack].posture === 'crouch') return null;
    return { guard: guardOf(threat.zone) };
  }
  if (projectile && eta <= 24 && threat.zone === 'low' && distance < 490 && eta > 6 && habit('prejump', s.tick) < 2) return { jump: 1 };
  return null;
}

export default {
  init(info) {
    memory = {
      rng: (info.seed ^ 0x4c6f6369) >>> 0,
      last: null, guard: 0, approach: 0, offense: 0, pattern: {},
      prevState: '', lastHP: Infinity, recoveredAt: -999, spokeHurt: -999, wokeAt: -999, lastMeter: 0, hurtAt: -999, baitAt: -999, lastBlockEnd: -999, lastRetreat: -999, shotsSeen: 0, zonerUntil: -999,
      foeFree: -999, erasedAt: -999,
    };
  },

  tick(s) {
    observe(s);
    const me = s.me;
    const op = s.opponent;
    if (me.move) return IDLE;
    if (!me.canAct && !me.canAirMove && !['blockstun', 'getup', 'hitstun', 'landing', 'parry'].includes(me.state)) return IDLE;
    const path = project(s, 32);
    const p = path[1];
    const distance = Math.abs(p.x - me.x);
    const threat = incoming(s, path);
    if (me.canAirMove) {
      const attack = chooseStrike(s, path, threat, true);
      return attack ? { attack: attack.attack } : IDLE;
    }
    if (!me.canAct) {
      const action = defend(s, path, threat, null);
      if (me.state === 'getup' && me.stateTicks === 15 && s.tick - memory.spokeHurt > 480) {
        memory.spokeHurt = s.tick;
        action.say = 'hurt';
      }
      return action;
    }
    const facing = (p.x - me.x) * me.facing > 0;
    const strike = facing ? chooseStrike(s, path, threat) : null;
    const defense = defend(s, path, threat, strike);
    if (defense) return defense;
    if (!facing) return { guard: 'low' };
    // After a blocked move, the opponent acts first. Reserve the next few
    // inputs for defence when they can immediately spend a full meter.
    if (op.bars === 3 && !p.air && !me.invulnerable && distance < 268
      && s.tick - memory.recoveredAt < 14 && (op.state === 'blockstun' || op.guard)
      && p.state === 'neutral' && strike?.attack !== 'finale') return { guard: 'low' };

    const lead = me.hp / me.maxHp - op.hp / op.maxHp;
    const corner = me.facing > 0 ? me.x - s.stage.left < 165 : s.stage.right - me.x < 165;
    const grabs = habit('throw', s.tick);
    const jumps = habit('prejump', s.tick);
    const closeGuard = memory.guard > 0.50 || (op.guard && memory.guard > 0.24);
    const parries = habit('parry', s.tick);
    const zoning = habit('fireball', s.tick) + habit('spike', s.tick) + habit('wave', s.tick) + habit('lance', s.tick);
    const midShots = habit('fireball', s.tick) + habit('lance', s.tick);
    const longPokes = habit('heavy', s.tick) + habit('sweep', s.tick);
    const possibleRepeat = p.state === 'neutral' && (op.state === 'move' || op.state === 'neutral');
    const afterHit = s.tick - memory.hurtAt;
    const waitingForPoke = longPokes > 1.25 && possibleRepeat && distance > 125 && distance < 237
      && afterHit > 12 && afterHit < 47 && !me.invulnerable && !op.guard;
    if (waitingForPoke && strike?.attack !== 'finale') return { guard: 'low' };
    const clearApproach = zoning > 0.9 && (midShots < 1.45 || threat?.zone === 'low') && !p.air && !p.inv && distance > 268 && distance < 520
      && p.state === 'neutral' && !p.guard && (!threat || threat.eta > 13);
    if (clearApproach && (memory.approach < 0.10 || p.free > 6) && strike?.attack !== 'finale') return { jump: 1 };
    const backpedal = s.tick - memory.lastRetreat < 650;
    if (memory.shotsSeen >= 2 && (backpedal || midShots > 1.65 && memory.approach < -0.35)) memory.zonerUntil = s.tick + 1500;
    // Keep the retreat read through temporary changes in behaviour near a wall.
    const zoner = memory.zonerUntil > s.tick;
    // Get behind a firing line only when the projected exit fits on the stage.
    const pursuer = memory.myMoves.cross;
    const theirWall = me.facing > 0 ? s.stage.right - p.x : p.x - s.stage.left;
    if (pursuer && midShots > 1.25 && distance > 340 && distance < 1030 && theirWall > 99 && !p.air
      && !p.inv && !p.guard && (!threat || threat.eta > 11)
      && (memory.approach < -0.19 || p.def?.segments.some(seg => seg.type === 'projectile') || zoner)) {
      const through = path[14];
      const contact = path[26];
      const exitX = through.x + me.facing * 90;
      if (Math.abs(contact.x - exitX) < 151 && !contact.air && !contact.inv) return { attack: 'cross' };
    }
    if (zoner && distance > 225 && distance < 730 && !p.inv && !p.air && strike?.attack !== 'finale') {
      if (threat?.eta <= 12) return { guard: guardOf(threat.zone) };
      if (!strike || strike.contact.o.state === 'neutral' || strike.contact.o.state === 'blockstun') {
        if (distance < 340 && p.def?.segments.some(seg => seg.type === 'projectile') && p.t < p.def.firstActive + 3) return { guard: 'low' };
        return { walk: 1 };
      }
    }
    const repeatedSweep = habit('sweep', s.tick) > 1.24;
    if (repeatedSweep && distance > 138 && distance < 215 && !p.air && !p.inv
      && !(threat?.eta < 27) && !p.def && strike?.attack !== 'finale'
      && habit('upper', s.tick) < 0.85 && afterHit < 120) {
      return { jump: distance > 151 ? 1 : 0 };
    }
    if (zoner && longPokes > 1.05 && p.state === 'neutral' && theirWall < 190 && distance > 136 && distance < 209
      && s.tick - memory.wokeAt <= 23 && strike?.attack !== 'finale') return { guard: 'low' };
    if (zoner && theirWall < 195 && distance < 211 && distance > 133 && !p.air && !p.inv) {
      if (p.state === 'neutral' && longPokes > 0.65 && strike?.attack !== 'finale') {
        if (distance > 182 && s.tick - memory.baitAt < 5) return { walk: 1 };
        if (distance <= 182 && memory.baitAt < s.tick - 70) memory.baitAt = s.tick;
        if (s.tick - memory.baitAt < 28) return { guard: 'low' };
        return { walk: 1 };
      }
      if (s.tick - memory.lastBlockEnd < 4 && distance < 199 && p.state === 'move' && p.t >= p.def.firstActive + 3 && p.def.duration - p.t >= 9) return { attack: 'knee' };
    }
    const next = path[6];
    // A block on wake-up protects against strikes. Against repeated throws,
    // leave the ground or take the opening while they are still recovering.
    const throwOnly = grabs > 1.35 && memory.offense < 0.35;
    const throwGap = Math.abs(next.x - me.x);
    if (throwOnly && !p.inv && !p.air && distance < 161 && throwGap < 157) {
      const committed = p.state === 'throw' && p.t >= 7 && p.t < 28;
      if (committed && strike && strike.contact.t + p.t < 35) return { attack: strike.attack };
      if (distance > 129 && strike?.attack === 'upper' && !p.guard) return { attack: strike.attack };
      if (p.guard && distance < 119 && s.tick - p.wake >= 6) return { throw: true };
      return { jump: distance > 120 ? 1 : 0 };
    }
    const throwOk = facing && !p.air && !next.air && distance < 131 && Math.abs(next.x - me.x) < 127 && !p.inv
      && (p.state === 'neutral' || p.state === 'throw' || p.state === 'parry' || p.state === 'staggered' || p.state === 'dizzy')
      && s.tick - p.wake >= 6;
    if (throwOk && (p.state === 'throw' || closeGuard || parries > 1.5 || (p.state === 'parry' && p.t < 13))
      && strike?.attack !== 'finale' && (closeGuard || (me.stale.throw || 1) > 0.59)) {
      return { throw: true };
    }
    if (closeGuard && parries > 0.9 && p.guard && !p.air && p.state === 'neutral'
      && distance >= 115 && distance < 225 && !(threat?.eta < 15)) {
      // A parry on reaction beats a slow overhead. Walk into throw range
      // and wait out throw protection at the edge of that range.
      return distance >= 127 ? { walk: 1 } : { guard: 'low' };
    }
    if (p.inv && (SAFE.includes(p.state) || op.invulnerable && p.state === 'neutral')) {
      if (distance > 138 && p.state !== 'neutral' && !(threat?.eta < 34)) return { walk: 1 };
      if (op.invulnerable && p.state === 'neutral' && distance < 200 && !corner) return { guard: 'low' };
      if (!strike || strike.contact.t > 20) return { guard: p.air ? 'high' : 'low' };
    }

    if (strike?.attack === 'finale') return { attack: strike.attack };
    const prop = s.props.find(item => item.in === 0 && Math.abs(item.x - me.x) <= item.reach);
    if (prop && distance > (memory.approach > 0.25 ? 460 : 320) && !p.inv && !p.air && !(threat?.eta < 36)
      && habit('cross', s.tick) < 2.2) return { use: true, say: 'jetsam' };

    if (strike) {
      const clean = strike.contact.o.state !== 'neutral' && strike.contact.o.state !== 'blockstun';
      if (strike.attack === 'slide' && distance > 272 && !clean && (parries > 1.45 || jumps > 2.2)) return { walk: 1 };
      if (p.air && strike.contact.o.air && !clean && jumps > 1.7 && strike.score < 30) return { guard: 'high' };
      return { attack: strike.attack };
    }

    const shot = shoot(s, path, threat, lead);
    if (shot && !(zoning > 1.1 && distance < 1050) && !(closeGuard && distance < 430) && !(parries > 1.8 && distance < 600)) return { attack: shot };
    const counter = p.seg?.type === 'strike' && p.def && p.t < p.seg.activeEnd;
    if (counter && threat?.eta < 14) return { guard: guardOf(threat.zone) };
    if (midShots > 1.4 && distance < 285 && distance > 204 && p.state === 'neutral' && !p.inv && !p.air && !threat && midShots > longPokes) {
      return { walk: 1 };
    }
    if (p.air && distance < 300) {
      if (p.y < 105 && path[6].y > p.y && distance > 190 && p.x * me.facing > me.x * me.facing) return { walk: 1 };
      return { guard: 'high' };
    }
    if (throwOk && grabs > 1.9) return { throw: true };
    if (distance < 165 && grabs > 1.5 && s.tick - memory.hurtAt < 220 && !closeGuard && !corner) return { dash: 'back' };
    if (distance < 232 && closeGuard && (!threat || threat.eta > 35)) return { walk: 1 };
    if (distance > 315 && distance < 510 && closeGuard && parries > 1.5 && p.state === 'neutral' && !(threat?.eta < 44)) {
      return { jump: 1 };
    }
    if (s.timeLeft < 740 && lead > 0.07 && !corner && !closeGuard && distance < 210 && !p.inv) return { walk: -1, guard: 'high' };
    if (zoning > 1.1 && distance > 540 && (!threat || threat.eta > 34) && !p.air) return { dash: 'forward' };
    if (distance > 575 && !threat && p.state !== 'move' && memory.approach < 0.20 && distance < 1250) return { dash: 'forward' };
    if (distance > 137 || closeGuard || s.timeLeft < 600 && lead < 0) return { walk: 1 };
    memory.rng = (Math.imul(memory.rng, 1664525) + 1013904223) >>> 0;
    return { guard: 'low', ...(memory.rng % 23 === 0 ? { walk: -1, guard: 'high' } : {}) };
  },
};
