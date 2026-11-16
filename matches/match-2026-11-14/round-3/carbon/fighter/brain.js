// Мозги КАЙРОСА — Раунд 3 (Контр-протокол против связок/парирований/мата Цугцванга и контроль серий COMBO_LIMIT=5).
// 1. Точный перехват авто-падений `mate` / `queen` / `rook` парированием в тик спада неуязвимости/серии (0 урона + шкала).
// 2. Бронированный `horizon_launch` (armor: 1 + charge) поглощает `pawn` без сбития и задерживает удар против `parry`,
//    пробивая соперника прямо в 18 тиков беспомощного `PARRY_WHIFF`.
// 3. Активные броски вблизи (445 урона сквозь блок и парирование без запуска comboLimit) + серии строго до 4 ударов.

const REACH_MAP = { short: 55, mid: 95, long: 150 };
const PROJ_SPEED = { slow: 6, mid: 9, medium: 9, fast: 13 };

function createMemory() {
  return {
    lastTick: -1,
    profiled: false,
    moveDB: Object.create(null),
    hasFastPin: false,
    lockCasts: 0,
    lastLockTick: -999,
    lastRawThrowTick: -999,
    prevMyMove: null,
    prevOpState: 'neutral',
    prevOpInvuln: false,
    opNeutralTicks: 0,
    myOutStunTicks: 99,
    myInvulnLeft: 0,
    prevMyInvuln: false,
    opStartupParries: 0,
    opDelayedParries: 0,
    myStrikeAttempts: 0,
    opTechs: 0,
    myGrabs: 0,
    parriedMateId: -1,
    parriedPinId: -1,
    lastPinParryTick: -999,
  };
}

let mem = createMemory();

function resetRound() {
  mem.lockCasts = 0;
  mem.lastLockTick = -999;
  mem.lastRawThrowTick = -999;
  mem.prevMyMove = null;
  mem.prevOpState = 'neutral';
  mem.prevOpInvuln = false;
  mem.opNeutralTicks = 0;
  mem.myOutStunTicks = 99;
  mem.myInvulnLeft = 0;
  mem.prevMyInvuln = false;
  mem.parriedMateId = -1;
  mem.parriedPinId = -1;
  mem.lastPinParryTick = -999;
}

function buildProfile(opMoves) {
  if (!Array.isArray(opMoves)) return;
  mem.hasFastPin = false;
  for (const m of opMoves) {
    let shiftX = 0;
    let hasTeleport = false;
    let teleportActive = -1;
    const segs = [];
    if ((m.firstActive ?? 99) <= 5 && m.ability) {
      mem.hasFastPin = true;
    }
    for (const s of m.segments || []) {
      if (s.type === 'movement') {
        if (s.kind === 'dash') shiftX += s.distance || 110;
        else if (s.kind === 'jump_forward') shiftX += 130;
        else if (s.kind === 'retreat') shiftX -= s.distance || 80;
      } else if (s.type === 'teleport') {
        hasTeleport = true;
        teleportActive = s.activeStart;
        if (s.to === 'behind') shiftX += 260;
        else if (s.to === 'forward') shiftX += s.distance || 180;
      } else if (s.type === 'strike') {
        const baseReach = 70 + (REACH_MAP[s.reach] || 95);
        const reach = Math.max(90, baseReach + Math.max(0, shiftX));
        segs.push({
          type: 'strike',
          activeStart: s.activeStart,
          activeEnd: s.activeEnd,
          end: s.end,
          zone: s.zone || 'mid',
          reach,
          hits: s.hits || 1,
          unblockable: !!s.unblockable,
        });
      } else if (s.type === 'projectile') {
        segs.push({
          type: 'projectile',
          activeStart: s.activeStart,
          activeEnd: s.activeEnd,
          end: s.end,
          zone: s.zone || 'mid',
          reach: 1800,
          speed: PROJ_SPEED[s.speed] || 9,
          unblockable: !!s.unblockable,
        });
      } else if (s.type === 'ability') {
        const meas = m.ability?.measured;
        const abilReach =
          m.slot === 'super'
            ? 680
            : meas && meas.objectTicks > 60
              ? 650
              : meas && meas.shove > 0
                ? 500
                : meas && (meas.damage > 0 || meas.control > 0)
                  ? 480
                  : 260;
        segs.push({
          type: 'ability',
          activeStart: s.activeStart,
          activeEnd: s.activeEnd,
          end: s.end,
          zone: 'mid',
          reach: abilReach,
          hasDamage: !meas || meas.damage > 0,
          hasControl: !!(meas && meas.control > 0),
          spawnsPin: !!(meas && meas.objectTicks > 60),
          unblockable: false,
        });
      }
    }
    mem.moveDB[m.id] = {
      id: m.id,
      slot: m.slot,
      posture: m.posture,
      duration: m.duration,
      firstActive: m.firstActive ?? 8,
      armor: m.armor || 0,
      charge: m.charge || null,
      hasTeleport,
      teleportActive,
      learnedReach: 0,
      segs,
    };
  }
  mem.profiled = true;
}

