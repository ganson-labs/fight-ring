// Strong: an ice shard that weaves forward, freezes on touch and slows for a while.
export function start(api) {
  api.spawn({
    x: 70, y: 170, w: 50, h: 50, vx: 7, life: 160, image: 'art/shard.png', color: '#9fe8ff', particles: 30,
    data: { phase: 0 },
    tick(api, o) {
      o.data.phase += 0.15;
      o.vy = Math.sin(o.data.phase) * 3;
    },
    touch: {
      damage: 45, zone: 'mid',
      effect: { id: 'freeze', ticks: 50, stop: true, speed: 0.6, label: 'ЗАМОРОЖЕН', color: '#9fe8ff', icon: 'art/snow.png', particles: 20 },
    },
  });
}
