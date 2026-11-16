// Мозги КАЙРОСА — Архитектора Времени.
// Профайлер приёмов соперника, расчёт стартапов/зарядов/брони,
// идеальное парирование ударов и снарядов (+20 шкалы -> Нулевой Меридиан на ~2430 урона),
// гарантированный неразрываемый бросок после Петли Безвременья и адаптация под любой архетип ИИ.

const REACH_MAP = { short: 55, mid: 95, long: 150 };
const PROJ_SPEED = { slow: 6, mid: 9, medium: 9, fast: 13 };

function createMemory() {
  return {
    lastTick: -1,
    profiled: false,
    moveDB: Object.create(null),
    lockCasts: 0,
    lastLockTick: -999,
    lastRawThrowTick: -999,
    prevMyMove: null,
    prevOpState: 'neutral',
    opStartupParries: 0,
    myNormalAttempts: 0,
    opTechs: 0,
    myGrabs: 0,
    opJumps: 0,
    tauntDone: false,
  };
}

let mem = createMemory();

function resetRound() {
  mem.lockCasts = 0;
  mem.lastLockTick = -999;
  mem.lastRawThrowTick = -999;
  mem.prevMyMove = null;
  mem.prevOpState = 'neutral';
  mem.opJumps = 0;
  mem.tauntDone = false;
}

