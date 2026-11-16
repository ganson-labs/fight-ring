// Фигуры-стражи («Связка»). Фигура повисает над соперником и ждёт. Бьёт она в один из моментов:
//  — соперник начал ход (замах приёма, бросок, прыжок), который до меня достаёт;
//  — меня бьют, и серию надо оборвать;
//  — я свободен и успеваю продолжить атаку сам;
//  — время фигуры вышло.
// Удар один, урон по приёму; зона — та, которую блок соперника сейчас не держит.
import { REACH, clampN, hittable, armored, moveOf, openZone, boxOn, busyTicks } from './common.js';

const PIECE = {
  pawn: { damage: 19, life: 280, image: 'fx/pawn.png', color: '#ffd9a0', w: 46, h: 96 },
  rook: { damage: 44, life: 280, image: 'fx/rook.png', color: '#ffb070', w: 54, h: 110 },
  queen: { damage: 44, life: 280, image: 'fx/queen.png', color: '#ff5a2e', w: 56, h: 132 },
};
const FORK = 'fork';
const CASTLE = 'castle';

// Места фигур: за спиной соперника, остриём к нему.
const SLOT = [[84, 236], [132, 196], [112, 300]];

function seat(me, op, slot) {
  const side = op.x >= me.x ? 1 : -1;
  const s = SLOT[slot % SLOT.length];
  let x = op.x + side * s[0];
  if (x < 30 || x > 2170) x = op.x - side * s[0] * 0.6;
  return [x, op.y + s[1]];
}

export function start(api) {
  const v = api.view();
  if (!v) return;
  const p = PIECE[api.move] || PIECE.pawn;
  const me = v.me;
  const op = v.opponent;
  let slot = 0;
  const used = [false, false, false];
  const mine = api.objects();
  for (let i = 0; i < mine.length; i++) {
    const od = mine[i].data;
    if (od && od.phase === 0 && od.slot >= 0) used[od.slot % 3] = true;
  }
  while (slot < 2 && used[slot]) slot++;
  const at = seat(me, op, slot);
  api.spawn({
    x: clampN((at[0] - me.x) * me.facing, -880, 880),
    y: clampN(at[1] + 120 - me.y, 0, 880),
    w: p.w,
    h: p.h,
    life: p.life,
    tick: watch,
    image: p.image,
    color: p.color,
    particles: 10,
    data: { kind: api.move, phase: 0, slot },
  });
  api.fx([(at[0] - me.x) * me.facing, at[1] - me.y]);
}

function strikeLen(damage) {
  return 14 + Math.floor(damage / 6);
}

// Иду ли я на соперника: шаг вперёд или рывок — знак фигурам, что пора.
function advancing(me) {
  if (me.state === 'dash') return me.stateLength === 16;
  return me.state === 'neutral' && me.vx * me.facing > 0.5;
}

// Мой удар уже летит в свободного соперника: фигура бьёт первой, и ответить он не успевает.
function covering(me, op, dist) {
  if (me.state !== 'move' || !me.move || me.move.id !== FORK || me.move.phase !== 'startup') return false;
  if (op.state !== 'neutral' || op.airborne) return false;
  const fork = moveOf(me, FORK);
  return dist <= 35 + REACH[fork.segments[0].reach] + 35 - 10;
}

// Успею ли я сам продолжить после удара фигуры: дойти, дорваться или переставиться рокировкой.
function canFollow(me, op, len) {
  if (!advancing(me)) return false;
  const fork = moveOf(me, FORK);
  if (!fork) return false;
  const seg = fork.segments[0];
  const startup = seg.activeStart;
  const avail = len - startup - busyTicks(me);
  if (avail < 0) return false;
  const castle = moveOf(me, CASTLE);
  if (castle && avail >= castle.duration) return true;
  const reach = 35 + REACH[seg.reach] + 35 - 22;
  const pace = me.derived.walk * me.mods.speed;
  let gain = pace * avail;
  if (me.state === 'dash' && me.stateLength === 16) {
    const k = 1 - me.stateTicks / me.stateLength;
    gain += me.derived.dashDistance * me.mods.speed * k * k;
  }
  const dist = Math.abs(op.x - me.x);
  return dist + 27 - gain <= reach;
}

// Ход соперника, который надо сорвать прямо сейчас.
function threat(me, op, dist, helpless) {
  if (op.state === 'throw') return op.stateTicks <= 7 && dist <= 210;
  if (op.state === 'air') return true;
  if (op.state !== 'move' || !op.move) return false;
  const def = moveOf(op, op.move.id);
  if (!def) return true;
  const idx = op.move.segment;
  if (idx < 0) return false;
  const seg = def.segments[idx];
  if (helpless && seg.type === 'strike' && op.move.phase !== 'recovery') return true;
  if (op.move.phase !== 'startup') return false;
  if (seg.type !== 'strike') return true;
  if (def.posture === 'air') return dist <= 420;
  return dist <= 35 + REACH[seg.reach] + 35 + 80;
}

function watch(api, o) {
  const d = o.data;
  if (d.phase === 1) {
    // удар нанесён: фигура вонзается в соперника и гаснет
    o.vx = (d.dir || 1) * 5;
    o.vy = -22;
    return;
  }
  const v = api.view();
  if (!v) return;
  const me = v.me;
  const op = v.opponent;
  const ox = o.x;
  const oy = o.y;
  // висеть за спиной соперника, слегка покачиваясь
  const at = seat(me, op, d.slot || 0);
  const bob = Math.sin((api.tick + (d.slot || 0) * 20) / 9) * 7;
  o.x = ox + (at[0] - ox) * 0.5;
  o.y = oy + (at[1] + bob - oy) * 0.3;
  o.vx = 0;
  o.vy = 0;

  const mem = api.mem;
  if (mem.fired === api.tick) return;
  if (!hittable(op) || armored(op)) return;
  const p = PIECE[d.kind] || PIECE.pawn;
  const dist = Math.abs(op.x - me.x);
  const hurt = me.state === 'hitstun' || me.state === 'juggle';
  const helpless = hurt || me.state === 'staggered' || me.state === 'dizzy' || me.mods.stop;
  const opHurt = op.state === 'hitstun' || op.state === 'juggle';
  let fire = false;
  if (!opHurt) {
    if (threat(me, op, dist, helpless)) fire = true;
    else if (covering(me, op, dist)) fire = true;
    else if (op.state === 'neutral' && !op.airborne && canFollow(me, op, strikeLen(p.damage))) fire = true;
    else if (o.life <= 1) fire = true;
  }
  if (!fire) return;
  const dx = (op.x - ox) * o.facing;
  const dy = op.y - oy;
  const r = api.hit({ box: boxOn(op, ox, oy, o.facing), damage: p.damage, zone: openZone(op) });
  if (r === 'miss' || r === 'wait') return;
  mem.fired = api.tick;
  api.fx([dx, dy + 160]);
  d.phase = 1;
  d.dir = op.x >= ox ? 1 : -1;
  o.x = op.x - d.dir * 30;
  o.y = op.y + 250;
  o.vx = d.dir * 5;
  o.vy = -22;
  o.life = 9;
}
