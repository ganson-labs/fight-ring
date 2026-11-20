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
  return { sound: true, volume: 0.8, menuVolume: 0.8, ...saved };
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
    s.set(c.sound, c.volume, c.menuVolume);
    s.unlock();
    s.preload(MENU);
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
      sfx.set(c.sound, c.volume, c.menuVolume);
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
if (heard) audio().then(() => setTimeout(() => play('vs-whoosh', 0.5), 160));

// what sounds: the things a visitor moves over and presses
const KEYS = '.plate, .nav a, .logo, .tile, .chip, .move, .vs-side, .vs-link, .champ-fig, [data-sfx]';
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

// The game is a page of its own without the site's transition: going there, the cut-in is skipped (otherwise the
// browser starts it and drops it with an error in the game's console).
addEventListener('pageswap', (e) => {
  if (e.viewTransition && /\/play\//.test(e.activation?.entry?.url ?? '')) e.viewTransition.skipTransition();
});
