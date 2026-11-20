// Sparring dummy. Mode comes from the sandbox: --dummy stand|block|crouch|jump|walk|parry|throw.
let mode = 'stand';

export default {
  init(info) {
    mode = info?.options?.dummy || 'stand';
  },
  tick(state) {
    const me = state.me;
    switch (mode) {
      case 'block': {
        const op = state.opponent;
        const low = op.move && op.moves.find((m) => m.id === op.move.id)?.segments.some((s) => s.zone === 'low');
        return { guard: low ? 'low' : 'high' };
      }
      case 'crouch':
        return { crouch: true };
      case 'jump':
        return me.canAct ? { jump: 0 } : {};
      case 'walk':
        return { walk: Math.floor(state.tick / 90) % 2 ? 1 : -1 };
      case 'parry':
        return state.opponent.move?.phase === 'startup' ? { parry: true } : {};
      case 'throw':
        return state.distance < 140 ? { throw: true } : { walk: 1 };
      default:
        return {};
    }
  },
};
