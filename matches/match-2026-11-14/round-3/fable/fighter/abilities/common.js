// Общие расчёты фигур-стражей и суперприёма. Всё состояние — в api.mem и в data объектов.

export const REACH = { short: 55, mid: 95, long: 150 };

export function clampN(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Можно ли попасть по сопернику прямо сейчас: есть коробка тела и окно парирования закрыто.
export function hittable(op) {
  if (op.invulnerable) return false;
  if (op.state === 'parry' && op.stateTicks <= 6) return false;
  return true;
}

// Броня на замахе у соперника: удар её не пробьёт, лучше подождать.
export function armored(op) {
  const m = op.move;
  if (!m || m.armorLeft <= 0) return false;
  const def = moveOf(op, m.id);
  return !def || m.t < def.segments[0].activeStart;
}

export function moveOf(F, id) {
  const list = F.moves;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

// Зона, которую блок соперника сейчас не держит.
export function openZone(op) {
  if (op.airborne) return 'mid';
  if (op.state !== 'neutral' && op.state !== 'blockstun') return 'mid';
  if (op.guard === 'high') return 'low';
  if (op.guard === 'low') return 'overhead';
  return 'mid';
}

// Коробка удара вокруг соперника, от объекта в точке (ox, oy) с направлением facing.
export function boxOn(op, ox, oy, facing) {
  const dx = (op.x - ox) * facing;
  const dy = op.y - oy;
  return [dx - 42, dy + 2, dx + 42, dy + 280];
}

// Через сколько тиков боец снова сможет начать действие (0 — может уже сейчас).
export function busyTicks(F) {
  if (F.mods && F.mods.stop) return 999;
  switch (F.state) {
    case 'neutral':
      return 0;
    case 'move':
      return F.move ? F.move.duration - F.move.t : 999;
    case 'dash':
    case 'landing':
    case 'techBreak':
      return F.stateLength - F.stateTicks;
    default:
      return 999;
  }
}
