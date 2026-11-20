// «Ринг моделей» — the game. Title, main menu, roster with fighter cards and their versions, matches with the
// locker room between rounds, a fight of two brains, a fight of the player against a brain, settings.
// Everything it shows comes from /api/game: the judge's match snapshots and the contestants' folders.
import * as E from '../../kit/arena/engine/index.js';
import { Sfx, GESTURES } from '../sfx.js';
import { at, ROOT, loadGame, fullFighter, fullMatch } from '../data.js';
import { ringFonts } from '../../kit/arena/render/text.js';
import { Nav, Pads, controlsHint, padHint, moveList, commandHtml, KEY_OF, PAD_OF, BTN_NAME } from './input.js';
import { MenuSound } from './sound.js';
import { figureShot, shotCached, FigureView } from './figure.js';
import { FightView, LiveMatch, computeFight, fighterAssets, previewAssets, heldFighters, useLightPictures, stageAssets, expand } from './fight.js';
import { fighterGrid, lazyShots, shotsWaiting, TILE_SHOT } from './select.js';
import { Backdrop } from './backdrop.js';
import { Intro } from './intro.js';
import { tournamentScreen } from './tournament.js';
import { resultFor, lockerFor, resultScreen, quickStats, storyHtml, matchStatsView, protocolView, changesView, icon, saidPlain, SCREEN_SOUNDS } from './screens.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const q = new URLSearchParams(location.search);

// ---------- settings ----------

const DEFAULTS = { sound: true, volume: 0.8, menuVolume: 0.8, musicVolume: 0.7, aspect: '16:9', ads: false, quality: 'high', fullscreen: false };
let settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('ring.settings') || '{}'));
} catch {}
const saveSettings = () => {
  try {
    localStorage.setItem('ring.settings', JSON.stringify(settings));
  } catch {}
  applySettings();
};

// A phone or a tablet: fingers and no mouse. It shows the fight in the shape it is held in (9:16 upright, 16:9 on
// its side) and has no «Кадр боя» setting; an iPhone has no full screen for a page at all.
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const CAN_FS = !!document.documentElement.requestFullscreen && document.fullscreenEnabled !== false;
document.body.classList.toggle('touch', TOUCH);
document.body.classList.toggle('no-fs', !CAN_FS);
const frameAspect = () => (TOUCH ? (window.innerHeight > window.innerWidth ? '9:16' : '16:9') : settings.aspect);
const PRESS = TOUCH ? 'Коснись экрана' : 'Нажми любую клавишу';

const sfx = new Sfx();
sfx.ahead(['menu-move', 'menu-select', 'menu-back', 'music-menu', 'vs-impact', 'vs-whoosh', 'whoosh-light', 'whoosh-heavy']);
const menu = new MenuSound(sfx);
function applySettings() {
  sfx.set(settings.sound, settings.volume, settings.menuVolume, settings.musicVolume);
  document.body.classList.toggle('q-medium', settings.quality === 'medium');
  fightView?.fit();
}

// full screen: F or the button in the corner; the choice is remembered and comes back on the first key press
function setFullscreen(on) {
  if (!CAN_FS) return;
  const el = document.documentElement;
  try {
    if (on && !document.fullscreenElement) el.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  } catch {}
}
function toggleFullscreen() {
  if (!CAN_FS) return;
  settings.fullscreen = !document.fullscreenElement;
  saveSettings();
  setFullscreen(settings.fullscreen);
  const top = stack[stack.length - 1];
  if (top?.name === 'settings') setTimeout(() => SCREENS.settings({}, null), 120);
}
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    toggleFullscreen();
  }
});

// ---------- state ----------

let data = { fighters: [], matches: [], stages: [] };
const stack = [];
const ui = $('#ui');
const overlay = $('#overlay');
const fightView = new FightView({ frame: $('#frame'), settings: () => ({ ...settings, aspect: frameAspect() }), sfx });
applySettings();
$('#fsBtn')?.addEventListener('click', () => toggleFullscreen());
const backdrop = new Backdrop($('#bg'));
let fighting = null; // { kind, pause() } while a fight is on screen
let cardView = null;

const nav = new Nav({
  onMove: () => menu.move(),
  onBack: () => back(),
  onPress: (el) => (el.dataset.sfx ? el.dataset.sfx !== 'none' && sfx.play(el.dataset.sfx, Number(el.dataset.gain || 0.6)) : menu.confirm()),
});

// The menu music: on from the first press, gives way to the stage's music for a fight and comes back after it. The
// site plays the same track (site/public/ui/arcade.js) and both keep the place in sessionStorage, so going from the
// site into the game and back does not start it over.
const MUSIC_KEY = 'ring.music';
function menuMusic() {
  if (!sfx.ctx || fighting || sfx.beds?.music?.name === 'music-menu') return;
  let from = 0;
  try {
    from = Number(sessionStorage.getItem(MUSIC_KEY)) || 0;
  } catch {}
  sfx.bed({ music: 'music-menu' }, 1.2, from);
}
function keepMusicPlace() {
  if (sfx.beds?.music?.name !== 'music-menu' || !sfx.beds.music.src) return;
  try {
    sessionStorage.setItem(MUSIC_KEY, String(sfx.bedTime('music')));
  } catch {}
}
addEventListener('pagehide', keepMusicPlace);
// A browser gives a page its sound only after a press on it: whatever screen the game opened on, the first press
// anywhere turns the sound on.
let soundOn = false;
function wakeSound() {
  sfx.unlock();
  if (soundOn || sfx.ctx.state !== 'running') return;
  soundOn = true;
  sfx.preload();
  menuMusic();
}
// (every kind of press: a finger gives the sound on its way up, not down — sfx.js GESTURES)
let waking = false;
for (const ev of GESTURES) addEventListener(ev, () => {
  sfx.unlock();
  if (soundOn || waking) return wakeSound();
  waking = true;
  // on an iPhone this stays unanswered until a press that counts comes
  sfx.ctx.resume().then(wakeSound, () => {}).finally(() => (waking = false));
}, true);
// the sound an iPhone took away (a call, another app) comes back with the page
document.addEventListener('visibilitychange', () => !document.hidden && soundOn && sfx.ctx.state !== 'running' && sfx.ctx.resume().catch(() => {}));
const pads = new Pads(nav);
// «Ты против нейросети» needs something to fight with. A phone has neither keys nor a gamepad, so there the game is
// for watching: the mode is offered once a gamepad is connected or a real key has been pressed.
let sawKey = false;
addEventListener('keydown', (e) => {
  if (e.isTrusted && !(e.target instanceof HTMLInputElement)) sawKey = true;
}, true);
const handsOn = () => !TOUCH || sawKey || !!pads.first();
addEventListener('gamepadconnected', () => {
  const top = stack[stack.length - 1];
  if (TOUCH && !fighting && ['main', 'versus', 'play', 'custom'].includes(top?.name)) render(top, true);
});

const fighterById = (id) => data.fighters.find((f) => f.id === id);
const contestants = () => data.fighters.filter((f) => !f.training);
const topVersion = (f) => f.versions[f.versions.length - 1];
const versionOf = (f, v) => f.versions.find((x) => x.v === v) || topVersion(f);
const colorsOf = (f, v = null) => (v ? versionOf(f, v).colors : f.colors) || f.versions[0]?.colors || { primary: f.color || '#3a3e4c', accent: f.color || '#ffc94a' };
const cssColors = (c) => `--p:${c.primary};--a:${c.accent}`;
const stageById = (id) => data.stages.find((s) => s.id === id);
const fmtDate = (iso) => {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
};
const SLOT = { normal: 'удар', special: 'особый', super: 'супер' };
const POSTURE = { stand: 'стоя', crouch: 'присев', air: 'в прыжке' };
const KIND = { intro: 'представление', taunt: 'дразнилка', super: 'супер', hit: 'удар', hurt: 'боль', victory: 'победа', defeat: 'поражение', other: 'другое' };

function versionWhen(f, v) {
  if (!v.rounds.length) return f.training ? 'набор' : f.roster ? 'общий набор' : 'в папке сейчас';
  const r = v.rounds[0];
  const lockers = r.round - 1;
  return lockers === 0 ? 'до первого раунда' : `после раздевалки ${lockers}`;
}

function roundTitle(r, firstTo = 2) {
  const decider = r.wins[0] === firstTo - 1 && r.wins[1] === firstTo - 1;
  const head = decider ? 'Решающий раунд' : `Раунд ${r.num}`;
  return r.rerun ? `${head} · переигровка` : head;
}

function roundResult(m, r) {
  const t = `${((r.ticks || 0) / 60).toFixed(1)} с`;
  if (!r.winner) return `<b>Ничья</b> · ${r.reason === 'ko' ? 'двойной нокаут' : 'по времени'} · ${t}`;
  return `Победа <b>${esc(r.names[r.winner])}</b> · ${r.reason === 'ko' ? 'нокаут' : 'по времени'} · ${t}`;
}

// ---------- screens ----------

// A heading that must stay one line (a fighter's name up to 20 letters, a move name): its size goes down until it
// fits its box, at most to 55 %; past that it wraps onto balanced lines with room for the accents.
function fitText(el) {
  el.style.fontSize = '';
  el.classList.remove('fit-wrap');
  if (!el.clientWidth) return;
  const over = () => el.scrollWidth > el.clientWidth + 1;
  const base = parseFloat(getComputedStyle(el).fontSize);
  let size = base;
  while (over() && size > base * 0.55) {
    size -= Math.max(1, base * 0.04);
    el.style.fontSize = `${size}px`;
  }
  if (over()) el.classList.add('fit-wrap');
}
const fitAll = (root = document) => root.querySelectorAll('[data-fit]').forEach(fitText);
// A window larger than 1080p shows the menus as a larger 1080p (zoom keeps the text in the window's real pixels);
// the fight frame and the screens between rounds size themselves.
function uiZoom() {
  const z = Math.max(1, Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
  document.documentElement.style.setProperty('--z', z.toFixed(4));
}
uiZoom();
window.addEventListener('resize', () => {
  uiZoom();
  fitAll();
});

// still: the same screen drawn again (a changed setting): it does not come in a second time
function mount(html, { id, cls = '', backIn = false, focus = null, still = false } = {}) {
  document.getElementById('boot')?.remove();
  cardView?.destroy();
  cardView = null;
  const el = document.createElement('section');
  el.className = `screen ${cls} ${still ? 'still' : backIn ? 'back-in' : ''}`;
  if (id) el.id = id;
  el.innerHTML = html;
  ui.replaceChildren(el);
  nav.setRoot(el, focus);
  requestAnimationFrame(() => fitAll(el));
  return el;
}

function go(name, args = {}, { replace = false } = {}) {
  if (replace) stack.pop();
  stack.push({ name, args });
  render(stack[stack.length - 1]);
}

function back() {
  if (fighting) {
    if (fighting.paused && fighting.resume) fighting.resume();
    else if (nav.enabled) leaveFight();
    return;
  }
  if (overlay.firstChild && overlay.dataset.closable === '1') return closeOverlay();
  // a panel opened inside a screen (the move list of the fight select) closes first
  if (subBack) {
    const f = subBack;
    subBack = null;
    menu.back();
    return f();
  }
  // the first screen of a published game: the way back is the site the player came from
  if (stack.length <= 1 || (stack.length === 2 && stack[0].name === 'title')) return data.static ? toSite() : undefined;
  menu.back();
  stack.pop();
  render(stack[stack.length - 1], true);
}
let subBack = null;

// Out of the published game: back to the page of the site the player came from, or to its front page. The press is
// heard before the page goes.
function toSite() {
  menu.back();
  keepMusicPlace();
  try {
    sessionStorage.setItem('ring.press', JSON.stringify({ name: 'menu-back', at: Date.now() }));
  } catch {}
  const from = document.referrer && new URL(document.referrer).origin === location.origin && !/\/play\//.test(new URL(document.referrer).pathname) ? document.referrer : at('./');
  setTimeout(() => (location.href = from), 160);
}

// a screen that keeps working while it is open (the tournament console, live figures) stops when another one opens
let screenLeave = null;

// a short line at the bottom of the screen
function toast(text) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 2600);
}

