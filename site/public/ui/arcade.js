// What makes the pages feel like the game's menus: the menu sounds, the blocks that come in with a hit when they
// reach the window, the numbers that run up, the fighter select. No page needs code of its own: it marks its
// elements (data-rise, data-count, data-select, data-pick) and this file does the rest.
const ROOT = new URL('../', import.meta.url).href;
const html = document.documentElement;
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- sound ----------
// The game keeps its settings in localStorage under ring.settings; the site reads and writes the same record, so
// sound switched off here is off in the game and the other way round.
const KEY = 'ring.settings';
function settings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {}
  return { sound: true, volume: 0.8, menuVolume: 0.8, musicVolume: 0.7, ...saved };
}
function save(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY) || '{}'), ...patch }));
  } catch {}
}
const MENU = ['menu-move', 'menu-select', 'menu-back', 'vs-impact', 'vs-whoosh', 'title-slam'];
let sfx = null;
let sfxP = null;
// A browser lets a page sound only after a press on it, so the player (the game's own, play/sfx.js) is fetched
// and started on the first press, and until then the page is silent.
function audio() {
  if (!settings().sound) return Promise.resolve(null);
  sfxP ??= import(`${ROOT}play/sfx.js`).then((m) => {
    const s = new m.Sfx();
    const c = settings();
    s.set(c.sound, c.volume, c.menuVolume, c.musicVolume);
    s.unlock();
    s.preload(MENU);
    // the menu music goes on from the place the last page left it
    let at = 0;
    try {
      at = Number(sessionStorage.getItem('ring.music')) || 0;
    } catch {}
    s.bed({ music: 'music-menu' }, 1.2, at);
    addEventListener('pagehide', () => {
      try {
        sessionStorage.setItem('ring.music', String(s.bedTime('music')));
      } catch {}
    });
    sfx = s;
    try {
      sessionStorage.setItem('ring.heard', '1');
    } catch {}
    return s;
  }).catch(() => null);
  return sfxP;
}
const sounding = () => !!sfx && sfx.ctx?.state === 'running' && settings().sound;
function play(name, gain = 1) {
  if (sounding()) sfx.play(name, gain);
}
function showSound() {
  const on = settings().sound;
  html.dataset.audio = on ? 'on' : 'off';
  for (const b of document.querySelectorAll('[data-sound]')) b.setAttribute('aria-pressed', String(on));
}
showSound();
for (const b of document.querySelectorAll('[data-sound]')) {
  b.addEventListener('click', async () => {
    const on = !settings().sound;
    save({ sound: on });
    showSound();
    if (sfx) {
      const c = settings();
      sfx.set(c.sound, c.volume, c.menuVolume, c.musicVolume);
    }
    if (on) {
      await audio();
      sfx?.unlock();
      play('menu-select');
    }
  });
}
addEventListener('storage', (e) => e.key === KEY && showSound());

const unlock = () => audio().then((s) => s?.unlock());
addEventListener('pointerdown', unlock, { passive: true });
addEventListener('keydown', unlock);
// A visitor who has already pressed something on the site comes to the next page with the right to sound: the
// page opens with the whoosh of the game's screens.
let heard = false;
try {
  heard = sessionStorage.getItem('ring.heard') === '1';
} catch {}
// The press that brought the visitor here was cut by the change of pages (the sound of a press is three quarters of
// a second, the page went after a tenth): it is finished here from the place it stopped at. The game does the same.
const TAIL = 'ring.press';
function tail() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TAIL) || 'null');
    sessionStorage.removeItem(TAIL);
    const from = t ? (Date.now() - t.at) / 1000 : 9;
    if (from < 0.7 && sounding()) sfx.play(t.name, 1, 0, 0, from);
    return from < 0.7;
  } catch {
    return false;
  }
}
if (heard) audio().then(() => setTimeout(() => tail() || play('vs-whoosh', 0.5), 60));

