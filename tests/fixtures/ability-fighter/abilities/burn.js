// Sets the opponent on fire, builds heat; full heat switches to the "hot" stance. The passive cools down.
export function start(api) {
  const r = api.hit({ box: [20, 60, 150, 260], damage: 25, zone: 'mid', effect: { id: 'burn', ticks: 180, dot: 12, label: 'ГОРИТ', color: '#ff7a33', particles: 25 } });
  if (r === 'hit' || r === 'block') {
    const heat = api.addResource('heat', 40);
    if (heat >= 100) api.setStance('hot');
  }
}

export function passive(api) {
  api.mem.t = (api.mem.t || 0) + 1;
  if (api.mem.t % 30 === 0) {
    const heat = api.addResource('heat', -5);
    if (heat <= 0 && api.view().me.stance === 'hot') api.setStance(null);
  }
}