// what a screen shows beyond the light list (viewer/data.js): asked for when the screen opens
function details(entry) {
  if (entry.name === 'card') return fullFighter(fighterById(entry.args.id));
  if (entry.name === 'match') return matchDetails(data.matches.find((x) => x.id === entry.args.id));
  return null;
}
const matchDetails = (m) => (m ? Promise.all([fullMatch(m), fullFighter(fighterById(`c/${m.red}`)), fullFighter(fighterById(`c/${m.blue}`))]) : null);
const TOP = ['main', 'versus', 'play', 'custom', 'roster', 'matches', 'settings'];

async function render(entry, backIn = false) {
  const wait = details(entry);
  if (wait) {
    await wait;
    if (stack[stack.length - 1] !== entry) return;
  }
  screenLeave?.();
  screenLeave = null;
  subBack = null;
  document.body.classList.toggle('menu', entry.name !== 'title');
  document.body.dataset.screen = entry.name;
  $('#legend').hidden = entry.name === 'title';
  // a published game shows the way out to the site on every screen of the top level
  $('#siteBtn').hidden = !(data.static && TOP.includes(entry.name));
  // fingers have no Esc: the way back is a button on every screen that has somewhere to go back to
  $('#backBtn').hidden = !(stack.length > 1 && !(stack.length === 2 && stack[0].name === 'title'));
  SCREENS[entry.name](entry.args, backIn);
  // a screen comes in with a sweep, the fight select with a heavier one; the way back has the sound of «назад»
  if (!backIn && entry.name !== 'title' && entry.name !== 'main') sfx.play(['versus', 'play', 'custom'].includes(entry.name) ? 'whoosh-heavy' : 'whoosh-light', 0.5);
  // the fight select has a backdrop of its own (the chosen stage): the live scene behind the menus rests
  if (!fighting) backdrop.pause(['versus', 'play', 'custom'].includes(entry.name));
}

const legend = (extra = '') => `<b>⏎</b>Выбрать &nbsp; <b>Esc</b>Назад${extra}`;
// the same cut-in for every screen title and every block that lands with a hit
const hit = (el) => {
  if (!el) return;
  el.classList.remove('hit');
  void el.offsetWidth;
  el.classList.add('hit');
};

