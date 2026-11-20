// Метроном — мозги. Считает каждый тик: соперника видно на 15 тиков позже, но всё, что он уже начал, идёт по
// таймингам ринга, поэтому мозги досчитывают, где он сейчас, и бьют ровно в окно.
import { createModel, observe, guessOpen } from './ai/model.js';
import { project, threats, mv, strikeSegs, isProjectileMove } from './ai/predict.js';
import { decide } from './ai/decide.js';

let M = null;

export default {
  init(info) {
    M = createModel(info);
    M.swaySeed = Math.floor(M.rng() * 42);
  },
  tick(s) {
    try {
      return think(s);
    } catch (e) {
      // never stand still on a bug: hold a low guard
      return { guard: 'low', crouch: true, why: 'ERR ' + (e && e.message) };
    }
  },
};

function think(s) {
  {
    if (!M) M = createModel({ seed: 1, side: s.side, reaction: s.reaction });
    observe(M, s);
    const P = project(M, s);
    if (!P.free) M.opFreeSince = s.tick + P.busy;
    M.lastPx = P.x;
    M.lastDir = P.dir;
    M.lastDist = P.dist;
    const T = threats(M, s, P);
    const act = decide(M, s, P, T) || {};
    M.lastAct = act;
    if (act.attack) M.lastAttackTick = s.tick;
    return act;
  }
}
