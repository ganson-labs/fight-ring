// Input of the game: menu navigation (keyboard, mouse, gamepad) and the player's fight controls.
import { brainView } from '../../kit/arena/engine/index.js';
import { parseCommand, readCommand, InputLog, numpad, commandGlyphs, ARROW } from '../../kit/arena/engine/commands.js';

// ---------- menus ----------

// Spatial navigation over the elements marked [data-nav] in the current root: arrows move to the nearest element
// in that direction, Enter/Space/A press it, Esc/Backspace/B go back.
export class Nav {
  constructor({ onMove, onBack, onPress } = {}) {
    this.root = null;
    this.cur = null;
    this.onMove = onMove || (() => {});
    this.onBack = onBack || (() => {});
    this.onPress = onPress || (() => {});
    this.enabled = true;
    this.anyKey = null; // a one-shot handler for "press any key"
    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('pointermove', () => document.body.classList.remove('kbd'));
    document.addEventListener('mouseover', (e) => {
      if (!this.enabled) return;
      const el = e.target.closest?.('[data-nav]');
      // a text field takes the keyboard only when it is pressed, not when the pointer crosses it
      if (el && this.root?.contains(el) && el !== this.cur && !(el instanceof HTMLInputElement)) this.focus(el, { sound: true, scroll: false });
    });
    document.addEventListener('click', (e) => {
      const el = e.target.closest?.('[data-nav]');
      if (el && this.root?.contains(el)) this.onPress(el);
    }, true);
  }

  items() {
    if (!this.root) return [];
    return [...this.root.querySelectorAll('[data-nav]')].filter((el) => !el.disabled && el.offsetParent !== null);
  }

  setRoot(root, prefer = null) {
    this.root = root;
    this.cur = null;
    const list = this.items();
    const first = (prefer && root.querySelector(prefer)) || root.querySelector('[data-autofocus]') || list[0];
    if (first) this.focus(first, { sound: false });
  }

  focus(el, { sound = true, scroll = true } = {}) {
    if (this.cur) this.cur.classList.remove('focus');
    this.cur = el;
    el.classList.add('focus');
    el.focus({ preventScroll: true });
    if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    if (sound) this.onMove(el);
    el.dispatchEvent(new CustomEvent('navfocus', { bubbles: true }));
  }

