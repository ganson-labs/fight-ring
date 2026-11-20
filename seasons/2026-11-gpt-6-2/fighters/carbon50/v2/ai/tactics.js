// Master tactical combat brain of Baron Fonar (v3 — Grandmaster Edition).
// Zero-delay hit/block/crush/teleport/prop fusion, 15-tick physics + ghost-projectile extrapolation,
// strict range-aware defense (fuzzy crouch-guard outside throw range >134, active strike/throw/backwalk <=134),
// deterministic projectile & overhead parrying, projectile-safe approach, turtle-cracker, and stale rotation.

import {
  STAGE_LEFT, STAGE_RIGHT, THROW_RANGE, strikeMaxDist,
  canStartMove, freshness,
} from './data.js';

function chooseGuaranteedPunish(me, op, pred, openTicks, dist, nearCornerOp) {
  const opCrouch = pred.predPosture === 'crouch';

  // 1. Super (`finale`: 8t startup, <220 dist, ~450 dmg) on lethal or meaty guaranteed window!
  if (canStartMove(me, 'finale') && openTicks >= 9 && dist < strikeMaxDist('long', opCrouch) - 6) {
    if (op.hp <= 495 || (op.hp >= 230 && openTicks >= 9)) {
      return { attack: 'finale' };
    }
  }

  // 2. `cyclone` (12t startup, <285 dist, launches into `knee` [81 dmg] or `upper` [94 corner] or `finale` [288]!)
  if (canStartMove(me, 'cyclone') && openTicks >= 13 && dist < strikeMaxDist('mid', opCrouch, 120) - 8) {
    if (freshness(me, 'cyclone') >= 0.72 || dist >= 160) {
      return { attack: 'cyclone' };
    }
  }

  // 3. Long-range whiff punish (`slide`: 14t, <365 dist, low launch!)
  if (canStartMove(me, 'slide') && openTicks >= 15 && dist >= 215 && dist < strikeMaxDist('mid', opCrouch, 200) - 10) {
    return { attack: 'slide', crouch: true };
  }

  // 4. Close launch / high damage (`jab -> upper` = 81 dmg at >=5 openTicks if <120; `upper` = 70 dmg at >=6 if standing!)
  if (dist < strikeMaxDist('short', opCrouch) - 5) {
    if (!opCrouch && canStartMove(me, 'upper') && openTicks >= 6 && freshness(me, 'upper') >= 0.78) {
      return { attack: 'upper' };
    }
    if (canStartMove(me, 'jab') && openTicks >= 5) {
      return { attack: 'jab' };
    }
  }

  // 5. Mid-range fast punish (`twin`: 8t, <142 dist, 62 dmg! Or `low`: 7t, <165 dist!)
  if (dist < strikeMaxDist('mid', opCrouch) - 5) {
    if (canStartMove(me, 'twin') && openTicks >= 9 && dist < 142 && freshness(me, 'twin') >= 0.75) {
      return { attack: 'twin' };
    }
    if (canStartMove(me, 'low') && openTicks >= 8) {
      return { attack: 'low', crouch: true };
    }
  }

  // 6. `sweep` (12t, <220 launch) / `smash` (12t, <220) / `heavy` (13t, <220)
  if (dist < strikeMaxDist('long', opCrouch) - 6) {
    if (canStartMove(me, 'sweep') && openTicks >= 13 && (nearCornerOp || freshness(me, 'sweep') > freshness(me, 'heavy'))) {
      return { attack: 'sweep', crouch: true };
    }
    if (canStartMove(me, 'smash') && openTicks >= 13 && freshness(me, 'smash') >= freshness(me, 'heavy')) {
      return { attack: 'smash', hold: false };
    }
    if (canStartMove(me, 'heavy') && openTicks >= 14) {
      return { attack: 'heavy' };
    }
  }

  // 7. Advancing `knee` (10t, <215)
  if (canStartMove(me, 'knee') && openTicks >= 11 && dist < strikeMaxDist('short', opCrouch, 90) - 8) {
    return { attack: 'knee' };
  }

  // 8. Full-screen projectile punish (`lance`: 9t, speed 13)
  if (canStartMove(me, 'lance') && openTicks >= 12 + Math.ceil(Math.max(0, dist - 90) / 13) && pred.projThreats.length === 0) {
    return { attack: 'lance' };
  }

  return null;
}

