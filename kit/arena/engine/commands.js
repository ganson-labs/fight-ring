// Commands: how a human starts each move, written in numpad notation the way fighting games write them.
// Directions are relative to the opponent (6 — towards, 4 — away), so the same input works on both sides:
//   7 8 9
//   4 5 6
//   1 2 3
// Buttons: LP, HP (light and heavy punch), LK, HK (kicks); P — any punch, K — any kick; PP, KK — two at once.
// "236P" quarter circle forward + punch, "623K" dragon punch, "[4]6P" charge back then forward, "236236P" double
// quarter circle. Brains never use commands: they start a move by its id. Pure module: game, check and tests.

export const BUTTONS = ['LP', 'HP', 'LK', 'HK'];
const TOKENS = { LP: ['LP'], HP: ['HP'], LK: ['LK'], HK: ['HK'], P: ['LP', 'HP'], K: ['LK', 'HK'], PP: ['LP', 'HP'], KK: ['LK', 'HK'] };
const TWO = new Set(['PP', 'KK']);
// built in: throw — LP+LK, the super — HP+HK as well as its own command
export const THROW_BUTTONS = ['LP', 'LK'];
export const SUPER_BUTTONS = ['HP', 'HK'];

const RE = /^(?:\[([1-9])\])?([1-9]*)(LP|HP|LK|HK|PP|KK|P|K)$/;

// Returns { raw, charge, motion: [digits], token, buttons: [..], two } or { error }.
export function parseCommand(raw) {
  if (typeof raw !== 'string') return { error: 'строка в нумпад-записи, например "236P"' };
  const m = RE.exec(raw.trim().toUpperCase());
  if (!m) return { error: `"${raw}": направления цифрами 1–9 (6 — к сопернику), заряд в скобках [4], в конце кнопка LP, HP, LK, HK, P, K, PP или KK` };
  const charge = m[1] ? Number(m[1]) : null;
  let motion = m[2].split('').map(Number);
  if (motion.length === 1 && motion[0] === 5) motion = [];
  if (motion.length > 8) return { error: `"${raw}": движение длиннее 8 направлений` };
  for (let i = 1; i < motion.length; i++) if (motion[i] === motion[i - 1]) return { error: `"${raw}": одно направление два раза подряд пишется один раз (двойное нажатие — через 5, например 656)` };
  if (charge !== null && (motion.length !== 1 || charge === 5)) return { error: `"${raw}": заряд — одно направление в скобках и одно после, например [4]6P или [2]8K` };
  const token = m[3];
  return { raw: raw.trim().toUpperCase(), charge, motion: motion.filter((d) => d !== 5 || motion.length > 1), token, buttons: TOKENS[token], two: TWO.has(token) };
}

// a command that is just a button with at most one direction: a normal; anything longer: a special
const isPlain = (c) => !c.charge && c.motion.length <= 1 && !c.two;

const DOWN = new Set([1, 2, 3]);
const limbClass = (m) => m.limb || 'P';

// The command of every move: its own "command" or a free one the ring picks by slot, posture and limb.
// moves: compiled moves ({ id, slot, posture, command?, totalDamage, limb? }). Returns { byId, errors }.
export function assignCommands(moves) {
  const errors = [];
  const byId = {};
  const taken = [];
  const clash = (posture, stance, c) => taken.find((t) => overlap(t, { posture, stance, c }));
  const take = (m, c) => {
    byId[m.id] = c;
    taken.push({ id: m.id, posture: m.posture, stance: m.stance ?? null, c });
  };
  // own commands first
  for (const m of moves) {
    if (m.command == null) continue;
    const c = parseCommand(m.command);
    if (c.error) {
      errors.push(`${m.id} → command: ${c.error}`);
      continue;
    }
    const e = shapeError(m, c);
    if (e) {
      errors.push(`${m.id} → command "${c.raw}": ${e}`);
      continue;
    }
    const other = clash(m.posture, m.stance ?? null, c);
    if (other) {
      errors.push(`${m.id} → command "${c.raw}" пересекается с командой "${other.c.raw}" приёма ${other.id}`);
      continue;
    }
    take(m, c);
  }
  // the rest: lightest normals get light buttons, specials the classic motions, the super a double quarter circle
  const NORMALS = { P: ['LP', 'HP', '6HP', '4HP', '6LP', '4LP'], K: ['LK', 'HK', '6HK', '4HK', '6LK', '4LK'] };
  const SPECIALS = { P: ['236P', '214P', '623P', '[4]6P', '41236P', '421P', '63214P', 'PP'], K: ['236K', '214K', '623K', '[2]8K', '63214K', '421K', '41236K', 'KK'] };
  const SUPERS = { P: ['236236P', '214214P', '236236K', '214214K'], K: ['236236K', '214214K', '236236P', '214214P'] };
  const free = (m, list) => {
    for (let s of list) {
      if (m.posture === 'crouch' && m.slot === 'normal') s = `${/^[46]/.test(s) ? (s[0] === '6' ? '3' : '1') + s.slice(1) : `2${s}`}`;
      const c = parseCommand(s);
      if (!shapeError(m, c) && !clash(m.posture, m.stance ?? null, c)) return c;
    }
    return null;
  };
  const rest = moves.filter((m) => !byId[m.id] && m.command == null).sort((a, b) => (a.totalDamage || 0) - (b.totalDamage || 0));
  for (const m of rest) {
    const own = limbClass(m);
    const alt = own === 'P' ? 'K' : 'P';
    const lists = m.slot === 'normal' ? [NORMALS[own], NORMALS[alt]] : m.slot === 'super' ? [SUPERS[own]] : [SPECIALS[own], SPECIALS[alt]];
    const c = free(m, lists.flat());
    if (c) take(m, c);
    else errors.push(`${m.id}: ринг не нашёл свободной команды, задай command сам`);
  }
  return { byId, errors };
}