function guardForZone(zone, opPosture) {
  if (zone === 'low') return 'low';
  if (zone === 'overhead' || zone === 'air' || zone === 'high') return 'high';
  return opPosture === 'crouch' ? 'low' : 'high';
}

function pickSay(state, id) {
  if (!state.lines || state.me.lastLine === id) return id;
  return id;
}

function willKill(op, baseDmg, isSuper = false) {
  const scale = Math.pow(0.8, Math.max(0, op.combo || 0));
  const est = Math.floor(baseDmg * 1.04 * (op.derived?.takenMul || 1) * scale * (isSuper ? 9 : 1));
  return op.hp <= est;
}

export default {
  init() {
    mem = createMemory();
  },

  tick(state) {
    if (!state || !state.me || !state.opponent) return {};

    if (state.tick < mem.lastTick) {
      resetRound();
    }
    const tickDelta = mem.lastTick >= 0 ? Math.max(1, state.tick - mem.lastTick) : 1;
    mem.lastTick = state.tick;

    if (!mem.profiled && state.opponent.moves?.length) {
      buildProfile(state.opponent.moves);
    }

    const me = state.me;
    const op = state.opponent;
    const dist = state.distance;
    const cd = me.cooldowns || {};

    // Inspect enemy objects (mate, queen, rook, pawn, hazards)
    let fallingMate = null;
    let activeQueen = null;
    let activeRook = null;
    let activePawn = null;
    let closeHazard = null;

    if (Array.isArray(state.objects)) {
      for (const o of state.objects) {
        if (o.mine) continue;
        if (o.move === 'mate' && o.y > 142) {
          fallingMate = o;
        } else if (o.move === 'queen' && o.y > 145) {
          activeQueen = o;
        } else if (o.move === 'rook' && o.y > 145) {
          activeRook = o;
        } else if (o.move === 'pawn' && o.y > 145) {
          activePawn = o;
        } else if (o.touch && o.touch.damage > 0) {
          const reachX = (o.w || 60) * 0.5 + 48;
          const nextDx = Math.abs(o.x + (o.vx || 0) - me.x);
          if (nextDx <= reachX + Math.abs(o.vx || 0) * 3 && o.y < 320) {
            closeHazard = o;
          }
        }
      }
    }

    // Track our own actionable invulnerability ticks (from comboLimit = 30 ticks after hitstun)
    const meInStun =
      me.state === 'hitstun' ||
      me.state === 'blockstun' ||
      me.state === 'juggle' ||
      me.state === 'knockdown' ||
      me.state === 'getup' ||
      me.state === 'thrown' ||
      me.state === 'grabbed';

    if (meInStun) {
      mem.myOutStunTicks = 0;
    } else {
      mem.myOutStunTicks += tickDelta;
    }

    if (me.invulnerable && !meInStun) {
      if (!mem.prevMyInvuln) {
        mem.myInvulnLeft = 30;
      } else {
        mem.myInvulnLeft = Math.max(1, mem.myInvulnLeft - tickDelta);
      }
      mem.prevMyInvuln = true;
    } else if (!me.invulnerable) {
      mem.myInvulnLeft = 0;
      mem.prevMyInvuln = false;
    }

    // Never waste unarmored 4f specials into a live `pawn` startup-interrupt pin unless we're invulnerable!
    const pawnBlocksUnarmored = !!activePawn && !me.invulnerable;
    const canCleave = !(cd.phase_cleave > 0) && !pawnBlocksUnarmored;
    const canOrb = !(cd.aegis_orb > 0) && !pawnBlocksUnarmored;
    const canLock = !(cd.chrono_lock > 0) && !pawnBlocksUnarmored;
    const hasSuper = (me.meter >= 300 || me.bars >= 3) && !pawnBlocksUnarmored;

    // Track opponent out-of-stun ticks (for 4-tick comboClear grace window)
    const opInStun =
      op.state === 'hitstun' ||
      op.state === 'blockstun' ||
      op.state === 'juggle' ||
      op.state === 'knockdown' ||
      op.state === 'getup' ||
      op.state === 'thrown' ||
      op.state === 'grabbed';

    if (opInStun) {
      mem.opNeutralTicks = 0;
    } else if (op.combo > 0) {
      mem.opNeutralTicks += tickDelta;
    } else {
      mem.opNeutralTicks = 99;
    }

    // Track opponent parry & throw-tech habits
    if (me.state === 'move' && me.move) {
      if (mem.prevMyMove !== me.move.id && me.move.id === 'horizon_launch') {
        mem.myStrikeAttempts++;
      }
      if (me.move.phase === 'startup' && op.state === 'parry' && mem.prevOpState !== 'parry') {
        mem.opStartupParries++;
      }
      mem.prevMyMove = me.move.id;
    } else {
      if (me.state === 'staggered' && mem.prevOpState === 'parry') {
        mem.opDelayedParries++;
      }
      mem.prevMyMove = null;
    }
    if (op.state === 'grabbed' && mem.prevOpState !== 'grabbed') {
      mem.myGrabs++;
    }
    if (op.state === 'techBreak' && mem.prevOpState !== 'techBreak') {
      mem.opTechs++;
    }
    const opJustBecameVulnerable =
      (mem.prevOpInvuln && !op.invulnerable) ||
      (mem.prevOpState === 'getup' && op.state === 'neutral');
    mem.prevOpState = op.state;
    mem.prevOpInvuln = !!op.invulnerable;

    const opTechGod = mem.myGrabs >= 3 && mem.opTechs >= mem.myGrabs * 0.65;

    // How many ticks until opponent returns to neutral (when auto-drop pins/mate fire!)
    let opReadyIn = 0;
    if (op.state === 'neutral') {
      opReadyIn = 0;
    } else if (op.state === 'move' && op.move) {
      opReadyIn = Math.max(0, (op.move.duration || 11) - (op.move.t || 0));
    } else if (op.stateLength > 0) {
      opReadyIn = Math.max(0, op.stateLength - (op.stateTicks || 0));
    } else {
      opReadyIn = 10;
    }

    // =========================================================================
    // 1. THROW TECH & ACTIVE MOVE CHARGE CONTROL (PARRY-BAIT TRAP!)
    // =========================================================================
    if (me.state === 'grabbed') {
      return { tech: true, throw: true };
    }

    if (me.state === 'blockstun') {
      let g = me.guard || 'high';
      if (op.state === 'move' && op.move) {
        const info = mem.moveDB[op.move.id];
        const seg = info?.segs?.[0];
        if (seg && seg.zone === 'low') g = 'low';
        else if (seg && (seg.zone === 'overhead' || seg.zone === 'high')) g = 'high';
      } else if (op.posture === 'crouch') {
        g = 'low';
      }
      return { guard: g };
    }

    if (me.state === 'move' && me.move) {
      if (me.move.id === 'horizon_launch') {
        const held = me.move.held || 0;
        const opParryingNow = op.state === 'parry' && (op.stateTicks || 0) <= 6;
        // Hold right before active frame if opponent is in active parry window, invulnerable, or on frame-1 wakeup (to bait frame-1 wakeup parry)!
        if ((opParryingNow || op.invulnerable || opJustBecameVulnerable) && held < 11) {
          return { hold: true };
        }
        // If opponent previously delayed parry to the exact active frame, vary timing by 7 ticks on alternate swings!
        if (mem.opDelayedParries >= 1 && op.state === 'neutral' && state.tick % 2 === 0 && held < 7) {
          return { hold: true };
        }
      }
      return { hold: false };
    }

    if (me.airborne) {
      if (me.canAirMove && dist <= 155 && Math.abs(me.y - op.y) < 160 && !op.invulnerable) {
        return { attack: 'air_crescent' };
      }
      return {};
    }

    if (!me.canAct) {
      return { guard: 'high' };
    }

    // =========================================================================
    // 2. TOP-PRIORITY `MATE` SUPER AUTO-DROP DEFENCE (0 DAMAGE TAKEN!)
    // =========================================================================
    // `mate` hovers at y=470 while we are invulnerable or have combo>0, and snaps onto us the exact tick
    // `!me.invulnerable && me.combo === 0 && op.state === 'neutral'`!
    if (fallingMate) {
      // Only attack if we still have >= 15 ticks of comboLimit invulnerability so our move finishes BEFORE mate can drop!
      if (me.invulnerable && mem.myInvulnLeft >= 15 && !op.invulnerable) {
        if (canCleave && op.combo <= 3 && dist <= 585) {
          return { attack: 'phase_cleave' };
        }
        if (op.combo <= 1 && dist <= 212) {
          return { attack: 'horizon_launch' };
        }
      }
      // If we are still invulnerable with 3..14 ticks left, DO NOT start any move — position safely and get ready to parry on expiry!
      if (me.invulnerable && mem.myInvulnLeft >= 3) {
        return { walk: -1, guard: 'high' };
      }
      // Now `!me.invulnerable` or `myInvulnLeft <= 2`: as soon as our combo has cleared (or clears within 2 ticks) and op is ready, PARRY!
      const myComboClearSoon = (me.combo || 0) === 0 || mem.myOutStunTicks >= 3;
      if (myComboClearSoon && opReadyIn <= 3) {
        if (mem.parriedMateId !== fallingMate.id) {
          mem.parriedMateId = fallingMate.id;
          return { parry: true, walk: 0, say: pickSay(state, 'other_parry') };
        }
        // Fallback if R3 mate ever waited out our first parry: invulnerable backdash!
        return { dash: 'back' };
      }
      return { walk: -1, guard: 'high' };
    }

    // =========================================================================
    // 3. AUTO-DROP PARRY OF HOVERING `QUEEN` / `ROOK` WHEN INVULN EXPIRES!
    // =========================================================================
    const autoPin = activeQueen || activeRook;
    if (
      autoPin &&
      (!me.invulnerable || mem.myInvulnLeft <= 2) &&
      ((me.combo || 0) === 0 || mem.myOutStunTicks >= 3) &&
      opReadyIn <= 2 &&
      mem.parriedPinId !== autoPin.id &&
      state.tick - mem.lastPinParryTick >= 36
    ) {
      mem.parriedPinId = autoPin.id;
      mem.lastPinParryTick = state.tick;
      return { parry: true, walk: 0 };
    }

    // =========================================================================
    // 4. GOD-MODE COUNTER-OFFENSE WHEN WE HAVE COMBO-LIMIT INVULNERABILITY!
    // =========================================================================
    if (me.invulnerable && mem.myInvulnLeft >= 8 && !op.invulnerable) {
      if (hasSuper && op.combo === 0 && dist <= 585 && mem.myInvulnLeft >= 14) {
        return { attack: 'zero_meridian' };
      }
      // Throw beats parry & guard, deals 445 unscaled HP + knockdown, and never triggers comboLimit!
      if (dist <= 128 && !opTechGod && (op.guard || op.state === 'parry' || mem.opStartupParries >= 1)) {
        mem.lastRawThrowTick = state.tick;
        return { throw: true };
      }
      if (canCleave && op.combo <= 3 && dist <= 585) {
        return { attack: 'phase_cleave' };
      }
      if (op.combo <= 1 && dist <= 212) {
        return { attack: 'horizon_launch' };
      }
      if (dist > 118) {
        return { walk: 1 };
      }
    }

    // =========================================================================
    // 5. WHEN OPPONENT HAS INVULNERABILITY (comboLimit / super startup):
    // =========================================================================
    if (op.invulnerable && op.state !== 'knockdown' && op.state !== 'getup') {
      if (op.state === 'move' && op.move) {
        const info = mem.moveDB[op.move.id];
        const seg = info?.segs?.[0];
        if (seg && seg.type === 'strike') {
          const tta = seg.activeStart - op.move.t;
          if (!seg.unblockable && tta >= 0 && tta <= 5 && dist <= seg.reach + 4) {
            return { parry: true, walk: 0, say: pickSay(state, 'other_parry') };
          }
          return { guard: guardForZone(seg.zone, op.posture), walk: -1 };
        }
      }
      if (dist < 145 && !activeRook) {
        return { dash: 'back' };
      }
      return { guard: op.posture === 'crouch' ? 'low' : 'high', walk: -1 };
    }

    // =========================================================================
    // 6. PROJECTILE & TOUCH-HAZARD DEFENCE
    // =========================================================================
    if (Array.isArray(state.projectiles)) {
      for (const p of state.projectiles) {
        if (p.mine) continue;
        const dx = me.x - p.x;
        if (dx * p.vx <= 0) continue;
        const speed = Math.abs(p.vx) || 9;
        const contactDist = Math.max(0, Math.abs(dx) - 60);
        const eta = contactDist / speed;
        if (eta <= 4.5) {
          return { parry: true, walk: 0, say: me.meter >= 240 ? pickSay(state, 'other_parry') : null };
        }
        if (eta <= 13) {
          if (canOrb && eta >= 6 && dist > 220) {
            return { attack: 'aegis_orb' };
          }
          return { guard: p.zone === 'low' ? 'low' : 'high', walk: 0 };
        }
      }
    }

    if (closeHazard) {
      const hZone = closeHazard.touch?.zone || 'mid';
      const nextDx = Math.abs(closeHazard.x + (closeHazard.vx || 0) - me.x);
      if (nextDx <= (closeHazard.w || 60) * 0.5 + 42) {
        return { parry: true, walk: 0 };
      }
      return { guard: guardForZone(hZone, op.posture), walk: -1 };
    }

    // =========================================================================
    // 7. COMBO-SMART PUNISH & SERIES ENGINE (ROUTES: 1+3=4 AND 3+1=4, NEVER 5!)
    // =========================================================================
    let opStopLeft = 0;
    if (Array.isArray(op.effects)) {
      for (const e of op.effects) {
        if (e.stop && e.left > opStopLeft) opStopLeft = e.left;
      }
    }

    if (opStopLeft > 0 && !op.airborne && !op.invulnerable) {
      if (hasSuper && (op.combo === 0 || willKill(op, 250, true)) && dist <= 585 && opStopLeft >= 5) {
        return { attack: 'zero_meridian' };
      }
      if (!op.guard && op.combo <= 1 && dist <= 212 && opStopLeft >= 6) {
        return { attack: 'horizon_launch' };
      }
      if (canCleave && op.combo <= 3 && dist <= 585 && opStopLeft >= 5) {
        return { attack: 'phase_cleave' };
      }
      if (opStopLeft >= 7 && dist <= 129) {
        return { throw: true };
      }
      if (dist > 115) {
        return { walk: 1 };
      }
    }

    const lockedStates =
      op.state === 'hitstun' ||
      op.state === 'getup' ||
      op.state === 'knockdown' ||
      op.state === 'staggered' ||
      op.state === 'dizzy' ||
      op.state === 'landing' ||
      op.state === 'techBreak';

    if (lockedStates) {
      let rem = Math.max(0, (op.stateLength || 0) - (op.stateTicks || 0));
      if (op.state === 'knockdown') {
        rem += 20;
      }

      if (
        hasSuper &&
        !op.invulnerable &&
        (op.combo === 0 || willKill(op, 250, true)) &&
        (op.state === 'hitstun' || op.state === 'dizzy' || op.state === 'staggered') &&
        rem >= 5 &&
        dist <= 585
      ) {
        return { attack: 'zero_meridian' };
      }

      if ((op.state === 'hitstun' || op.state === 'dizzy' || op.state === 'staggered') && !op.invulnerable) {
        if (op.combo <= 1) {
          if ((op.state === 'dizzy' || op.state === 'staggered') && rem >= 6 && dist <= 212) {
            return { attack: 'horizon_launch', say: pickSay(state, 'hit_1') };
          }
          if (op.state === 'hitstun' && rem >= 6 && rem <= 20 && dist <= 212) {
            return { attack: 'horizon_launch' };
          }
          if (rem === 5 && dist <= 215) {
            return { attack: 'horizon_launch' };
          }
          if (rem === 4 && dist > 215 && canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        } else if (op.combo === 3) {
          if (rem >= 5 && canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
          if (rem >= 11 && dist <= 122 && !activePawn) {
            return { crouch: true, attack: 'low_sweep' };
          }
        } else if (op.combo === 2) {
          if (rem >= 5 && canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
          if (rem >= 11 && dist <= 122 && !activePawn) {
            return { crouch: true, attack: 'low_sweep' };
          }
        } else if (op.combo >= 4) {
          if (willKill(op, 69, false) && rem >= 6 && dist <= 212) {
            return { attack: 'horizon_launch' };
          }
          if (dist > 122) return { walk: 1 };
          return { guard: 'high', walk: 0 };
        }
      }

      if (op.state === 'knockdown' || op.state === 'getup') {
        if (op.combo <= 1) {
          // Mix meaty throw and meaty armored horizon_launch on opponent wakeup!
          if (rem <= 2 && dist <= 126 && !opTechGod && state.tick % 2 === 0) {
            return { throw: true };
          }
          if (rem === 5 && dist <= 215) {
            return { attack: 'horizon_launch' };
          }
          if (rem === 4 && canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        }
      }

      if (op.combo >= 4) {
        if (dist > 122) return { walk: 1 };
        return { guard: 'high', walk: 0 };
      }
      if (dist > 240 && rem >= 16 && !activeRook) {
        return { dash: 'forward' };
      }
      if (dist > 102) {
        return { walk: 1 };
      }
      return { walk: 0 };
    }

    // =========================================================================
    // 8. 4-TICK COMBO-RESET WINDOW (op just left hitstun with op.combo >= 2..4!)
    // =========================================================================
    if (op.combo >= 2 && !willKill(op, 48, false)) {
      if (op.state === 'move' && op.move) {
        const info = mem.moveDB[op.move.id];
        const seg = info?.segs?.[0];
        if (seg && seg.type === 'strike') {
          const tta = seg.activeStart - op.move.t;
          if (!seg.unblockable && tta >= 0 && tta <= 5 && dist <= seg.reach + 4) {
            return { parry: true, walk: 0, say: pickSay(state, 'other_parry') };
          }
        }
      }
      // Throw grabs immediately without triggering comboLimit and deals 445 unscaled HP!
      if (dist <= 128 && !opTechGod && (op.guard || op.state === 'parry' || mem.opNeutralTicks >= 1)) {
        mem.lastRawThrowTick = state.tick;
        return { throw: true };
      }
      if (mem.opNeutralTicks >= 1) {
        if (hasSuper && dist <= 585) {
          return { attack: 'zero_meridian' };
        }
        if (canCleave && dist <= 585) {
          return { attack: 'phase_cleave' };
        }
        if (
          canLock &&
          state.tick >= 62 &&
          mem.lockCasts < 5 &&
          state.tick - mem.lastLockTick >= 362 &&
          dist <= 220
        ) {
          mem.lockCasts++;
          mem.lastLockTick = state.tick;
          return { attack: 'chrono_lock' };
        }
        if (mem.opNeutralTicks >= 2 && dist <= 212) {
          return { attack: 'horizon_launch' };
        }
      }
      return { guard: op.posture === 'crouch' ? 'low' : 'high', walk: 0 };
    }

    if (op.airborne) {
      if (op.state === 'juggle') {
        if (dist > 115) return { walk: 1 };
        return { walk: 0 };
      }
      if (hasSuper && op.combo === 0 && dist <= 520 && !op.invulnerable) {
        return { attack: 'zero_meridian' };
      }
      if (canCleave && op.combo <= 3 && dist <= 520 && !op.invulnerable) {
        return { attack: 'phase_cleave' };
      }
      if (dist <= 165) {
        return { parry: op.state === 'move' && op.y < 190, guard: 'high', walk: 0 };
      }
      return { guard: 'high', walk: -1 };
    }

    // =========================================================================
    // 9. OPPONENT IN PARRY / THROW / TELEPORT / MOVE REACTION
    // =========================================================================
    if (op.state === 'parry') {
      if (op.stateTicks > 6) {
        if (hasSuper && dist <= 585) return { attack: 'zero_meridian' };
        if (dist <= 212) return { attack: 'horizon_launch', say: pickSay(state, 'other_parry') };
        if (canCleave && dist <= 585) return { attack: 'phase_cleave' };
        return { walk: 1 };
      }
      if (dist <= 128 && !opTechGod) {
        mem.lastRawThrowTick = state.tick;
        return { throw: true };
      }
      if (dist <= 212) {
        // horizon_launch will hold at t=4 until parry window ends, then punish PARRY_WHIFF!
        return { attack: 'horizon_launch' };
      }
      if (canCleave && dist <= 585) return { attack: 'phase_cleave' };
      return { walk: 1 };
    }

    if (op.state === 'throw') {
      if (op.stateTicks >= 8) {
        if (hasSuper && dist <= 585) return { attack: 'zero_meridian' };
        if (dist <= 212) return { attack: 'horizon_launch' };
        if (canCleave && dist <= 585) return { attack: 'phase_cleave' };
      } else if (dist <= 135 && !activeRook) {
        return { dash: 'back' };
      }
    }

    if (op.state === 'move' && op.move) {
      const m = op.move;
      const info = mem.moveDB[m.id];

      if (info && info.hasTeleport) {
        const tpTick = info.teleportActive;
        if (m.t < tpTick) {
          // Pre-spawn Aegis Orb while opponent is teleporting!
          const myOrbsNow = Array.isArray(state.objects)
            ? state.objects.filter((o) => o.mine && o.label === 'ЭГИДА').length
            : 0;
          if (canOrb && myOrbsNow === 0) {
            return { attack: 'aegis_orb' };
          }
          return { guard: 'high', walk: 0 };
        }
        if (hasSuper && dist <= 585) return { attack: 'zero_meridian' };
        if (dist <= 212) return { attack: 'horizon_launch', say: pickSay(state, 'hit_3') };
        if (canCleave && dist <= 585) return { attack: 'phase_cleave' };
      }

      let curSeg = null;
      if (info && info.segs.length) {
        for (const s of info.segs) {
          if (m.t < s.end) {
            curSeg = s;
            break;
          }
        }
      }

      if (!curSeg || m.phase === 'recovery') {
        const recLeft = (m.duration || 0) - m.t;
        if (hasSuper && recLeft >= 5 && dist <= 585) {
          return { attack: 'zero_meridian' };
        }
        if (recLeft >= 5 && dist <= 212) {
          return { attack: 'horizon_launch' };
        }
        if (recLeft >= 5 && canCleave && dist <= 585) {
          return { attack: 'phase_cleave' };
        }
      } else {
        const ticksToActive = curSeg.activeStart - m.t;
        const isCharging = !!(info.charge && m.held > 0 && m.t === curSeg.activeStart - 1);
        const effReach = Math.max(curSeg.reach, info.learnedReach || 0);

        if (curSeg.type === 'strike') {
          if (
            !curSeg.unblockable &&
            !isCharging &&
            ticksToActive >= 0 &&
            ticksToActive <= 5 &&
            dist <= effReach + 8
          ) {
            return { parry: true, walk: 0, say: pickSay(state, 'other_parry') };
          }
          if (ticksToActive >= 6 && m.armorLeft === 0 && !isCharging) {
            if (dist <= 212) {
              return { attack: 'horizon_launch' };
            }
            if (canCleave && dist <= 585) {
              return { attack: 'phase_cleave' };
            }
          }
          if (dist <= effReach + 22) {
            return { guard: guardForZone(curSeg.zone, op.posture), walk: 0 };
          }
          if (dist <= 214) {
            return { attack: 'horizon_launch' };
          }
          if (canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        } else if (curSeg.type === 'ability') {
          if (hasSuper && dist <= 585 && m.slot !== 'super') {
            return { attack: 'zero_meridian' };
          }
          if (dist <= 212 && m.slot !== 'super') {
            return { attack: 'horizon_launch' };
          }
          if (ticksToActive >= 5 && canCleave && dist <= 585 && m.slot !== 'super') {
            return { attack: 'phase_cleave' };
          }
        }
      }
    }

    // =========================================================================
    // 10. PROACTIVE NEUTRAL OFFENSE (op.combo <= 1)
    // =========================================================================
    if (hasSuper && op.combo === 0 && dist <= 585 && !op.invulnerable) {
      return { attack: 'zero_meridian' };
    }

    // If enemy `pawn` is floating above, break it with armored `horizon_launch` or bypass with `throw`!
    if (pawnBlocksUnarmored) {
      if (dist <= 128 && !opTechGod && !op.invulnerable && state.tick - mem.lastRawThrowTick >= 36) {
        mem.lastRawThrowTick = state.tick;
        return { throw: true };
      }
      if (dist <= 212 && !op.invulnerable) {
        return { attack: 'horizon_launch' };
      }
      return { walk: 1 };
    }

    if (canCleave && dist <= 585 && !op.invulnerable) {
      return { attack: 'phase_cleave', say: state.tick < 20 ? pickSay(state, 'intro_2') : null };
    }

    if (
      canLock &&
      state.tick >= 62 &&
      mem.lockCasts < 5 &&
      state.tick - mem.lastLockTick >= 362 &&
      dist <= 220 &&
      !op.invulnerable
    ) {
      mem.lockCasts++;
      mem.lastLockTick = state.tick;
      return { attack: 'chrono_lock' };
    }

    const myOrbs = Array.isArray(state.objects)
      ? state.objects.filter((o) => o.mine && o.label === 'ЭГИДА').length
      : 0;
    if (canOrb && myOrbs === 0 && dist >= 95 && !op.invulnerable) {
      return { attack: 'aegis_orb', say: pickSay(state, 'other_orb') };
    }

    // Mix close-range throw (445 HP, beats guard & parry!) with armored parry-baiting horizon_launch!
    if (
      dist <= 128 &&
      !opTechGod &&
      !op.invulnerable &&
      state.tick - mem.lastRawThrowTick >= 42 &&
      (op.guard || mem.opStartupParries >= 1 || state.tick % 3 === 0)
    ) {
      mem.lastRawThrowTick = state.tick;
      return { throw: true };
    }

    if (!op.guard && dist <= 212 && !op.invulnerable) {
      return { attack: 'horizon_launch' };
    }

    if (op.guard === 'high' && dist <= 122) {
      if (!opTechGod) {
        mem.lastRawThrowTick = state.tick;
        return { throw: true };
      }
      return { crouch: true, attack: 'low_sweep' };
    }

    if (dist > 260 && !activeRook && myOrbs > 0) {
      return { dash: 'forward' };
    }
    if (dist > 112) {
      return { walk: 1 };
    }
    return { guard: op.posture === 'crouch' ? 'low' : 'high', walk: 0 };
  },
};
