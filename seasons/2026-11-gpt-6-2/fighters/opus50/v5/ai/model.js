// Memory of the fight: what my own attacks did (seen at once), when the opponent touched me, and what he tends to do
// (seen 15 ticks late, but counted all the same).

// small deterministic generator from the fight's seed
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createModel(info) {
  return {
    rng: makeRng((info?.seed ?? 1) ^ 0x9e3779b9),
    side: info?.side ?? 0,
    round: info?.options?.round ?? 1,
    touchedAt: -999, // last tick an opponent's strike touched me (hit, block, parry, armour)
    myHitTick: -999,
    myHitStun: 0,
    myHitLaunch: false,
    myBlockTick: -999,
    prev: null,
    prevOp: null,
    lastAct: null,
    lastAttackTick: -999,
    lastSay: -999,
    // what the opponent does (counted on the delayed view)
    op: {
      moves: {}, // id → starts
      starts: 0,
      jumps: 0,
      throws: 0,
      parries: 0,
      dashes: 0,
      backdashes: 0,
      projectiles: 0,
      blocks: 0, // my attacks he blocked
      hitsTaken: 0, // my attacks that hit him
      wakeAttack: 0,
      wakeBlock: 0,
      wakes: 0,
      afterBlockAttack: 0, // after blocking my attack, he attacked at once
      afterBlockSeen: 0,
      closeNeutralTicks: 0, // ticks he stood near me free
      closeAttacks: 0, // attacks he began near me from neutral
      guardLowTicks: 0,
      guardHighTicks: 0,
      guardNoneTicks: 0,
      airAttacks: 0,
      supers: 0,
      lastStartTick: -999,
      lastMoveId: null,
      throwRangeTicks: 0,
      throwTries: 0,
      jabsNear: 0,
      freeTicks: 0,
      lows: 0,
      closeThrows: 0,
      closeStrikes: 0,
      closeGuardTicks: 0,
      lastAttackSeen: 0,
    },
    me: { meetTries: 0, meetHits: 0, parries: 0, parryFails: 0, throwsTried: 0, throwsLanded: 0, techs: 0, thrown: 0, hits: 0, blocked: 0, whiffs: 0, punishes: 0 },
    hist: [], // my x by tick for the last 32 ticks
    plan: null,
    swaySeed: 0,
    pressUntil: 0,
    opFreeSince: 0,
    planUntil: 0,
    approach: 0,
    oki: null,
    parryUntil: -1,
    projSeen: 0,
    lastOpProj: -999,
  };
}

const staleSig = (st) => {
  let s = '';
  for (const k in st) s += k + ':' + st[k] + ',';
  return s;
};

