// Нулевой Меридиан (Zero Meridian): Ultimate time-severing judgment slash across half the arena.

function tryJudgment(api) {
  const v = api.view();
  if (!v) return;
  const op = v.opponent;
  let dist = v.distance;

  if (dist > 105) {
    const moved = api.shove('me', Math.min(12, dist - 92));
    dist -= moved;
  }

  const parryActive = op.state === 'parry' && op.stateTicks <= 6;
  if ((parryActive || op.invulnerable) && api.t < 10) {
    if (api.t % 2 === 0) api.fx([80, 160]);
    return;
  }

  let zone = 'overhead';
  let box = [0, 0, 595, 320];
  if (op.airborne || op.y > 20) {
    zone = 'overhead';
    box = [0, 0, 595, 450];
  } else if (op.guard === 'high') {
    zone = 'low';
    box = [0, 0, 595, 140];
  }

  api.hit({
    box,
    damage: 248,
    zone,
    launch: true,
    push: 'heavy',
  });

  api.fx([Math.min(dist, 420), zone === 'low' ? 65 : 160]);
  api.addResource('chrono', 50);
  api.mem.hitDone = true;
}

export function start(api) {
  api.mem.hitDone = false;
  api.fx([50, 155]);
  tryJudgment(api);
}

export function tick(api) {
  if (api.mem.hitDone) {
    if (api.t === 3) api.fx([190, 165]);
    if (api.t >= 6) {
      api.fx([320, 145]);
      api.end();
    }
    return;
  }
  if (api.t > 10) {
    api.end();
    return;
  }
  tryJudgment(api);
}
