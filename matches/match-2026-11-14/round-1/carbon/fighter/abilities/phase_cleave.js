// Фазовый Раскол (Phase Cleave): gap-closing adaptive chrono-blade slash + passive Chrono-Charge engine.

export function passive(api) {
  const mem = api.mem;
  if (mem.prevHits === undefined) {
    mem.prevHits = 0;
    mem.prevParries = 0;
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

  if (dist > 105) {
    const glide = Math.min(12, dist - 92);
    const moved = api.shove('me', glide);
    dist -= moved;
  }

  const parryActive = op.state === 'parry' && op.stateTicks <= 6;
  if ((parryActive || op.invulnerable) && api.t < 9) {
    if (api.t % 3 === 0) api.fx([45, 145]);
    return;
  }

  if (dist > 235 && api.t < 9) {
    return;
  }

  let zone = 'overhead';
  let box = [8, 30, 215, 290];
  if (op.airborne || op.y > 20) {
    zone = 'overhead';
    box = [8, 20, 215, 420];
  } else if (op.guard === 'high') {
    zone = 'low';
    box = [8, 0, 215, 120];
  } else if (op.guard === 'low' || op.posture === 'crouch') {
    zone = 'overhead';
    box = [8, 90, 215, 260];
  }

  const res = api.hit({
    box,
    damage: 49,
    zone,
    launch: true,
    push: 'light',
  });

  api.fx([Math.min(dist, 180), zone === 'low' ? 55 : 165]);
  if (res === 'hit') {
    api.addResource('chrono', 28);
  }
  api.mem.struck = true;
  api.end();
}

export function start(api) {
  api.mem.struck = false;
  api.addResource('chrono', -20);
  api.fx([35, 140]);
  trySlash(api);
}

export function tick(api) {
  if (api.mem.struck || api.t > 9) {
    api.end();
    return;
  }
  trySlash(api);
}