// what sounds: the things a visitor moves over and presses
const KEYS = '.plate, .nav a, .logo, .tile, .chip, .move, .vs-side, .vs-link, .champ-fig, .rung-name, [data-sfx]';
let over = null;
addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const el = e.target.closest?.(KEYS) ?? null;
  if (el === over) return;
  over = el;
  if (el) play('menu-move', 0.9);
});
addEventListener('focusin', (e) => {
  const el = e.target.closest?.(KEYS);
  if (el && el.matches(':focus-visible')) play('menu-move', 0.9);
});
addEventListener('click', (e) => {
  const el = e.target.closest?.(`${KEYS}, [data-sound]`);
  if (!el || el.hasAttribute('data-sound') || e.defaultPrevented) return;
  play(el.dataset.sfx === 'back' ? 'menu-back' : 'menu-select');
  // the press is heard before the page goes: a link to another page waits for the sound's first beat
  const a = el.closest('a[href]');
  if (!a || !sounding() || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
  e.preventDefault();
  try {
    sessionStorage.setItem(TAIL, JSON.stringify({ name: el.dataset.sfx === 'back' ? 'menu-back' : 'menu-select', at: Date.now() }));
  } catch {}
  setTimeout(() => location.assign(url.href), 110);
});

// ---------- blocks come in when they reach the window ----------
const fmt = new Intl.NumberFormat('ru-RU');
function count(el) {
  const to = Number(el.dataset.count);
  if (!Number.isFinite(to) || STILL) return;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 700);
    el.textContent = fmt.format(Math.round(to * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
let lastHit = 0;
const rise = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target;
    rise.unobserve(el);
    el.classList.add('in');
    for (const n of el.matches('[data-count]') ? [el] : el.querySelectorAll('[data-count]')) count(n);
    // a VS screen lands with the game's impact, but a fast scroll does not turn into a drum roll
    if (el.dataset.rise === 'vs' && performance.now() - lastHit > 500) {
      lastHit = performance.now();
      play('vs-impact', 0.4);
    }
  }
}, { threshold: 0.18 });
for (const el of document.querySelectorAll('[data-rise]')) rise.observe(el);

// ---------- the fighter select ----------
// Tiles (data-pick, with the fighter's card in data-*) and one large preview (data-select). Moving over a tile or
// focusing it selects the fighter; a press opens its page. On a touch screen the first press selects and the
// second opens, as there is nothing to move over.
const select = document.querySelector('[data-select]');
if (select) {
  const tiles = [...document.querySelectorAll('[data-pick]')];
  const part = (name) => select.querySelector(`[data-p="${name}"]`);
  let current = tiles.find((t) => t.classList.contains('on')) ?? null;
  const show = (tile) => {
    if (tile === current) return;
    current?.classList.remove('on');
    current = tile;
    tile.classList.add('on');
    const d = tile.dataset;
    select.style.setProperty('--c', d.color);
    for (const a of select.querySelectorAll('[data-p="link"]')) a.href = tile.href;
    part('name').textContent = d.name;
    part('model').textContent = d.model;
    const author = part('author');
    if (author) author.textContent = d.author || '';
    const motto = part('motto');
    if (motto) motto.textContent = d.motto || '';
    const stats = d.stats ? JSON.parse(d.stats) : null;
    for (const g of select.querySelectorAll('[data-stat]')) {
      const v = stats?.[g.dataset.stat] ?? 0;
      [...g.children].forEach((cell, i) => cell.classList.toggle('on', i < v));
    }
    const img = part('fig')?.querySelector('img');
    if (img) {
      const from = tile.querySelector('img');
      img.srcset = from?.srcset || '';
      img.src = from?.currentSrc || from?.src || '';
    }
    const fig = part('fig');
    if (fig && d.dir) {
      fig.classList.remove('live');
      fig.dataset.dir = d.dir;
      fig.dispatchEvent(new Event('fig:set'));
    }
    // the name lands again for every fighter
    const who = part('who');
    if (who && !STILL) {
      who.classList.remove('hit');
      void who.offsetWidth;
      who.classList.add('hit');
    }
  };
  for (const tile of tiles) {
    tile.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && show(tile));
    tile.addEventListener('focus', () => show(tile));
    tile.addEventListener('pointerdown', (e) => {
      tile.__select = e.pointerType !== 'mouse' && tile !== current;
    });
    tile.addEventListener('click', (e) => {
      if (!tile.__select) return;
      tile.__select = false;
      e.preventDefault();
      show(tile);
      play('menu-move');
    }, true);
  }
}

