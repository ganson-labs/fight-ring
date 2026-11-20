// The grid of fighters, made for hundreds of them: the fight select and the roster both stand on it.
//   stills are drawn only for the tiles in the window, four at a time, and a fighter loaded for its still is let go
//   search by name, model and author (typing anywhere on the screen goes to the search), a filter by model,
//   sorting by rating, by date and by name
//   PageUp / PageDown / Home / End (LB / RB on a gamepad) jump over the grid, so a long list is not walked tile by tile
import { figureShot, shotCached, shotScale } from './figure.js';
import { withFighter } from './fight.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- stills, drawn when their tile comes into the window ----------

const SHOT = { tile: { w: 200, h: 250 }, waist: { w: 360, h: 480 }, knees: { w: 520, h: 680, crop: 'knees' } };
export const TILE_SHOT = SHOT.tile;
const jobs = [];
let running = 0;
// A still costs a third of a second of loading and drawing a fighter, so it is kept in the browser between visits
// under the hash of the fighter's folder: the second time a grid of hundreds opens at once.
const kept = 'caches' in window ? caches.open('ring-stills-1').catch(() => null) : Promise.resolve(null);
const keptKey = (img, o) => (img.dataset.hash ? `/ring-still/${img.dataset.hash}/${o.crop || 'waist'}-${o.w}x${o.h}@${shotScale()}` : null);
async function still(img, url, opts) {
  const key = keptKey(img, opts);
  const box = key ? await kept : null;
  const hit = box ? await box.match(key).catch(() => null) : null;
  if (hit) return URL.createObjectURL(await hit.blob());
  const src = await withFighter(url, (a) => figureShot(a, opts));
  if (box) fetch(src).then((r) => r.blob()).then((b) => box.put(key, new Response(b, { headers: { 'content-type': 'image/png' } }))).catch(() => {});
  return src;
}
function pump() {
  while (running < 4 && jobs.length) {
    const img = jobs.shift(); // tiles that have left the window since they asked are passed over
    img._queued = false;
    if (!img.isConnected || !img._seen || img.getAttribute('src')) continue;
    running++;
    const url = img.dataset.shot;
    const opts = SHOT[img.dataset.crop || 'waist'];
    still(img, url, opts).then((src) => {
      if (img.dataset.shot === url) show(img, src);
    }).catch(() => {}).finally(() => {
      running--;
      pump();
    });
  }
}
function show(img, src) {
  img.src = src;
  img.classList.add('in');
}
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const img = e.target;
    img._seen = e.isIntersecting;
    if (!e.isIntersecting || img.getAttribute('src')) continue;
    const have = shotCached(img.dataset.shot, SHOT[img.dataset.crop || 'waist']);
    if (have) {
      show(img, have);
      seen.unobserve(img);
    } else if (!img._queued) {
      img._queued = true;
      jobs.push(img);
      pump();
    }
  }
}, { rootMargin: '120px' });

// every <img data-shot="fighter folder"> under root gets its still when it is in the window
export function lazyShots(root) {
  for (const img of root.querySelectorAll('img[data-shot]')) {
    const have = shotCached(img.dataset.shot, SHOT[img.dataset.crop || 'waist']);
    if (have) show(img, have);
    else seen.observe(img);
  }
}
export const shotsWaiting = () => jobs.length + running;

// ---------- the grid ----------

const SORTS = { top: 'Рейтинг', new: 'Новые', name: 'Имя' };
const topVersion = (f) => f.versions[f.versions.length - 1];
const colorsOf = (f) => f.colors || f.versions[0]?.colors || { primary: f.color || '#3a3e4c', accent: f.color || '#ffc94a' };
const born = (f) => String(f.versions[0]?.at || '');

