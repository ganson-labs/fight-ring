// Фазовый Раскол (Phase Cleave): half-screen 4f unblockable chrono-slash + phase-glide into point-blank pressure.

export function passive(api) {
  const mem = api.mem;
  if (mem.prevHits === undefined) {
    mem.prevHits = 0;
  }
  if (api.tick % 8 === 0) {
    api.addResource('chrono', 1);
  }
  if (api.tick % 10 === 2) {
    const v = api.view();
    if (!v) return;
    if (v.opponent.state === 'staggered' && mem.lastStagger !== v.tick) {
      mem.lastStagger = v.tick;
      api.addResource('chrono', 14);
    }
    if (v.opponent.combo > mem.prevHits) {
      api.addResource('chrono', 8);
    }
    mem.prevHits = v.opponent.combo;
  }
}

function trySlash(api) {
  const v = api.view();
  if (!v) return;
  const op = v.opponent;
  let dist = v.distance;

  const parryActive = op.state === 'parry' && op.stateTicks <= 6;
  if ((parryActive || op.invulnerable || op.combo >= 4) && api.t < 11) {
    if (api.t % 3 === 0) api.fx([60, 145]);
    return;
  }

  if (dist > 620 && api.t < 11) {
    if (dist > 115) api.shove('me', 12);
    return;
  }

  let zone = 'overhead';
  let box = [0, 80, 595, 310];
  if (op.airborne || op.y > 20) {
    zone = 'overhead';
    box = [0, 10, 595, 460];
  } else if (op.guard === 'high') {
    zone = 'low';
    box = [0, 0, 595, 140];
  } else if (op.guard === 'low' || op.posture === 'crouch') {
    zone = 'overhead';
    box = [0, 80, 595, 290];
  }

  const res = api.hit({
    box,
    damage: 48,
    zone,
    launch: false,
    push: 'light',
  });

  api.fx([Math.min(dist, 520), zone === 'low' ? 60 : 165]);
  api.mem.struck = true;
  if (res === 'hit' || res === 'block' || res === 'armor') {
    api.mem.hitClean = true;
    api.addResource('chrono', 28);
    if (res === 'hit' && dist > 130) {
      const pulled = Math.abs(api.shove('opponent', -12));
      dist -= pulled;
    }
    if (dist > 112) {
      api.shove('me', Math.min(12, dist - 108));
    }
  } else {
    api.end();
  }
}

export function start(api) {
  api.mem.struck = false;
  api.mem.hitClean = false;
  api.addResource('chrono', -20);
  const live = api.objects();
  if (live.length >= 3) {
    api.remove(live[0].id);
  }
  api.spawn({
    x: 70,
    y: 145,
    w: 42,
    h: 42,
    vx: 18,
    vy: 0,
    life: 15,
    solid: false,
    image: 'fx/chrono_orb.png',
    color: '#2ef2ff',
    glow: true,
    particles: 36,
  });
  api.fx([45, 145]);
  trySlash(api);
}

export function tick(api) {
  if (api.t > 14) {
    api.end();
    return;
  }
  if (!api.mem.struck) {
    trySlash(api);
    return;
  }
  if (api.mem.hitClean) {
    const v = api.view();
    if (v && v.distance > 112) {
      api.shove('me', Math.min(12, v.distance - 108));
    }
  }
}