function shapeError(m, c) {
  if (m.slot === 'normal') {
    if (!isPlain(c)) return 'у обычного приёма команда — кнопка и не больше одного направления (например "HK", "6HP", "2LK")';
    const d = c.motion[0];
    if (m.posture === 'stand' && d !== undefined && (DOWN.has(d) || d >= 7)) return 'стоя направление 4 или 6 (вниз — это присед, вверх — прыжок)';
    if (m.posture === 'crouch' && d !== undefined && !DOWN.has(d)) return 'присев направление 1, 2 или 3';
    return null;
  }
  if (isPlain(c)) return 'у особого приёма и суперприёма нужно движение, заряд или две кнопки (например "236P", "[4]6K", "PP")';
  return null;
}

// do two commands catch the same input?
function overlap(a, b) {
  const ground = (p) => (p === 'air' ? 'air' : 'ground');
  const plain = isPlain(a.c) && isPlain(b.c);
  if (plain ? a.posture !== b.posture : ground(a.posture) !== ground(b.posture)) return false;
  if (a.stance && b.stance && a.stance !== b.stance) return false;
  const dir = (x) => (isPlain(x.c) && x.posture === 'crouch' && !x.c.motion.length ? [2] : x.c.motion);
  if (a.c.charge !== b.c.charge || a.c.two !== b.c.two || dir(a).join('') !== dir(b).join('')) return false;
  return a.c.buttons.some((x) => b.c.buttons.includes(x));
}

// ---------- reading the input ----------

export const INPUT = {
  buffer: 8, // ticks a pressed button waits for its move to become possible
  stepWindow: 10, // ticks allowed between two directions of a motion
  lastWindow: 8, // the last direction of a motion at most this long before the button
  chargeTicks: 30, // a charge direction held this long
  chargeRelease: 12, // ticks between leaving the charge and the button
  together: 3, // two buttons "at once": pressed this close
};

// numpad direction from held keys, relative to the opponent
export function numpad({ left, right, up, down }, facing = 1) {
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const fx = x * (facing || 1);
  const y = up && !down ? 1 : down && !up ? -1 : 0;
  return 5 + fx + y * 3;
}

// Input history of one player: a direction for every tick and button presses with their ticks.
export class InputLog {
  constructor() {
    this.dirs = []; // [{ tick, dir }]
    this.presses = []; // [{ tick, btn }]
  }
  push(tick, dir, pressed = []) {
    this.dirs.push({ tick, dir });
    for (const btn of pressed) this.presses.push({ tick, btn });
    const keep = tick - 90;
    while (this.dirs.length && this.dirs[0].tick < keep) this.dirs.shift();
    while (this.presses.length && this.presses[0].tick < keep) this.presses.shift();
  }
  dirAt(tick) {
    for (let i = this.dirs.length - 1; i >= 0; i--) if (this.dirs[i].tick <= tick) return this.dirs[i].dir;
    return 5;
  }
}

// was the motion entered, ending at most lastWindow ticks before tick?
function motionDone(log, motion, tick) {
  if (motion.length <= 1) return true;
  // walk backwards: last step first; middle diagonals may be skipped (26 counts as 236)
  const steps = motion.map((d, i) => ({ d, optional: i > 0 && i < motion.length - 1 && d % 2 === 1 }));
  let i = steps.length - 1;
  let limit = tick - INPUT.lastWindow;
  let last = null;
  for (let k = log.dirs.length - 1; k >= 0 && i >= 0; k--) {
    const e = log.dirs[k];
    if (e.tick > tick) continue;
    if (e.tick < limit) {
      if (steps[i].optional) {
        i--;
        k++;
        continue;
      }
      return false;
    }
    if (e.dir === steps[i].d) {
      last = e.tick;
      i--;
      limit = last - INPUT.stepWindow;
    } else if (steps[i].optional && i > 0 && e.dir === steps[i - 1].d) {
      i -= 2;
      last = e.tick;
      limit = last - INPUT.stepWindow;
    }
  }
  while (i >= 0 && steps[i].optional) i--;
  return i < 0;
}

