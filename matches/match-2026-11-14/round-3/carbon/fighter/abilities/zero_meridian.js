// Нулевой Меридиан (Zero Meridian): 4f invulnerable half-screen judgment slash (55t standing hitstun or KO launch).

function tryJudgment(api) {
  const v = api.view();
  if (!v) return;
  const op = v.opponent;
  let dist = v.distance;

  if (dist > 105) {
    const moved = api.shove('me', Math.min(12, dist - 95));
    dist -= moved;
  }

  const parryActive = op.state === 'parry' && op.stateTicks <= 6;
  if ((parryActive || op.invulnerable) && api.t < 9) {
    if (api.t % 2 === 0) api.fx([80, 160]);
    return;
  }

  let zone = 'overhead';
  let box = [0, 75, 598, 320];
  if (op.airborne || op.y > 20) {
    zone = 'overhead';
    box = [0, 0, 598, 455];
  } else if (op.guard === 'high') {
    zone = 'low';
    box = [0, 0, 598, 140];
  }

  // Apply 25% vulnerability mark right before impact so Zero Meridian deals full 25% max-HP cap (~3,101 HP)!
  api.effect('opponent', {
    id: 'meridian_mark',
    ticks: 14,
    taken: 1.25,
    box: [-30, 0, 200, 320],
    label: 'РАЗЛОМ',
    color: '#e8a838',
  });

  api.hit({
    box,
    damage: 250,
    zone,
    launch: false,
    push: 'light',
    effect: {
      id: 'meridian_mark',
      ticks: 14,
      taken: 1.25,
      label: 'РАЗЛОМ',
      color: '#e8a838',
    },
  });

  api.fx([Math.min(dist, 440), zone === 'low' ? 65 : 160]);
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
    if (api.t >= 5) {
      api.fx([320, 145]);
      api.end();
    }
    return;
  }
  if (api.t > 9) {
    api.end();
    return;
  }
  tryJudgment(api);
}
