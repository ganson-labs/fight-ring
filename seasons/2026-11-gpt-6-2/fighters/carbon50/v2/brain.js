// Brain entry point for «Барон Фонарь» (Baron Fonar).
import { createRng } from './ai/data.js';
import { createPredictor, updatePredictor } from './ai/predictor.js';
import { createProfiler, updateProfiler } from './ai/profiler.js';
import { decideAction } from './ai/tactics.js';

let rng = createRng(1);
let predictor = createPredictor();
let profiler = createProfiler();
let startInfo = null;
let mem = { lastSayTick: -999, lastRespectTick: -999, targetSmashHold: 0 };

export default {
  init(info) {
    const seed = info && info.seed ? info.seed : 0x5bd1e995;
    rng = createRng(seed);
    predictor = createPredictor();
    profiler = createProfiler();
    startInfo = info && info.start ? info.start : null;
    mem = { lastSayTick: -999, lastRespectTick: -999, targetSmashHold: 0 };
  },

  tick(state) {
    const pred = updatePredictor(predictor, state, startInfo);
    updateProfiler(profiler, state, pred);
    return decideAction(state, pred, profiler, mem, rng);
  },
};