// host: the element the grid fills. fighters: the game's list. state: { q, model, sort } kept by the caller between
// visits. cols(n) → columns for n fighters. onFocus(f), onPick(f): the tile under the cursor and the tile pressed.
// Returns { focus(id), mark(side, id), count }.
export function fighterGrid(host, { fighters, state, cols, onFocus = () => {}, onPick = () => {}, nav }) {
  const main = fighters.filter((f) => !f.training);
  const spar = fighters.filter((f) => f.training);
  const many = main.length > 12;
  // the sparring partners of the kit stand behind a tab of their own: they are not what a player came to see
  state.group = state.group === 'spar' && spar.length ? 'spar' : main.length ? 'main' : 'spar';
  const rated = fighters.some((f) => f.rating);
  state.sort ||= many ? (rated ? 'top' : 'new') : 'given';
  if (state.sort === 'top' && !rated) state.sort = 'new';
  state.q ||= '';
  const models = [...fighters.reduce((m, f) => (f.training ? m : m.set(f.model, (m.get(f.model) || 0) + 1)), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  const tile = (f) => {
    const c = colorsOf(f);
    const v = topVersion(f);
    return `<button class="ft" data-nav data-id="${esc(f.id)}" style="--p:${c.primary};--a:${c.accent}"><img alt="" data-crop="tile" data-shot="${esc(v.url)}"${v.hash ? ` data-hash="${esc(v.hash)}"` : ''}><span class="ft-n">${esc(v.name)}</span><span class="ft-m">${esc(f.model)}</span></button>`;
  };
  const groups = main.length && spar.length ? `<div class="fg-groups"><button class="fg-chip" data-nav data-group="main">Бойцы<i>${main.length}</i></button><button class="fg-chip" data-nav data-group="spar">Спарринг<i>${spar.length}</i></button></div>` : '';
  host.classList.add('fg');
  host.innerHTML = `
    ${many ? `<div class="fg-bar">
      ${groups}
      <label class="fg-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><input data-nav type="search" placeholder="Имя, модель, автор" autocomplete="off" spellcheck="false" value="${esc(state.q)}"></label>
      <div class="fg-sorts">${Object.entries(SORTS).filter(([k]) => k !== 'top' || rated).map(([k, t]) => `<button class="fg-chip" data-nav data-sort="${k}">${t}</button>`).join('')}</div>
      <span class="fg-count"></span>
    </div>
    ${models.length > 1 ? `<div class="fg-models" data-for="main"><button class="fg-chip" data-nav data-model="">Все</button>${models.map(([m, n]) => `<button class="fg-chip" data-nav data-model="${esc(m)}">${esc(m)}<i>${n}</i></button>`).join('')}</div>` : ''}` : groups}
    <div class="fg-grid" data-page>${fighters.map(tile).join('')}</div>
    <div class="fg-none" hidden>Никого не нашлось</div>`;
  const grid = host.querySelector('.fg-grid');
  const input = host.querySelector('.fg-search input');
  const tiles = new Map([...grid.children].map((el) => [el.dataset.id, el]));
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const text = new Map(fighters.map((f) => [f.id, `${topVersion(f).name} ${f.model} ${f.author || ''} ${f.authorGithub || ''}`.toLowerCase()]));
  const order = {
    given: () => 0,
    top: (a, b) => (b.rating || 0) - (a.rating || 0),
    new: (a, b) => born(b).localeCompare(born(a)),
    name: (a, b) => topVersion(a).name.localeCompare(topVersion(b).name, 'ru'),
  };
  let count = fighters.length;

  function refresh() {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const sorted = [...fighters].sort((a, b) => (a.training ? 1 : 0) - (b.training ? 1 : 0) || order[state.sort](a, b));
    count = 0;
    for (const f of sorted) {
      const el = tiles.get(f.id);
      const on = (state.group === 'spar') === !!f.training && (f.training || !state.model || f.model === state.model) && words.every((w) => text.get(f.id).includes(w));
      el.hidden = !on;
      if (on) count++;
      grid.appendChild(el);
    }
    // the size of a tile follows the size of the list, not of what a search has left of it
    const total = state.group === 'spar' ? spar.length : main.length;
    grid.style.setProperty('--cols', cols(total));
    grid.classList.toggle('big', cols(total) <= 6);
    host.querySelector('.fg-none').hidden = count > 0;
    const c = host.querySelector('.fg-count');
    if (c) c.textContent = count === total ? '' : `${count} / ${total}`;
    for (const b of host.querySelectorAll('[data-sort]')) b.classList.toggle('on', b.dataset.sort === state.sort);
    for (const b of host.querySelectorAll('[data-group]')) b.classList.toggle('on', b.dataset.group === state.group);
    const mods = host.querySelector('.fg-models');
    if (mods) mods.hidden = state.group !== 'main';
    for (const b of host.querySelectorAll('[data-model]')) b.classList.toggle('on', b.dataset.model === (state.model || ''));
  }
  refresh();
  lazyShots(grid);

  for (const b of host.querySelectorAll('[data-sort]')) b.onclick = () => {
    state.sort = b.dataset.sort;
    refresh();
    grid.scrollTop = 0;
  };
  for (const b of host.querySelectorAll('[data-group]')) b.onclick = () => {
    state.group = b.dataset.group;
    refresh();
    grid.scrollTop = 0;
  };
  for (const b of host.querySelectorAll('[data-model]')) b.onclick = () => {
    state.model = b.dataset.model || null;
    refresh();
    grid.scrollTop = 0;
  };
  input?.addEventListener('input', () => {
    state.q = input.value;
    refresh();
    grid.scrollTop = 0;
  });
  for (const el of tiles.values()) {
    el.addEventListener('navfocus', () => onFocus(byId.get(el.dataset.id), el));
    el.onclick = () => onPick(byId.get(el.dataset.id), el);
  }
  // typing anywhere on the screen goes to the search: no walking to the field first
  if (input) {
    const type = (e) => {
      if (!host.isConnected) return removeEventListener('keydown', type, true);
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === ' ' || e.target instanceof HTMLInputElement) return;
      if (!nav.enabled || !nav.root?.contains(input)) return;
      nav.focus(input, { sound: false });
    };
    addEventListener('keydown', type, true);
  }

  return {
    get count() {
      return count;
    },
    tile: (id) => tiles.get(id),
    // the tile of a fighter, with its tab opened when the fighter stands behind the other one
    reveal(id) {
      const f = byId.get(id);
      if (f && (state.group === 'spar') !== !!f.training) {
        state.group = f.training ? 'spar' : 'main';
        refresh();
      }
      const el = tiles.get(id);
      return el && !el.hidden ? el : null;
    },
    first: () => [...grid.children].find((el) => !el.hidden) || null,
    // which side has taken which fighter: a corner mark in that side's colour
    mark(side, id) {
      for (const el of tiles.values()) el.classList.toggle(`pick-${side}`, el.dataset.id === id);
    },
    reset() {
      state.q = '';
      state.model = null;
      if (input) input.value = '';
      refresh();
    },
  };
}