const SCREENS = {
  // the opening (intro.js) on the live background, then «Нажми любую клавишу». A key during the opening skips
  // to its end; the second time in a session the opening is skipped at once.
  title() {
    const el = mount(`
      <div class="intro-title">
        <h1 class="intro-logo"><span class="w1" data-t="Ринг">Ринг</span><span class="w2" data-t="моделей">моделей</span></h1>
        <div class="press">${PRESS}</div>
      </div>`, { id: 'title' });
    const titleEl = $('.intro-title', el);
    let intro = null;
    const seen = (() => {
      try {
        return sessionStorage.getItem('ring.intro') === '1';
      } catch {
        return false;
      }
    })();
    const startGame = () => {
      menu.unlock();
      wakeSound();
      if (settings.fullscreen) setFullscreen(true);
      menu.start();
      try {
        sessionStorage.setItem('ring.intro', '1');
      } catch {}
      startMenuBackdrop();
      go('main');
    };
    const waitStart = () => {
      nav.anyKey = startGame;
    };
    // a press on the screen is any key: it skips the opening and starts the game. «click» and not «pointerup»: it is
    // the last event of a touch, so the same touch does not also press the menu that opens under the finger.
    el.addEventListener('click', () => {
      const f = nav.anyKey;
      if (!f) return;
      nav.anyKey = null;
      f();
    });
    // a key while the opening runs: straight to its end (the title stands, «Нажми любую клавишу» pulses)
    const skipKey = () => {
      sfx.unlock();
      sfx.preload();
      if (intro && !intro.done) {
        intro.skip();
        sfx.play('title-slam', 0.8);
      }
      waitStart();
    };
    introReady.then((parts) => {
      if (!parts) return waitStart();
      backdrop.intro((app) => new Intro({ app, ...parts, title: titleEl, sfx })).then((it) => {
        intro = it;
        window.__intro = it; // for recordings: stop its clock and step it frame by frame
        if (seen) it.skip();
        it.play();
        if (seen) waitStart();
        else {
          nav.anyKey = skipKey;
          const t = setInterval(() => {
            if (intro.done && nav.anyKey === skipKey) {
              clearInterval(t);
              waitStart();
            }
            if (stack[stack.length - 1]?.name !== 'title') clearInterval(t);
          }, 100);
        }
      });
    });
  },

  main(_, backIn) {
    if (backIn) refreshData();
    // a published copy (data.static) has no judge behind it: no tournament console, no developer mode, no ads
    const items = [...(handsOn() ? [['play', 'Играть самому']] : []), ['custom', 'Бой нейросетей'], ['roster', 'Бойцы'], ['matches', 'Матчи'], ...(data.static ? [] : [['tournament', 'Турнир']]), ['settings', 'Настройки'], ...(data.static ? [['site', 'На сайт']] : [])];
    const el = mount(`
      <div class="wrap">
        <div>
          <div class="brand slab hot">Ринг моделей</div>
          <nav class="mm">${items.map(([k, t], i) => `<button class="item" data-nav data-go="${k}" style="--i:${i}"><span class="n">0${i + 1}</span>${t}</button>`).join('')}</nav>
        </div>
        <div class="side"><div class="pair"></div><div class="caption"></div></div>
      </div>`, { id: 'main', backIn, focus: stack.mainFocus && items.some(([k]) => k === stack.mainFocus) ? `[data-go="${stack.mainFocus}"]` : null });
    el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => {
      stack.mainFocus = b.dataset.go;
      if (b.dataset.go === 'site') return toSite();
      go(b.dataset.go);
    }));
    $('#legend').innerHTML = legend();
    // the two newest contestants side by side
    const pair = contestants().slice(-2);
    if (pair.length === 2) {
      Promise.all(pair.map(async (f) => figureShot(await fighterAssets(topVersion(f).url), { w: 680, h: 900, crop: 'knees' }))).then((urls) => {
        const box = $('.pair', el);
        if (!box) return;
        box.innerHTML = urls.map((u, i) => `<img src="${u}" alt="" style="--glow:${colorsOf(pair[i]).accent}">`).join('');
        $('.caption', el).innerHTML = '<div class="vs slab hot">VS</div>';
      }).catch(() => {});
    }
  },

  // The roster: the grid of every fighter and, beside it, the fighter under the cursor alive. One live figure on the
  // screen whatever the number of fighters; the tiles are stills drawn as they come into the window.
  roster(_, backIn) {
    const all = data.fighters;
    const el = mount(`
      <div class="ro-side">
        <h1 class="title slab hit">Бойцы</h1>
        <div class="ro-stage"></div>
        <div class="ro-who"><span class="plate" data-p="model"></span><div class="ro-name slab" data-fit data-p="name"></div><span class="ro-by" data-p="by"></span></div>
      </div>
      <div class="ro-grid" data-grid></div>`, { id: 'roster', backIn });
    if (!contestants().length) $('[data-grid]', el).insertAdjacentHTML('beforebegin', '<div class="empty">Бойцов пока нет: их создают участники</div>');
    const view = new FigureView($('.ro-stage', el), { slot: 'roster', fit: 'corner' });
    view.noIntro = true;
    const ready = view.init();
    screenLeave = () => view.destroy();
    let seq = 0;
    let timer = 0;
    const show = (f) => {
      const v = topVersion(f);
      const side = $('.ro-side', el);
      side.style.cssText = cssColors(colorsOf(f));
      $('[data-p="model"]', el).textContent = f.model;
      $('[data-p="name"]', el).textContent = v.name;
      $('[data-p="by"]', el).textContent = f.author || '';
      fitText($('[data-p="name"]', el));
      hit($('.ro-who', el));
      stack.rosterFocus = f.id;
      const n = ++seq;
      clearTimeout(timer);
      $('.ro-stage', el).classList.add('loading');
      // the cursor running over the grid does not load every fighter on its way
      timer = setTimeout(async () => {
        const [a] = await Promise.all([previewAssets(v.url), ready]).catch(() => []);
        if (!a || n !== seq || !el.isConnected) return;
        view.set(a);
        $('.ro-stage', el).classList.remove('loading');
      }, 160);
    };
    const grid = fighterGrid($('[data-grid]', el), {
      fighters: all, nav, state: (stack.rosterGrid ||= {}),
      cols: (n) => (n <= 8 ? 4 : n <= 24 ? 6 : n <= 80 ? 8 : 10),
      onFocus: show,
      onPick: (f) => go('card', { id: f.id }),
    });
    const start = grid.reveal(stack.rosterFocus) || grid.first();
    if (start) nav.setRoot(el, `[data-id="${CSS.escape(start.dataset.id)}"]`);
    $('#legend').innerHTML = legend(contestants().length > 12 ? ' &nbsp; <b>PgUp PgDn</b>Листать' : '');
  },

  card({ id, v = null, tab = null }, backIn) {
    const f = fighterById(id);
    const ver = versionOf(f, v);
    const c = colorsOf(f, ver.v);
    const hasChanges = !!ver.changes;
    stack.rosterFocus = f.id;
    const T = tab === 'changes' && !hasChanges ? 'about' : tab || 'about';
    stack[stack.length - 1].args.tab = T;
    const el = mount(`
      <div class="layout" style="${cssColors(c)}">
        <div class="stage"><div class="anim"><button class="btn" data-nav data-anim="intro">Представление</button><button class="btn" data-nav data-anim="victory">Победа</button><button class="btn" data-nav data-reveal>Собрать заново</button></div></div>
        <div class="info">
          <div class="who"><span class="plate">${esc(f.model)}</span>${f.author ? `<span class="by">${esc(f.author)}</span>` : ''}</div>
          <h1 class="name slab hit" data-fit>${esc(ver.name)}</h1>
          <div class="motto" data-motto></div>
          <div class="acts">${handsOn() ? '<button class="btn primary" data-nav data-fight="play">Сразиться</button>' : ''}<button class="btn ${handsOn() ? '' : 'primary'}" data-nav data-fight="cpu">Стравить</button></div>
          ${f.versions.length > 1 || !f.training ? `<div class="versions">${f.versions.map((x) => `<button class="vchip ${x.v === ver.v ? 'on' : ''}" data-nav data-v="${x.v}" ${x.v === ver.v ? 'data-autofocus' : ''}><span class="v">${x.label}</span><span class="when">${esc(versionWhen(f, x))}</span></button>`).join('')}</div>` : ''}
          <div class="tabs">
            <button class="tab" data-nav data-tab="about">Обзор</button>
            <button class="tab" data-nav data-tab="moves">Приёмы</button>
            <button class="tab" data-nav data-tab="abilities">Способности</button>
            <button class="tab" data-nav data-tab="lines">Реплики</button>
            ${hasChanges ? '<button class="tab" data-nav data-tab="changes">Что изменил<span class="dot"></span></button>' : ''}
          </div>
          <div class="pane"></div>
        </div>
      </div>`, { id: 'card', backIn, focus: v ? `[data-v="${ver.v}"]` : null });
    $('#legend').innerHTML = legend();
    const pane = $('.pane', el);
    // a move plays as in a fight, against the sparring dummy
    const dummy = fighterById('sparring/dummy');
    const view = new FigureView($('.stage', el), { dummy: dummy ? () => fighterAssets(topVersion(dummy).url) : null });
    cardView = view;
    let assets = null;
    const showTab = (name) => {
      el.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
      if (!assets) return;
      const def = assets.def;
      if (name === 'about') {
        const sup = def.moves.find((m) => m.slot === 'super');
        const rec = f.cid ? recordOf(f.cid) : null;
        pane.innerHTML = `<p class="story">${esc(def.card.story)}</p>
          <div class="stat4">${E.STAT_KEYS.map((k) => `<div class="st4"><span class="sx-lab">${{ health: 'Здоровье', power: 'Сила', speed: 'Скорость', defense: 'Защита' }[k]}</span><b class="slab">${def.stats[k]}</b><span class="seg">${Array.from({ length: E.STAT_MAX }, (_, i) => `<i class="${i < def.stats[k] ? 'on' : ''}"></i>`).join('')}</span></div>`).join('')}</div>
          <div class="about2">
            ${sup ? `<button class="sig btnlike" data-nav data-move="${esc(sup.id)}"><span class="sx-lab">Суперприём</span><span class="slab sig-n">${esc(sup.name)}</span><span class="sig-k">${commandHtml(sup)}</span><span class="sig-d">${(() => {
              // a super made in code has no damage in its blocks: the ring's measurement, or «кодом» without one
              const d = sup.totalDamage || (ver.abilities || []).find((a) => a.move === sup.id)?.measured?.damage || 0;
              return d ? `<b class="slab hot">${Math.round(d)}</b><em>урона</em>` : sup.ability ? '<b class="slab hot">код</b><em>урон кодом</em>' : '<b class="slab hot">0</b><em>урона</em>';
            })()}</span></button>` : ''}
            ${rec ? `<div class="rec"><span class="sx-lab">На ринге</span><div class="rec-n">${[['Матчи', rec.matches], ['Раунды', rec.rounds], ['Победы', rec.wins], ['Нокауты', rec.kos]].map(([t, v]) => `<div><b class="slab">${v}</b><em>${t}</em></div>`).join('')}</div></div>` : ''}
          </div>`;
        pane.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => view.play(def.movesById[b.dataset.move])));
      }
      if (name === 'moves') {
        const order = { normal: 0, special: 1, super: 2 };
        const moves = [...def.moves].sort((a, b) => order[a.slot] - order[b.slot]);
        pane.innerHTML = `<div class="list moves">${moves.map((m) => `<button class="li btnlike" data-nav data-move="${esc(m.id)}"><span class="dmg slab ${m.slot === 'super' ? 'hot' : ''}">${m.totalDamage ? Math.round(m.totalDamage) : '—'}</span><span class="t">${esc(m.name)}</span><span class="k">${commandHtml(m)}<span class="tag ${m.slot}">${SLOT[m.slot]}</span></span><span class="s">${m.totalDamage ? `урон ${Math.round(m.totalDamage)}` : m.ability ? 'урон кодом' : 'без урона'} · старт ${m.firstActive} · всего ${m.duration} тиков${m.armor ? ` · броня ${m.armor}` : ''}${m.charge ? ' · заряд' : ''}${m.hasProjectile ? ' · снаряд' : ''}${m.ability ? ' · способность кодом' : ''}</span></button>`).join('')}</div>`;
        pane.querySelectorAll('[data-move]').forEach((b) => {
          const m = def.movesById[b.dataset.move];
          b.onclick = () => view.play(m);
          b.addEventListener('navfocus', () => view.play(m));
        });
      }
      if (name === 'abilities') {
        const ab = ver.abilities || [];
        pane.innerHTML = ab.length ? `<div class="list">${ab.map((a) => {
          const m = def.movesById[a.move];
          return `<button class="li btnlike" data-nav data-move="${esc(a.move)}"><span class="t">${esc(a.name)}</span><span class="k"><span class="tag ${a.slot}">${SLOT[a.slot] || a.slot}</span>${m?.ability?.cooldown ? `<span class="tag">перезарядка ${(m.ability.cooldown / 60).toFixed(1)} с</span>` : ''}</span>${a.about ? `<span class="s">«${esc(a.about)}»</span>` : ''}</button>`;
        }).join('')}</div>` : `<div class="none2">${icon('ability')}<span>Способностей кодом нет: все приёмы собраны из конструктора</span></div>`;
        pane.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => view.play(def.movesById[b.dataset.move])));
      }
      if (name === 'lines') {
        const lines = def.voice?.lines || [];
        pane.innerHTML = `<div class="list">${lines.map((l) => `<div class="li"><span class="t" style="text-transform:none;font-style:italic">«${esc(l.text)}»</span><span class="k"><span class="tag">${KIND[l.kind] || l.kind}</span><button class="play" data-nav data-line="${esc(l.id)}" aria-label="Прослушать">▶</button></span></div>`).join('')}</div>`;
        pane.querySelectorAll('[data-line]').forEach((b) => (b.onclick = () => {
          sfx.unlock();
          sfx.line(ver.url, b.dataset.line);
        }));
      }
      if (name === 'changes') pane.innerHTML = changesView(ver);
      nav.items();
    };
    el.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
      stack[stack.length - 1].args.tab = t.dataset.tab;
      showTab(t.dataset.tab);
    }));
    el.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => go('card', { id, v: Number(b.dataset.v), tab: stack[stack.length - 1].args.tab }, { replace: true })));
    el.querySelectorAll('[data-anim]').forEach((b) => (b.onclick = () => view.play(b.dataset.anim)));
    // from the card straight into a fight: against this fighter yourself, or this fighter against another one
    el.querySelectorAll('[data-fight]').forEach((b) => (b.onclick = () => {
      const me = { id: f.id, v: ver.v };
      initPick();
      if (b.dataset.fight === 'play') {
        if (pick.a.id === f.id) pick.a = pick.b;
        Object.assign(pick, { b: me, side: 'a' });
      } else {
        if (pick.b.id === f.id) pick.b = pick.a;
        Object.assign(pick, { a: me, side: 'b' });
      }
      go('versus', { mode: b.dataset.fight });
    }));
    showTab(T);
    // the reveal: the first time this version is opened here, and again on «Собрать заново»
    const seenKey = `ring.revealed.${f.id}.v${ver.v}`;
    const seen = () => {
      try {
        return localStorage.getItem(seenKey) === '1';
      } catch {
        return true;
      }
    };
    const markSeen = () => {
      try {
        localStorage.setItem(seenKey, '1');
      } catch {}
    };
    const revealNow = (a) => {
      const ch = ver.changes;
      const short = ver.v > 1 && !!ch;
      // the bones whose pictures changed in the locker room
      const files = new Set([...(ch?.changed || []).map((x) => x.file), ...(ch?.added || [])].map((x) => String(x).replace(/^fighter\//, '')));
      const changed = new Set(Object.entries(a.def.parts).filter(([, p]) => p && (files.has(p.image) || Object.values(p.skins || {}).some((k) => files.has(k.image)))).map(([b]) => b));
      const intro = a.def.voice.lines.find((l) => l.kind === 'intro')?.id;
      const flash = (els) => els.forEach((x) => {
        x.classList.remove('rv-flash');
        void x.offsetWidth;
        x.classList.add('rv-flash');
      });
      view.reveal({
        short,
        changed: short ? (changed.size ? changed : null) : null,
        onBeat: (k, i) => {
          if (k === 'start') {
            sfx.play(short ? 'whoosh-heavy-1' : 'riser', short ? 0.7 : 0.6);
            if (short) {
              const stats = (ch?.stats || []).join(' ').toLowerCase();
              flash([...el.querySelectorAll('.st4')].filter((t) => stats.includes(t.querySelector('.sx-lab')?.textContent.toLowerCase())));
              flash([...el.querySelectorAll('.tab')].filter((t) => (t.dataset.tab === 'moves' && ch?.moves?.length) || (t.dataset.tab === 'abilities' && ch?.abilities?.length) || t.dataset.tab === 'changes'));
            }
          }
          if (k === 'land') sfx.play(i % 2 ? 'kick' : 'block', 0.3);
          if (k === 'scan') sfx.play('electric', 0.45);
          if (k === 'pose') sfx.play('vs-impact', 0.9);
          if (k === 'title') flash([...el.querySelectorAll('.info .plate, .info .name, .info .motto')]);
          if (k === 'voice' && intro) sfx.line(ver.url, intro);
          if (k === 'end') markSeen();
        },
      });
    };
    $('[data-reveal]', el)?.addEventListener('click', () => assets && revealNow(assets));
    Promise.all([view.init(), previewAssets(ver.url)]).then(([, a]) => {
      assets = a;
      $('[data-motto]', el).textContent = a.def.card.motto;
      view.noIntro = !f.training && !seen();
      view.set(a);
      if (view.noIntro) revealNow(a);
      if (!a.def.anims.victory) $('[data-anim="victory"]', el)?.remove();
      showTab(T === stack[stack.length - 1].args.tab ? T : stack[stack.length - 1].args.tab || T);
    }).catch((e) => (pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  },

  matches(_, backIn) {
    const card = (m) => {
      const [a, b] = [fighterById(`c/${m.red}`), fighterById(`c/${m.blue}`)];
      const ca = a ? colorsOf(a) : { accent: '#ff7a33', primary: '#5a1d10' };
      const cb = b ? colorsOf(b) : { accent: '#4fc3ff', primary: '#10306a' };
      const name = (f, cid) => (f ? topVersion(f).name : cid);
      const status = m.over ? (m.winner ? `окончен · победил ${esc(name(fighterById(`c/${m.winner}`), m.winner))}` : 'окончен вничью') : `идёт · сыграно раундов: ${m.rounds.length}`;
      return `<button class="mcard" data-nav data-id="${esc(m.id)}" style="--pa:${ca.primary};--pb:${cb.primary};--ca:${cornerOf(m, m.red)};--cb:${cornerOf(m, m.blue)}">
        ${a ? `<img class="mc-fig l" alt="" data-shot="${esc(topVersion(a).url)}">` : ''}${b ? `<img class="mc-fig r" alt="" data-shot="${esc(topVersion(b).url)}">` : ''}
        <div class="side" style="--a:${cornerOf(m, m.red)}"><span class="plate">${esc(m.models[m.red])}</span><span data-fit class="nm slab ${m.winner === m.red ? 'hot' : ''}">${esc(name(a, m.red))}</span></div>
        <div class="score slab hot">${m.score[m.red]} : ${m.score[m.blue]}</div>
        <div class="side r" style="--a:${cornerOf(m, m.blue)}"><span class="plate">${esc(m.models[m.blue])}</span><span data-fit class="nm slab ${m.winner === m.blue ? 'hot' : ''}">${esc(name(b, m.blue))}</span></div>
        <div class="when">${fmtDate(m.created)}<br>${status}</div></button>`;
    };
    const el = mount(`
      <div class="head"><div class="left"><h1 class="title slab hit">Матчи</h1></div></div>
      ${data.matches.length ? `<div class="mlist">${data.matches.map(card).join('')}</div>` : '<div class="empty">Матчей пока нет</div>'}`, { id: 'matches', backIn, focus: stack.matchFocus ? `[data-id="${CSS.escape(stack.matchFocus)}"]` : null });
    el.querySelectorAll('.mcard').forEach((b, i) => {
      b.style.setProperty('--i', Math.min(i, 8));
      b.dataset.sfx = 'vs-whoosh';
      b.onclick = () => {
        stack.matchFocus = b.dataset.id;
        go('match', { id: b.dataset.id });
      };
    });
    fillShots(el);
    $('#legend').innerHTML = legend();
  },

  match({ id, tab = 'story' }, backIn) {
    const m = data.matches.find((x) => x.id === id);
    const fa = fighterById(`c/${m.red}`);
    const fb = fighterById(`c/${m.blue}`);
    const col = (cid) => {
      const f = fighterById(`c/${cid}`);
      return f ? colorsOf(f) : { accent: '#ffc94a', primary: '#333' };
    };
    const verOf = (cid, v) => fighterById(`c/${cid}`)?.versions.find((x) => x.v === v);
    let rows = '';
    m.rounds.forEach((r, i) => {
      if (i > 0) {
        const prev = m.rounds[i - 1];
        const blocks = [m.red, m.blue].map((cid) => {
          const was = prev.versions[cid];
          const now = r.versions[cid];
          const c = col(cid);
          const name = r.names[cid] || cid;
          if (!now || was === now) return `<div class="lk" style="--a:${c.accent}"><span class="who">${esc(name)} · ${esc(m.models[cid])}</span><span class="none">без изменений</span></div>`;
          const v = verOf(cid, now);
          const ch = v?.changes;
          const what = { plus: 'новый приём', minus: 'убран приём', tilde: 'приём изменён' };
          const awhat = { plus: 'новая способность', minus: 'убрана способность', tilde: 'способность изменена' };
          const bul = ch ? [...ch.stats, ...ch.moves.map((x) => `${what[mark(x)]}: ${plain(x).split(':')[0]}`), ...ch.abilities.map((x) => `${awhat[mark(x)]}: ${plain(x).split(':')[0]}`), ...ch.card, ...(ch.brain ? ['мозги переписаны'] : [])] : [];
          return `<div class="lk" style="--a:${c.accent}"><span class="who">${esc(name)} · v${was} → v${now}</span>${bul.slice(0, 6).map((x) => `<span class="bul">${esc(x)}</span>`).join('')}${v?.note ? `<span class="say">«${esc((t => (t.length > 260 ? t.slice(0, 260) + '…' : t))(saidPlain(v.note.text)))}»</span>` : ''}</div>`;
        });
        const same = [m.red, m.blue].every((cid) => !r.versions[cid] || prev.versions[cid] === r.versions[cid]);
        rows += same ? '<div class="ltitle" style="color:var(--mute)">Раздевалка · без изменений</div>' : `<div class="ltitle">Раздевалка</div><div class="locker">${blocks.join('')}</div>`;
      }
      const st = stageById(r.stage);
      rows += `<div class="round"><div class="thumb" style="background-image:url('${esc(st?.thumb || '')}')"></div>
        <div class="what"><span class="rn slab ${r.wins[0] === m.firstTo - 1 && r.wins[1] === m.firstTo - 1 ? 'hot' : ''}">${esc(roundTitle(r, m.firstTo))}</span><span class="res">${roundResult(m, r)}</span><span class="res" style="color:var(--dim)">${esc(st?.name || r.stage)} · ${esc(r.names[r.left])} v${r.versions[r.left] ?? '?'} против ${esc(r.names[r.right])} v${r.versions[r.right] ?? '?'}</span></div>
        <div class="go"><button class="btn" data-nav data-round="${r.n}">Смотреть</button></div></div>`;
    });
    const nm = (f, cid) => (f ? topVersion(f).name : cid);
    const el = mount(`
      <div class="mhead hit" style="--ca:${cornerOf(m, m.red)};--cb:${cornerOf(m, m.blue)}">
        ${fa ? `<img class="mh-fig l" alt="" data-shot="${esc(topVersion(fa).url)}">` : ''}${fb ? `<img class="mh-fig r" alt="" data-shot="${esc(topVersion(fb).url)}">` : ''}
        <div class="s" style="--a:${cornerOf(m, m.red)}"><span class="plate">${esc(m.models[m.red])}</span><span data-fit class="nm slab ${m.winner === m.red ? 'hot' : ''}">${esc(nm(fa, m.red))}</span></div>
        <div class="score slab hot">${m.score[m.red]} : ${m.score[m.blue]}</div>
        <div class="s r" style="--a:${cornerOf(m, m.blue)}"><span class="plate">${esc(m.models[m.blue])}</span><span data-fit class="nm slab ${m.winner === m.blue ? 'hot' : ''}">${esc(nm(fb, m.blue))}</span></div>
      </div>
      <div class="row" style="margin-bottom:20px">${m.rounds.length ? '<button class="btn primary" data-nav data-all data-autofocus>Смотреть весь матч</button>' : ''}<span style="color:var(--dim);font-size:16px">${fmtDate(m.created)} · до ${m.firstTo} побед</span></div>
      <div class="tabs mtabs">
        <button class="tab ${tab === 'story' ? 'on' : ''}" data-nav data-mtab="story">История</button>
        <button class="tab ${tab === 'course' ? 'on' : ''}" data-nav data-mtab="course">Ход матча</button>
        <button class="tab ${tab === 'stats' ? 'on' : ''}" data-nav data-mtab="stats">Статистика</button>
        <button class="tab ${tab === 'protocol' ? 'on' : ''}" data-nav data-mtab="protocol">Протокол</button>
        ${m.reel ? `<a class="tab" data-nav href="${esc(m.reel)}" target="_blank" rel="noopener">Ролик матча</a>` : ''}
      </div>
      ${tab === 'story' ? storyHtml(m, { col: (cid) => cornerOf(m, cid), stageOf: stageById, title: (r) => roundTitle(r, m.firstTo), verOf }) : ''}
      ${tab === 'course' ? `<div class="timeline">${rows || '<div class="empty">Раундов пока нет</div>'}</div>` : ''}
      ${tab === 'stats' ? matchStatsView(m, (cid) => cornerOf(m, cid), (r) => roundTitle(r, m.firstTo)) : ''}
      ${tab === 'protocol' ? protocolView(m.protocol, m, (cid) => cornerOf(m, cid)) : ''}`, { id: 'match', backIn, focus: `[data-mtab="${tab}"]` });
    el.querySelectorAll('[data-mtab]').forEach((b) => (b.onclick = () => go('match', { id, tab: b.dataset.mtab }, { replace: true })));
    el.querySelectorAll('[data-juicy]').forEach((b) => (b.onclick = () => momentReplay(m, Number(b.dataset.juicy), Number(b.dataset.tick) - 75, Number(b.dataset.tick) + 60)));
    el.querySelectorAll('[data-moment]').forEach((b) => (b.onclick = () => momentReplay(m, Number(b.dataset.moment), Number(b.dataset.from), Number(b.dataset.to))));
    el.querySelectorAll('[data-round]').forEach((b) => (b.onclick = () => watchRound(m, Number(b.dataset.round))));
    $('[data-all]', el)?.addEventListener('click', () => watchMatch(m));
    fillShots(el);
    $('#legend').innerHTML = legend();
  },

  custom(args, backIn) {
    versusScreen({ ...args, mode: 'cpu' }, backIn);
  },

  versus(args, backIn) {
    versusScreen(args, backIn);
  },

  tournament(_, backIn) {
    tournamentScreen({
      mount,
      backIn,
      ctx: {
        onLeave: (fn) => (screenLeave = fn),
        toast,
        refresh: refreshData,
        // the round just played, live in the game (VS, the fight, the result), as «Смотреть» on a match page
        watch: async (id, n) => {
          const has = () => data.matches.find((x) => x.id === id && x.rounds.some((r) => r.n === n));
          if (!has()) await refreshData();
          const m = has();
          if (m) watchRound(m, n);
        },
      },
    });
    $('#legend').innerHTML = legend();
  },

  play(args, backIn) {
    versusScreen({ ...args, mode: 'play' }, backIn);
  },

  settings(_, backIn) {
    const on = (v) => (v ? 'Вкл' : 'Выкл');
    const ICO = { sound: 'play', volume: 'stat', menuVolume: 'stat', musicVolume: 'stat', aspect: 'card', quality: 'super', fullscreen: 'replay', ads: 'juicy' };
    const opt = (key, title, val) => `<button class="opt" data-nav data-adjust data-key="${key}"><span class="o-t">${icon(ICO[key])}<span>${title}</span></span><span class="val">${val}</span></button>`;
    const vol = (v) => `<span class="vol">${Array.from({ length: 10 }, (_, i) => `<i class="${i < Math.round(v * 10) ? 'on' : ''}"></i>`).join('')}</span>`;
    const two = (a, b, cur) => `<span class="o ${cur === a ? 'on' : ''}">${a}</span><span class="o ${cur === b ? 'on' : ''}">${b}</span>`;
    const el = mount(`
      <div class="head"><div class="left"><h1 class="title slab hit">Настройки</h1></div></div>
      <div class="set">
        ${opt('sound', 'Звук', two('Вкл', 'Выкл', on(settings.sound)))}
        ${opt('volume', 'Громкость', vol(settings.volume))}
        ${opt('menuVolume', 'Звуки меню', vol(settings.menuVolume))}
        ${opt('musicVolume', 'Музыка', vol(settings.musicVolume))}
        ${TOUCH ? '' : opt('aspect', 'Кадр боя', two('16:9', '9:16', settings.aspect))}
        ${opt('quality', 'Качество', two('Высокое', 'Среднее', settings.quality === 'medium' ? 'Среднее' : 'Высокое'))}
        ${CAN_FS ? opt('fullscreen', 'Полный экран', two('Вкл', 'Выкл', on(settings.fullscreen))) : ''}
        ${data.static ? '' : `${opt('ads', 'Реклама', two('Вкл', 'Выкл', on(settings.ads)))}
        <a class="opt" data-nav href="${at('viewer/dev.html')}" style="text-decoration:none"><span>Режим разработчика</span><span class="val">→</span></a>`}
      </div>`, { id: 'settings', backIn, still: backIn === null, focus: stack.setFocus ? `[data-key="${stack.setFocus}"]` : null });
    const VOLS = ['volume', 'menuVolume', 'musicVolume'];
    const change = (key, dir) => {
      if (key === 'sound') settings.sound = !settings.sound;
      if (key === 'ads') settings.ads = !settings.ads;
      if (key === 'aspect') settings.aspect = settings.aspect === '16:9' ? '9:16' : '16:9';
      if (key === 'quality') settings.quality = settings.quality === 'medium' ? 'high' : 'medium';
      if (key === 'fullscreen') return toggleFullscreen();
      if (VOLS.includes(key)) settings[key] = Math.max(0, Math.min(1, Math.round((settings[key] + (dir || 1) * 0.1) * 10) / 10));
      saveSettings();
      stack.setFocus = key;
      SCREENS.settings({}, null);
      menu.confirm();
      if (key === 'sound' && settings.sound) wakeSound();
    };
    el.querySelectorAll('[data-key]').forEach((b) => {
      b.onclick = (e) => {
        const k = b.dataset.key;
        if (VOLS.includes(k)) {
          const r = b.querySelector('.vol').getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.detail) {
            settings[k] = Math.max(0.1, Math.min(1, Math.ceil(((e.clientX - r.left) / r.width) * 10) / 10));
            saveSettings();
            stack.setFocus = k;
            return SCREENS.settings({}, null);
          }
          return change(k, settings[k] >= 1 ? -10 : 1);
        }
        change(k, 1);
      };
      b.addEventListener('adjust', (e) => change(b.dataset.key, e.detail));
    });
    $('#legend').innerHTML = legend(' &nbsp; <b>← →</b>Изменить');
  },
};

const plain = (x) => x.replace(/^[+−~]\s*/, '').replace(/\s\([a-z0-9_]+\)/g, '');
const mark = (x) => (x.startsWith('+') ? 'plus' : x.startsWith('−') ? 'minus' : 'tilde');

// a contestant's record over every match of the judge: matches, rounds, rounds won, knockouts
function recordOf(cid) {
  const ms = data.matches.filter((m) => m.red === cid || m.blue === cid);
  const rounds = ms.flatMap((m) => m.rounds);
  return { matches: ms.length, rounds: rounds.length, wins: rounds.filter((r) => r.winner === cid).length, kos: rounds.filter((r) => r.winner === cid && r.reason === 'ko').length };
}

function fillShots(root) {
  lazyShots(root);
}

// ---------- the fight select: who fights whom, where, and who holds the controls ----------
// One screen for both kinds of fight. The grid of every fighter stands in the middle, the two corners at its sides
// show their fighters alive, face to face. The corner that is choosing has the cursor of its colour; a press on a
// tile gives that corner its fighter and hands the cursor to the other corner, then to «В бой».

const pick = { mode: 'play', a: null, b: null, stage: null, side: 'a', grid: {} };

function initPick() {
  if (pick.a && fighterById(pick.a.id) && fighterById(pick.b.id)) return;
  const list = contestants();
  const a = list[0] || data.fighters[0];
  const b = list[1] || fighterById('sparring/dummy') || data.fighters[1] || a;
  Object.assign(pick, { a: { id: a.id, v: topVersion(a).v }, b: { id: b.id, v: topVersion(b).v }, side: 'a' });
  pick.stage ||= data.stages[0]?.id || null;
}

const KEY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M10 10h1M14 10h1M18 10h0M7 14h10"/></svg>';
const PAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10a5 5 0 0 1 5 5v2.5a3 3 0 0 1-5.4 1.8L15.5 15h-7l-1.1 1.3A3 3 0 0 1 2 14.5V12a5 5 0 0 1 5-5z"/><path d="M7 10v3M5.5 11.5h3M16 10.5h0M18 12.5h0"/></svg>';
const CPU_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9.5 9.5h5v5h-5zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/></svg>';

function versusScreen({ mode = null, focusStart = false } = {}, backIn) {
  initPick();
  if (mode) pick.mode = mode;
  // nothing to fight with (a phone without a gamepad): the screen is the fight of two programs
  const hands = handsOn();
  if (!hands) pick.mode = 'cpu';
  const p = pick;
  const pad = !!pads.first();
  const corner = (s) => `
    <div class="vs-corner ${s}">
      <button class="vs-fig" data-nav data-corner="${s}" data-sfx="whoosh-light"><span class="vs-who plate"></span></button>
      <div class="vs-name slab" data-fit></div>
      <div class="vs-by"></div>
      <div class="vs-vers"></div>
      ${s === 'a' ? `<div class="vs-keys">${pad
    ? `<i class="kcap wide">стик</i><span class="kgap"></span><i class="kcap p">X</i><i class="kcap p">Y</i><i class="kcap k">A</i><i class="kcap k">B</i>`
    : `<i class="kcap">←</i><i class="kcap">↑</i><i class="kcap">↓</i><i class="kcap">→</i><span class="kgap"></span><i class="kcap p">U</i><i class="kcap p">I</i><i class="kcap k">J</i><i class="kcap k">K</i>`}<button class="btn small" data-nav data-moves>Приёмы</button></div>` : ''}
    </div>`;
  const el = mount(`
    <div class="vs-bg"></div>
    <div class="vs-modes">
      ${hands ? `<button class="vs-mode" data-nav data-mode="play" data-sfx="whoosh-heavy">${pad ? PAD_ICON : KEY_ICON}<span>Ты против нейросети</span></button>` : ''}
      <button class="vs-mode" data-nav data-mode="cpu" data-sfx="whoosh-heavy">${CPU_ICON}<span>Нейросеть против нейросети</span></button>
    </div>
    <div class="vs-body">
      ${corner('a')}
      <div class="vs-mid">
        <div class="vs-pickers">
          <div class="vs-grid" data-grid></div>
          <div class="vs-foot">
            <div class="vs-stages">${data.stages.map((s) => `<button class="stg" data-nav data-stage="${esc(s.id)}" data-sfx="whoosh-light" style="background-image:url('${esc(s.thumb || '')}')"><span>${esc(s.name)}</span></button>`).join('')}</div>
            <button class="btn primary vs-go" data-nav data-start data-sfx="none">В бой</button>
          </div>
        </div>
        <div class="vs-moves" hidden></div>
      </div>
      ${corner('b')}
    </div>`, { id: 'versus', backIn });
  const views = {};
  const shown = { a: null, b: null };
  const showing = { a: null, b: null };
  const seq = { a: 0, b: 0 };
  const timers = { a: 0, b: 0 };
  const dummy = fighterById('sparring/dummy');
  for (const s of ['a', 'b']) {
    views[s] = new FigureView($(`.vs-corner.${s} .vs-fig`, el), { slot: `vs-${s}`, flip: s === 'b' ? -1 : 1, fit: 'corner', dummy: s === 'a' && dummy ? () => fighterAssets(topVersion(dummy).url) : null });
    views[s].noIntro = true;
    views[s].ready = views[s].init();
  }
  screenLeave = () => Object.values(views).forEach((v) => v.destroy());

  // A corner shows a fighter: the one it has taken, or the one under the cursor while it is choosing.
  // land: the fighter has just been taken — it lands with a hit, steps out and says its line.
  function showCorner(s, id, v = null, { land = false, wait = 0 } = {}) {
    const f = fighterById(id);
    const ver = versionOf(f, v);
    showing[s] = id;
    const box = $(`.vs-corner.${s}`, el);
    const human = p.mode === 'play' && s === 'a';
    box.style.cssText = cssColors(colorsOf(f, ver.v));
    const who = $('.vs-who', box);
    who.innerHTML = human ? `${pads.first() ? PAD_ICON : KEY_ICON}<b>Ты</b>` : `${CPU_ICON}<b>${esc(f.model)}</b>`;
    who.classList.toggle('me', human);
    $('.vs-name', box).textContent = ver.name;
    fitText($('.vs-name', box));
    $('.vs-by', box).textContent = [human ? f.model : null, f.author].filter(Boolean).join(' · ');
    const taken = id === p[s].id;
    $('.vs-vers', box).innerHTML = taken && f.versions.length > 1 ? f.versions.map((x) => `<button class="vchip ${x.v === ver.v ? 'on' : ''}" data-nav data-v="${x.v}" data-sfx="whoosh-light"><span class="v">${x.label}</span></button>`).join('') : '';
    $('.vs-vers', box).querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => {
      p[s].v = Number(b.dataset.v);
      showCorner(s, id, p[s].v, { land: true });
      nav.focus($(`.vs-corner.${s} [data-v="${p[s].v}"]`, el), { sound: false });
    }));
    if (land) hit(box);
    const n = ++seq[s];
    clearTimeout(timers[s]);
    if (shown[s] === ver.url && !land) return;
    if (shown[s] !== ver.url) $('.vs-fig', box).classList.add('loading');
    timers[s] = setTimeout(async () => {
      const [a] = await Promise.all([(taken ? fighterAssets : previewAssets)(ver.url), views[s].ready]).catch(() => []);
      if (!a || n !== seq[s] || !el.isConnected) return;
      if (shown[s] !== ver.url) views[s].set(a);
      shown[s] = ver.url;
      $('.vs-fig', box).classList.remove('loading');
      if (land) {
        if (a.def.anims.intro) views[s].play('intro');
        const line = a.def.voice?.lines?.find((l) => l.kind === 'intro')?.id;
        if (line) sfx.line(ver.url, line);
      }
    }, wait);
  }

  function setSide(s) {
    p.side = s;
    el.dataset.side = s;
  }
  function setMode(m) {
    p.mode = m;
    el.classList.toggle('mode-play', m === 'play');
    el.classList.toggle('mode-cpu', m === 'cpu');
    for (const b of el.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
    const top = stack[stack.length - 1];
    if (top) top.args = { ...top.args, mode: m };
    showCorner('a', p.a.id, p.a.v);
  }
  function setStage(id) {
    p.stage = id;
    for (const b of el.querySelectorAll('[data-stage]')) b.classList.toggle('on', b.dataset.stage === id);
    const bg = $('.vs-bg', el);
    bg.style.backgroundImage = `url('${stageById(id)?.thumb || ''}')`;
    hit(bg);
  }

  const grid = fighterGrid($('[data-grid]', el), {
    fighters: data.fighters, nav, state: p.grid,
    cols: (n) => (n <= 10 ? 5 : n <= 24 ? 6 : n <= 100 ? 8 : 10),
    onFocus: (f) => showCorner(p.side, f.id, f.id === p[p.side].id ? p[p.side].v : null, { wait: 140 }),
    onPick: (f) => {
      const s = p.side;
      p[s] = { id: f.id, v: topVersion(f).v };
      grid.mark(s, f.id);
      sfx.play('vs-impact', 0.55);
      showCorner(s, f.id, p[s].v, { land: true });
      // the cursor goes to the other corner; when both have chosen, to the one main step
      if (s === 'a') setSide('b');
      else nav.focus($('[data-start]', el));
    },
  });
  // the cursor has left the grid: the corner shows the fighter it has taken again
  el.addEventListener('navfocus', (e) => {
    if (!e.target.closest('.ft')) for (const s of ['a', 'b']) if (showing[s] !== p[s].id) showCorner(s, p[s].id, p[s].v);
  });
  el.querySelectorAll('[data-corner]').forEach((b) => (b.onclick = () => {
    setSide(b.dataset.corner);
    nav.focus(grid.reveal(p[p.side].id) || grid.first() || b);
  }));
  el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  el.querySelectorAll('[data-stage]').forEach((b) => (b.onclick = () => setStage(b.dataset.stage)));
  $('[data-start]', el).onclick = () => {
    sfx.play('title-slam', 0.7);
    (p.mode === 'play' ? startLive(p) : startCustom(p));
  };

  // The move list of the player's fighter takes the place of the grid; the move under the cursor plays on the
  // fighter in its corner, against the sparring dummy.
  $('[data-moves]', el).onclick = async () => {
    const ver = versionOf(fighterById(p.a.id), p.a.v);
    showCorner('a', p.a.id, p.a.v);
    const a = await fighterAssets(ver.url);
    const panel = $('.vs-moves', el);
    panel.innerHTML = `<div class="vs-moves-h slab">${esc(a.def.card.name)}</div>${moveListHtml(a.def, pads.first() ? 'pad' : 'kb', { play: true })}`;
    panel.hidden = false;
    $('.vs-pickers', el).hidden = true;
    hit(panel);
    panel.querySelectorAll('[data-move]').forEach((b) => {
      const m = a.def.movesById[b.dataset.move];
      b.onclick = () => views.a.play(m);
      b.addEventListener('navfocus', () => views.a.play(m));
    });
    nav.setRoot(panel);
    subBack = () => {
      panel.hidden = true;
      $('.vs-pickers', el).hidden = false;
      views.a.stopDemo();
      nav.setRoot(el, '[data-moves]');
    };
  };

  setSide(p.side);
  setMode(p.mode);
  setStage(p.stage);
  for (const s of ['a', 'b']) {
    grid.mark(s, p[s].id);
    showCorner(s, p[s].id, p[s].v);
  }
  const start = grid.reveal(p[p.side].id);
  nav.setRoot(el, focusStart ? '[data-start]' : start ? `[data-id="${CSS.escape(p[p.side].id)}"]` : null);
  $('#legend').innerHTML = legend(contestants().length > 12 ? ' &nbsp; <b>PgUp PgDn</b>Листать' : '');
}

function closeOverlay(sound = true) {
  if (sound) menu.back();
  overlay.replaceChildren();
  overlay.dataset.closable = '';
  nav.setRoot(ui.firstElementChild);
}

// ---------- fights ----------

function showOverlay(html, { closable = false, focus = null } = {}) {
  document.getElementById('boot')?.remove();
  const box = document.createElement('div');
  box.innerHTML = html;
  overlay.replaceChildren(...box.childNodes);
  overlay.dataset.closable = closable ? '1' : '';
  nav.enabled = true;
  nav.setRoot(overlay, focus);
  return overlay;
}

function busy(text) {
  return showOverlay(`<div class="ov busy"><div class="txt">${esc(text)}</div><div class="bar2"><i></i></div></div>`);
}

function enterFight(kind) {
  screenLeave?.();
  screenLeave = null;
  subBack = null;
  keepMusicPlace();
  backdrop.pause(true);
  ui.hidden = true;
  $('#legend').hidden = true;
  $('#backBtn').hidden = true; // a touch on the fight pauses it, the pause has the way out
  nav.enabled = false;
  overlay.replaceChildren();
  fighting = { kind, paused: false };
}

function leaveFight() {
  fightView.stop();
  fighting = null;
  hideControls();
  overlay.replaceChildren();
  overlay.dataset.closable = '';
  ui.hidden = false;
  backdrop.pause(false);
  nav.enabled = true;
  menuMusic();
  render(stack[stack.length - 1], true);
}

// the hint over the bottom of the fight frame: base controls and a few commands of the player's fighter;
// it fades after a few seconds, Tab (or Select) shows and hides it, the pause screen has the full move list
let ctrlTimer = 0;
let ctrlDef = null;
function controlsHtml(def) {
  const { base, specials } = controlsHint(def);
  const chip = ([k, t]) => `<span class="kc"><b>${esc(k)}</b>${esc(t)}</span>`;
  return `<div class="row">${base.map(chip).join('')}<span class="kc"><b>Esc</b>пауза</span><span class="kc"><b>Tab</b>подсказка</span></div>
    <div class="row">${specials.map((m) => `<span class="kc mv">${commandHtml(m, 'kb')}<span class="mn">${esc(m.name)}</span></span>`).join('')}</div>`;
}
function showControls(def, { stay = 6000 } = {}) {
  ctrlDef = def || ctrlDef;
  if (!ctrlDef) return;
  const bar = $('#controls');
  bar.innerHTML = controlsHtml(ctrlDef);
  bar.hidden = false;
  bar.classList.remove('off');
  clearTimeout(ctrlTimer);
  if (stay) ctrlTimer = setTimeout(() => bar.classList.add('off'), stay);
}
function hideControls() {
  clearTimeout(ctrlTimer);
  ctrlDef = null;
  $('#controls').hidden = true;
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Tab' || !ctrlDef || !fighting) return;
  e.preventDefault();
  const bar = $('#controls');
  if (bar.classList.contains('off')) showControls(null, { stay: 0 });
  else bar.classList.add('off');
});