function buildProfile(opMoves) {
  if (!Array.isArray(opMoves)) return;
  for (const m of opMoves) {
    let shiftX = 0;
    const segs = [];
    for (const s of m.segments || []) {
      if (s.type === 'movement') {
        if (s.kind === 'dash') shiftX += s.distance || 110;
        else if (s.kind === 'jump_forward') shiftX += 130;
        else if (s.kind === 'retreat') shiftX -= s.distance || 80;
      } else if (s.type === 'teleport') {
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
            : meas && meas.shove > 0
              ? 440
              : meas && (meas.damage > 0 || meas.control > 0)
                ? 330
                : 240;
        segs.push({
          type: 'ability',
          activeStart: s.activeStart,
          activeEnd: s.activeEnd,
          end: s.end,
          zone: 'any',
          reach: abilReach,
          hasDamage: !meas || meas.damage > 0,
          hasControl: !!(meas && meas.control > 0),
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
  if (!id || state.me.lastLine === id) return null;
  return id;
}

export default {
  init(ctx) {
    mem = createMemory();
    if (ctx?.view?.opponent?.moves) {
      buildProfile(ctx.view.opponent.moves);
    }
  },

  tick(state) {
    const { me, opponent: op, distance, stage } = state;

    if (mem.lastTick < 0 || state.tick < mem.lastTick) {
      resetRound();
    }
    mem.lastTick = state.tick;

    if (!mem.profiled && op.moves) {
      buildProfile(op.moves);
    }

    // 1. Мгновенный разрыв любого обычного броска соперника (100% tech)
    if (me.state === 'grabbed') {
      return { tech: true };
    }

    // Телеметрия поведения соперника
    if (op.state === 'parry' && mem.prevOpState !== 'parry') {
      if (me.state === 'move' && me.move && me.move.slot === 'normal') {
        mem.opStartupParries++;
      }
    }
    if (op.state === 'prejump' && mem.prevOpState !== 'prejump') {
      mem.opJumps++;
    }
    if (me.state === 'techBreak' && mem.prevOpState === 'grabbed') {
      mem.opTechs++;
    }
    if (op.state === 'grabbed' && mem.prevOpState !== 'grabbed' && !op.mods.stop) {
      mem.myGrabs++;
    }
    if (me.move?.id === 'chrono_lock' && mem.prevMyMove !== 'chrono_lock') {
      mem.lockCasts++;
      mem.lastLockTick = state.tick;
    }
    if (me.move && me.move.slot === 'normal' && mem.prevMyMove !== me.move.id) {
      mem.myNormalAttempts++;
    }
    if (op.move && (me.state === 'hitstun' || me.state === 'blockstun') && me.stateTicks <= 1) {
      const info = mem.moveDB[op.move.id];
      if (info && distance + 28 > info.learnedReach) {
        info.learnedReach = distance + 28;
      }
    }

    mem.prevMyMove = me.move ? me.move.id : null;
    mem.prevOpState = op.state;

    // Переключение уровня блока во время блокстана
    if (me.state === 'blockstun') {
      let g = op.posture === 'crouch' ? 'low' : 'high';
      if (op.move) {
        const info = mem.moveDB[op.move.id];
        if (info) {
          for (const s of info.segs) {
            if (op.move.t <= s.activeEnd) {
              g = guardForZone(s.zone, op.posture);
              break;
            }
          }
        }
      }
      return { guard: g, crouch: g === 'low' };
    }

    // 2. Действия в воздухе
    if (me.airborne) {
      if (me.canAirMove && !op.invulnerable) {
        const predMyX = me.x + me.vx * 10;
        const predOpX = op.x + op.vx * 10;
        if (me.vy <= 4.5 && me.y >= 26 && me.y <= 155 && Math.abs(predOpX - predMyX) <= 176) {
          return { attack: 'air_crescent' };
        }
      }
      return {};
    }

    if (!me.canAct) {
      return {};
    }

    const canOrb = !me.cooldowns.aegis_orb && !me.abilitiesOff.includes('abilities/aegis_orb.js');
    const canCleave = !me.cooldowns.phase_cleave && !me.abilitiesOff.includes('abilities/phase_cleave.js');
    const canLock =
      !me.cooldowns.chrono_lock &&
      !me.abilitiesOff.includes('abilities/chrono_lock.js') &&
      state.tick >= 64 &&
      mem.lockCasts < 3 &&
      state.tick - mem.lastLockTick >= 365;
    const canSuper = me.meter >= 300 && !me.abilitiesOff.includes('abilities/zero_meridian.js');
    const myOrbs = state.objects.filter((o) => o.mine);

    const isParryBot = mem.opStartupParries >= 2 && mem.opStartupParries >= mem.myNormalAttempts * 0.35;
    const opTechsThrows = mem.myGrabs >= 2 && mem.opTechs >= Math.ceil(mem.myGrabs * 0.65);
    const isSerialJumper = mem.opJumps >= 5 && mem.opJumps * 95 > state.tick;
    const canRawThrow =
      !opTechsThrows &&
      !op.airborne &&
      op.state !== 'prejump' &&
      !isSerialJumper &&
      state.tick - mem.lastRawThrowTick >= 72;

    const doRawThrow = () => {
      mem.lastRawThrowTick = state.tick;
      return { throw: true };
    };

    // 3. Парирование снарядов и боевых объектов (+20 шкалы за каждый!)
    let shieldBetween = false;
    for (const o of myOrbs) {
      if (o.solid && (op.x - me.x) * (o.x - me.x) > 0 && Math.abs(o.x - me.x) < distance) {
        shieldBetween = true;
      }
    }

    for (const p of state.projectiles) {
      if (p.mine || p.hitsLeft <= 0) continue;
      const dx = me.x - p.x;
      if (dx * p.vx < 0 && Math.abs(dx) > 65) continue;
      let blockedByOrb = false;
      for (const o of myOrbs) {
        if (o.solid && (o.x - p.x) * p.vx >= 0 && Math.abs(o.x - p.x) + 20 < Math.abs(dx)) {
          blockedByOrb = true;
          break;
        }
      }
      if (blockedByOrb) continue;

      const spd = Math.max(1, Math.abs(p.vx));
      const ticksToHit = Math.max(0, Math.ceil((Math.abs(dx) - 62) / spd));
      if (ticksToHit <= 2) {
        return { parry: true, say: pickSay(state, 'other_parry') };
      }
      if (ticksToHit <= 5) {
        const g = guardForZone(p.zone, 'stand');
        return { guard: g, crouch: g === 'low', walk: g === 'high' ? -1 : 0 };
      }
    }

    for (const o of state.objects) {
      if (o.mine || !o.touch) continue;
      const gapX = Math.abs(me.x - o.x) - (o.w * 0.5 + 38);
      const towards = me.x >= o.x ? o.vx : -o.vx;
      const closeSpd = Math.max(0, towards);
      const yOverlap = o.y + o.h * 0.5 >= me.y && o.y - o.h * 0.5 <= me.y + 235;
      if (yOverlap && gapX <= Math.max(18, closeSpd * 2 + 12)) {
        return { parry: true, say: pickSay(state, 'other_parry') };
      }
    }

    // 4. Реакция на бросок соперника (startup=5, active=2, whiff=28, range=130)
    if (op.state === 'throw') {
      if (op.stateTicks < 7 && distance <= 136) {
        if (op.stateTicks <= 1) return { jump: 1 };
        return { dash: 'back' };
      }
      if (op.stateTicks >= 7) {
        const rem = op.stateLength - op.stateTicks;
        if (canSuper && rem >= 8 && distance <= 605) return { attack: 'zero_meridian' };
        if (canLock && rem >= 8 && distance <= 148) return { attack: 'chrono_lock' };
        if (canRawThrow && rem >= 8 && distance <= 128) return doRawThrow();
        if (canCleave && rem >= 8 && distance <= 275) return { attack: 'phase_cleave' };
        if (rem >= 9 && distance <= 162) return { attack: 'low_sweep' };
        if (rem >= 10 && distance <= 216) return { attack: 'horizon_launch' };
        if (rem >= 6 && distance <= 162) return { attack: 'chrono_jab' };
      }
    }

    // 5. Реакция на приём соперника (контр-супер, бросок в броню, перехват, парри, вифф-паниш)
    if (op.state === 'move' && op.move) {
      const m = op.move;
      const info = mem.moveDB[m.id];
      const remTotal = m.duration - m.t;

      if (m.phase === 'recovery') {
        if (!op.invulnerable) {
          if (canSuper && remTotal >= 8 && distance <= 605 && op.combo <= 1) {
            return { attack: 'zero_meridian' };
          }
          if (canLock && remTotal >= 8 && distance <= 148) {
            return { attack: 'chrono_lock' };
          }
          if (canRawThrow && remTotal >= 8 && distance <= 128) {
            return doRawThrow();
          }
          if (canCleave && remTotal >= 8 && distance <= 280) {
            return { attack: 'phase_cleave', say: pickSay(state, 'hit_3') };
          }
          if (remTotal >= 10 && distance <= 162 && !op.airborne) {
            return { attack: 'low_sweep' };
          }
          if (remTotal >= 11 && distance <= 232) {
            return { attack: 'horizon_launch', say: pickSay(state, 'hit_2') };
          }
          if (remTotal >= 7 && distance <= 162) {
            return { attack: 'chrono_jab' };
          }
        }
      } else if (info) {
        let threat = null;
        for (const s of info.segs) {
          if (m.t < s.activeEnd) {
            threat = s;
            break;
          }
        }
        if (threat) {
          const effReach = Math.max(threat.reach, info.learnedReach);
          const ticksToActive = Math.max(0, threat.activeStart - m.t);
          const canHoldCharge =
            !!info.charge && m.t === threat.activeStart - 1 && m.held < info.charge.maxHold;

          if (
            canSuper &&
            m.slot !== 'super' &&
            !op.invulnerable &&
            m.armorLeft === 0 &&
            remTotal >= 8 &&
            distance <= 605 &&
            (op.combo === 0 || op.hp <= 1950)
          ) {
            return { attack: 'zero_meridian' };
          }

          if (m.armorLeft > 0 && distance <= 128 && ticksToActive >= 6 && !op.airborne) {
            return { throw: true };
          }

          if (
            m.slot !== 'super' &&
            m.armorLeft === 0 &&
            !op.invulnerable &&
            ticksToActive >= 5 &&
            distance <= 162 &&
            !isParryBot
          ) {
            return { attack: 'chrono_jab', say: pickSay(state, 'hit_1') };
          }

          if (distance <= effReach + 16) {
            if (canHoldCharge) {
              if (threat.unblockable && distance <= effReach + 10) {
                return { dash: 'back' };
              }
              const g = guardForZone(threat.zone, op.posture);
              return { guard: g, crouch: g === 'low', walk: g === 'high' ? -1 : 0 };
            }

            // Парируем ТОЛЬКО когда удар гарантированно дотянется до нашего хёртбокса (иначе парри уйдёт в 18-тиковый промах!)
            const sureConnect =
              threat.type === 'strike'
                ? distance <= effReach - 3
                : distance <= effReach;

            if (ticksToActive <= 2 && sureConnect) {
              if (threat.type === 'ability' && threat.hasControl && !threat.hasDamage) {
                return { dash: 'back' };
              }
              if (threat.type === 'strike' || threat.type === 'projectile' || threat.hasDamage) {
                return { parry: true, say: pickSay(state, 'other_parry') };
              }
            }

            if (ticksToActive <= 6) {
              // Если удар точно достаёт — стоим на месте в блоке (walk: 0), чтобы не выйти случайно на 2 ед. и спарировать на ticksToActive <= 2 за +20 шкалы!
              if (sureConnect && threat.type === 'strike') {
                const g = guardForZone(threat.zone, op.posture);
                return { guard: g, crouch: g === 'low', walk: 0 };
              }
              const g = guardForZone(threat.zone, op.posture);
              return { guard: g, crouch: g === 'low', walk: g === 'high' ? -1 : 0 };
            }
          } else if (threat.type === 'strike' && distance <= effReach + 75) {
            return { walk: 0 };
          }
        }
      }
    }

    // 6. Реализация остановки времени (Петля Безвременья -> 100% неразрываемый бросок ~458 HP или Супер!)
    if (op.mods.stop && !op.invulnerable) {
      let stopLeft = 0;
      for (const e of op.effects || []) {
        if (e.stop && e.left > stopLeft) stopLeft = e.left;
      }
      if (canSuper && distance <= 605 && (op.combo === 0 || op.hp <= 1950)) {
        return { attack: 'zero_meridian' };
      }
      if (!op.airborne && stopLeft >= 20) {
        if (distance <= 129) {
          return { throw: true };
        }
        const needTicks = Math.ceil((distance - 128) / 4.7);
        if (20 + needTicks <= stopLeft) {
          return { walk: 1 };
        }
      }
      if (distance <= 162 && !op.airborne) {
        return { attack: 'low_sweep' };
      }
      if (canCleave && distance <= 280) {
        return { attack: 'phase_cleave' };
      }
      if (distance <= 216) {
        return { attack: 'horizon_launch' };
      }
      return { dash: 'forward' };
    }

    // 7. Мгновенная реализация накопленного Суперприёма (~2430 урона, пробивает блок и ждёт окончания парри)
    if (canSuper && !op.invulnerable && !op.airborne && op.combo === 0 && distance <= 575) {
      return { attack: 'zero_meridian' };
    }

    // 8. Наказание беспомощных состояний (staggered после парри, dizzy, промах чужого парри)
    const parryWhiffLeft =
      op.state === 'parry' && op.stateTicks >= 6 ? op.stateLength - op.stateTicks : 0;
    const helplessLeft =
      op.state === 'staggered' || op.state === 'dizzy'
        ? op.stateLength - op.stateTicks
        : parryWhiffLeft;

    if (helplessLeft >= 6 && !op.invulnerable) {
      if (canSuper && helplessLeft >= 8 && distance <= 605 && (op.combo <= 1 || op.hp <= 1900)) {
        return { attack: 'zero_meridian' };
      }
      if (canLock && helplessLeft >= 8 && distance <= 148 && op.state !== 'dizzy') {
        return { attack: 'chrono_lock' };
      }
      if (canRawThrow && helplessLeft >= 8 && distance <= 128) {
        return doRawThrow();
      }
      if (canCleave && helplessLeft >= 8 && distance <= 280) {
        return { attack: 'phase_cleave', say: pickSay(state, 'hit_3') };
      }
      if (helplessLeft >= 10 && distance <= 162 && !op.airborne) {
        return { attack: 'low_sweep' };
      }
      if (helplessLeft >= 11 && distance <= 218) {
        return { attack: 'horizon_launch', say: pickSay(state, 'hit_2') };
      }
      if (helplessLeft >= 7 && distance <= 162) {
        return { attack: 'chrono_jab' };
      }
      if (helplessLeft >= 18 && distance > 218) {
        return { dash: 'forward' };
      }
    }

    // 9. Наземное подтверждение попаданий
    if (op.state === 'hitstun' && !op.airborne && !op.invulnerable) {
      const adv = op.stateLength - op.stateTicks;
      const superKill = op.hp <= Math.floor(2150 * Math.pow(0.8, op.combo));
      if (canSuper && adv >= 7 && distance <= 605 && (op.combo <= 1 || superKill)) {
        return { attack: 'zero_meridian' };
      }
      if (op.combo < 3) {
        if (adv >= 8 && distance <= 162) {
          return { attack: 'low_sweep' };
        }
        if (adv >= 5 && distance <= 162) {
          return { attack: 'chrono_jab' };
        }
        if (adv >= 9 && distance <= 218) {
          return { attack: 'horizon_launch', say: pickSay(state, 'hit_2') };
        }
      }
      return distance > 125 ? { walk: 1 } : { walk: 0 };
    }

    // 10. Воздушный джаггл и перехват прыгунов (anti-air)
    if ((op.state === 'juggle' || op.state === 'prejump' || (op.airborne && op.state !== 'move')) && !op.invulnerable) {
      const superKill = op.hp <= Math.floor(2100 * Math.pow(0.8, op.combo));
      if (canSuper && superKill && distance <= 600) {
        return { attack: 'zero_meridian' };
      }
      if (op.state === 'juggle' && op.combo < 4) {
        const yIn4 = op.y + op.vy * 4 - 6.8;
        const yIn8 = op.y + op.vy * 8 - 27.2;
        if (distance <= 218 && yIn8 >= 12 && yIn8 <= 172) {
          return { attack: 'horizon_launch' };
        }
        if (distance <= 162 && yIn4 >= 5 && yIn4 <= 175) {
          return { attack: 'chrono_jab' };
        }
        if (distance > 155) {
          return distance > 270 && op.y > 75 ? { dash: 'forward' } : { walk: 1 };
        }
        return { walk: 0 };
      }
      if (op.state !== 'juggle') {
        if (canCleave && distance <= 265) {
          return { attack: 'phase_cleave' };
        }
        if (canOrb && myOrbs.length === 0 && distance >= 175) {
          return { attack: 'aegis_orb', say: pickSay(state, 'other_orb') };
        }
        const yIn8 = op.y + op.vy * 8 - 27.2;
        if (distance <= 218 && yIn8 >= 20 && yIn8 <= 185 && !isParryBot) {
          return { attack: 'horizon_launch' };
        }
        if (distance <= 162 && op.y <= 175 && !isParryBot) {
          return { attack: 'chrono_jab' };
        }
        return distance > 140 ? { walk: 1 } : { guard: 'high', walk: 0 };
      }
    }

    // 11. Окиземе на подъёме соперника
    if (op.state === 'knockdown' || op.state === 'getup') {
      if (canOrb && myOrbs.length === 0 && distance >= 165) {
        return { attack: 'aegis_orb', say: pickSay(state, 'other_orb') };
      }
      const targetDist = canLock || canRawThrow ? 120 : 144;
      if (distance > targetDist + 14) {
        return distance > 290 ? { dash: 'forward' } : { walk: 1 };
      }
      if (distance < targetDist - 12) {
        return { walk: -1, guard: 'high' };
      }
      if (!mem.tauntDone && op.state === 'knockdown' && me.hp > op.hp) {
        mem.tauntDone = true;
        return { walk: 0, say: pickSay(state, state.tick % 2 === 0 ? 'taunt_1' : 'taunt_2') };
      }
      return { walk: 0, guard: 'high' };
    }

    // 12. Выход из угла
    const nearLeftWall = me.x - stage.left < 90 && op.x > me.x;
    const nearRightWall = stage.right - me.x < 90 && op.x < me.x;
    if ((nearLeftWall || nearRightWall) && distance < 145 && !canLock && !canCleave) {
      return { jump: 1 };
    }

    // 13. Проактивные способности и гарантированное вскрытие защиты
    if (!op.invulnerable) {
      if (canLock && distance <= 148 && !op.airborne && op.state !== 'prejump') {
        return { attack: 'chrono_lock' };
      }

      if (canRawThrow && distance <= 128) {
        return doRawThrow();
      }

      if (
        canCleave &&
        distance >= 90 &&
        distance <= 275 &&
        (op.guard === 'low' || op.posture === 'crouch' || isParryBot || isSerialJumper || distance > 162)
      ) {
        return { attack: 'phase_cleave' };
      }

      if (canOrb && myOrbs.length === 0 && distance >= 215) {
        return { attack: 'aegis_orb', say: pickSay(state, 'other_orb') };
      }
    }

    // 14. Давление по блокстану
    if (op.state === 'blockstun') {
      const adv = op.stateLength - op.stateTicks;
      if (canRawThrow && adv <= 2 && distance <= 128) {
        return doRawThrow();
      }
      if (op.guard === 'low' && canCleave && distance <= 250) {
        return { attack: 'phase_cleave' };
      }
      if (!isParryBot && adv <= 4 && distance <= 158) {
        return op.guard === 'high' ? { attack: 'low_sweep' } : { attack: 'chrono_jab' };
      }
      return { walk: 1 };
    }

    // 15. Нейтрал (анти-парри режим и плотный наземный прессинг)
    if (isParryBot) {
      if (distance <= 128 && (canRawThrow || state.tick % 17 === 0)) {
        return doRawThrow();
      }
      if (canLock || canRawThrow) {
        return { walk: 1 };
      }
      if (canCleave && distance <= 275) {
        return { attack: 'phase_cleave' };
      }
      if (distance < 195) {
        return { walk: -1, guard: 'high' };
      }
      return distance > 245 ? { walk: 1 } : { walk: 0, guard: 'high' };
    }

    if (distance <= 158 && !op.invulnerable) {
      if (op.guard === 'low' && canCleave) {
        return { attack: 'phase_cleave' };
      }
      if (op.guard !== 'low') {
        return { attack: 'low_sweep' };
      }
      return { attack: 'chrono_jab' };
    }

    if (shieldBetween) {
      return distance > 240 ? { dash: 'forward' } : { walk: 1 };
    }

    if (distance > 310) {
      return { dash: 'forward' };
    }

    return { walk: 1 };
  },
};
