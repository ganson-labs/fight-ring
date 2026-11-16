// Алый Лис: осторожный контратакующий боец.
let n = 0, lastFire = -999;
export default {
  init() {},
  tick(s) {
    const me = s.me, op = s.opponent, d = s.distance;
    n++;
    if (!me.canAct && me.state !== 'blockstun') return { guard: 'high' };
    // защита от угроз
    let threat = null;
    if (op.move) {
      const def = op.moves.find(m => m.id === op.move.id);
      const seg = def && def.segments[op.move.segment || 0];
      if (seg && op.move.phase !== 'recovery') {
        const reach = seg.type === 'strike' ? { short: 55, mid: 95, long: 150 }[seg.reach] + 70 : 0;
        if (seg.type === 'strike' && d < reach + 20) threat = seg.zone;
        if (seg.type === 'teleport' || def.slot === 'super') threat = threat || 'mid';
      }
    }
    for (const p of s.projectiles) if (!p.mine && Math.abs(p.x - me.x) < 200) threat = p.zone === 'low' ? 'low' : 'mid';
    if (threat && me.canAct) {
      if (op.move && op.move.phase === 'startup' && d < 110 && n % 3 === 0 && me.meter < 300) return { throw: true };
      return threat === 'low' ? { guard: 'low', crouch: true } : threat === 'overhead' || threat === 'air' ? { guard: 'high' } : { guard: 'high' };
    }
    if (!me.canAct) return {};
    if (me.meter >= 300 && d < 160) return { attack: 'super_1' };
    if (op.state === 'knockdown' || op.state === 'getup') return d > 150 ? { walk: 1 } : {};
    if (op.state === 'dizzy' || op.state === 'hitstun' || op.state === 'blockstun') {
      if (d < 100) return { attack: 'jab' };
      if (d < 180) return { attack: 'kick' };
    }
    if (op.move && op.move.phase === 'recovery' && d < 180) return { attack: d < 100 ? 'jab' : 'kick' };
    if (d < 120 && op.guard && op.canAct) return n % 4 === 0 ? { attack: 'sweep' } : { throw: true };
    if (d < 90) return n % 5 === 0 ? { throw: true } : { attack: n % 2 ? 'jab' : 'sweep' };
    if (op.guard && d >= 120) return { walk: 1 };
    if (d < 165) return { attack: 'kick' };
    if (d > 380 && !me.projectileOut && n - lastFire > 150) { lastFire = n; return { attack: 'fire' }; }
    if (d > 220) return { walk: 1 };
    return n % 40 < 20 ? { walk: -1 } : { walk: 1 };
  },
};