export function decideAction(s, pred, prof, mem, rng) {
  const me = s.me;
  const op = s.opponent;
  const tick = s.tick;
  const dist = pred.predDist;
  const cDist = pred.confirmDist;
  const myWallDist = me.facing > 0 ? me.x - STAGE_LEFT : STAGE_RIGHT - me.x;
  const opWallDist = me.facing > 0 ? STAGE_RIGHT - pred.predX : pred.predX - STAGE_LEFT;
  const iAmCornered = myWallDist < 190;
  const opIsCornered = opWallDist < 220;

  if (me.state === 'blockstun') {
    mem.lastMyBlockTick = tick;
  }
  if (me.state === 'knockdown' || me.state === 'getup' || me.state === 'hitstun' || me.state === 'juggle') {
    mem.lastMyWakeTick = tick;
  }
  if (me.state === 'move') {
    mem.lastMyMoveEndTick = tick + 1;
  }
  // Detect opponent wakeup reversal mashing (e.g. mashing cyclone/upper/sweep/finale right out of getup!)
  if (op.state === 'getup' || op.state === 'knockdown') {
    mem.opLastDownTick = tick;
  } else if (op.state === 'move' && mem.opLastDownTick && tick - mem.opLastDownTick <= 22) {
    mem.opWakeReversals = (mem.opWakeReversals || 0) + 1;
    mem.opLastDownTick = -999;
  }

  let sayLine = null;
  if (tick - mem.lastSayTick > 840 && dist > 280 && me.canAct && s.lines && s.lines.length) {
    if (rng() < 0.015) {
      const taunts = s.lines.filter((l) => l.kind === 'taunt');
      if (taunts.length) {
        sayLine = taunts[Math.floor(rng() * taunts.length)].id;
        mem.lastSayTick = tick;
      }
    }
  }
  const withSay = (act) => (sayLine ? { ...act, say: sayLine } : act);

  // =========================================================================
  // 0. WHILE IN A MOVE (`smash` short micro-hold ONLY if opponent is currently parrying!)
  // =========================================================================
  if (me.state === 'move' && me.move) {
    if (me.move.id === 'smash' && me.move.t <= 12 && me.move.held < mem.targetSmashHold) {
      if (pred.predAirborne || dist > 235 || pred.incomingStrike || pred.projThreats.length > 0) {
        return { hold: false };
      }
      return { hold: true };
    }
    return {};
  }

  // =========================================================================
  // 1. AIRBORNE OFFENSE (`dive` vs `air_kick` — EXACT LANDING ARC MATH!)
  //    Note: `dive` has 5t startup; falling at vy ~ -11 covers ~60u during startup,
  //    so firing at `me.y <= 138 && me.vy < 1.5` activates at y~75 right into grounded body!
  // =========================================================================
  if (me.airborne) {
    if (me.canAirMove) {
      const airReach = 162;
      const airToAir = pred.predAirborne && Math.abs(me.y - pred.predY) < 95 && dist < airReach;
      const deepGround = !pred.predAirborne && me.vy < 1.5 && me.y <= 138 && me.y >= 48 && dist < airReach;
      if (airToAir || deepGround) {
        if (canStartMove(me, 'dive') && (airToAir || pred.openTicks > 0 || op.guard !== 'high' || freshness(me, 'dive') >= 0.78)) {
          return { attack: 'dive' };
        }
        if (canStartMove(me, 'air_kick')) {
          return { attack: 'air_kick' };
        }
      }
    }
    return {};
  }

  // =========================================================================
  // 2. NON-NEUTRAL WAKE-GUARD BUFFERING
  // =========================================================================
  if (!me.canAct) {
    let guardDir = 'low';
    if (pred.incomingStrike && (pred.incomingStrike.zone === 'overhead' || pred.incomingStrike.zone === 'air') && pred.incomingStrike.ticksUntilActive <= 8) {
      guardDir = 'high';
    } else if (pred.predAirborne && pred.predState !== 'juggle' && dist < 240 && pred.predVy < 3) {
      guardDir = 'high';
    }
    return { guard: guardDir, crouch: guardDir === 'low' };
  }

  // =========================================================================
  // 3. ZERO-DELAY TELEPORT / CROSS-UP COUNTER (`blink`, `cross`, `ambush`)
  // =========================================================================
  if (pred.justTeleported && dist < 135) {
    if (pred.teleportSuspectSuper) {
      if (pred.teleportTicksAgo >= 1 && pred.teleportTicksAgo <= 5) {
        return { parry: true };
      }
      return { guard: 'low', crouch: true };
    }
    if (canStartMove(me, 'jab')) {
      return { attack: 'jab' };
    }
  }

  // =========================================================================
  // 4. FRAME-PERFECT ZERO-DELAY HIT-CONFIRMS & JUGGLE FOLLOWUPS!
  // =========================================================================
  if (pred.predState === 'juggle') {
    if (pred.openTicks >= 5 || pred.predY > 15) {
      if (canStartMove(me, 'finale') && dist < 210 && pred.openTicks >= 9 && (op.hp <= 300 || (op.hp <= 420 && s.timeLeft < 1800))) {
        return { attack: 'finale' };
      }
      if (opIsCornered && dist < 122 && canStartMove(me, 'upper') && pred.openTicks >= 6) {
        return { attack: 'upper' };
      }
      if (dist < 205 && canStartMove(me, 'knee') && pred.openTicks >= 10) {
        return { attack: 'knee' };
      }
      if (dist < 122 && canStartMove(me, 'jab') && pred.openTicks >= 5) {
        return { attack: 'jab' };
      }
    }
  }

  if (pred.justHitMove && (pred.predState === 'hitstun' || pred.predState === 'staggered') && pred.openTicks >= 5) {
    const opCrouch = pred.predPosture === 'crouch';
    if ((pred.justHitCounter || pred.predState === 'staggered') && pred.openTicks >= 9 && canStartMove(me, 'finale') && dist < 210 && op.hp <= 520) {
      return { attack: 'finale' };
    }
    if (pred.justHitCounter && pred.openTicks >= 9 && canStartMove(me, 'twin') && dist < 145) {
      return { attack: 'twin' };
    }
    if (!opCrouch && pred.openTicks >= 6 && dist < 118 && canStartMove(me, 'upper')) {
      return { attack: 'upper' };
    }
    if (pred.openTicks >= 5 && dist < 118 && canStartMove(me, 'jab')) {
      return { attack: 'jab' };
    }
    if (pred.openTicks >= 8 && dist < 158 && canStartMove(me, 'low')) {
      return { attack: 'low', crouch: true };
    }
  }

  // =========================================================================
  // 5. DETERMINISTIC PROJECTILE DEFENSE & FREE-METER PARRY ENGINE!
  //    (Includes Ghost Projectiles detected from `op.move` 15 ticks early!)
  // =========================================================================
  const hasIncomingProj = pred.projThreats.length > 0;
  const nearestProjTicks = hasIncomingProj ? pred.projThreats[0].ticksToHit : 999;

  if (hasIncomingProj) {
    const pr = pred.projThreats[0];
    // High projectile (`spike` y=235): `slide` right under it if opponent is still in `spike` recovery (`openTicks` or `<345`), else duck/parry!
    if (pr.zone === 'high') {
      if (dist < 345 && dist > 150 && pr.ticksToHit <= 14 && canStartMove(me, 'slide') && !pred.predInvuln && freshness(me, 'slide') >= 0.65) {
        return { attack: 'slide', crouch: true };
      }
      if (pr.ticksToHit >= 0 && pr.ticksToHit <= 3 && dist > 160 && me.meter < 296) {
        return { parry: true };
      }
      if (pr.ticksToHit <= 4) {
        return { crouch: true, guard: 'low' };
      }
      return { walk: 1 };
    } else {
      if (pr.ticksToHit >= 0 && pr.ticksToHit <= 4 && dist > 145) {
        return { parry: true };
      }
      if (pr.ticksToHit <= 5) {
        return { guard: 'low', crouch: true };
      }
      if (pr.zone === 'low' && Math.abs(pr.vx) <= 7 && pr.ticksToHit >= 8 && pr.ticksToHit <= 18 && dist >= 195 && dist <= 295 && !pred.predAirborne) {
        return { jump: 1 };
      }
      return { walk: 1 };
    }
  }

  // =========================================================================
  // 6. INCOMING STRIKE DEFENSE: EXACT PARRY ON REACTABLE MOVES & FUZZY GUARD!
  // =========================================================================
  if (pred.incomingStrike) {
    const st = pred.incomingStrike;
    if (dist <= st.maxDist + 28) {
      if (st.hasCharge && st.held > 0) {
        if (dist > 195 && !iAmCornered) return { walk: -1, guard: 'high' };
        return { guard: 'low', crouch: true };
      }
      if (st.armorLeft > 0) {
        if (dist <= THROW_RANGE - 4 && st.ticksUntilActive >= 7 && !pred.throwProtected) {
          return { throw: true };
        }
        if (canStartMove(me, 'finale') && st.ticksUntilActive >= 9 && dist < 212 && op.hp <= 520) {
          return { attack: 'finale' };
        }
        if (canStartMove(me, 'cyclone') && st.ticksUntilActive >= 19 && dist < 265) {
          return { attack: 'cyclone' };
        }
      }
      if (!st.hasCharge && st.ticksUntilActive >= 0 && st.ticksUntilActive <= 4 && dist <= st.maxDist + 6) {
        if (st.zone === 'overhead' || st.armorLeft > 0 || st.moveId === 'rush' || st.moveId === 'cross' || me.guardGauge >= 65) {
          return { parry: true };
        }
      }
      if (st.ticksUntilActive <= 9) {
        if (me.guardGauge >= 78 && st.ticksUntilActive >= 2 && !iAmCornered) {
          return { dash: 'back' };
        }
        const g = (st.zone === 'overhead' || st.zone === 'air') ? 'high' : 'low';
        return { guard: g, crouch: g === 'low' };
      }
    }
  }

  // 6B. WAKEUP & POST-HITSTUN FORTRESS:
  // For 10 ticks after leaving getup/knockdown/hitstun (`THROW_PROTECT = 6` + `THROW_STARTUP = 5` = 11 ticks 100% throw-immune!),
  // hold fuzzy crouch-guard unconditionally when opponent is within `< 365` (blocks ALL meaty sweep/slide/cyclone/heavy/finale -> +15..+29 punish!)
  const sinceWake = tick - (mem.lastMyWakeTick || -999);
  if (sinceWake <= 10 && dist < 365 && pred.openTicks < 5) {
    if (me.guardGauge >= 84 && sinceWake >= 2 && !iAmCornered) {
      return { dash: 'back' };
    }
    return { guard: 'low', crouch: true };
  }

  // 6C. POST-BLOCKED-MOVE REVERSAL TRAP:
  // When our move was blocked, opponent has the turn (`+2` to `+18`) and mashers immediately fire `cyclone` (12t) / `sweep` (12t) / `slide` (14t)!
  // Hold fuzzy crouch-guard for 14 ticks (unless a dedicated grappler is in throw range after tick 9) to block & punish their reversal!
  const sinceMyBlockedEnd = tick - (mem.lastMyMoveEndTick || -999);
  if (pred.justBlockedMove && sinceMyBlockedEnd <= 14 && dist < 285 && pred.openTicks < 5) {
    if (sinceMyBlockedEnd > 9 && prof.throwCloseRate >= 0.25 && dist <= 134 && !iAmCornered) {
      return { walk: -1, guard: 'high' };
    }
    if (me.guardGauge < 76) {
      return { guard: 'low', crouch: true };
    }
  }

  // =========================================================================
  // 7. ANTI-AIR SNIPER (`upper` 5t / `finale` 8t)
  // =========================================================================
  if (pred.predAirborne && pred.predState !== 'juggle') {
    if (pred.predMove && pred.predMove.id === 'meteor') {
      if (dist < 175) return { parry: true };
      return { guard: 'high' };
    }
    if (dist < 123 && pred.predY <= 230 && pred.predVy < 5 && canStartMove(me, 'upper')) {
      return { attack: 'upper' };
    }
    if (dist < 210 && pred.predY <= 205 && pred.predVy < 4 && canStartMove(me, 'finale') && op.hp <= 520) {
      return { attack: 'finale' };
    }
    if (dist >= 123 && dist < 215 && pred.predVy < 2) {
      return { walk: 1 };
    }
    if (dist < 175 && pred.predY < 180) {
      return { guard: 'high' };
    }
  }

  // =========================================================================
  // 8. NEVER SWING INTO INVULNERABLE OPPONENT
  // =========================================================================
  if (pred.predInvuln) {
    const ticksToWake = pred.wakeTick > tick ? pred.wakeTick - tick : 15;
    if (ticksToWake >= 28 && s.props && s.props.length) {
      for (let i = 0; i < s.props.length; i++) {
        const pr = s.props[i];
        if (pr.in === 0 && Math.abs(pr.x - me.x) <= pr.reach) return { use: true };
        if (pr.in === 0 && Math.abs(pr.x - me.x) <= 135 && ticksToWake >= 38) {
          return { walk: (pr.x - me.x) * me.facing > 0 ? 1 : -1 };
        }
      }
    }
    const wakeMasher = (mem.opWakeReversals || 0) >= 2;
    const targetOkiDist = (op.bars >= 3 || prof.throwCloseRate > 0.32 || wakeMasher) ? 142 : 118;
    if (dist > targetOkiDist + 16) {
      if (dist > 340 && ticksToWake >= 20) return { dash: 'forward' };
      return { walk: 1 };
    }
    if (dist < targetOkiDist - 12 && !iAmCornered) {
      return { walk: -1, guard: 'high' };
    }
    // If opponent mashes wakeup reversals (`cyclone`/`upper`/`finale`), BAIT & CROUCH-BLOCK at 142u for a massive +17..+29 punish!
    if (!wakeMasher && op.bars < 3 && pred.wakeTick > tick) {
      const rem = pred.wakeTick - tick;
      if (rem === 7 && dist < 156 && canStartMove(me, 'low') && prof.guardLowRate < 0.65) {
        return { attack: 'low', crouch: true };
      }
      if (rem === 19 && dist < 156 && canStartMove(me, 'overhead') && prof.guardLowRate >= 0.45) {
        return { attack: 'overhead' };
      }
    }
    return { guard: 'low', crouch: true };
  }

  // =========================================================================
  // 9. GUARANTEED WHIFF / BLOCK / PARRY / GUARD-CRUSH / LANDING PUNISH!
  // =========================================================================
  if (pred.openTicks >= 5) {
    const pun = chooseGuaranteedPunish(me, op, pred, pred.openTicks, cDist, opIsCornered);
    if (pun) return withSay(pun);
    if (pred.openTicks >= 20 && dist > 220 && nearestProjTicks > 24) {
      return { dash: 'forward' };
    }
  }

  // Just exited blockstun: it is GUARANTEED OUR TURN (+2 to +18)! Strike back immediately!
  if (tick - (mem.lastMyBlockTick || -99) <= 2) {
    if (dist < 120 && canStartMove(me, 'jab')) return { attack: 'jab' };
    if (dist < 158 && canStartMove(me, 'low')) return { attack: 'low', crouch: true };
  }

  // =========================================================================
  // 10. UNREACTABLE `finale` SUPER ASSASSINATION (8t invuln, <220 dist, 450 dmg!)
  // =========================================================================
  if (canStartMove(me, 'finale') && cDist < 206) {
    const opNotBlocking = (op.state === 'neutral' && !op.guard && Math.abs(op.vx) > 0.5)
      || op.state === 'dash'
      || op.state === 'throw'
      || op.state === 'use'
      || (op.state === 'move' && (!pred.predMove || !pred.predInvuln));
    if (opNotBlocking && (op.hp <= 510 || op.hp >= 220)) {
      return withSay({ attack: 'finale' });
    }
  }

  // =========================================================================
  // 11. STAGE OBJECTS (`props`)
  // =========================================================================
  if (s.props && s.props.length > 0 && nearestProjTicks > 28) {
    for (let i = 0; i < s.props.length; i++) {
      const pr = s.props[i];
      if (pr.in === 0) {
        const dProp = Math.abs(pr.x - me.x);
        const safeGrab = dist > 310;
        if (dProp <= pr.reach && safeGrab) {
          return withSay({ use: true });
        }
        if (dProp <= 150 && dist > 350 && safeGrab) {
          const dir = (pr.x - me.x) * me.facing > 0 ? 1 : -1;
          return { walk: dir };
        }
      }
    }
  }

  // =========================================================================
  // 12. CORNER ESCAPE (when WE are near our wall!)
  // =========================================================================
  const turtleScore = prof.guardHighRate + prof.guardLowRate;
  const isParryBot = prof.parryRate >= 0.22; // Decays naturally when opponent switches style!
  const isTurtle = turtleScore >= 0.52;
  const isGrappler = prof.throwCloseRate >= 0.26 || prof.dominantMove === 'throw';
  const isArmorBot = prof.armorRate >= 0.18 || prof.dominantMove === 'ram' || prof.dominantMove === 'breaker';
  const isZoner = prof.zoneRate >= 0.22 || prof.retreatRate >= 0.28;
  const isSpamHeavy = prof.dominantMoveShare > 0.45 && (prof.dominantMove === 'heavy' || prof.dominantMove === 'sweep');

  if (iAmCornered && dist < 250) {
    // Against close pressure in corner: jump forward cross-up (`dive` / side-swap) to escape the corner!
    if (dist < 175 && (isGrappler || me.guardGauge > 40 || isArmorBot || rng() < 0.28)) {
      return { jump: 1 };
    }
    // Safe -4 advancing `knee` (`<210`) instead of punishable -17 `cyclone` when opponent has super or blocks!
    if (dist < 208 && !isParryBot && canStartMove(me, 'knee') && rng() < 0.35) {
      return { attack: 'knee' };
    }
    if (dist <= THROW_RANGE - 5 && !pred.throwProtected && rng() < 0.48) {
      return { throw: true };
    }
  }

  // =========================================================================
  // 13. ARCHETYPE COUNTERS IN NEUTRAL
  // =========================================================================
  // 13A. Anti-Grappler (non-turtles like `brosok`): jump deep `dive` (70 dmg launch!) over throw attempts!
  if (isGrappler && !isTurtle && dist <= 152) {
    if (dist <= 146 && rng() < 0.48) {
      return { jump: dist < 105 ? 0 : 1 };
    }
    if (dist < 120 && canStartMove(me, 'jab')) {
      return { attack: 'jab' };
    }
  }

  // 13B. Anti-Armor: `throw` up close or 3-hit `cyclone`!
  if (isArmorBot && dist < 260 && !isParryBot) {
    if (dist <= THROW_RANGE - 4 && !pred.throwProtected) {
      return { throw: true };
    }
    if (dist < 258 && canStartMove(me, 'cyclone') && rng() < 0.50) {
      return { attack: 'cyclone' };
    }
  }

  // 13C. Anti-Whiff-Spammer (`pryamoy`, `krug`): hover at 225..245 holding fuzzy low guard, bait whiff, then crush!
  if (isSpamHeavy && dist >= 195 && dist <= 255) {
    if (dist < 224 && !iAmCornered) {
      return { walk: -1, guard: 'high' };
    }
    if (rng() < 0.65) {
      return { guard: 'low', crouch: true };
    }
  }

  // 13D. DEDICATED TURTLE-CRACKER (`cherepaha`, `turtle_master`, `skala`):
  if (isTurtle && dist <= 195) {
    // At `131..156` (OUTSIDE enemy 130 throw range!), crack crouch-blockers safely with `overhead` (-3 on block, +5 -> `jab` 80 dmg!)
    if (dist > THROW_RANGE - 6) {
      if (prof.guardLowRate >= 0.35 && !isParryBot && dist < 156 && canStartMove(me, 'overhead') && freshness(me, 'overhead') >= 0.72 && rng() < 0.36) {
        return { attack: 'overhead' };
      }
      return { walk: 1 };
    }
    // Inside `<= 124`: unblockable `throw` (91 dmg, beats block, parry, AND techs their throw!)
    if (!pred.throwProtected && (freshness(me, 'throw') >= 0.58 || isParryBot) && rng() < (0.72 - prof.techRate * 0.28)) {
      prof.myThrowAttempts++;
      return { throw: true };
    }
    if (prof.guardLowRate >= 0.32 && !isParryBot && canStartMove(me, 'overhead') && rng() < 0.55) {
      return { attack: 'overhead' };
    }
    if (canStartMove(me, 'low') && prof.guardHighRate > 0.35 && rng() < 0.50) {
      return { attack: 'low', crouch: true };
    }
    if (canStartMove(me, 'jab') && rng() < 0.55) {
      return { attack: 'jab' };
    }
    return iAmCornered ? { walk: 1 } : { walk: -1, guard: 'high' };
  }

  // =========================================================================
  // 14. CLOSE RANGE (`dist <= 162`): NEVER SIT STATIONARY INSIDE THROW RANGE (`<= 134`)!
  // =========================================================================
  if (dist <= 162) {
    // Against Parry Bots: walk-up `throw` (91 unblockable, unparryable!) + crisp unreactable `low` (7t) / `jab` (4t)!
    if (isParryBot) {
      if (dist <= THROW_RANGE - 5 && !pred.throwProtected && rng() < 0.62) {
        prof.myThrowAttempts++;
        return { throw: true };
      }
      if (op.state === 'parry' && canStartMove(me, 'smash') && dist < 205) {
        mem.targetSmashHold = 6;
        return { attack: 'smash', hold: true };
      }
      if (dist > THROW_RANGE - 7 && rng() < 0.65) {
        return { walk: 1 };
      }
    }

    if (dist <= THROW_RANGE - 4 && !pred.throwProtected) {
      const wantThrow = (op.guard !== null ? 0.55 : 0.24) - (prof.techRate * 0.32);
      if (rng() < wantThrow && freshness(me, 'throw') >= 0.70) {
        prof.myThrowAttempts++;
        return { throw: true };
      }
    }

    if ((op.guard === 'low' || prof.guardLowRate > 0.40) && !isParryBot && dist < 155 && canStartMove(me, 'overhead') && freshness(me, 'overhead') >= 0.75 && rng() < 0.28) {
      return { attack: 'overhead' };
    }

    if (dist < 120 && canStartMove(me, 'jab') && rng() < 0.54) {
      return { attack: 'jab' };
    }

    if (dist < 158 && canStartMove(me, 'low') && rng() < 0.56) {
      return { attack: 'low', crouch: true };
    }

    // Only use `twin` (-11 on block) in neutral if opponent almost never blocks AND has <3 bars!
    if (dist < 142 && !isParryBot && turtleScore < 0.22 && op.bars < 3 && canStartMove(me, 'twin') && freshness(me, 'twin') >= 0.85 && rng() < 0.22) {
      return { attack: 'twin' };
    }

    // RANGE-AWARE DEFENSE:
    // Outside throw range (`135..162`): `{ guard: 'low', crouch: true }` is 100% throw-safe AND blocks all mids/lows!
    // Inside throw range (`<= 134`): step back with `{ walk: -1, guard: 'high' }` (escapes throw while blocking!) or walk in!
    if (dist > 134 && me.guardGauge < 68) {
      return { guard: 'low', crouch: true };
    }
    return iAmCornered ? { walk: 1 } : { walk: -1, guard: 'high' };
  }

  // =========================================================================
  // 15. FOOTSIES & MID RANGE (`162 < dist <= 360`): ZERO-PUNISH SAFE NEUTRAL!
  // =========================================================================
  if (dist <= 360) {
    // Super-bait crouch-guard check when opponent has 3 bars (`> 134` so 100% throw-immune!)
    if (op.bars >= 3 && dist < 232 && me.guardGauge < 65 && rng() < 0.44) {
      return { guard: 'low', crouch: true };
    }

    // Against Zoners (`zoner_god`, `strelok`, `zalp`): walk them down & parry, use safe `knee` (`-4` on block!) up close,
    // and only `slide` when opponent has <3 bars and rarely crouch-blocks!
    if (isZoner) {
      if (dist >= 215 && dist < 340 && op.bars < 3 && !isParryBot && prof.guardLowRate < 0.20 && canStartMove(me, 'slide') && freshness(me, 'slide') >= 0.82 && rng() < 0.22) {
        return { attack: 'slide', crouch: true };
      }
      if (!isParryBot && turtleScore < 0.35 && op.bars < 3 && dist >= 190 && dist < 216) {
        if (prof.guardHighRate > 0.35 && canStartMove(me, 'sweep') && freshness(me, 'sweep') >= 0.80 && rng() < 0.26) {
          return { attack: 'sweep', crouch: true };
        }
        if (canStartMove(me, 'smash') && freshness(me, 'smash') >= 0.78 && rng() < 0.26) {
          mem.targetSmashHold = 0;
          return { attack: 'smash', hold: false };
        }
      }
      if (dist < 208 && canStartMove(me, 'knee') && freshness(me, 'knee') >= 0.72 && rng() < 0.36) {
        return { attack: 'knee' };
      }
      return { walk: 1 };
    }

    // Primary mid-range neutral approach poke: `knee` (10t startup, advances 90u -> reaches `<215`, -4 ON BLOCK = 100% UNPUNISHABLE!)
    if (dist < 210 && !isParryBot && canStartMove(me, 'knee') && freshness(me, 'knee') >= 0.70 && rng() < 0.38) {
      return { attack: 'knee' };
    }

    // Only swing punishable `smash`/`heavy`/`sweep`/`cyclone` in neutral when opponent is actively dashing/moving UNGUARDED and `<3` bars!
    const opMovingOpen = op.bars < 3 && !isTurtle && !isParryBot && op.guard === null && (op.state === 'dash' || (op.state === 'neutral' && Math.abs(op.vx) > 2.5 && turtleScore < 0.28));
    if (opMovingOpen) {
      if (dist < 212 && canStartMove(me, 'smash') && freshness(me, 'smash') >= 0.82 && rng() < 0.22) {
        mem.targetSmashHold = 0;
        return { attack: 'smash', hold: false };
      }
      if (dist >= 190 && dist < 268 && prof.jumpRate < 0.20 && canStartMove(me, 'cyclone') && freshness(me, 'cyclone') >= 0.85 && rng() < 0.20) {
        return { attack: 'cyclone' };
      }
    }

    if (dist > 250 && !isZoner && canStartMove(me, 'lance') && prof.jumpRate < 0.25 && rng() < 0.20) {
      return withSay({ attack: 'lance' });
    }

    if (opIsCornered && !isTurtle && dist >= 185 && dist <= 228) {
      if (rng() < 0.52) return { guard: 'low', crouch: true };
    }

    // Safe throw-immune (`dist > 162`) fuzzy crouch-guard micro-checks inside opponent's `< 226` poke zone!
    if (dist < 226 && !isTurtle && me.guardGauge < 62 && (tick % 5 === 0)) {
      return { guard: 'low', crouch: true };
    }

    if (dist > 300 && !isZoner && prof.jumpRate < 0.20 && rng() < 0.14) {
      return { dash: 'forward' };
    }
    return { walk: 1 };
  }

  // =========================================================================
  // 16. LONG RANGE (`dist > 360`)
  // =========================================================================
  if (me.passive > 140) {
    if (dist > 480 && !isZoner && rng() < 0.22) return { dash: 'forward' };
    return { walk: 1 };
  }

  // Opening 32 ticks at range: don't blindly throw `lance` into opponent's tick-1 `spike` or opening parry — crouch/walk & parry their shot!
  if (tick <= 32 && dist > 300) {
    if (tick >= 10 && tick <= 28) return { guard: 'low', crouch: true };
    return { walk: 1 };
  }

  // Against dedicated zoners, don't trade slow projectiles from full screen — walk forward and parry every shot for +12 super meter!
  if (!isZoner && canStartMove(me, 'lance') && rng() < 0.24) {
    return withSay({ attack: 'lance' });
  }

  const myHpShare = me.hp / me.maxHp;
  const opHpShare = op.hp / op.maxHp;
  if (s.timeLeft < 900 && myHpShare - opHpShare > 0.12 && me.passive < 130) {
    if (canStartMove(me, 'lance')) return { attack: 'lance' };
    return { guard: 'low', crouch: true };
  }

  if (dist > 520 && !isZoner && rng() < 0.20) {
    return { dash: 'forward' };
  }
  return { walk: 1 };
}