// A fighter's command list as fighting games show it: the moves by kind with their commands in the keys of the
// device in hand, then what every fighter can do. play: the rows are buttons — the move under the cursor plays on
// the fighter's figure.
function moveListHtml(def, device = 'kb', { play = false } = {}) {
  const SL = { normal: 'Удары', special: 'Особые приёмы', super: 'Суперприём' };
  const groups = { normal: [], special: [], super: [] };
  for (const m of moveList(def)) groups[m.slot].push(`<${play ? `button data-nav data-sfx="none" data-move="${esc(m.id)}"` : 'div'} class="ml-r ${m.slot}"><span class="ml-n">${esc(m.name)}</span>${commandHtml(m, device)}</${play ? 'button' : 'div'}>`);
  const key = (k) => `<span class="cmd">${k.split(' ').map((x) => (x === '+' ? '<i class="cplus">+</i>' : `<i class="ckey">${x}</i>`)).join('')}</span>`;
  const common = (device === 'pad' ? [['Бросок', 'LB'], ['Парирование', 'LT'], ['Суперприём', 'RT'], ['Блок', '←'], ['Рывок', '→ →']] : [['Бросок', 'U + J'], ['Парирование', 'N'], ['Суперприём', 'I + K'], ['Блок', '←'], ['Рывок', '→ →']])
    .map(([t, k]) => `<div class="ml-r base"><span class="ml-n">${t}</span>${key(k)}</div>`);
  const col = (title, rows, cls = '') => (rows.length ? `<div class="ml-g ${cls}"><div class="ml-h">${title}</div>${rows.join('')}</div>` : '');
  return `<div class="movelist">${col(SL.normal, groups.normal)}${col(SL.special, groups.special)}${col(SL.super, groups.super, 'sup')}${col('Всегда', common, 'base')}</div>`;
}

