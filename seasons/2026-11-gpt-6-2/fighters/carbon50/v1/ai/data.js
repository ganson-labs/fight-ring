// Exact mechanical data of Ring 4 standard ruleset for zero-error tactical reasoning.

export const STAGE_LEFT = 40;
export const STAGE_RIGHT = 2160;
export const STAGE_CENTER = 1100;
export const PUSH_WIDTH = 70;
export const THROW_RANGE = 130; // PUSH_WIDTH (70) + THROW.range (60)
export const THROW_STARTUP = 5;
export const THROW_ACTIVE = 2;
export const THROW_WHIFF = 28;
export const THROW_TOTAL = 35;
export const THROW_PROTECT = 6;
export const THROW_TECH_WIN = 12;

export const PARRY_WIN = 6;
export const PARRY_WHIFF = 18;
export const PARRY_TOTAL = 24;
export const PARRY_STAGGER = 24;

export const GRAVITY = 0.85;
export const JUMP_VY = 17;
export const PREJUMP_TICKS = 3;
export const LANDING_TICKS = 3;
export const DASH_TICKS = 16;
export const BACKDASH_TICKS = 18;
export const BACKDASH_DIST = 140;
export const BACKDASH_INVULN_END = 7;

export const WHIFF_EXTRA = 8;
export const BLOCK_MINUS = 2;
export const GUARD_ANY_TICKS = 7;
export const REACTION_DEFAULT = 15;

export const REACH_PX = { short: 55, mid: 95, long: 150 };
export const PROJ_SPEED = { slow: 6, mid: 9, fast: 13 };
export const PROJ_Y = { high: 235, mid: 170, low: 35 };
export const PROJ_HALF = 25;

// Max center-to-center distance at which a strike connects against a standing (35) or crouching (40) hurtbox
export function strikeMaxDist(reachName, opCrouching = false, advance = 0) {
  const r = REACH_PX[reachName] || 95;
  return 35 + r + (opCrouching ? 40 : 35) + advance;
}

// Deterministic PRNG (Mulberry32) seeded from info.seed
export function createRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function nextRand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Precomputed properties for our 15 moves and opponent moves
export function getMoveDef(fighterView, id) {
  const list = fighterView && fighterView.moves;
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

export function hasMove(fighterView, id) {
  return !!getMoveDef(fighterView, id);
}

// Can `me` legally initiate move `id` on this tick (from ground or air)?
export function canStartMove(me, id) {
  const m = getMoveDef(me, id);
  if (!m) return false;
  if (m.slot === 'super' && me.meter < 300) return false;
  if (m.posture === 'air') {
    if (!me.canAirMove) return false;
  } else {
    if (!me.canAct) return false;
  }
  const segs = m.segments;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].type === 'projectile' && me.projectileOut) return false;
  }
  return true;
}

export function freshness(me, id) {
  if (!me.stale) return 1;
  const v = me.stale[id];
  return v === undefined ? 1 : v;
}
