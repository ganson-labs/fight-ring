// Test brain: walk in, use the abilities when they are ready, otherwise punch.
export default {
  tick(s) {
    const me = s.me;
    if (!me.canAct) return {};
    const ready = (id) => !me.cooldowns[id] && me.moves.some((m) => m.id === id && (!m.stance || m.stance === me.stance));
    if (s.distance > 420 && ready('frost')) return { attack: 'frost' };
    if (s.distance < 200 && ready('flare')) return { attack: 'flare' };
    if (s.distance < 200 && ready('burn')) return { attack: 'burn' };
    if (s.distance < 160 && ready('spark')) return { attack: 'spark' };
    if (s.distance > 150) return { walk: 1 };
    return { attack: 'strike_1' };
  },
};