// a moment again: the round's clip from a little before it to its end (ticks of the fight)
async function momentReplay(m, n, fromTick, toTick) {
  const r = m.rounds.find((x) => x.n === n);
  if (!r?.video || !r.timing) return watchRound(m, n);
  const t = await (await fetch(r.timing, { cache: 'no-store' })).json();
  const at = (tick) => {
    const i = t.ticks.findIndex((x) => x >= tick);
    return (i < 0 ? t.ticks.length : i) / t.fps;
  };
  const from = Math.max(0, at(fromTick) - 0.4);
  const to = Math.max(from + 2.5, at(toTick) + 0.6);
  const el = showOverlay(`<div class="ov wide replayov"><span class="kicker">${esc(roundTitle(r, m.firstTo))} · повтор</span><video class="juicyv" src="${esc(r.video)}" playsinline preload="auto"></video><div class="row"><button class="btn primary" data-nav data-autofocus data-k="again">Ещё раз</button><button class="btn" data-nav data-k="round">Весь раунд</button><button class="btn" data-nav data-k="close">Закрыть</button></div></div>`, { closable: true });
  const v = $('.juicyv', el);
  const play = () => {
    v.currentTime = from;
    v.play().catch(() => {
      v.muted = true; // a browser without a gesture to go on plays it silent
      v.play().catch(() => {});
    });
  };
  v.addEventListener('timeupdate', () => v.currentTime > to && v.pause());
  if (v.readyState >= 1) play();
  else v.addEventListener('loadedmetadata', play, { once: true });
  $('[data-k="again"]', el).onclick = play;
  $('[data-k="round"]', el).onclick = () => {
    closeOverlay(false);
    watchRound(m, n);
  };
  $('[data-k="close"]', el).onclick = () => closeOverlay();
}