// ---------- the finder of a long list ----------
// <div data-finder="id of the list">: a search field (data-find), chips of models (data-model) and of orders
// (data-sort). The items are the elements marked data-item inside the list; a block marked data-group that has no
// item left is hidden with its title. Typing anywhere on the page goes to the search, «/» too.
for (const finder of document.querySelectorAll('[data-finder]')) {
  const list = document.getElementById(finder.dataset.finder);
  if (!list) continue;
  const items = [...list.querySelectorAll('[data-item]')].map((el, i) => ({ el, i, parent: el.parentNode, text: `${el.dataset.name || ''} ${el.dataset.model || ''} ${el.dataset.author || ''}`.toLowerCase(), name: el.dataset.name || '', model: el.dataset.model || '', rating: Number(el.dataset.rating) || 0, added: el.dataset.added || '' }));
  const input = finder.querySelector('[data-find]');
  const state = { q: '', model: '', sort: finder.querySelector('[data-sort].on')?.dataset.sort || '' };
  const ORDER = { top: (a, b) => b.rating - a.rating || a.i - b.i, new: (a, b) => b.added.localeCompare(a.added) || a.i - b.i, name: (a, b) => a.name.localeCompare(b.name, 'ru') };
  const apply = (resort = false) => {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const it of items) {
      const on = (!state.model || it.model === state.model) && words.every((w) => it.text.includes(w));
      it.el.hidden = !on;
      if (on) shown++;
    }
    // the order is kept inside each block of the list (the roster, a tournament)
    if (resort && ORDER[state.sort]) for (const it of [...items].sort(ORDER[state.sort])) it.parent.appendChild(it.el);
    for (const g of list.querySelectorAll('[data-group]')) g.hidden = !g.querySelector('[data-item]:not([hidden])');
    const count = finder.querySelector('[data-count-shown]');
    if (count) count.textContent = shown === items.length ? '' : `${shown} / ${items.length}`;
    const none = finder.querySelector('[data-none]');
    if (none) none.hidden = shown > 0;
    for (const b of finder.querySelectorAll('[data-model]')) b.classList.toggle('on', b.dataset.model === state.model), b.setAttribute('aria-pressed', String(b.dataset.model === state.model));
    for (const b of finder.querySelectorAll('[data-sort]')) b.classList.toggle('on', b.dataset.sort === state.sort), b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort));
  };
  input?.addEventListener('input', () => {
    state.q = input.value;
    apply();
  });
  // Enter and the down arrow go from the search to what it found; Esc empties it
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      list.querySelector('[data-item]:not([hidden]) a, a[data-item]:not([hidden])')?.focus();
    } else if (e.key === 'Escape' && input.value) {
      input.value = '';
      state.q = '';
      apply();
    }
  });
  for (const b of finder.querySelectorAll('[data-model]')) b.addEventListener('click', () => {
    state.model = b.dataset.model;
    apply();
  });
  for (const b of finder.querySelectorAll('[data-sort]')) b.addEventListener('click', () => {
    state.sort = b.dataset.sort;
    apply(true);
  });
  addEventListener('keydown', (e) => {
    if (!input || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === ' ' || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === '/') e.preventDefault();
    input.focus();
  });
}

// Arrows walk a grid of tiles as they walk the game's fighter select: left and right to the neighbours, up and down
// to the tile above and below; Home and End to the ends.
addEventListener('keydown', (e) => {
  const cur = e.target.closest?.('a[data-pick]');
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!cur || (!dir && e.key !== 'Home' && e.key !== 'End') || e.ctrlKey || e.metaKey || e.altKey) return;
  const tiles = [...document.querySelectorAll('a[data-pick]')].filter((t) => !t.hidden && t.offsetParent);
  let to = null;
  if (!dir) to = e.key === 'Home' ? tiles[0] : tiles[tiles.length - 1];
  else if (dir[0]) to = tiles[tiles.indexOf(cur) + dir[0]];
  else {
    const a = cur.getBoundingClientRect();
    let best = Infinity;
    for (const t of tiles) {
      const b = t.getBoundingClientRect();
      const dy = (b.top - a.top) * dir[1];
      if (dy < a.height * 0.5) continue;
      const score = dy + Math.abs(b.left - a.left) * 3;
      if (score < best) {
        best = score;
        to = t;
      }
    }
    // the first row goes up to the search
    if (!to && dir[1] < 0) to = document.querySelector('[data-finder] [data-find]');
  }
  if (!to) return;
  e.preventDefault();
  to.focus();
  to.scrollIntoView({ block: 'nearest' });
});

// The game is a page of its own without the site's transition: going there, the cut-in is skipped (otherwise the
// browser starts it and drops it with an error in the game's console).
addEventListener('pageswap', (e) => {
  if (e.viewTransition && /\/play\//.test(e.activation?.entry?.url ?? '')) e.viewTransition.skipTransition();
});
