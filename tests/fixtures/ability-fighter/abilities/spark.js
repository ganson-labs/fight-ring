// Weak: one small hit right in front.
export function start(api) {
  api.hit({ box: [20, 100, 140, 240], damage: 20, zone: 'mid' });
  api.fx([90, 170]);
}
