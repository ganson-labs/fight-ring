// One move of a fighter against the sparring dummy: where the two stand and what the fighter presses, tick by tick.
// The lab's move clips (`arena preview --move`) and the fighter card in the viewer play moves through it, so a move
// looks the same in both: its fx, its projectiles, the objects and effects of its ability, the hit on the dummy.
import { STAGE, METER_MAX, ABILITY, IDLE_ACTION, RING_SEED, sanitizeAction, createFight, stepFight } from '../engine/index.js';

const REACH_GAP = { short: 110, mid: 145, long: 195 };

// The distance between the two at the start: a projectile from afar, a teleport from mid range, a strike at its reach.
export function demoGap(m) {
  const strike = m.segments.find((s) => s.type === 'strike');
  if (m.segments.some((s) => s.type === 'projectile')) return 560;
  if (m.segments.some((s) => s.type === 'teleport')) return 420;
  if (strike) return REACH_GAP[strike.p.reach];
  return m.ability ? 160 : 150;
}

// Places the fighters (side 0 the fighter, side 1 the dummy) and returns source(fight, i) for the Player / Broadcast:
// actions per step, null while the fight is frozen, undefined when the clip is over. dummy(fight) → the dummy's action.
export function moveDemo(fight, m, { gap = demoGap(m), start = 20, dummy = () => IDLE_ACTION } = {}) {
  fight.f[0].x = STAGE.width / 2 - gap / 2;
  fight.f[1].x = STAGE.width / 2 + gap / 2;
  if (m.slot === 'super') fight.f[0].meter = METER_MAX;
  const air = m.posture === 'air';
  const total = start + m.duration + (m.charge ? m.charge.maxHold : 0) + (air ? 40 : 0) + 80;
  let pressed = false;
  // an ability keeps the clip running while its objects and effects live
  const busy = (f) => f.casts.length || f.objects.length || f.f.some((F) => F.effects.length);
  return (f, i) => {
    if (i >= (total + ABILITY.castTicks) * 3) return undefined;
    if (f.tick >= total && !(m.ability && busy(f) && f.tick < total + ABILITY.castTicks)) return undefined;
    if (f.freeze || f.hitstop) return null;
    const me = f.f[0];
    let a = {};
    if (f.tick >= start) {
      if (air) {
        if (me.state === 'neutral' && !pressed) a = { jump: 1 };
        else if (me.state === 'air' && me.vy < 4 && !pressed) {
          a = { attack: m.id };
          pressed = true;
        }
      } else if (!pressed && me.state === 'neutral') {
        a = { attack: m.id, crouch: m.posture === 'crouch' };
        pressed = true;
      }
      if (m.charge) a.hold = true;
      if (m.posture === 'crouch' && me.state === 'neutral') a.crouch = true;
    }
    let b = IDLE_ACTION;
    try {
      b = sanitizeAction(dummy(f));
    } catch {}
    return [sanitizeAction(a), b];
  };
}

// For an ability: the gap at which its objects stay on screen longest (an orb that hits at once from up close is
// never seen), tried on a copy of the fight; other moves keep demoGap. fighters: [fighter def, dummy def].
export function showGap(fighters, m, { seed = RING_SEED } = {}) {
  const base = demoGap(m);
  if (!m.ability) return base;
  let best = base;
  let bestScore = -1;
  for (const gap of [base, 360, 560]) {
    const f = createFight({ fighters, seed });
    const source = moveDemo(f, m, { gap });
    let score = 0;
    for (let i = 0; i < 4000; i++) {
      const a = source(f, i);
      if (a === undefined) break;
      stepFight(f, a);
      score += f.objects.filter((o) => !o.dead).length;
    }
    if (score > bestScore * 1.5) {
      best = gap;
      bestScore = score;
    }
  }
  return best;
}
