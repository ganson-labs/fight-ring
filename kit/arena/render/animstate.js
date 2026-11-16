// Which animation the renderer shows for a fighter, and at which tick. Pure, no Pixi.
import { sampleAnim } from '../engine/skeleton.js';

export function animFor(F, fight, sub = 0) {
  const A = F.def.anims;
  const st = F.st + sub;
  if (fight.over && fight.winner === F.side && ['neutral', 'landing'].includes(F.state)) return { anim: A.victory, t: fight.tick - fight.endTick + sub };
  switch (F.state) {
    case 'neutral':
      if (F.posture === 'crouch') return { anim: A.crouch, t: fight.tick + sub };
      if (F.walk > 0) return { anim: A.walk_forward, t: fight.tick + sub };
      if (F.walk < 0) return { anim: A.walk_back, t: fight.tick + sub };
      return { anim: A.idle, t: fight.tick + sub };
    case 'prejump':
      return { anim: A.jump, t: 0 };
    case 'air':
      return { anim: A.jump, t: Math.min(st + 3, A.jump.length) };
    case 'landing':
      return { anim: A.crouch, t: 0 };
    case 'dash':
      return { anim: F.dashDir > 0 ? A.dash_forward : A.dash_back, t: st };
    case 'move':
      return { anim: F.move.def.anim, t: F.move.t + (F.move.held > 0 && F.holding ? 0 : sub), charging: F.move.held > 0 && F.holding };
    case 'hitstun':
      return { anim: F.posture === 'crouch' ? A.hit_low : A.hit, t: st };
    case 'blockstun':
      return { anim: F.guard === 'low' ? A.block_low : A.block_high, t: st };
    case 'juggle':
      return { anim: A.hit_air, t: st };
    case 'knockdown':
      return { anim: A.knockdown, t: st };
    case 'getup':
      return { anim: A.getup, t: st };
    case 'ko':
      return { anim: A.defeat, t: st + 40 };
    case 'parry':
      return { anim: A.parry, t: st };
    case 'staggered':
    case 'techBreak':
      return { anim: A.hit, t: Math.min(st, 6) };
    case 'dizzy':
      return { anim: A.dizzy, t: st };
    case 'throw':
    case 'throwing':
      return { anim: A.throw, t: st };
    case 'grabbed':
    case 'thrown':
      return { anim: A.thrown, t: st };
    default:
      return { anim: A.idle, t: fight.tick };
  }
}

export function poseFor(F, fight, sub = 0) {
  const a = animFor(F, fight, sub);
  return { pose: sampleAnim(a.anim, a.t), charging: !!a.charging };
}
