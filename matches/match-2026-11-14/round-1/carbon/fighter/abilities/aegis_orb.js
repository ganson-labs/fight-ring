// Часовой Эгиды (Aegis Sentinel): solid projectile-erasing chrono-orb that tracks target and pauses past parries.

function orbTick(api, o) {
  const v = api.view();
  if (!v) return;
  const op = v.opponent;
  const dx = op.x - o.x;
  const adx = Math.abs(dx);
  const targetY = op.y + (op.posture === 'crouch' ? 95 : 145);
  const dy = targetY - o.y;

  const parryActive = op.state === 'parry' && op.stateTicks <= 6;
  if ((parryActive || op.invulnerable) && adx < 118) {
    o.vx = adx < 84 ? (dx >= 0 ? -10 : 10) : 0;
    o.vy = 0;
    return;
  }

  const dir = dx >= 0 ? 1 : -1;
  o.facing = dir;
  const spd = o.age < 4 ? 12 : 22;
  o.vx = adx < spd ? dx : dir * spd;
  const rawVy = dy * 0.45;
  o.vy = rawVy < -16 ? -16 : rawVy > 16 ? 16 : rawVy;
}

export function start(api) {
  const live = api.objects();
  if (live.length >= 3) {
    api.remove(live[0].id);
  }
  api.addResource('chrono', -15);
  api.spawn({
    x: 58,
    y: 135,
    w: 56,
    h: 175,
    vx: 10,
    vy: 0,
    life: 100,
    solid: true,
    image: 'fx/chrono_orb.png',
    color: '#2ef2ff',
    glow: true,
    particles: 80,
    label: 'ЭГИДА',
    tick: orbTick,
    touch: {
      damage: 46,
      zone: 'mid',
      launch: true,
      push: 'heavy',
      once: true,
    },
  });
  api.fx([58, 135]);
  api.end();
}