  move(dx, dy) {
    const list = this.items();
    if (!list.length) return;
    if (!this.cur || !list.includes(this.cur)) return this.focus(list[0]);
    const a = this.cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === this.cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const ddx = bx - ax;
      const ddy = by - ay;
      const along = dx ? ddx * dx : ddy * dy;
      if (along <= 4) continue;
      const across = dx ? Math.abs(ddy) : Math.abs(ddx);
      // overlap along the other axis is preferred: rows and columns stay rows and columns
      // (a real overlap: the cursor's tile is drawn a little larger and would touch the row above by a pixel)
      const overlap = dx ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.height, b.height) * 0.25 : Math.min(a.right, b.right) - Math.max(a.left, b.left) > Math.min(a.width, b.width) * 0.25;
      const score = along + across * (overlap ? 0.3 : 2.5);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.focus(best);
  }

  press() {
    if (this.cur) this.cur.click();
  }

  // A jump over a long grid (PageUp / PageDown, LB / RB): a window of the scrolling box the cursor is in ([data-page])
  // up or down in the same column; to: 'first' | 'last' — Home and End.
  page(dir, to = null) {
    const box = this.cur?.closest('[data-page]') || this.root?.querySelector('[data-page]');
    if (!box) return;
    const list = this.items().filter((el) => box.contains(el));
    if (!list.length) return;
    if (to || !box.contains(this.cur)) return this.focus(to === 'last' ? list[list.length - 1] : list[0]);
    const a = this.cur.getBoundingClientRect();
    const x = a.left + a.width / 2;
    const y = a.top + a.height / 2 + dir * Math.max(a.height, box.clientHeight - a.height);
    let best = null;
    let score = Infinity;
    for (const el of list) {
      const b = el.getBoundingClientRect();
      const s = Math.abs(b.top + b.height / 2 - y) * 3 + Math.abs(b.left + b.width / 2 - x);
      if (s < score) {
        score = s;
        best = el;
      }
    }
    if (best && best !== this.cur) this.focus(best);
  }

  // a direction: left/right on an adjustable element changes its value instead of moving
  dir(dx, dy) {
    if (dx && this.cur?.dataset.adjust !== undefined) this.cur.dispatchEvent(new CustomEvent('adjust', { detail: dx }));
    else this.move(dx, dy);
  }

  key(e) {
    if (this.anyKey) {
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      e.preventDefault();
      const f = this.anyKey;
      this.anyKey = null;
      f();
      return;
    }
    if (!this.enabled) return;
    const k = e.key;
    // a text field: letters, Backspace and the caret keys are its own; up and down leave it, Enter goes to what it
    // found, Esc empties it first and goes back second
    if (e.target instanceof HTMLInputElement) {
      if (k === 'Escape' && e.target.value) {
        e.preventDefault();
        e.target.value = '';
        e.target.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (k === 'Escape') {
        e.preventDefault();
        this.onBack();
      } else if (k === 'ArrowDown' || k === 'Enter' || k === 'ArrowUp') {
        e.preventDefault();
        document.body.classList.add('kbd');
        this.move(0, k === 'ArrowUp' ? -1 : 1);
      }
      return;
    }
    if (k === 'PageDown' || k === 'PageUp' || k === 'Home' || k === 'End') {
      e.preventDefault();
      document.body.classList.add('kbd');
      return this.page(k === 'PageDown' ? 1 : -1, k === 'Home' ? 'first' : k === 'End' ? 'last' : null);
    }
    const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (map[k] && this.cur?.dataset.adjust !== undefined && map[k][0]) {
      e.preventDefault();
      this.cur.dispatchEvent(new CustomEvent('adjust', { detail: map[k][0] }));
      return;
    }
    if (map[k]) {
      e.preventDefault();
      document.body.classList.add('kbd');
      this.move(...map[k]);
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      this.press();
    } else if (k === 'Escape' || k === 'Backspace') {
      e.preventDefault();
      this.onBack();
    }
  }
}

// Gamepad polling: in menus the d-pad and the left stick move (with repeat), A presses, B goes back, Start presses.
export class Pads {
  constructor(nav) {
    this.nav = nav;
    this.prev = new Map();
    this.repeat = { dir: null, next: 0 };
    this.connected = false;
    window.addEventListener('gamepadconnected', () => (this.connected = true));
  }

  first() {
    for (const p of navigator.getGamepads?.() || []) if (p && p.connected) return p;
    return null;
  }

  // the menu side; returns true if a pad is present
  poll(now) {
    const p = this.first();
    if (!p) return false;
    const was = this.prev.get(p.index) || [];
    const down = p.buttons.map((b) => b.pressed);
    const edge = (i) => down[i] && !was[i];
    if (this.nav.anyKey && down.some((d, i) => d && !was[i])) {
      const f = this.nav.anyKey;
      this.nav.anyKey = null;
      f();
    } else if (this.nav.enabled) {
      if (edge(0) || edge(9)) this.nav.press();
      if (edge(1)) this.nav.onBack();
      if (edge(4)) this.nav.page(-1);
      if (edge(5)) this.nav.page(1);
      const ax = p.axes[0] || 0;
      const ay = p.axes[1] || 0;
      const dir = down[12] || ay < -0.6 ? 'u' : down[13] || ay > 0.6 ? 'd' : down[14] || ax < -0.6 ? 'l' : down[15] || ax > 0.6 ? 'r' : null;
      if (dir && (dir !== this.repeat.dir || now >= this.repeat.next)) {
        const first = dir !== this.repeat.dir;
        this.repeat = { dir, next: now + (first ? 380 : 140) };
        this.nav.dir(...{ u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] }[dir]);
      }
      if (!dir) this.repeat.dir = null;
    }
    this.prev.set(p.index, down);
    return true;
  }
}

