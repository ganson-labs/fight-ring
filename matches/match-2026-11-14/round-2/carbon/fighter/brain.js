// Мозги КАЙРОСА — Архитектора Времени (Адаптация под новые правила серий ринга: COMBO_LIMIT=5, COMBO_GRACE_TICKS=4).
// Точный контроль счётчика серии `opponent.combo` (маршруты 1+3=4 и 3+1=4 без дарения сопернику 30 тиков неуязвимости),
// выдержка 4 тиков сброса серии с чтением первого хода соперника и мгновенным вскрытием,
// полный иммунитет к шахматным связкам (queen/rook/pawn/mate/castle) и использование собственной неуязвимости comboLimit.

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
    opNeutralTicks: 0,
    myInvulnLeft: 0,
    prevMyInvuln: false,
    opStartupParries: 0,
    myNormalAttempts: 0,
    opTechs: 0,
    myGrabs: 0,
  };
}

let mem = createMemory();

function resetRound() {
  mem.lockCasts = 0;
  mem.lastLockTick = -999;
  mem.lastRawThrowTick = -999;
  mem.prevMyMove = null;
  mem.prevOpState = 'neutral';
  mem.opNeutralTicks = 0;
  mem.myInvulnLeft = 0;
  mem.prevMyInvuln = false;
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

// Estimate whether a single hit of `baseDmg` (or super) will finish `op` even with combo scaling
function willKill(op, baseDmg, isSuper = false) {
  const scale = Math.pow(0.8, Math.max(0, op.combo || 0));
  const est = Math.floor(baseDmg * (op.derived?.takenMul || 1) * scale * (isSuper ? 9 : 1));
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
    const canCleave = !(cd.phase_cleave > 0);
    const canOrb = !(cd.aegis_orb > 0);
    const canLock = !(cd.chrono_lock > 0);
    const hasSuper = me.meter >= 300 || me.bars >= 3;

    // Track our own actionable invulnerability ticks (from comboLimit = 30 ticks after hitstun)
    if (me.invulnerable && me.state === 'neutral') {
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

    // Track how many ticks opponent has been out of stun (for 4-tick comboClear grace window)
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

    // Track opponent parry / tech habits
    if (me.state === 'move' && me.move) {
      if (mem.prevMyMove !== me.move.id && me.move.slot === 'normal') {
        mem.myNormalAttempts++;
      }
      if (me.move.phase === 'startup' && op.state === 'parry' && mem.prevOpState !== 'parry') {
        mem.opStartupParries++;
      }
      mem.prevMyMove = me.move.id;
    } else {
      mem.prevMyMove = null;
    }
    if (op.state === 'grabbed' && mem.prevOpState !== 'grabbed') {
      mem.myGrabs++;
    }
    if (op.state === 'techBreak' && mem.prevOpState !== 'techBreak') {
      mem.opTechs++;
    }
    mem.prevOpState = op.state;

    const opParryGod =
      mem.opStartupParries >= 1 &&
      mem.opStartupParries >= Math.max(1, mem.myNormalAttempts * 0.35);

    // Inspect enemy objects (pins: queen, rook, pawn, mate, traps, etc.)
    let activeQueen = false;
    let activeRook = false;
    let fallingMate = null;
    let closeHazard = null;

    if (Array.isArray(state.objects)) {
      for (const o of state.objects) {
        if (o.mine) continue;
        if (o.move === 'queen' && o.y > 132) activeQueen = true;
        else if (o.move === 'rook' && o.y > 132) activeRook = true;
        else if (o.move === 'mate' && o.y > 90 && Math.abs(o.x - me.x) < 125) {
          fallingMate = o;
        } else if (o.touch && o.touch.damage > 0) {
          const reachX = (o.w || 60) * 0.5 + 48;
          const nextDx = Math.abs(o.x + (o.vx || 0) - me.x);
          if (nextDx <= reachX + Math.abs(o.vx || 0) * 3 && o.y < 320) {
            closeHazard = o;
          }
        }
      }
    }

    // 1. Always tech throws immediately when grabbed
    if (me.state === 'grabbed') {
      return { tech: true, throw: true };
    }

    // 2. Maintain active guard during blockstun so guard persists across toNeutral()!
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

    // 3. Hold charge if ever applicable
    if (me.state === 'move') {
      return { hold: false };
    }

    // 4. Air combat
    if (me.airborne) {
      if (me.canAirMove && dist <= 185 && Math.abs(me.y - op.y) < 165 && !op.invulnerable) {
        return { attack: 'air_crescent' };
      }
      return {};
    }

    if (!me.canAct) {
      return { guard: 'high' };
    }

    // =========================================================================
    // 5. GOD-MODE COUNTER-OFFENSE WHEN WE HAVE COMBO-LIMIT INVULNERABILITY!
    // =========================================================================
    // When opponent triggered comboLimit on us, we are actionable AND invulnerable for 30 ticks!
    // Enemy strikes, throws, queen/rook/pawn, and mate CANNOT hit us — counter-attack immediately!
    if (me.invulnerable && mem.myInvulnLeft >= 7 && !op.invulnerable) {
      if (hasSuper && op.combo <= 1 && dist <= 585) {
        return { attack: 'zero_meridian' };
      }
      if (canCleave && op.combo <= 3 && dist <= 585) {
        return { attack: 'phase_cleave' };
      }
      if (op.combo <= 1 && dist <= 212 && !op.guard) {
        return { attack: 'horizon_launch' };
      }
      if (dist <= 126 && op.guard) {
        return { throw: true };
      }
      if (dist > 110) {
        return { walk: 1 };
      }
    }

    // =========================================================================
    // 6. WHEN OPPONENT HAS INVULNERABILITY (e.g. comboLimit / wakeup / super startup):
    // =========================================================================
    // Never whiff cooldowns or normals into an invulnerable opponent! Defend & space cleanly!
    if (op.invulnerable && op.state !== 'knockdown' && op.state !== 'getup') {
      if (fallingMate) {
        const dxMate = Math.abs(fallingMate.x - me.x);
        if (dxMate < 90 && fallingMate.y <= 315 && fallingMate.y >= 135) {
          return { parry: true, walk: 0 };
        }
        return { guard: 'high', walk: -1 };
      }
      // If opponent is swinging a strike while invulnerable, parry or block it!
      if (op.state === 'move' && op.move) {
        const info = mem.moveDB[op.move.id];
        const seg = info?.segs?.[0];
        if (seg && seg.type === 'strike') {
          const tta = seg.activeStart - op.move.t;
          if (!seg.unblockable && tta >= 0 && tta <= 4 && dist <= seg.reach - 2) {
            return { parry: true, walk: 0, say: pickSay(state, 'other_parry') };
          }
          return { guard: guardForZone(seg.zone, op.posture), walk: -1 };
        }
      }
      if (dist < 145 && !activeRook && !activeQueen) {
        return { dash: 'back' };
      }
      return { guard: op.posture === 'crouch' ? 'low' : 'high', walk: -1 };
    }

    // =========================================================================
    // 7. INCOMING PROJECTILES & FALLING SUPER / OBJECT DEFENCE
    // =========================================================================
    if (fallingMate) {
      if (hasSuper && op.combo <= 1 && dist <= 585) {
        return { attack: 'zero_meridian' };
      }
      const dxMate = Math.abs(fallingMate.x - me.x);
      if (dxMate < 90 && fallingMate.y <= 315 && fallingMate.y >= 135) {
        return { parry: true, walk: 0 };
      }
      if (!activeRook && dxMate < 105 && fallingMate.y > 315) {
        const awayFromMate = (me.x - fallingMate.x) * me.facing >= 0 ? 1 : -1;
        if (awayFromMate < 0) return { dash: 'back' };
        return { walk: 1, guard: 'high' };
      }
      return { guard: 'high', walk: 0 };
    }

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
          if (canOrb && eta >= 6 && dist > 230) {
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
    // 8. COMBO-SMART PUNISH & SERIES ENGINE (ROUTES: 1+3=4 AND 3+1=4, NEVER 5!)
    // =========================================================================
    // Check if opponent is frozen by our chrono_lock
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
      if (!op.guard && op.combo <= 1) {
        if (dist <= 212 && opStopLeft >= 6) {
          return { attack: 'horizon_launch' };
        }
        if (dist > 212 && canCleave && dist <= 585) {
          return { attack: 'phase_cleave' };
        }
        return { walk: 1 };
      }
      if (op.guard && canCleave && op.combo <= 3 && dist <= 585 && opStopLeft >= 5) {
        return { attack: 'phase_cleave' };
      }
      // Throw NEVER triggers comboLimit and sets op.combo = 1 for 458 unscaled HP!
      if (opStopLeft >= 20 && dist <= 129) {
        return { throw: true };
      }
      if (opStopLeft >= 21 && dist <= 145) {
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

      // 8a. Lethal KO override: if Super or hit kills right now, finish the round immediately!
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

      // 8b. True-combo extensions while opponent is in hitstun / dizzy / staggered WITHOUT hitting combo 5!
      if ((op.state === 'hitstun' || op.state === 'dizzy' || op.state === 'staggered') && !op.invulnerable) {
        // op.combo <= 1 (e.g. after phase_cleave, aegis_orb, Super, dizzy, or parry stagger):
        // Land 3-hit horizon_launch (`1 + 3 = 4 < 5`!) as a true combo or 0-gap meaty!
        if (op.combo <= 1) {
          if ((op.state === 'dizzy' || op.state === 'staggered') && rem >= 6 && dist <= 212) {
            return { attack: 'horizon_launch', say: pickSay(state, 'hit_1') };
          }
          if (op.state === 'hitstun' && rem >= 6 && rem <= 16 && dist <= 212) {
            return { attack: 'horizon_launch' };
          }
          if (rem === 5 && dist <= 215) {
            return { attack: 'horizon_launch' };
          }
          if (rem === 4 && dist > 215 && canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        }
        // op.combo === 3 (after raw 3-hit horizon_launch!):
        // Land 1-hit 80-dmg low_sweep (`3 + 1 = 4 < 5`!) inside the 23-tick hitstun!
        else if (op.combo === 3) {
          if (rem >= 11 && dist <= 122) {
            return { crouch: true, attack: 'low_sweep' };
          }
          if (rem >= 5 && canCleave && dist > 130 && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        }
        // op.combo === 2: single 80-dmg hit brings combo to 3!
        else if (op.combo === 2) {
          if (rem >= 11 && dist <= 122) {
            return { crouch: true, attack: 'low_sweep' };
          }
          if (rem >= 5 && canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        }
        // op.combo >= 4: DO NOT HIT #5 unless it kills!
        else if (op.combo >= 4) {
          if (willKill(op, 80, false) && rem >= 6 && dist <= 212) {
            return { attack: 'horizon_launch' };
          }
          // Hold crisp spacing at ~122u with high guard ready to read op's T_1 wakeup and reset on T_4!
          if (dist > 128) return { walk: 1 };
          if (dist < 105) return { guard: 'high', walk: -1 };
          return { guard: 'high', walk: 0 };
        }
      }

      // 8c. Wakeup from knockdown/getup (op.combo resets 4 ticks after getup ends if > 0; after throw op.combo is 1!):
      if (op.state === 'knockdown' || op.state === 'getup') {
        if (op.combo <= 1) {
          if (rem === 5 && dist <= 215) {
            return { attack: 'horizon_launch' };
          }
          if (rem === 4 && canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        }
      }

      // Positioning while waiting inside locked state:
      if (op.combo >= 4) {
        if (dist > 128) return { walk: 1 };
        return { guard: 'high', walk: 0 };
      }
      if (dist > 240 && rem >= 16 && !activeRook && !activeQueen) {
        return { dash: 'forward' };
      }
      if (dist > 100) {
        return { walk: 1 };
      }
      return { guard: activeQueen ? 'high' : null, walk: 0 };
    }

    // =========================================================================
    // 9. 4-TICK COMBO-RESET WINDOW (op just left hitstun with op.combo >= 2..4!)
    // =========================================================================
    // In sim.js, op.combo resets to 0 on the 4th neutral tick (`comboClear: 4 -> 0` inside advance()).
    // Wait on tick 1 of op's neutral (`opNeutralTicks <= 1`) with guard up to observe op's reaction,
    // then fire a 4f/5f starter so it lands right as `op.combo` hits 0!
    if (op.combo >= 2 && !willKill(op, 48, false)) {
      // If op swung a strike during the grace window, parry it (parry does NOT hit comboLimit and gives +20 meter + 24t stagger at combo=0!)
      if (op.state === 'move' && op.move) {
        const info = mem.moveDB[op.move.id];
        const seg = info?.segs?.[0];
        if (seg && seg.type === 'strike') {
          const tta = seg.activeStart - op.move.t;
          if (!seg.unblockable && tta >= 0 && tta <= 4 && dist <= seg.reach - 2) {
            return { parry: true, walk: 0, say: pickSay(state, 'other_parry') };
          }
        }
      }
      // Once opNeutralTicks >= 1 (so a 4f startup move lands on tick 4+ when op.combo === 0!):
      if (mem.opNeutralTicks >= 1 && !activeQueen) {
        if (hasSuper && dist <= 585) {
          return { attack: 'zero_meridian' };
        }
        if (canCleave && dist <= 585) {
          return { attack: 'phase_cleave' };
        }
        if (
          canLock &&
          state.tick >= 62 &&
          mem.lockCasts < 3 &&
          state.tick - mem.lastLockTick >= 365 &&
          dist <= 225
        ) {
          mem.lockCasts++;
          mem.lastLockTick = state.tick;
          return { attack: 'chrono_lock' };
        }
        // Throw NEVER triggers comboLimit even if it grabs early!
        if (dist <= 126 && (op.guard || op.state === 'parry' || mem.opNeutralTicks >= 2)) {
          mem.lastRawThrowTick = state.tick;
          return { throw: true };
        }
      }
      // On opNeutralTicks === 0..1 when specials are cooling down, hold guard and let op.combo drop to 0!
      return { guard: op.posture === 'crouch' ? 'low' : 'high', walk: 0 };
    }

    // Opponent is airborne / juggling
    if (op.airborne) {
      if (op.state === 'juggle') {
        if (dist > 115) return { walk: 1 };
        return { walk: 0 };
      }
      if (hasSuper && op.combo === 0 && dist <= 520 && !op.invulnerable) {
        return { attack: 'zero_meridian' };
      }
      if (canCleave && op.combo <= 3 && dist <= 520 && !op.invulnerable && !activeQueen) {
        return { attack: 'phase_cleave' };
      }
      if (dist <= 165) {
        return { parry: op.state === 'move' && op.y < 190, guard: 'high', walk: 0 };
      }
      return { guard: 'high', walk: -1 };
    }

    // =========================================================================
    // 10. ROUND-START ANTI-PIN BAIT (TICKS 1..6)
    // =========================================================================
    if (state.tick <= 6 && mem.hasFastPin) {
      if (state.tick === 1 || activeQueen) {
        return { guard: 'high', walk: 0 };
      }
      if (op.state === 'move' && op.move) {
        const info = mem.moveDB[op.move.id];
        const fa = info ? info.firstActive : 4;
        if (op.move.t < fa) {
          return { guard: 'high', walk: 0 };
        }
        if (canCleave && dist <= 585) {
          return { attack: 'phase_cleave', say: pickSay(state, 'intro_1') };
        }
      } else if (canCleave && dist <= 585) {
        return { attack: 'phase_cleave', say: pickSay(state, 'intro_1') };
      }
    }

    // Clear active floating Queen pin safely into high guard before attacking
    if (activeQueen && op.state !== 'staggered' && op.state !== 'dizzy') {
      return { guard: 'high', walk: 0 };
    }

    // =========================================================================
    // 11. OPPONENT IN PARRY / WHIFF / TELEPORT / MOVE REACTION
    // =========================================================================
    if (op.state === 'parry') {
      if (op.stateTicks > 6) {
        if (hasSuper && dist <= 585) return { attack: 'zero_meridian' };
        if (dist <= 212) return { attack: 'horizon_launch', say: pickSay(state, 'other_parry') };
        if (canCleave && dist <= 585) return { attack: 'phase_cleave' };
        return { walk: 1 };
      }
      if (dist <= 128) return { throw: true };
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
        if (recLeft >= 6 && dist <= 212) {
          return { attack: 'horizon_launch' };
        }
        if (recLeft >= 5 && canCleave && dist <= 585) {
          return { attack: 'phase_cleave' };
        }
        if (recLeft === 5 && dist <= 215) {
          return { attack: 'horizon_launch' };
        }
      } else {
        const ticksToActive = curSeg.activeStart - m.t;
        const isCharging = !!(info.charge && m.held > 0 && m.t === curSeg.activeStart - 1);
        const effReach = Math.max(curSeg.reach, info.learnedReach || 0);

        if (curSeg.type === 'strike') {
          if (ticksToActive >= 6 && m.armorLeft === 0 && !isCharging) {
            if (canCleave && dist <= 585) {
              return { attack: 'phase_cleave' };
            }
            if (dist <= 212) {
              return { attack: 'horizon_launch' };
            }
          }
          if (
            !curSeg.unblockable &&
            !isCharging &&
            ticksToActive >= 0 &&
            ticksToActive <= 4 &&
            dist <= effReach - 2
          ) {
            return { parry: true, walk: 0, say: pickSay(state, 'other_parry') };
          }
          if (dist <= effReach + 25) {
            return { guard: guardForZone(curSeg.zone, op.posture), walk: 0 };
          }
          if (dist <= 214 && m.armorLeft === 0) {
            return { attack: 'horizon_launch' };
          }
          if (canCleave && dist <= 585) {
            return { attack: 'phase_cleave' };
          }
        } else if (curSeg.type === 'ability') {
          if (hasSuper && dist <= 585 && m.slot !== 'super') {
            return { attack: 'zero_meridian' };
          }
          if (ticksToActive >= 5 && canCleave && dist <= 585 && m.slot !== 'super') {
            return { attack: 'phase_cleave' };
          }
          if (ticksToActive >= 0 && ticksToActive <= 4 && dist <= effReach) {
            return { guard: 'high', walk: 0 };
          }
        }
      }
    }

    // =========================================================================
    // 12. PROACTIVE NEUTRAL OFFENSE (op.combo <= 1)
    // =========================================================================
    if (hasSuper && op.combo === 0 && dist <= 585 && !op.invulnerable) {
      return { attack: 'zero_meridian' };
    }

    if (canCleave && dist <= 585 && !op.invulnerable) {
      return { attack: 'phase_cleave', say: state.tick < 20 ? pickSay(state, 'intro_2') : null };
    }

    if (
      canLock &&
      state.tick >= 62 &&
      mem.lockCasts < 3 &&
      state.tick - mem.lastLockTick >= 365 &&
      dist <= 225 &&
      !op.invulnerable
    ) {
      mem.lockCasts++;
      mem.lastLockTick = state.tick;
      return { attack: 'chrono_lock' };
    }

    const myOrbs = Array.isArray(state.objects)
      ? state.objects.filter((o) => o.mine && o.label === 'ЭГИДА').length
      : 0;
    if (canOrb && myOrbs === 0 && (dist >= 160 || op.guard || opParryGod) && !op.invulnerable) {
      return { attack: 'aegis_orb', say: pickSay(state, 'other_orb') };
    }

    if (dist <= 126 && (op.guard || opParryGod) && state.tick - mem.lastRawThrowTick >= 48) {
      mem.lastRawThrowTick = state.tick;
      return { throw: true };
    }

    // Crack high-guard turtles with 80-dmg low_sweep or throw when specials are cooling down!
    if (op.guard === 'high' && dist <= 122) {
      if (state.tick % 2 === 0) return { throw: true };
      return { crouch: true, attack: 'low_sweep' };
    }

    if (!opParryGod && !op.guard && dist <= 212 && !op.invulnerable) {
      return { attack: 'horizon_launch' };
    }

    if (dist > 260 && !activeRook && !activeQueen && myOrbs > 0) {
      return { dash: 'forward' };
    }
    if (dist > 108) {
      return { walk: 1 };
    }
    return { guard: op.posture === 'crouch' ? 'low' : 'high', walk: 0 };
  },
};
