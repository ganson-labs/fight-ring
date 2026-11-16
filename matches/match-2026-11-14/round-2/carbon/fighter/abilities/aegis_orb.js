// Часовой Эгиды (Aegis Sentinel): solid projectile-erasing chrono-orb with adaptive unblockable standing hitstun.

function orbTick(api, o) {
  const v = api.view();
  if (!v) return;
  const op = v.opponent;
  const dx = op.x - o.x;
  const adx = Math.abs(dx);
  const targetY = op.y + (op.posture === 'crouch' ? 95 : 145);
  const dy = targetY - o.y;

  const parryActive = op.state === 'parry' && op.stateTicks <= 6;
  if ((parryActive || op.invulnerable) && adx < 120) {
    o.vx = adx < 86 ? (dx >= 0 ? -10 : 10) : 0;
    o.vy = 0;
    return;
  }

  const dir = dx >= 0 ? 1 : -1;
  o.facing = dir;
  const spd = o.age < 3 ? 14 : 23;
  o.vx = adx < spd ? dx : dir * spd;
  const rawVy = dy * 0.48;
  o.vy = rawVy < -16 ? -16 : rawVy > 16 ? 16 : rawVy;

  if (adx <= 64 && Math.abs(dy) <= 160) {
    const zone = !op.airborne && op.guard === 'high' ? 'low' : 'overhead';
    const res = api.hit({
      box: [-68, -145, 68, 165],
      damage: 47,
      zone,
      launch: false,
      push: 'light',
    });
    if (res !== 'miss' && res !== 'wait') {
      api.remove();
    }
  }
}

export function start(api) {
  const live = api.objects();
  if (live.length >= 3) {
    api.remove(live[0].id);
  }
  api.addResource('chrono', -15);
  api.spawn({
    x: 60,
    y: 135,
    w: 56,
    h: 175,
    vx: 12,
    vy: 0,
    life: 90,
    solid: true,
    image: 'fx/chrono_orb.png',
    color: '#2ef2ff',
    glow: true,
    particles: 80,
    label: 'ЭГИДА',
    tick: orbTick,
  });
  api.fx([60, 135]);
  api.end();
}