// ---------- the fight: one human fighter ----------
// Four attack buttons and directions, read as numpad commands (engine/commands.js): the same command list the
// card and the pause screen show. Throw — LP+LK (or H / LB), parry — N / LT, the super also on HP+HK (Space / RT).

export const KEY_OF = { LP: 'U', HP: 'I', LK: 'J', HK: 'K' };
export const PAD_OF = { LP: 'X', HP: 'Y', LK: 'A', HK: 'B' };
export const BTN_NAME = { LP: 'лёгкий рукой', HP: 'сильный рукой', LK: 'лёгкий ногой', HK: 'сильный ногой' };
const KEYS = { KeyU: ['LP'], KeyI: ['HP'], KeyJ: ['LK'], KeyK: ['HK'], Space: ['HP', 'HK'], KeyH: ['LP', 'LK'], KeyN: ['PARRY'] };
const PAD_BUTTONS = { 2: ['LP'], 3: ['HP'], 0: ['LK'], 1: ['HK'], 7: ['HP', 'HK'], 5: ['HP', 'HK'], 4: ['LP', 'LK'], 6: ['PARRY'] };
const ATTACK = new Set(['LP', 'HP', 'LK', 'HK']);

// the fighter's move list in the order fighting games show it: normals, specials, the super
export function moveList(def) {
  const order = { normal: 0, special: 1, super: 2 };
  const post = { stand: 0, crouch: 1, air: 2 };
  return [...def.moves].filter((m) => m.command).sort((a, b) => order[a.slot] - order[b.slot] || post[a.posture] - post[b.posture]);
}

// HTML of a command: arrows and button chips. device: 'kb' | 'pad' | null (button names only)
export function commandHtml(m, device = null) {
  const g = commandGlyphs(m.command, m.posture);
  const btn = (b) => {
    const list = b === 'P' ? ['LP', 'HP'] : b === 'K' ? ['LK', 'HK'] : [b];
    const key = device === 'kb' ? list.map((x) => KEY_OF[x]).join('/') : device === 'pad' ? list.map((x) => PAD_OF[x]).join('/') : '';
    return `<i class="cb ${b.endsWith('P') ? 'p' : 'k'}" title="${list.map((x) => BTN_NAME[x]).join(' или ')}">${b}${key ? `<small>${key}</small>` : ''}</i>`;
  };
  const air = m.posture === 'air' ? '<i class="cj">в прыжке</i>' : '';
  return `<span class="cmd">${air}${g.map((x) => (x.dir ? `<i class="ca ${x.hold ? 'hold' : ''}">${ARROW[x.dir]}</i>` : btn(x.btn))).join('')}</span>`;
}

// the base controls and a few of the fighter's commands (the full list is in the pause screen)
export function controlsHint(def) {
  const base = [['← →', 'шаг'], ['↑', 'прыжок'], ['↓', 'присед'], ['назад', 'блок'], ['→ →', 'рывок'], ['U I J K', 'удары'], ['U+J', 'бросок'], ['N', 'парирование']];
  const specials = moveList(def).filter((m) => m.slot !== 'normal').slice(-3);
  return { base, specials };
}

export function padHint() {
  return [['стик', 'шаг, прыжок, присед'], ['назад', 'блок'], ['X Y A B', 'удары'], ['LB', 'бросок'], ['LT', 'парирование'], ['RT', 'суперприём'], ['Start', 'пауза']];
}

// Reads the keyboard and the first gamepad; act(fight, side) gives the action for this tick.
export class Controls {
  constructor(def) {
    this.def = def;
    this.options = def.moves.filter((m) => m.command).map((m) => ({ id: m.id, slot: m.slot, posture: m.posture, stance: m.stance, command: parseCommand(m.command) }));
    this.down = new Set();
    this.pending = []; // buttons pressed since the last tick
    this.log = new InputLog();
    this.parry = 0;
    this.lastTap = { dir: 0, tick: -99, released: true };
    this.padPrev = [];
    this.started = null;
    this.onKey = (e) => {
      const b = KEYS[e.code];
      if (e.type === 'keydown') {
        if (e.repeat) return;
        this.down.add(e.code);
        if (b) this.pending.push(...b);
        if (b || e.code.startsWith('Arrow') || ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
      } else this.down.delete(e.code);
    };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    this.onBlur = () => this.down.clear();
    window.addEventListener('blur', this.onBlur);
  }

  dispose() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
  }