function chargeDone(log, from, to, tick) {
  const back = (d) => d === from || (from % 3 === 1 && (d === from - 3 || d === from + 3)) || (from <= 3 && (d === from - 1 || d === from + 1) && d >= 1 && d <= 3);
  const fwd = (d) => d === to || (to % 3 === 0 && (d === to - 3 || d === to + 3)) || (to >= 7 && (d === to - 1 || d === to + 1) && d >= 7);
  // find the release: the latest tick with the forward direction, before it a run of the charge direction
  for (let k = log.dirs.length - 1; k >= 0; k--) {
    const e = log.dirs[k];
    if (e.tick > tick) continue;
    if (tick - e.tick > INPUT.chargeRelease) return false;
    if (!fwd(e.dir)) continue;
    let run = 0;
    let j = k - 1;
    while (j >= 0 && fwd(log.dirs[j].dir)) j--;
    const end = j >= 0 ? log.dirs[j].tick : null;
    while (j >= 0 && back(log.dirs[j].dir)) {
      run = end - log.dirs[j].tick + 1;
      j--;
    }
    if (run >= INPUT.chargeTicks) return true;
  }
  return false;
}

// the press (or the pair of presses) of this command's button(s), the newest one at most `buffer` ticks old
function buttonsDone(log, c, tick) {
  const recent = log.presses.filter((p) => tick - p.tick <= INPUT.buffer && p.tick <= tick);
  if (!c.two) {
    const p = [...recent].reverse().find((x) => c.buttons.includes(x.btn));
    return p ? p.tick : null;
  }
  const a = [...recent].reverse().find((x) => x.btn === c.buttons[0]);
  const b = [...recent].reverse().find((x) => x.btn === c.buttons[1]);
  return a && b && Math.abs(a.tick - b.tick) <= INPUT.together ? Math.max(a.tick, b.tick) : null;
}

// What the input asks for at this tick. options: list of { id, posture, slot, stance, command (parsed) }.
// state: { airborne, crouching, stance }. Returns { move, throw, at } or null. Longer commands win.
export function readCommand(log, options, state, tick) {
  // built in: both heavies — the super, both lights — the throw
  const pairs = (btns) => buttonsDone(log, { two: true, buttons: btns }, tick);
  const candidates = [];
  const sup = options.find((o) => o.slot === 'super');
  for (const o of options) {
    if (o.stance && o.stance !== state.stance) continue;
    const c = o.command;
    if (!c) continue;
    const air = o.posture === 'air';
    if (air !== !!state.airborne) continue;
    if (isPlain(c)) {
      if (o.posture === 'crouch' && !state.crouching) continue;
      if (o.posture === 'stand' && state.crouching) continue;
    }
    const at = buttonsDone(log, c, tick);
    if (at === null) continue;
    if (c.charge !== null && !chargeDone(log, c.charge, c.motion[0], at)) continue;
    if (c.charge === null && !motionDone(log, c.motion, at)) continue;
    let rank;
    if (isPlain(c)) {
      const want = c.motion[0] ?? (o.posture === 'crouch' ? null : 5);
      const now = log.dirAt(at);
      if (want !== null && want !== 5 && now !== want) continue;
      rank = want === null || want === 5 ? 0 : 1; // a direction normal beats the neutral one
    } else rank = 10 + (c.charge !== null ? 3 : c.motion.length) + (c.two ? 1 : 0) + (o.slot === 'super' ? 20 : 0);
    candidates.push({ o, rank, at });
  }
  if (sup && sup.posture === 'air' ? !!state.airborne : !state.airborne) {
    const at = pairs(SUPER_BUTTONS);
    if (at !== null) candidates.push({ o: sup, rank: 40, at });
  }
  if (!state.airborne) {
    const at = pairs(THROW_BUTTONS);
    if (at !== null) candidates.push({ o: null, throw: true, rank: 9, at });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rank - a.rank || b.at - a.at);
  const best = candidates[0];
  return best.throw ? { throw: true, at: best.at } : { move: best.o.id, at: best.at };
}

// for the screen: "236P" → [{ dir: 2 }, { dir: 3 }, { dir: 6 }, { btn: 'P' }]
export function commandGlyphs(raw, posture = 'stand') {
  const c = typeof raw === 'string' ? parseCommand(raw) : raw;
  if (!c || c.error) return [];
  const out = [];
  if (c.charge !== null) out.push({ dir: c.charge, hold: true });
  const motion = isPlain(c) && posture === 'crouch' && !c.motion.length ? [2] : c.motion;
  for (const d of motion) out.push({ dir: d });
  if (c.two) out.push({ btn: c.token[0] }, { btn: c.token[0] });
  else out.push({ btn: c.token });
  return out;
}

export const ARROW = { 1: '↙', 2: '↓', 3: '↘', 4: '←', 5: '•', 6: '→', 7: '↖', 8: '↑', 9: '↗' };
