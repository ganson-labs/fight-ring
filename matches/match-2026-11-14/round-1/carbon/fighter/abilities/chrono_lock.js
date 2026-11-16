// Петля Безвременья (Chrono Lock): freezes the opponent in stopped time through guard, setting up untechable throws.

export function start(api) {
  const v = api.view();
  let dist = v ? v.distance : 120;
  if (dist > 88) {
    const moved = api.shove('me', Math.min(12, dist - 88));
    dist -= moved;
  }
  api.addResource('chrono', -25);
  const applied = api.effect('opponent', {
    id: 'chrono_stop',
    ticks: 30,
    stop: true,
    box: [-20, 0, 195, 310],
    label: 'ХРОНО-СТОП',
    color: '#2ef2ff',
    particles: 110,
  });
  if (applied) {
    api.fx([Math.min(dist, 160), 150]);
  } else {
    api.fx([75, 140]);
  }
  api.end();
}
