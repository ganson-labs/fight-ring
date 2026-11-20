// 15-tick state estimator + zero-delay telemetry fusion from live `state.me` and `state.props`.
import {
  STAGE_LEFT, STAGE_RIGHT, PUSH_WIDTH, GRAVITY, JUMP_VY, PREJUMP_TICKS, LANDING_TICKS,
  DASH_TICKS, BACKDASH_TICKS, BACKDASH_DIST, WHIFF_EXTRA, THROW_TOTAL, PARRY_TOTAL,
  REACH_PX, PROJ_SPEED, PROJ_HALF, getMoveDef,
} from './data.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createPredictor() {
  return {
    lastTick: -1,
    prevMeter: 0,
    prevHp: -1,
    prevFacing: 0,
    prevMeX: 0,
    prevMeState: 'neutral',
    prevMeStateTicks: 0,
    prevMoveId: null,
    prevProjOut: false,
    prevStaleSnap: '',
    prevProps: [],

    // Zero-delay tracked events on opponent caused by OUR hits/blocks
    lastConnectTick: -999,
    lastConnectKind: null, // 'hit' | 'block' | 'armor' | 'whiff' | 'crush'
    lastConnectMove: null,
    lastConnectCounter: false,
    opKnockback: 0, // Estimated knockback push added to predX before delayed sight catches up!
    opLockedUntil: -999, // tick until which opponent is guaranteed unable to act from our hit/block
    opLockType: null, // 'hitstun' | 'blockstun' | 'juggle' | 'knockdown' | 'staggered'
    opJuggleLandTick: -999,
    opWakeTick: -999, // exact tick opponent leaves getup -> neutral (freeAt)

    // Zero-delay teleport / crossup alert
    teleportAlertTick: -999,
    teleportSuspectSuper: false,

    // Zero-delay stage prop projectile alert (before 15t sight sees the projectile)
    phantomPropProj: null, // { spawnTick, x0, vx }

    // Seen opponent state tracking
    seenOpMoveKey: '',
    seenOpMoveTouchedMe: false,
    lastMyHurtOrBlockTick: -999,
    opFreeAtEst: -999,
    wasSeenWakeState: false,
  };
}

function staleSignature(stale) {
  if (!stale) return '';
  let out = '';
  const ks = Object.keys(stale);
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i];
    out += k + ':' + stale[k] + ';';
  }
  return out;
}