  pad() {
    for (const p of navigator.getGamepads?.() || []) {
      if (!p || !p.connected) continue;
      const down = p.buttons.map((b) => b.pressed);
      for (const [i, b] of Object.entries(PAD_BUTTONS)) if (down[i] && !this.padPrev[i]) this.pending.push(...b);
      this.padPrev = down;
      const ax = p.axes[0] || 0;
      const ay = p.axes[1] || 0;
      return { left: down[14] || ax < -0.5, right: down[15] || ax > 0.5, up: down[12] || ay < -0.6, down: down[13] || ay > 0.6, attackHeld: [0, 1, 2, 3, 5, 7].some((i) => down[i]) };
    }
    return null;
  }

  act(fight, side) {
    const k = this.down;
    const p = this.pad();
    const left = k.has('ArrowLeft') || k.has('KeyA') || !!p?.left;
    const right = k.has('ArrowRight') || k.has('KeyD') || !!p?.right;
    const up = k.has('ArrowUp') || k.has('KeyW') || !!p?.up;
    const dn = k.has('ArrowDown') || k.has('KeyS') || !!p?.down;
    const v = brainView(fight, side, { live: true });
    const me = v.me;
    const tick = fight.tick;
    const pressed = this.pending.splice(0);
    if (pressed.includes('PARRY')) this.parry = 8;
    this.log.push(tick, numpad({ left, right, up, down: dn }, me.facing), pressed.filter((b) => ATTACK.has(b)));
    const abs = (right ? 1 : 0) - (left ? 1 : 0);
    const walk = abs * (me.facing || 1);
    const a = { walk, crouch: dn, jump: up ? walk : null };
    // double tap a direction: dash — only a clean → → or ← ← through neutral; a motion like 623 (→ ↓ ↘) is not one
    const pure = abs !== 0 && !dn && !up;
    if (pure) {
      if (this.lastTap.released && this.lastTap.dir === abs && tick - this.lastTap.tick < 14) a.dash = walk > 0 ? 'forward' : 'back';
      if (this.lastTap.released) this.lastTap = { dir: abs, tick, released: false };
    } else if (abs === 0 && !dn && !up) this.lastTap.released = true;
    else if (abs === 0 || dn || up) this.lastTap = { dir: 0, tick: -99, released: false };
    // holding back blocks when something is coming
    const threat = v.opponent.state === 'move' || v.opponent.state === 'throwing' || v.projectiles.some((pr) => !pr.mine && Math.abs(pr.x - me.x) < 520);
    if (walk < 0 && threat && !me.airborne) a.guard = dn ? 'low' : 'high';
    const busy = me.state === 'move' || me.state === 'throwing' || me.state === 'parry';
    if (busy && this.started !== null) {
      // a started move uses up the presses that started it
      this.log.presses = this.log.presses.filter((x) => x.tick > this.started);
      this.started = null;
    }
    if (this.parry > 0) {
      a.parry = true;
      this.parry = busy ? 0 : this.parry - 1;
    }
    const got = busy ? null : readCommand(this.log, this.options, { airborne: me.airborne, crouching: dn, stance: me.stance ?? null }, tick);
    if (got?.throw) {
      a.throw = true;
      this.started = tick;
    } else if (got?.move) {
      const m = this.def.movesById[got.move];
      a.attack = m.id;
      a.crouch = m.posture === 'crouch';
      a.dash = null;
      this.started = tick;
    }
    this.lastGot = got;
    // charge: keep holding an attack button
    const held = ['KeyU', 'KeyI', 'KeyJ', 'KeyK', 'Space'].some((c) => k.has(c)) || !!p?.attackHeld;
    if (me.state === 'move' && me.move) a.hold = held;
    return a;
  }
}
