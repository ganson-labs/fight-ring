// Online exponentially-decayed opponent profiler: learns habits and adapts within seconds when style changes!
import { getMoveDef } from './data.js';

export function createProfiler() {
  return {
    lastSeenState: 'neutral',
    lastSeenMoveKey: '',
    lastCloseSampleTick: -99,
    lastMidSampleTick: -99,

    // Decaying behavioral EMA estimates in [0, 1]
    guardHighRate: 0.35,
    guardLowRate: 0.25,
    parryRate: 0.08,
    throwCloseRate: 0.16,
    techRate: 0.08,
    jumpRate: 0.06,
    armorRate: 0.05,
    zoneRate: 0.10,
    teleportRate: 0.04,
    aggroWalkRate: 0.45,
    retreatRate: 0.15,

    // Move usage counters (decayed)
    moveCounts: {},
    totalMoves: 0,
    dominantMove: null,
    dominantMoveShare: 0,

    // Our own outcomes tracking (did they parry our poke? did they tech our throw?)
    timesParriedMe: 0,
    prevMeState: 'neutral',
    myThrowAttempts: 0,
    myThrowTechs: 0,
  };
}

function ema(cur, obs, alpha = 0.12) {
  return cur * (1 - alpha) + obs * alpha;
}

export function updateProfiler(prof, s, pred) {
  const tick = s.tick;
  const me = s.me;
  const op = s.opponent;
  const dist = s.distance;

  // Detect if opponent just parried us!
  if (me.state === 'staggered' && prof.prevMeState === 'move') {
    prof.timesParriedMe++;
    prof.parryRate = ema(prof.parryRate, 1.0, 0.28);
  }
  // Detect if opponent teched our throw!
  if (me.state === 'techBreak' && prof.prevMeState !== 'techBreak') {
    prof.myThrowTechs++;
    prof.techRate = ema(prof.techRate, 1.0, 0.30);
  }
  if (me.state === 'throwing' && prof.prevMeState !== 'throwing') {
    prof.techRate = ema(prof.techRate, 0.0, 0.16);
  }

  // Track opponent state transitions (from delayed sight, accurate behavioral record!)
  if (op.state !== prof.lastSeenState) {
    if (op.state === 'parry') {
      prof.parryRate = ema(prof.parryRate, 1.0, 0.22);
    } else if (op.state === 'throw' && dist < 190) {
      prof.throwCloseRate = ema(prof.throwCloseRate, 1.0, 0.22);
      prof.guardHighRate *= 0.95;
      prof.guardLowRate *= 0.95;
    } else if (op.state === 'prejump') {
      prof.jumpRate = ema(prof.jumpRate, 1.0, 0.18);
      prof.guardHighRate *= 0.96;
      prof.guardLowRate *= 0.96;
    }
    prof.lastSeenState = op.state;
  }

  // Track opponent moves started
  const moveKey = op.state === 'move' && op.move ? op.move.id + ':' + Math.floor((tick - op.move.t) / 6) : '';
  if (op.state === 'move' && op.move && op.move.t <= 3 && moveKey !== prof.lastSeenMoveKey) {
    prof.lastSeenMoveKey = moveKey;
    const id = op.move.id;
    // Decay all move counts slightly so mid-fight style switches shift dominantMove rapidly!
    const keys = Object.keys(prof.moveCounts);
    let sum = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      prof.moveCounts[k] *= 0.92;
      sum += prof.moveCounts[k];
    }
    prof.moveCounts[id] = (prof.moveCounts[id] || 0) + 1;
    sum += 1;
    prof.totalMoves = sum;

    let bestId = null;
    let bestVal = 0;
    const keys2 = Object.keys(prof.moveCounts);
    for (let i = 0; i < keys2.length; i++) {
      const k = keys2[i];
      if (prof.moveCounts[k] > bestVal) {
        bestVal = prof.moveCounts[k];
        bestId = k;
      }
    }
    prof.dominantMove = bestId;
    prof.dominantMoveShare = sum > 2 ? bestVal / sum : 0;

    const mDef = getMoveDef(op, id);
    const isArmor = !!(mDef && mDef.armor > 0);
    const isProj = !!(mDef && mDef.segments.some((g) => g.type === 'projectile'));
    const isTele = !!(mDef && mDef.segments.some((g) => g.type === 'teleport'));
    prof.armorRate = ema(prof.armorRate, isArmor ? 1 : 0, 0.16);
    prof.zoneRate = ema(prof.zoneRate, isProj ? 1 : 0, 0.14);
    prof.teleportRate = ema(prof.teleportRate, isTele ? 1 : 0, 0.16);
    prof.guardHighRate *= 0.96;
    prof.guardLowRate *= 0.96;
    if (dist < 220) {
      prof.parryRate = ema(prof.parryRate, 0, 0.04);
      prof.throwCloseRate = ema(prof.throwCloseRate, 0, 0.05);
    }
  }

  // Periodic sampling of neutral posture, guard, and movement every 12 ticks
  if (op.state === 'neutral' || op.state === 'blockstun') {
    if (dist < 235 && tick - prof.lastCloseSampleTick >= 10) {
      prof.lastCloseSampleTick = tick;
      prof.guardHighRate = ema(prof.guardHighRate, op.guard === 'high' ? 1 : 0, 0.10);
      prof.guardLowRate = ema(prof.guardLowRate, op.guard === 'low' ? 1 : 0, 0.10);
      if (dist < 150 && op.state === 'neutral') {
        prof.throwCloseRate = ema(prof.throwCloseRate, 0, 0.04);
      }
    }
    if (tick - prof.lastMidSampleTick >= 14 && op.state === 'neutral') {
      prof.lastMidSampleTick = tick;
      const toMe = me.x >= op.x ? 1 : -1;
      const vxToward = op.vx * toMe;
      prof.aggroWalkRate = ema(prof.aggroWalkRate, vxToward > 1 ? 1 : 0, 0.08);
      prof.retreatRate = ema(prof.retreatRate, vxToward < -1 ? 1 : 0, 0.08);
      prof.jumpRate = ema(prof.jumpRate, 0, 0.03);
    }
  }

  prof.prevMeState = me.state;
  return prof;
}