// the corner's colour in a match (the contestant's own in a mirror match)
function cornerOf(m, cid) {
  const a = fighterById(`c/${m.red}`);
  const b = fighterById(`c/${m.blue}`);
  const ca = a ? colorsOf(a).accent : '#ff7a33';
  const cb = b ? colorsOf(b).accent : '#4fc3ff';
  if (ca.toLowerCase() !== cb.toLowerCase()) return cid === m.red ? ca : cb;
  return fighterById(`c/${cid}`)?.color || (cid === m.red ? '#ff7a33' : '#4fc3ff');
}
const verOf = (cid, v) => fighterById(`c/${cid}`)?.versions.find((x) => x.v === v);

// A screen between rounds over the fight frame (viewer/game/screens.js). buttons: [[title, fn]]; auto: seconds
// after which it goes on by itself (the first button, «Дальше», skips sooner). Resolves with the button's index.
async function betweenScreen(make, buttons = [], { auto = 0, kind = 'round' } = {}) {
  const html = buttons.map(([t], i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-nav data-i="${i}" ${i === 0 ? 'data-autofocus' : ''}>${esc(t)}</button>`).join('');
  const scr = await make(html);
  if (!scr) return -1;
  if (buttons.length) scr.root.classList.add('has-buttons');
  overlay.replaceChildren(scr.root);
  overlay.dataset.closable = '';
  await scr.ready();
  scr.play();
  for (const [name, at, gain] of SCREEN_SOUNDS[kind] || []) sfx.play(name, gain, 0, at);
  nav.enabled = true;
  nav.setRoot(overlay);
  return new Promise((resolve) => {
    let done = false;
    const finish = (i) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      scr.destroy();
      if (overlay.firstChild === scr.root) overlay.replaceChildren();
      resolve(i);
    };
    scr.root.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => finish(Number(b.dataset.i))));
    const timer = auto ? setTimeout(() => finish(-1), auto * 1000) : 0;
    if (fighting) fighting.skip = () => finish(-1);
  });
}

function pauseMenu() {
  if (!fighting || fighting.paused) return;
  fighting.paused = true;
  fightView.pause(true);
  menu.back();
  const list = fighting.kind === 'live' && ctrlDef ? moveListHtml(ctrlDef, pads.first() ? 'pad' : 'kb') : '';
  const el = showOverlay(`<div class="pauseov ${list ? 'has-list' : ''}"><div class="p-left"><span class="kicker">${esc(fighting.kind === 'live' ? 'Ты против нейросети' : fighting.kind === 'custom' ? 'Нейросеть против нейросети' : 'Матч')}</span><div class="slab hot p-big">Пауза</div>
    <nav class="mm">
    <button class="item" data-nav data-autofocus data-k="go">Продолжить</button>
    ${fighting.restart ? '<button class="item" data-nav data-k="again">Начать заново</button>' : ''}
    <button class="item" data-nav data-k="out">Выйти в меню</button></nav></div>${list ? `<div class="p-list"><div class="vs-moves-h slab">${esc(ctrlDef.card.name)}</div>${list}</div>` : ''}</div>`);
  const resume = () => {
    overlay.replaceChildren();
    fighting.paused = false;
    fightView.pause(false);
    nav.enabled = false;
  };
  fighting.resume = resume;
  $('[data-k="go"]', el).onclick = resume;
  $('[data-k="again"]', el)?.addEventListener('click', () => {
    const r = fighting.restart;
    overlay.replaceChildren();
    fightView.stop();
    r();
  });
  $('[data-k="out"]', el).onclick = () => {
    fighting.abort = true;
    leaveFight();
  };
}

function afterMenu(title, sub, buttons) {
  const el = showOverlay(`<div class="ov"><div class="big slab hot">${esc(title)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}<div class="col">${buttons.map((b, i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-nav data-i="${i}" ${i === 0 ? 'data-autofocus' : ''}>${esc(b[0])}</button>`).join('')}</div></div>`);
  el.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => buttons[Number(b.dataset.i)][1]()));
}

// loaded: called when the fighters, the stage and the record have arrived and the show is about to start —
// until then «Загружаю раунд» stays on the screen (on a phone's network that is several seconds, not a blink)
async function roundShow(m, r, { intro = true, loaded = null } = {}) {
  const [assets, stage, replay] = await Promise.all([Promise.all(r.dirs.map(fighterAssets)), stageAssets(stageById(r.stage)?.dir, { hd: settings.quality !== 'medium' }), fetch(r.replay, { cache: 'no-store' }).then((x) => x.json())]);
  loaded?.();
  return fightView.show({
    assets, urls: r.dirs, names: [m.models[r.left], m.models[r.right]], stage, steps: expand(replay.steps), seed: replay.seed, intro,
    show: { round: r.num, rerun: r.rerun, wins: r.wins, firstTo: m.firstTo, final: r.final, result: false }, totalTicks: replay.result?.ticks || 1,
  });
}

async function watchRound(m, n) {
  const r = m.rounds.find((x) => x.n === n);
  enterFight('round');
  matchDetails(m);
  fighting.restart = () => watchRound(m, n);
  busy('Загружаю раунд');
  try {
    nav.enabled = false;
    const p = roundShow(m, r, { loaded: () => overlay.replaceChildren() });
    const res = await p;
    if (res.stopped || !fighting) return;
    const next = m.rounds.find((x) => x.n === n + 1);
    const buttons = [['Ещё раз', () => watchRound(m, n)], ...(next ? [['Следующий раунд', () => watchRound(m, n + 1)]] : []), ['К матчу', leaveFight]];
    await matchDetails(m);
    const i = await betweenScreen((html) => resultFor(data, m, n, { assetsOf: fighterAssets, buttons: html }), buttons);
    if (i >= 0) buttons[i][1]();
  } catch (e) {
    failed(e);
  }
}

// The whole match as a show: VS, every round with its result screen, the locker rooms before a round where a
// model changed its fighter, the final.
async function watchMatch(m) {
  enterFight('match');
  fighting.restart = () => watchMatch(m);
  const token = fighting;
  try {
    await matchDetails(m);
    for (let i = 0; i < m.rounds.length; i++) {
      const r = m.rounds[i];
      const prev = m.rounds[i - 1];
      const changed = prev ? [m.red, m.blue].filter((cid) => prev.versions[cid] !== r.versions[cid]) : [];
      for (const cid of changed) {
        await betweenScreen((html) => lockerFor(data, m, r.n, cid, { assetsOf: fighterAssets, buttons: html }), [['Дальше']], { auto: 9, kind: 'locker' });
        if (fighting !== token || token.abort) return;
      }
      busy('Загружаю раунд');
      nav.enabled = false;
      const p = roundShow(m, r, { intro: i === 0 || changed.length > 0, loaded: () => overlay.replaceChildren() });
      const res = await p;
      if (res.stopped || fighting !== token) return;
      const last = i === m.rounds.length - 1;
      if (!last) {
        await betweenScreen((html) => resultFor(data, m, r.n, { assetsOf: fighterAssets, buttons: html }), [['Дальше']], { auto: 7 });
        if (fighting !== token || token.abort) return;
      } else {
        const buttons = [['Ещё раз', () => watchMatch(m)], ['К матчу', leaveFight]];
        const k = await betweenScreen((html) => resultFor(data, m, r.n, { assetsOf: fighterAssets, buttons: html }), buttons);
        if (k >= 0) buttons[k][1]();
      }
    }
  } catch (e) {
    failed(e);
  }
}

// the two corners of a fight outside a match: each fighter's accent, two fixed colours when they wear the same
function pairColors(fa, va, fb, vb) {
  const a = colorsOf(fa, va.v).accent;
  const b = colorsOf(fb, vb.v).accent;
  return a.toLowerCase() === b.toLowerCase() ? ['#ff7a33', '#4fc3ff'] : [a, b];
}

async function startCustom(p) {
  const fa = fighterById(p.a.id);
  const fb = fighterById(p.b.id);
  const va = versionOf(fa, p.a.v);
  const vb = versionOf(fb, p.b.v);
  enterFight('custom');
  fighting.restart = () => startCustom(p);
  const token = fighting;
  const el = busy('Считаю бой');
  try {
    const [assets, stage] = await Promise.all([Promise.all([va.url, vb.url].map(fighterAssets)), stageAssets(stageById(p.stage)?.dir, { hd: settings.quality !== 'medium' })]);
    const txt = $('.txt', el);
    const rec = await computeFight([va.url, vb.url], assets, { progress: (k) => (txt.textContent = `Считаю бой · ${Math.round(k * 100)}%`) });
    if (fighting !== token) return;
    overlay.replaceChildren();
    nav.enabled = false;
    const res = await fightView.show({ assets, urls: [va.url, vb.url], names: [fa.model, fb.model], stage, steps: rec.steps, seed: rec.seed, show: { round: 1, wins: [0, 0], firstTo: 2, final: false, result: false }, totalTicks: E.ROUND_TICKS });
    if (res.stopped || fighting !== token) return;
    const st = await quickStats(assets.map((a) => a.def), rec.steps, rec.seed);
    const cols = pairColors(fa, va, fb, vb);
    const buttons = [['Ещё раз', () => startCustom(p)], ['Другие бойцы', leaveFight]];
    const k = await betweenScreen((html) => resultScreen({
      title: `Свой бой · ${stageById(p.stage)?.name || ''}`, bg: stageById(p.stage)?.thumb || null, winner: rec.winner, reason: rec.reason, firstTo: 1, score: [rec.winner === 0 ? 1 : 0, rec.winner === 1 ? 1 : 0], st, buttons: html,
      sides: [[fa, va], [fb, vb]].map(([f, v], i) => ({ name: assets[i].def.card.name, model: f.model, color: cols[i], assets: assets[i] })),
    }), buttons);
    if (k >= 0) buttons[k][1]();
  } catch (e) {
    failed(e);
  }
}

async function startLive(p) {
  const fa = fighterById(p.a.id);
  const fb = fighterById(p.b.id);
  const va = versionOf(fa, p.a.v);
  const vb = versionOf(fb, p.b.v);
  enterFight('live');
  fighting.restart = () => startLive(p);
  const token = fighting;
  busy('Готовлю бой');
  try {
    const [aa, ab, stage] = await Promise.all([fighterAssets(va.url), fighterAssets(vb.url), stageAssets(stageById(p.stage)?.dir, { hd: settings.quality !== 'medium' })]);
    const live = new LiveMatch(fightView, { me: { assets: aa, url: va.url }, cpu: { assets: ab, url: vb.url }, stage, names: ['Игрок', fb.model] });
    overlay.replaceChildren();
    nav.enabled = false;
    ctrlDef = aa.def;
    live.onFight = () => showControls(aa.def, { stay: live.round === 1 && !live.rerun ? 7000 : 3500 });
    const cols = pairColors(fa, va, fb, vb);
    const sides = [{ name: aa.def.card.name, model: 'Игрок', color: cols[0], assets: aa }, { name: ab.def.card.name, model: fb.model, color: cols[1], assets: ab }];
    for (;;) {
      const num = live.round;
      const rerun = live.rerun;
      const res = await live.playRound();
      if (res.stopped || fighting !== token) return;
      hideControls();
      const st = await quickStats([aa.def, ab.def], res.steps, res.seed);
      const screen = (html) => resultScreen({ title: `Раунд ${num}${rerun ? ' · переигровка' : ''}`, bg: stageById(p.stage)?.thumb || null, winner: res.winner, reason: res.reason, firstTo: 2, score: [...live.wins], final: res.over, st, sides, buttons: html });
      if (res.over) {
        const buttons = [['Реванш', () => startLive(p)], ['Сменить бойцов', leaveFight]];
        const k = await betweenScreen(screen, buttons);
        if (k >= 0) buttons[k][1]();
        return;
      }
      await betweenScreen(screen, [['Дальше']], { auto: 6 });
      if (fighting !== token || token.abort) return;
      nav.enabled = false;
    }
  } catch (e) {
    failed(e);
  }
}

function failed(e) {
  console.error(e);
  afterMenu('Не получилось', esc(e.message || e), [['В меню', leaveFight]]);
}

// in a fight: Esc / Start pauses; a pause menu takes the navigation
window.addEventListener('keydown', (e) => {
  if (!fighting) return;
  if (e.key === 'Escape' && !fighting.paused && !nav.enabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    pauseMenu();
  } else if (e.key === 'Escape' && fighting.paused && fighting.resume && overlay.querySelector('[data-k="go"]')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    fighting.resume();
  }
}, true);

// fingers have no Esc: a touch on the fight pauses it, the button in the corner goes back
let finger = false;
addEventListener('pointerdown', (e) => (finger = e.pointerType !== 'mouse'), true);
$('#frame').addEventListener('click', () => {
  if (finger && fighting && !fighting.paused && !nav.enabled) pauseMenu();
});
$('#backBtn').addEventListener('click', () => back());

let padStart = false;
function frame(now) {
  pads.poll(now);
  if (fighting && !fighting.paused && !nav.enabled) {
    const p = pads.first();
    const s = !!p?.buttons[9]?.pressed;
    if (s && !padStart) pauseMenu();
    padStart = s;
  }
  requestAnimationFrame(frame);
}

// ---------- start ----------

// new fighters and new versions after a locker room show up on their own: the data is read again when the
// window comes back into focus and on the way back to the main menu
let refreshing = null;
async function refreshData() {
  if (refreshing || fighting) return refreshing;
  refreshing = loadGame().then((d) => {
    const changed = d.text !== data.text;
    if (changed) data = d;
    return changed;
  }).catch(() => false).finally(() => (refreshing = null));
  return refreshing;
}
window.addEventListener('focus', () => refreshData().then((changed) => {
  const top = stack[stack.length - 1];
  if (changed && top && top.name !== 'title' && !overlay.firstChild) render(top, true);
}));

let introReady = Promise.resolve(null);

// behind the menus: one of the stages and the newest contestants of the roster (one stands alone, none — the
// empty stage); the sparring dummy and the kit's template are never shown there
function startMenuBackdrop() {
  const pair = contestants().slice(-2);
  const stage = data.stages[Math.floor(Date.now() / 86400000) % Math.max(1, data.stages.length)];
  const urls = pair.map((f) => topVersion(f).url);
  introReady.then(() => Promise.all([Promise.all(urls.map(fighterAssets)), stageAssets(stage?.dir, { hd: settings.quality !== 'medium' })]))
    .then(([assets, st]) => backdrop.start({ assets, urls, stage: st })).catch((e) => console.warn('фон', e));
}

async function boot() {
  await ringFonts();
  data = await loadGame();
  if (data.static) {
    settings.ads = false;
    // the site's lighter copies of the fighters' pictures, one small file a fighter
    const rigs = new Map();
    useLightPictures(async (url) => {
      const dir = url.startsWith(ROOT.href) ? url.slice(ROOT.href.length) : null;
      const id = dir?.match(/^(?:seasons\/[^/]+\/fighters|roster)\/([^/]+)\//)?.[1];
      if (!id) return null;
      if (!rigs.has(id)) rigs.set(id, fetch(at(`ui/rig/${id}.json`)).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
      const map = (await rigs.get(id))[dir];
      return map ? Object.fromEntries(Object.entries(map).map(([img, to]) => [img, at(to)])) : null;
    });
  }
  requestAnimationFrame(frame);
  // the opening needs the four stages and the contestants (never the dummy); behind the menus later the same
  introReady = (async () => {
    try {
      const ids = ['rooftop', 'server', 'foundry', 'temple'];
      const stages = {};
      await Promise.all(ids.map(async (id) => {
        const st = stageById(id);
        if (st) stages[id] = await stageAssets(st.dir, { hd: settings.quality !== 'medium' });
      }));
      const cast = await Promise.all(contestants().slice(-2).map((f) => fighterAssets(topVersion(f).url)));
      const kit = fighterById('kit/fighter');
      const filler = kit ? await fighterAssets(topVersion(kit).url) : cast[0];
      backdrop.filler = filler;
      return { stages, cast, filler };
    } catch (e) {
      console.warn('заставка', e);
      return null;
    }
  })();
  // a link straight into a screen skips the title: the menu background starts now (the title starts its own)
  const linked = q.get('screen') || q.get('match');
  if (linked) startMenuBackdrop();
  // A link from the site opens a round or a screen at once, past the title — and a browser gives a page its sound
  // only after a press on it. A visitor who has pressed something on the site usually keeps that right on the next
  // page, so the game asks for a press only when the sound really did not start.
  if (linked) {
    sfx.unlock();
    if (data.static) await Promise.race([sfx.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 150))]);
    if (data.static && sfx.ctx.state !== 'running') {
      await new Promise((res) => {
        const gate = document.createElement('div');
        gate.id = 'gate';
        document.getElementById('boot')?.remove();
        gate.innerHTML = `<div class="press">${PRESS}</div>`;
        document.body.appendChild(gate);
        // «click» is the end of a touch (sfx.js GESTURES); the press itself turns the sound on in the listener above
        const go = () => {
          removeEventListener('keydown', go, true);
          gate.remove();
          res();
        };
        addEventListener('keydown', go, true);
        gate.addEventListener('click', go);
      });
      sfx.unlock();
      // a browser that still holds the sound back does not hold the game: the next press tries again
      await Promise.race([sfx.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    }
    wakeSound();
    // the press on the site's link is finished here: its sound was cut by the change of pages
    if (data.static) {
      let from = 9;
      try {
        const t = JSON.parse(sessionStorage.getItem('ring.press') || 'null');
        sessionStorage.removeItem('ring.press');
        if (t) from = (Date.now() - t.at) / 1000;
      } catch {}
      if (from < 0.7) sfx.play('menu-select', 1, 0, 0, from);
      else menu.start();
    }
  }
  // the two fighters of the main menu are drawn while the title is on; every other still waits for its tile
  (async () => {
    for (const f of contestants().slice(-2)) await figureShot(await fighterAssets(topVersion(f).url), { w: 680, h: 900, crop: 'knees' }).catch(() => {});
  })();
  // A published game opened by a link has no menu under its first screen: Esc there leads back to the site.
  const under = data.static ? [] : [{ name: 'main', args: {} }];
  // links: ?screen=roster, ?match=<id>&round=N&auto=round
  // ?match=<id>&round=N&auto=result (the round's result screen) or auto=locker&cid=<id> (its locker room)
  if (q.get('match') && ['result', 'locker'].includes(q.get('auto'))) {
    stack.push(...under, { name: 'match', args: { id: q.get('match') } });
    await render(stack[stack.length - 1]);
    const m = data.matches.find((x) => x.id === q.get('match'));
    const n = Number(q.get('round') || 1);
    if (m) {
      const buttons = [['К матчу', () => closeOverlay(false)]];
      const make = (html) => (q.get('auto') === 'locker' ? lockerFor(data, m, n, q.get('cid') || m.red, { assetsOf: fighterAssets, buttons: html }) : resultFor(data, m, n, { assetsOf: fighterAssets, buttons: html }));
      betweenScreen(make, buttons, { kind: q.get('auto') === 'locker' ? 'locker' : 'round' }).then((i) => i >= 0 && buttons[i][1]());
    }
    return;
  }
  if (q.get('match') && q.get('auto') === 'round') {
    stack.push(...under, { name: 'match', args: { id: q.get('match') } });
    await render(stack[stack.length - 1]);
    const m = data.matches.find((x) => x.id === q.get('match'));
    if (m) watchRound(m, Number(q.get('round') || 1));
    return;
  }
  const screen = q.get('screen');
  if (screen && SCREENS[screen]) {
    stack.push(...under);
    const args = q.get('id') ? { id: q.get('id'), v: q.get('v') ? Number(q.get('v')) : null, tab: q.get('tab') || undefined } : {};
    // ?screen=play&vs=c/<id> — the opponent is already chosen (the site's «Сразиться» on a fighter's page);
    // ?screen=custom&a=c/<id> — the left corner is chosen, the cursor chooses its opponent («Стравить»)
    if (['play', 'custom', 'versus'].includes(screen)) {
      initPick();
      const vs = fighterById(q.get('vs'));
      const a = fighterById(q.get('a'));
      if (vs) {
        if (pick.a.id === vs.id) pick.a = pick.b;
        pick.b = { id: vs.id, v: topVersion(vs).v };
      }
      if (a) {
        if (pick.b.id === a.id) pick.b = pick.a;
        Object.assign(pick, { a: { id: a.id, v: topVersion(a).v }, side: 'b' });
      }
    }
    go(screen, args);
    return;
  }
  go('title');
}

boot().catch((e) => {
  console.error(e);
  ui.innerHTML = `<section class="screen"><div class="empty">Игра не загрузилась: ${esc(e.message)}</div></section>`;
});

// for tests and agents: the game state and a direct way into a live fight
window.__game = { get data() { return data; }, go, back, get stack() { return stack; }, nav, fightView, startLive, startCustom, pick, sfx, load: () => ({ held: heldFighters(), waiting: shotsWaiting() }) };