export function updatePredictor(P, s, startInfo) {
  const tick = s.tick;
  const me = s.me;
  const op = s.opponent; // delayed by s.reaction (15 ticks)
  const lag = s.reaction || 15;

  if (P.prevHp < 0) {
    P.prevHp = me.hp;
    P.prevMeter = me.meter;
    P.prevFacing = me.facing;
    P.prevMeX = me.x;
    P.prevStaleSnap = staleSignature(me.stale);
    P.prevProps = (s.props || []).map((o) => ({ id: o.id, x: o.x }));
  }

  const dMeter = me.meter - P.prevMeter;
  const dHp = P.prevHp - me.hp;
  const staleNow = staleSignature(me.stale);
  const staleChanged = staleNow !== P.prevStaleSnap;
  const activeMoveId = me.move ? me.move.id : P.prevMoveId;

  // Track if opponent touched us recently (so we know whether their seen move whiffed or connected)
  if (dHp > 0 || me.state === 'hitstun' || me.state === 'blockstun' || me.state === 'juggle' || me.state === 'grabbed') {
    P.lastMyHurtOrBlockTick = tick;
  }

  // 1A. ZERO-DELAY PARRY SUCCESS DETECTOR!
  // Whiffed parry lasts 24 ticks (`PARRY_WINDOW 6 + PARRY_WHIFF 18`). If we were in `parry` at `stateTicks <= 7`
  // and returned to `neutral` IMMEDIATELY (or gained +12 parry meter), we just parried an enemy attack THIS TICK!
  // If opponent is within `< 295` (strike parry, not a far projectile parry), opponent is now in `staggered` for 24 FULL TICKS!
  if (P.prevMeState === 'parry' && me.state === 'neutral' && P.prevMeStateTicks <= 7 && dHp <= 0) {
    const rawDistNow = Math.abs(op.x - me.x);
    const hadCloseProj = (s.projectiles || []).some((p) => !p.mine && Math.abs((p.x + p.vx * lag) - me.x) < 110);
    if (!hadCloseProj && rawDistNow < 305) {
      P.lastConnectTick = tick;
      P.lastConnectKind = 'parry';
      P.lastConnectMove = null;
      P.lastConnectCounter = false;
      P.opLockType = 'staggered';
      P.opLockedUntil = tick + 23; // 24 ticks of stagger!
      P.opFreeAtEst = P.opLockedUntil;
      P.opKnockback = 0;
    }
  }

  // 1B. ZERO-DELAY HIT / BLOCK / GUARD-CRUSH / PROJ CONFIRMATION FROM `me`
  // Guard crush gives +30 raw meter in a single tick (`addMeter(A, 30, true)`), larger than any normal hit (+12 max)!
  if (dMeter >= 26 && dHp <= 0 && me.state !== 'hitstun' && me.state !== 'blockstun') {
    P.lastConnectTick = tick;
    P.lastConnectKind = 'crush';
    P.lastConnectMove = activeMoveId;
    P.lastConnectCounter = false;
    P.opLockType = 'staggered';
    P.opLockedUntil = tick + 38;
    P.opFreeAtEst = P.opLockedUntil;
  } else if (activeMoveId && dHp <= 0 && me.state !== 'hitstun' && me.state !== 'blockstun') {
    const mDef = getMoveDef(me, activeMoveId);
    if (mDef && mDef.slot !== 'super') {
      const hasProj = mDef.segments.some((g) => g.type === 'projectile');
      if (!hasProj && (dMeter > 0.5 || staleChanged)) {
        // Clean hit gives base * 0.15 meter AND updates stale; block gives base * 0.075 meter and does NOT update stale!
        const firstStrike = mDef.segments.find((g) => g.type === 'strike');
        const baseDmg = firstStrike ? firstStrike.damage : 25;
        const hitGain = baseDmg * 0.15;
        const isCleanHit = staleChanged || dMeter >= hitGain * 0.85;
        const isLauncher = !!(firstStrike && firstStrike.launch);
        if (isCleanHit && (isLauncher || P.lastConnectTick < tick - 2)) {
          P.lastConnectTick = tick;
          P.lastConnectKind = 'hit';
          P.lastConnectMove = activeMoveId;
          const opWasStartup = !!(op.move && op.move.phase === 'startup');
          P.lastConnectCounter = opWasStartup;
          if (isLauncher) {
            P.opLockType = 'juggle';
            // Each juggle/launch hit resets vy=15 (35 ticks to floor), push vx=2.5 (~75u over flight)
            P.opJuggleLandTick = tick + 34;
            P.opWakeTick = tick + 34 + 44 + 20;
            P.opLockedUntil = P.opWakeTick;
            P.opKnockback = 55;
          } else {
            const hs = 14 + Math.floor(baseDmg / 6) + (opWasStartup ? 4 : 0);
            P.opLockType = 'hitstun';
            P.opLockedUntil = tick + hs - 1;
            P.opFreeAtEst = P.opLockedUntil;
            P.opKnockback = firstStrike && firstStrike.push === 'heavy' ? 40 : 24;
          }
        } else if (!isCleanHit && dMeter > 0.5 && P.lastConnectTick < tick - 2) {
          P.lastConnectTick = tick;
          P.lastConnectKind = 'block';
          P.lastConnectMove = activeMoveId;
          P.lastConnectCounter = false;
          const bs = 10 + Math.floor(baseDmg / 10);
          P.opLockType = 'blockstun';
          P.opLockedUntil = tick + Math.min(bs, 16);
          P.opFreeAtEst = P.opLockedUntil;
          P.opKnockback = firstStrike && firstStrike.push === 'heavy' ? 30 : 18;
        }
      }
    }
  }

  // Projectile disappeared (`prevProjOut && !me.projectileOut`): check if it hit or was blocked!
  if (P.prevProjOut && !me.projectileOut && dHp <= 0) {
    if (dMeter >= 3.8 || staleChanged) {
      // Note: projectile pushes stale at launch, NOT on hit! So check dMeter: lance(30)*0.15 = 4.5, block = 2.25
      P.lastConnectTick = tick;
      P.lastConnectKind = 'hit';
      P.lastConnectMove = 'lance';
      P.opLockType = 'hitstun';
      P.opLockedUntil = tick + 18;
      P.opFreeAtEst = P.opLockedUntil;
    } else if (dMeter >= 1.8) {
      P.lastConnectTick = tick;
      P.lastConnectKind = 'block';
      P.lastConnectMove = 'lance';
      P.opLockType = 'blockstun';
      P.opLockedUntil = tick + 12;
      P.opFreeAtEst = P.opLockedUntil;
    }
  }

  // 2. ZERO-DELAY TELEPORT / CROSS-UP RADAR (`me.facing` vs delayed `op.x`)
  // In neutral/blockstun/landing/getup on ground, engine sets `me.facing = liveOp.x > me.x ? 1 : -1`!
  const delayedDir = op.x > me.x ? 1 : op.x < me.x ? -1 : me.facing;
  if (!me.airborne && me.facing !== delayedDir && Math.abs(op.x - me.x) > 85) {
    if (tick - P.teleportAlertTick > 20) {
      P.teleportAlertTick = tick;
      P.teleportSuspectSuper = op.bars >= 3 && !!getMoveDef(op, 'ambush');
    }
  }

  // 3. ZERO-DELAY STAGE PROP DISAPPEARANCE RADAR
  const curProps = s.props || [];
  if (curProps.length < P.prevProps.length && me.state !== 'use') {
    for (let i = 0; i < P.prevProps.length; i++) {
      const oldP = P.prevProps[i];
      let stillThere = false;
      for (let j = 0; j < curProps.length; j++) {
        if (curProps[j].id === oldP.id) stillThere = true;
      }
      if (!stillThere && Math.abs(oldP.x - me.x) > 80) {
        const dirToMe = me.x >= oldP.x ? 1 : -1;
        P.phantomPropProj = { spawnTick: tick, x0: oldP.x + dirToMe * 60, vx: dirToMe * 13 };
      }
    }
  }
  if (P.phantomPropProj && tick - P.phantomPropProj.spawnTick > lag + 2) {
    P.phantomPropProj = null;
  }

  // 4. FORWARD EXTRAPOLATE OPPONENT FROM (T - lag) -> T
  let predX = op.x;
  let predY = op.y;
  let predVx = op.vx;
  let predVy = op.vy;
  let predState = op.state;
  let predPosture = op.posture;
  let predAirborne = op.airborne;
  let predInvuln = op.invulnerable;
  let predMove = null;
  let openTicks = 0; // Guaranteed ticks remaining RIGHT NOW where opponent cannot block or act!
  let incomingStrike = null; // { zone, ticksUntilActive, activeTicksLeft, maxDist, moveId, unblockable }
  let ghostProj = null; // Projectile spawned during the last `lag` ticks from `op.move` before `s.projectiles` sees it!

  // Start-of-round wait invulnerability
  const opDelay = startInfo && startInfo.delay ? startInfo.delay[1 - s.side] || 0 : 0;
  if (tick <= opDelay) {
    predInvuln = true;
  }

  // Track wakeup from delayed sight too
  const inWakeChain = op.state === 'knockdown' || op.state === 'getup' || op.state === 'hitstun' || op.state === 'blockstun';
  if (inWakeChain) {
    let rem = Math.max(0, op.stateLength - op.stateTicks);
    if (op.state === 'knockdown') rem += 20; // + getup
    const wakeAt = (tick - lag) + rem;
    if (wakeAt > P.opFreeAtEst) P.opFreeAtEst = wakeAt;
    if (op.state === 'knockdown' || op.state === 'getup') P.opWakeTick = wakeAt;
  }

  if (op.state === 'move' && op.move) {
    const mDef = getMoveDef(op, op.move.id);
    if (mDef) {
      const seenT = op.move.t;
      const nowT = seenT + lag;
      const isStrikeMove = mDef.posture !== 'air' && mDef.segments.some((g) => g.type === 'strike');
      let lastStrikeEnd = 0;
      for (let i = 0; i < mDef.segments.length; i++) {
        if (mDef.segments[i].type === 'strike') lastStrikeEnd = mDef.segments[i].activeEnd;
      }
      // Did any strike of this move touch us? If active frames already passed without hurting/blocking us, +8 WHIFF_EXTRA is guaranteed!
      const moveStartApprox = (tick - lag) - seenT;
      const touchedUs = P.lastMyHurtOrBlockTick >= moveStartApprox - 2;
      const whiffBonus = isStrikeMove && !touchedUs && nowT >= lastStrikeEnd ? WHIFF_EXTRA : 0;
      const totalDur = Math.max(op.move.duration, mDef.duration + whiffBonus);

      // Advance position for advancing moves (`rush`, `slide`, `cyclone`, `knee`, `ram`, `rampage`)
      for (let i = 0; i < mDef.segments.length; i++) {
        const seg = mDef.segments[i];
        if (seg.type === 'strike' && seg.advance) {
          const a0 = Math.max(seg.start, seenT);
          const a1 = Math.min(seg.activeStart, nowT);
          if (a1 > a0) {
            const step = (seg.advance * (a1 - a0)) / Math.max(1, seg.activeStart - seg.start);
            predX = clamp(predX + op.facing * step, STAGE_LEFT, STAGE_RIGHT);
          }
        } else if (seg.type === 'teleport') {
          if (seenT < seg.activeStart && nowT >= seg.activeStart) {
            if (seg.to === 'behind') {
              let tx = me.x + op.facing * 90;
              if (tx < STAGE_LEFT || tx > STAGE_RIGHT) tx = me.x - op.facing * 90;
              predX = clamp(tx, STAGE_LEFT, STAGE_RIGHT);
            } else {
              const dir = seg.to === 'forward' ? op.facing : -op.facing;
              predX = clamp(predX + dir * (seg.distance || 300), STAGE_LEFT, STAGE_RIGHT);
            }
          }
        }
      }

      if (nowT < totalDur) {
        predState = 'move';
        predMove = { id: mDef.id, t: nowT, totalDur, armorLeft: nowT < mDef.firstActive ? op.move.armorLeft : 0, def: mDef };
        predInvuln = (mDef.slot === 'super' && nowT < mDef.firstActive);

        // Check upcoming or currently active segments (AND projectiles spawned in the last `lag` ticks!)
        let allActiveDone = true;
        for (let i = 0; i < mDef.segments.length; i++) {
          const seg = mDef.segments[i];
          if (seg.type === 'projectile' && seenT < seg.activeStart && nowT >= seg.activeStart - 4) {
            const pSpd = PROJ_SPEED[seg.speed] || 9;
            const age = nowT - seg.activeStart; // >= 0 means already in flight; < 0 means spawns in -age ticks
            const x0 = op.x + op.facing * 60;
            const nowPx = age >= 0 ? x0 + op.facing * pSpd * age : x0;
            const waitSpawn = age < 0 ? -age : 0;
            ghostProj = { x: nowPx, vx: op.facing * pSpd, zone: seg.zone, damage: seg.damage, hitsLeft: seg.hits || 1, waitSpawn };
          }
          if (nowT < seg.activeEnd) {
            allActiveDone = false;
            if (seg.type === 'strike') {
              const until = Math.max(0, seg.activeStart - nowT);
              const left = seg.activeEnd - Math.max(nowT, seg.activeStart);
              // Remaining advance before activeStart
              let remAdv = 0;
              if (seg.advance && nowT < seg.activeStart) {
                const fromT = Math.max(seg.start, nowT);
                remAdv = (seg.advance * (seg.activeStart - fromT)) / Math.max(1, seg.activeStart - seg.start);
              }
              const maxDist = 35 + (REACH_PX[seg.reach] || 95) + 40 + remAdv;
              if (!incomingStrike || until < incomingStrike.ticksUntilActive) {
                incomingStrike = {
                  moveId: mDef.id,
                  zone: seg.zone,
                  ticksUntilActive: until,
                  activeTicksLeft: left,
                  maxDist,
                  hasCharge: !!mDef.charge,
                  held: op.move.held || 0,
                  armorLeft: predMove.armorLeft,
                };
              }
            }
          }
        }
        if (allActiveDone && !predInvuln) {
          openTicks = totalDur - nowT;
        }
      } else {
        predState = 'neutral';
        predInvuln = false;
      }
    }
  } else if (op.state === 'prejump' || op.state === 'air' || op.state === 'juggle') {
    // Exact air trajectory forward simulation over `lag` ticks!
    let st = op.state;
    let stTicks = op.stateTicks;
    let x = op.x;
    let y = op.y;
    let vx = op.vx;
    let vy = op.vy;
    let landRem = 0;
    let kdRem = 0;
    for (let k = 0; k < lag; k++) {
      stTicks++;
      if (st === 'prejump') {
        if (stTicks >= PREJUMP_TICKS) {
          st = 'air';
          stTicks = 0;
          vy = JUMP_VY;
          // Approximate jumpVx if unknown: opponent derived.jumpVx
          if (vx === 0 && op.derived) vx = 0; // neutral jump if vx=0
        }
      } else if (st === 'air' || st === 'juggle') {
        vy -= GRAVITY;
        x = clamp(x + vx, STAGE_LEFT, STAGE_RIGHT);
        y += vy;
        if (y <= 0) {
          y = 0;
          vy = 0;
          vx = 0;
          if (st === 'juggle') {
            st = 'knockdown';
            stTicks = 0;
            kdRem = 44 + 20;
          } else {
            st = 'landing';
            stTicks = 0;
            landRem = LANDING_TICKS;
          }
        }
      } else if (st === 'landing') {
        landRem--;
        if (landRem <= 0) st = 'neutral';
      } else if (st === 'knockdown') {
        kdRem--;
        if (kdRem <= 0) st = 'neutral';
      }
    }
    predX = x;
    predY = y;
    predVx = vx;
    predVy = vy;
    predState = st;
    predAirborne = (st === 'air' || st === 'juggle' || y > 0);
    predInvuln = (st === 'knockdown');
    if (st === 'landing') openTicks = Math.max(openTicks, landRem);
  } else if (op.state === 'dash') {
    const rem = op.stateLength - (op.stateTicks + lag);
    const dir = op.vx >= 0 ? 1 : -1;
    const totalDist = Math.abs(op.vx) > 0 ? (op.stateLength === DASH_TICKS ? (op.derived ? op.derived.dashDistance : 198) : BACKDASH_DIST) : 160;
    const k0 = Math.min(1, op.stateTicks / op.stateLength);
    const k1 = Math.min(1, (op.stateTicks + lag) / op.stateLength);
    const ease = (u) => 1 - (1 - u) * (1 - u);
    predX = clamp(op.x + dir * totalDist * (ease(k1) - ease(k0)), STAGE_LEFT, STAGE_RIGHT);
    predState = rem > 0 ? 'dash' : 'neutral';
    predInvuln = false;
  } else if (op.state === 'throw' || op.state === 'parry' || op.state === 'staggered' || op.state === 'dizzy' || op.state === 'use') {
    const rem = op.stateLength - (op.stateTicks + lag);
    if (rem > 0) {
      predState = op.state;
      openTicks = Math.max(openTicks, rem);
      predInvuln = false;
    } else {
      predState = 'neutral';
      predInvuln = false;
    }
  } else if (op.state === 'knockdown' || op.state === 'getup') {
    const total = op.state === 'knockdown' ? (44 - op.stateTicks) + 20 : (20 - op.stateTicks);
    const rem = total - lag;
    if (rem > 0) {
      predState = rem > 20 ? 'knockdown' : 'getup';
      predInvuln = true;
    } else {
      predState = 'neutral';
      predInvuln = false;
    }
  } else if (op.state === 'neutral') {
    // Extrapolate partial walk (damped by 0.65 since opponent may stop walking)
    predX = clamp(op.x + op.vx * (lag * 0.65), STAGE_LEFT, STAGE_RIGHT);
  }

  // Override with ZERO-DELAY truths when fresh!
  if (tick - P.teleportAlertTick <= lag) {
    predX = clamp(me.x + me.facing * 90, STAGE_LEFT, STAGE_RIGHT);
    predAirborne = false;
    predY = 0;
  }
  // Pushbox clamp: if live opponent is in front of `me.facing`, they cannot be closer than 70 on ground
  if (!me.airborne && !predAirborne) {
    if (me.facing > 0 && predX < me.x + PUSH_WIDTH - 5 && op.x > me.x) predX = me.x + PUSH_WIDTH;
    if (me.facing < 0 && predX > me.x - PUSH_WIDTH + 5 && op.x < me.x) predX = me.x - PUSH_WIDTH;
  }

  if (P.opLockedUntil >= tick && tick - P.lastConnectTick < lag) {
    // Apply zero-delay knockback push to predX until delayed sight (`tick - lastConnectTick >= lag`) catches up!
    if (P.opKnockback > 0) {
      predX = clamp(predX + me.facing * P.opKnockback, STAGE_LEFT, STAGE_RIGHT);
    }
    const lockRem = P.opLockedUntil - tick + 1;
    if (P.opLockType === 'hitstun' || P.opLockType === 'staggered') {
      predState = P.opLockType;
      openTicks = Math.max(openTicks, lockRem);
      predInvuln = false;
      // Crucial: if we just parried/hit/crushed them at zero delay, their delayed `incomingStrike` was CANCELLED!
      incomingStrike = null;
      predMove = null;
    } else if (P.opLockType === 'juggle') {
      incomingStrike = null;
      predMove = null;
      if (tick <= P.opJuggleLandTick) {
        predState = 'juggle';
        predAirborne = true;
        openTicks = Math.max(openTicks, P.opJuggleLandTick - tick);
      } else {
        predState = 'knockdown';
        predInvuln = true;
      }
    } else if (P.opLockType === 'blockstun') {
      predState = 'blockstun';
    }
  }

  // 5. EXTRAPOLATE ENEMY PROJECTILES TO CURRENT TICK T
  const threats = [];
  const projs = s.projectiles || [];
  for (let i = 0; i < projs.length; i++) {
    const p = projs[i];
    if (p.mine) continue;
    const nowPx = p.x + p.vx * lag;
    const dx = me.x - nowPx;
    // Moving toward me or overlapping me?
    if ((dx * p.vx < 0) && Math.abs(dx) > 65) continue;
    const edgeDist = Math.abs(dx) - (PROJ_HALF + 38);
    const speed = Math.max(1, Math.abs(p.vx));
    const ticksToHit = edgeDist <= 0 ? 0 : Math.ceil(edgeDist / speed);
    if (ticksToHit <= 45) {
      threats.push({
        x: nowPx,
        vx: p.vx,
        zone: p.zone,
        damage: p.damage,
        hitsLeft: p.hitsLeft || 1,
        ticksToHit,
      });
    }
  }
  if (ghostProj) {
    const dx = me.x - ghostProj.x;
    if (dx * ghostProj.vx >= 0 || Math.abs(dx) <= 70) {
      const edgeDist = Math.abs(dx) - (PROJ_HALF + 40);
      const speed = Math.max(1, Math.abs(ghostProj.vx));
      const ticksToHit = ghostProj.waitSpawn + (edgeDist <= 0 ? 0 : Math.ceil(edgeDist / speed));
      if (ticksToHit <= 45) {
        threats.push({
          x: ghostProj.x,
          vx: ghostProj.vx,
          zone: ghostProj.zone,
          damage: ghostProj.damage,
          hitsLeft: ghostProj.hitsLeft,
          ticksToHit,
        });
      }
    }
  }
  if (P.phantomPropProj) {
    const dt = tick - P.phantomPropProj.spawnTick;
    const nowPx = P.phantomPropProj.x0 + P.phantomPropProj.vx * dt;
    const dx = me.x - nowPx;
    if (dx * P.phantomPropProj.vx >= 0 || Math.abs(dx) <= 65) {
      const edgeDist = Math.abs(dx) - (PROJ_HALF + 38);
      const ticksToHit = edgeDist <= 0 ? 0 : Math.ceil(edgeDist / 13);
      threats.push({ x: nowPx, vx: P.phantomPropProj.vx, zone: 'mid', damage: 80, hitsLeft: 1, ticksToHit });
    }
  }
  threats.sort((a, b) => a.ticksToHit - b.ticksToHit);

  // Save state for next tick
  P.lastTick = tick;
  P.prevMeter = me.meter;
  P.prevHp = me.hp;
  P.prevFacing = me.facing;
  P.prevMeX = me.x;
  P.prevMeState = me.state;
  P.prevMeStateTicks = me.stateTicks;
  P.prevMoveId = me.move ? me.move.id : null;
  P.prevProjOut = !!me.projectileOut;
  P.prevStaleSnap = staleNow;
  P.prevProps = curProps.map((o) => ({ id: o.id, x: o.x }));

  const predDist = Math.abs(predX - me.x);
  const rawDist = s.distance;
  // Conservative distance for guaranteeing OUR attacks connect: max(predDist, min(rawDist, predDist + 24)) unless locked!
  const confirmDist = (openTicks > 0 || predState === 'hitstun' || predState === 'blockstun' || predState === 'juggle' || tick - P.teleportAlertTick <= lag)
    ? predDist
    : Math.max(predDist, Math.min(rawDist, predDist + 18));

  const throwProtected = (tick - P.opFreeAtEst) < 6 || predInvuln || predAirborne;

  return {
    predX,
    predY,
    predVx,
    predVy,
    predState,
    predPosture,
    predAirborne,
    predInvuln,
    predMove,
    predDist,
    rawDist,
    confirmDist,
    openTicks,
    incomingStrike,
    projThreats: threats,
    throwProtected,
    justTeleported: (tick - P.teleportAlertTick) <= 8,
    teleportTicksAgo: tick - P.teleportAlertTick,
    teleportSuspectSuper: P.teleportSuspectSuper,
    justHitMove: (tick - P.lastConnectTick) <= 16 && P.lastConnectKind === 'hit' ? P.lastConnectMove : null,
    justHitCounter: P.lastConnectCounter,
    justBlockedMove: (tick - P.lastConnectTick) <= 20 && P.lastConnectKind === 'block' ? P.lastConnectMove : null,
    wakeTick: P.opWakeTick,
    opJuggleLandTick: P.opJuggleLandTick,
  };
}
