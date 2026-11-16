// «Шах и мат». Над соперником встаёт король и опускается, как только по сопернику можно попасть
// чисто: вне серии, вне окна парирования, в зону, которую не держит блок.
import { clampN, hittable, armored, openZone, boxOn } from './common.js';

const DAMAGE = 250;
const LIFE = 80;
const HOVER = 470;

export function start(api) {
  const v = api.view();
  if (!v) return;
  const me = v.me;
  const op = v.opponent;
  const dx = clampN((op.x - me.x) * me.facing, -880, 880);
  api.spawn({
    x: dx,
    y: clampN(op.y + HOVER - me.y, 0, 880),
    w: 80,
    h: 190,
    life: LIFE,
    tick: verdict,
    image: 'fx/king.png',
    color: '#ff5a2e',
    particles: 40,
    data: { phase: 0 },
  });
}

function verdict(api, o) {
  const d = o.data;
  if (d.phase === 1) {
    o.vy = -24;
    return;
  }
  const v = api.view();
  if (!v) return;
  const op = v.opponent;
  const ox = o.x;
  const oy = o.y;
  o.x = ox + (op.x - ox) * 0.7;
  o.y = oy + (op.y + HOVER - oy) * 0.4;
  o.vx = 0;
  o.vy = 0;
  if (!hittable(op)) return;
  const last = o.life <= 1;
  // в серии удар слабеет: ждём, пока соперник выйдет из неё, но не дольше жизни фигуры
  if (!last && (op.combo > 0 || op.state === 'hitstun' || op.state === 'juggle' || armored(op))) return;
  api.effect('opponent', { id: 'check', taken: 1.25, ticks: 10, label: 'ШАХ', color: '#ff5a2e', particles: 60 });
  const r = api.hit({ box: boxOn(op, ox, oy, o.facing), damage: DAMAGE, zone: openZone(op), launch: true });
  if (r === 'miss' || r === 'wait') return;
  api.fx([(op.x - ox) * o.facing, op.y - oy + 160]);
  d.phase = 1;
  o.x = op.x;
  o.y = op.y + 320;
  o.vy = -24;
  o.life = 12;
}