export function observe(M, s) {
  const me = s.me;
  const op = s.opponent;
  const L = s.reaction + 1; // the view is the state after the step 16 before the one my action goes into
  const prev = M.prev;
  // my position history (to know where I stood when the opponent acted)
  M.hist.push({ tick: s.tick, x: me.x, state: me.state, move: me.move?.id || null });
  if (M.hist.length > 40) M.hist.shift();

  if (prev) {
    // touched by the opponent: entered blockstun / hitstun / juggle, or a parry ended early, or armour took a hit
    const hurt = me.hp < prev.hp;
    const nowStun = me.state === 'blockstun' || me.state === 'hitstun' || me.state === 'juggle';
    const newStun = nowStun && (prev.state !== me.state || me.stateTicks < prev.stateTicks || hurt);
    const parried = prev.state === 'parry' && me.state === 'neutral' && prev.stateTicks <= 6;
    if (newStun || parried) M.touchedAt = s.tick;
    if (parried) {
      M.me.parries++;
      M.justParried = s.tick;
    }
    if (prev.state === 'parry' && me.state === 'parry' && me.stateTicks === 7) M.me.parryFails++;
    if (me.state === 'grabbed' && prev.state !== 'grabbed') M.me.thrown++;
    if (prev.state === 'blockstun' && me.state !== 'blockstun') M.bsEnd = s.tick;
    // how each of my moves ended: a whiff shows as a longer recovery
    if (prev.move && (!me.move || me.move.id !== prev.move || me.move.t < prev.moveT)) {
      const R = ((M.me.moveRes ||= {})[prev.move] ||= { n: 0, whiff: 0, hit: 0 });
      R.n++;
      if (prev.moveWhiff) R.whiff++;
      else if (M.myHitTick >= prev.moveStart) R.hit++;
    }
    // how my throws end: landed, teched, whiffed, or stuffed by a hit
    if (prev.state === 'throw' && me.state !== 'throw') {
      const R = (M.me.throwRes ||= { land: 0, tech: 0, whiff: 0, stuffed: 0 });
      if (me.state === 'throwing') R.land++;
      else if (me.state === 'techBreak') R.tech++;
      else if (me.state === 'neutral') R.whiff++;
      else R.stuffed++;
    }
    if (me.state === 'techBreak' && prev.state !== 'techBreak') M.me.techs++;
    // my attack connected? the stale table changes on a clean hit, the meter rises on hit or block
    const sig = staleSig(me.stale);
    const dm = me.meter - prev.meter;
    const myStrikeLive = prev.move && prev.moveSeg === 'strike';
    if (sig !== prev.staleSig && me.move && !isLaunchTick(me)) {
      // clean hit with the move running
      const d = me.moves.find((m) => m.id === me.move.id);
      const g = d && d.segments.find((x) => x.type === 'strike' && me.move.t >= x.activeStart && me.move.t <= x.activeEnd + 1);
      if (g) {
        M.myHitTick = s.tick;
        M.myHitStun = 14 + Math.floor(g.damage / 6);
        M.myHitLaunch = !!g.launch;
        M.myHitMove = d.id;
        M.myHitPush = g.push === 'heavy' ? 9 : 5;
        M.myHitOx = M.lastPx ?? null;
        M.myHitDir = M.lastDir ?? me.facing;
        M.me.hits++;
        if (s.tick - (M.meetTick ?? -99) < 12) M.me.meetHits++;
      }
    } else if (dm > 0 && myStrikeLive && me.move && sig === prev.staleSig && !nowStun) {
      M.myBlockTick = s.tick;
      M.myBlockMove = me.move.id;
      M.me.blocked++;
    }
    if (me.state === 'throwing' && prev.state !== 'throwing') {
      M.me.throwsLanded++;
      M.myHitTick = s.tick;
      M.myHitStun = 0;
      M.myHitLaunch = true;
    }
  }
  const mseg = (() => {
    if (!me.move) return null;
    const d = me.moves.find((m) => m.id === me.move.id);
    const g = d && d.segments.find((x) => me.move.t < x.end);
    return g ? g.type : null;
  })();
  const pm = M.prev;
  const moveStart = me.move ? (pm && pm.move === me.move.id && me.move.t > (pm.moveT ?? 0) ? pm.moveStart : s.tick - me.move.t) : 0;
  const def = me.move ? me.moves.find((x) => x.id === me.move.id) : null;
  M.prev = { hp: me.hp, state: me.state, stateTicks: me.stateTicks, meter: me.meter, staleSig: staleSig(me.stale), move: me.move?.id || null, moveT: me.move?.t ?? 0, moveStart, moveWhiff: !!(me.move && def && me.move.duration > def.duration), moveSeg: mseg, x: me.x };

  // the opponent, as seen
  const po = M.prevOp;
  const O = M.op;
  const myThen = M.hist.length > L ? M.hist[M.hist.length - 1 - L] : M.hist[0];
  const distThen = Math.abs(op.x - myThen.x);
  // what he saw when he decided: me 15 ticks before that
  const mySeen = M.hist.length > 2 * L ? M.hist[M.hist.length - 1 - 2 * L] : M.hist[0];
  const distHis = Math.abs(op.x - mySeen.x);
  if (po) {
    if (op.state === 'move' && (po.state !== 'move' || po.moveId !== op.move.id || op.move.t < po.moveT)) {
      const dd = op.moves.find((x) => x.id === op.move.id);
      if (dd && dd.segments.some((g) => g.type === 'strike' || g.type === 'projectile')) {
        O.starts++;
        O.lastAttackSeen = s.tick;
      }
      O.moves[op.move.id] = (O.moves[op.move.id] || 0) + 1;
      O.lastStartTick = s.tick - L;
      O.lastMoveId = op.move.id;
      const d = op.moves.find((m) => m.id === op.move.id);
      if (d && d.slot === 'super') O.supers++;
      if (d && d.posture === 'air') O.airAttacks++;
      if (d && d.segments.some((g) => g.zone === 'low')) O.lows++;
      if (d && d.segments.some((g) => g.type === 'projectile')) {
        O.projectiles++;
        // when his shots start, for a rhythm to read
        (O.projStarts ||= []).push({ t: s.tick - L - op.move.t, id: d.id, x: op.x });
        if (O.projStarts.length > 5) O.projStarts.shift();
      }
      if (po.state === 'neutral' && distThen < 200 && myThen.state !== 'move') O.closeAttacks++;
      if (po.state === 'neutral' && distHis < 150 && dd && dd.segments.some((g) => g.type === 'strike')) O.closeStrikes++;
      if (po.state === 'neutral' && dd && dd.segments[0].type === 'strike') O.atkTrig = O.atkTrig == null ? distHis : Math.min(O.atkTrig * 0.7 + distHis * 0.3, 400);
      if (po.state === 'getup') O.wakeAttack++;
      if (po.state === 'blockstun') O.afterBlockAttack++;
      if (d && (d.id === 'jab' || d.id === 'low') && distThen < 160) O.jabsNear++;
    }
    if (op.state === 'prejump' && po.state !== 'prejump') O.jumps++;
    if (op.state === 'throw' && po.state !== 'throw') {
      O.throwTrig = O.throwTrig == null ? distHis : O.throwTrig * 0.7 + distHis * 0.3;
      if (distHis < 150) O.closeThrows++;
      O.throws++;
      if (distThen < 150) O.throwTries++;
    }
    if (op.state === 'parry' && po.state !== 'parry') O.parries++;
    if (op.state === 'dash' && po.state !== 'dash') {
      if (op.stateLength === 18) O.backdashes++;
      else O.dashes++;
    }
    if (op.state === 'blockstun' && po.state !== 'blockstun') O.blocks++;
    if (op.state === 'hitstun' && po.state !== 'hitstun') O.hitsTaken++;
    if (po.state === 'getup' && op.state !== 'getup') {
      O.wakes++;
      if (op.state === 'neutral' && op.guard) O.wakeBlock++;
    }
    if (po.state === 'blockstun' && op.state !== 'blockstun') O.afterBlockSeen++;
  }
  if (op.state === 'neutral' && !op.airborne) {
    O.freeTicks++;
    if (distThen < 200) O.closeNeutralTicks++;
    if (distThen < 135) O.throwRangeTicks++;
    if (op.guard && distThen < 150) O.closeGuardTicks++;
    if (op.guard === 'low') O.guardLowTicks++;
    else if (op.guard === 'high') O.guardHighTicks++;
    else O.guardNoneTicks++;
  }
  if (op.state === 'prejump' && op.stateTicks >= 0) M.opJumpDir = null;
  if (op.state === 'air' && po && po.state === 'prejump') M.opJumpDir = Math.sign(op.vx) * op.facing;
  M.prevOp = { state: op.state, moveId: op.move?.id || null, moveT: op.move?.t ?? -1, x: op.x };
}

function isLaunchTick(me) {
  // a projectile thrown this tick also tires its move: not a hit
  if (!me.move) return false;
  const d = me.moves.find((m) => m.id === me.move.id);
  return !!d && d.segments.some((g) => g.type === 'projectile' && me.move.t >= g.activeStart && me.move.t <= g.activeStart + 1);
}

// share of observed situations, with a prior
export function rate(n, of, prior = 0.3, w = 3) {
  return (n + prior * w) / (of + w);
}

export function guessOpen() {
  return 0;
}
