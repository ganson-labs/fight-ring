// «Ринг моделей» — the game. Title, main menu, roster with fighter cards and their versions, matches with the
// locker room between rounds, a fight of two brains, a fight of the player against a brain, settings.
// Everything it shows comes from /api/game: the judge's match snapshots and the contestants' folders.
import * as E from '/kit/arena/engine/index.js';
import { Sfx } from '../sfx.js';
import { Nav, Pads, controlsHint, padHint, moveList, commandHtml, KEY_OF, PAD_OF, BTN_NAME } from './input.js';
import { MenuSound } from './sound.js';
import { figureShot, FigureView } from './figure.js';
import { FightView, LiveMatch, computeFight, fighterAssets, stageAssets, expand } from './fight.js';
import { Backdrop } from './backdrop.js';
import { Intro } from './intro.js';
import { tournamentScreen } from './tournament.js';
import { resultFor, lockerFor, resultScreen, quickStats, storyHtml, matchStatsView, protocolView, changesView, icon, saidPlain, SCREEN_SOUNDS } from './screens.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const q = new URLSearchParams(location.search);

// ---------- settings ----------

const DEFAULTS = { sound: true, volume: 0.8, menuVolume: 0.8, aspect: '16:9', ads: false, quality: 'high', fullscreen: false };
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

const sfx = new Sfx();
const menu = new MenuSound(sfx);
function applySettings() {
  sfx.set(settings.sound, settings.volume, settings.menuVolume);
  document.body.classList.toggle('q-medium', settings.quality === 'medium');
  fightView?.fit();
}

// full screen: F or the button in the corner; the choice is remembered and comes back on the first key press
function setFullscreen(on) {
  const el = document.documentElement;
  try {
    if (on && !document.fullscreenElement) el.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  } catch {}
}
function toggleFullscreen() {
  settings.fullscreen = !document.fullscreenElement;
  saveSettings();
  setFullscreen(settings.fullscreen);
  const top = stack[stack.length - 1];
  if (top?.name === 'settings') setTimeout(() => SCREENS.settings({}, false), 120);
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
const fightView = new FightView({ frame: $('#frame'), settings: () => settings, sfx });
applySettings();
$('#fsBtn')?.addEventListener('click', () => toggleFullscreen());
const backdrop = new Backdrop($('#bg'));
let fighting = null; // { kind, pause() } while a fight is on screen
let cardView = null;

const nav = new Nav({
  onMove: () => menu.move(),
  onBack: () => back(),
  onPress: () => menu.confirm(),
});
const pads = new Pads(nav);

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
  if (!v.rounds.length) return f.training ? 'набор' : 'в папке сейчас';
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

function mount(html, { id, cls = '', backIn = false, focus = null } = {}) {
  cardView?.destroy();
  cardView = null;
  const el = document.createElement('section');
  el.className = `screen ${cls} ${backIn ? 'back-in' : ''}`;
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
  if (stack.length <= 1) return;
  menu.back();
  stack.pop();
  render(stack[stack.length - 1], true);
}

// a screen that keeps working while it is open (the tournament console) stops when another one opens
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

function render(entry, backIn = false) {
  screenLeave?.();
  screenLeave = null;
  document.body.classList.toggle('menu', entry.name !== 'title');
  $('#legend').hidden = entry.name === 'title';
  SCREENS[entry.name](entry.args, backIn);
}

const legend = (extra = '') => `<b>⏎</b>Выбрать &nbsp; <b>Esc</b>Назад${extra}`;

const SCREENS = {
  // the opening (intro.js) on the live background, then «Нажми любую клавишу». A key during the opening skips
  // to its end; the second time in a session the opening is skipped at once.
  title() {
    const el = mount(`
      <div class="intro-title">
        <h1 class="intro-logo"><span class="w1" data-t="Ринг">Ринг</span><span class="w2" data-t="моделей">моделей</span></h1>
        <div class="press">Нажми любую клавишу</div>
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
      sfx.unlock();
      sfx.preload();
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
      el.addEventListener('pointerdown', () => {
        if (nav.anyKey) {
          nav.anyKey = null;
          startGame();
        }
      }, { once: true });
    };
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
    const items = [['tournament', 'Турнир'], ['matches', 'Матчи'], ['roster', 'Бойцы'], ['custom', 'Свой бой'], ['play', 'Играть самому'], ['settings', 'Настройки']];
    const el = mount(`
      <div class="wrap">
        <div>
          <div class="brand slab hot">Ринг моделей</div>
          <nav class="mm">${items.map(([k, t], i) => `<button class="item" data-nav data-go="${k}"><span class="n">0${i + 1}</span>${t}</button>`).join('')}</nav>
        </div>
        <div class="side"><div class="pair"></div><div class="caption"></div></div>
      </div>`, { id: 'main', backIn, focus: stack.mainFocus ? `[data-go="${stack.mainFocus}"]` : null });
    el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => {
      stack.mainFocus = b.dataset.go;
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

  roster(_, backIn) {
    const list = contestants();
    const train = data.fighters.filter((f) => f.training);
    const tile = (f) => {
      const c = colorsOf(f);
      const v = topVersion(f);
      return `<button class="tile" data-nav data-id="${esc(f.id)}" style="${cssColors(c)}"><img alt="" data-shot="${esc(v.url)}"><span class="ver">${f.versions.length > 1 ? `${f.versions.length} версии` : 'v1'}</span><div class="meta"><span class="model">${esc(f.model)}</span><div class="name slab">${esc(v.name)}</div></div></button>`;
    };
    const el = mount(`
      <div class="head"><div class="left"><span class="kicker">Ростер</span><h1 class="title slab">Бойцы</h1></div></div>
      ${list.length ? `<div class="grid">${list.map(tile).join('')}</div>` : '<div class="empty">Бойцов пока нет: их создают участники</div>'}
      ${train.length ? `<div class="label section">Спарринг</div><div class="grid small">${train.map(tile).join('')}</div>` : ''}`, { id: 'roster', backIn });
    el.querySelectorAll('.tile').forEach((b) => (b.onclick = () => go('card', { id: b.dataset.id })));
    fillShots(el);
    $('#legend').innerHTML = legend();
  },

  card({ id, v = null, tab = null }, backIn) {
    const f = fighterById(id);
    const ver = versionOf(f, v);
    const c = colorsOf(f, ver.v);
    const hasChanges = !!ver.changes;
    const T = tab === 'changes' && !hasChanges ? 'about' : tab || 'about';
    stack[stack.length - 1].args.tab = T;
    const el = mount(`
      <div class="layout" style="${cssColors(c)}">
        <div class="stage"><div class="anim"><button class="btn" data-nav data-anim="intro">Представление</button><button class="btn" data-nav data-anim="victory">Победа</button><button class="btn" data-nav data-reveal>Собрать заново</button></div></div>
        <div class="info">
          <span class="plate">${esc(f.model)}</span>
          <h1 class="name slab" data-fit>${esc(ver.name)}</h1>
          <div class="motto" data-motto></div>
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
    Promise.all([view.init(), fighterAssets(ver.url)]).then(([, a]) => {
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
      <div class="head"><div class="left"><span class="kicker">Записи судьи</span><h1 class="title slab">Матчи</h1></div></div>
      ${data.matches.length ? `<div class="mlist">${data.matches.map(card).join('')}</div>` : '<div class="empty">Матчей пока нет</div>'}`, { id: 'matches', backIn });
    el.querySelectorAll('.mcard').forEach((b) => (b.onclick = () => go('match', { id: b.dataset.id })));
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
      <div class="mhead" style="--ca:${cornerOf(m, m.red)};--cb:${cornerOf(m, m.blue)}">
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
    pickerScreen('custom', args, backIn);
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
    pickerScreen('play', args, backIn);
  },

  settings(_, backIn) {
    const on = (v) => (v ? 'Вкл' : 'Выкл');
    const ICO = { sound: 'play', volume: 'stat', menuVolume: 'stat', aspect: 'card', quality: 'super', fullscreen: 'replay', ads: 'juicy' };
    const opt = (key, title, val) => `<button class="opt" data-nav data-adjust data-key="${key}"><span class="o-t">${icon(ICO[key])}<span>${title}</span></span><span class="val">${val}</span></button>`;
    const vol = (v) => `<span class="vol">${Array.from({ length: 10 }, (_, i) => `<i class="${i < Math.round(v * 10) ? 'on' : ''}"></i>`).join('')}</span>`;
    const two = (a, b, cur) => `<span class="o ${cur === a ? 'on' : ''}">${a}</span><span class="o ${cur === b ? 'on' : ''}">${b}</span>`;
    const el = mount(`
      <div class="head"><div class="left"><span class="kicker">Игра</span><h1 class="title slab">Настройки</h1></div></div>
      <div class="set">
        ${opt('sound', 'Звук', two('Вкл', 'Выкл', on(settings.sound)))}
        ${opt('volume', 'Громкость', vol(settings.volume))}
        ${opt('menuVolume', 'Звуки меню', vol(settings.menuVolume))}
        ${opt('aspect', 'Кадр боя', two('16:9', '9:16', settings.aspect))}
        ${opt('quality', 'Качество', two('Высокое', 'Среднее', settings.quality === 'medium' ? 'Среднее' : 'Высокое'))}
        ${opt('fullscreen', 'Полный экран', two('Вкл', 'Выкл', on(settings.fullscreen)))}
        ${opt('ads', 'Реклама', two('Вкл', 'Выкл', on(settings.ads)))}
        <a class="opt" data-nav href="/viewer/dev.html" style="text-decoration:none"><span>Режим разработчика</span><span class="val">→</span></a>
      </div>`, { id: 'settings', backIn, focus: stack.setFocus ? `[data-key="${stack.setFocus}"]` : null });
    const change = (key, dir) => {
      if (key === 'sound') settings.sound = !settings.sound;
      if (key === 'ads') settings.ads = !settings.ads;
      if (key === 'aspect') settings.aspect = settings.aspect === '16:9' ? '9:16' : '16:9';
      if (key === 'quality') settings.quality = settings.quality === 'medium' ? 'high' : 'medium';
      if (key === 'fullscreen') return toggleFullscreen();
      if (key === 'volume' || key === 'menuVolume') settings[key] = Math.max(0, Math.min(1, Math.round((settings[key] + (dir || 1) * 0.1) * 10) / 10));
      saveSettings();
      stack.setFocus = key;
      SCREENS.settings({}, false);
      menu.move();
    };
    el.querySelectorAll('[data-key]').forEach((b) => {
      b.onclick = (e) => {
        const k = b.dataset.key;
        if (k === 'volume' || k === 'menuVolume') {
          const r = b.querySelector('.vol').getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.detail) {
            settings[k] = Math.max(0.1, Math.min(1, Math.ceil(((e.clientX - r.left) / r.width) * 10) / 10));
            saveSettings();
            stack.setFocus = k;
            return SCREENS.settings({}, false);
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
  root.querySelectorAll('img[data-shot]').forEach(async (img) => {
    try {
      img.src = await figureShot(await fighterAssets(img.dataset.shot), img.dataset.crop === 'knees' ? { w: 520, h: 680, crop: 'knees' } : {});
    } catch {}
  });
}

// ---------- pickers: two corners and a stage ----------

const pick = { custom: null, play: null };

function defaultPick(kind) {
  const list = contestants();
  const a = list[0] || data.fighters[0];
  const b = kind === 'play' ? list[1] || fighterById('sparring/dummy') || data.fighters[0] : list[1] || data.fighters[1] || a;
  return { a: { id: a.id, v: topVersion(a).v }, b: { id: b.id, v: topVersion(b).v }, stage: data.stages[0]?.id || null };
}

function pickerScreen(kind, args, backIn) {
  const p = (pick[kind] ||= defaultPick(kind));
  const corner = (side) => {
    const s = p[side];
    const f = fighterById(s.id);
    const v = versionOf(f, s.v);
    const c = colorsOf(f, v.v);
    const label = kind === 'play' ? (side === 'a' ? 'Ты' : 'Соперник') : side === 'a' ? 'Слева' : 'Справа';
    return `<div class="col" style="display:flex;flex-direction:column;gap:10px">
      <button class="slot ${side === 'b' ? 'r' : ''}" data-nav data-slot="${side}" style="${cssColors(c)}"><img alt="" data-shot="${esc(v.url)}" data-crop="knees"><span class="corner">${label}</span><span class="change">Сменить</span><span class="plate">${esc(f.model)}</span><span data-fit class="nm slab">${esc(v.name)}</span></button>
      ${f.versions.length > 1 ? `<div class="versions" style="${cssColors(c)};${side === 'b' ? 'justify-content:flex-end' : ''}">${f.versions.map((x) => `<button class="vchip ${x.v === v.v ? 'on' : ''}" data-nav data-side="${side}" data-v="${x.v}"><span class="v">${x.label}</span><span class="when">${esc(versionWhen(f, x))}</span></button>`).join('')}</div>` : ''}
    </div>`;
  };
  const me = kind === 'play' ? versionOf(fighterById(p.a.id), p.a.v) : null;
  const el = mount(`
    <div class="head"><div class="left"><span class="kicker">${kind === 'play' ? 'Ты против бойца' : 'Мозги против мозгов'}</span><h1 class="title slab">${kind === 'play' ? 'Играть самому' : 'Свой бой'}</h1></div>
      <button class="btn primary" data-nav data-start ${args.focusStart ? 'data-autofocus' : ''}>В бой</button></div>
    <div class="versus">${corner('a')}<div class="vsmark slab hot">VS</div>${corner('b')}</div>
    <div class="label">Сцена</div>
    <div class="stages">${data.stages.map((s) => `<button class="stg ${s.id === p.stage ? 'on' : ''}" data-nav data-stage="${esc(s.id)}" style="background-image:url('${esc(s.thumb || '')}')"><span>${esc(s.name)}</span></button>`).join('')}</div>
    ${kind === 'play' ? '<div class="label">Клавиатура</div><div data-hint></div>' : ''}`, { id: kind, backIn, focus: args.focus || null });
  el.querySelectorAll('[data-slot]').forEach((b) => (b.onclick = () => openPicker(kind, b.dataset.slot)));
  el.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => {
    p[b.dataset.side].v = Number(b.dataset.v);
    pickerScreen(kind, { focus: `[data-side="${b.dataset.side}"][data-v="${b.dataset.v}"]` }, false);
  }));
  el.querySelectorAll('[data-stage]').forEach((b) => (b.onclick = () => {
    p.stage = b.dataset.stage;
    pickerScreen(kind, { focus: `[data-stage="${b.dataset.stage}"]` }, false);
  }));
  $('[data-start]', el).onclick = () => (kind === 'play' ? startLive(p) : startCustom(p));
  fillShots(el);
  if (me) fighterAssets(me.url).then((a) => {
    const box = $('[data-hint]', el);
    if (!box) return;
    const kb = controlsHint(a.def).base;
    const chip = ([k, t]) => `<span class="kk"><b>${esc(k)}</b>${esc(t)}</span>`;
    box.innerHTML = `<div class="keys">${kb.map(chip).join('')}</div>
      <div class="label">Геймпад</div><div class="keys">${padHint().map(chip).join('')}</div>
      <div class="label">Приёмы</div>${moveListHtml(a.def)}`;
  }).catch(() => {});
  $('#legend').innerHTML = legend();
}

function openPicker(kind, side) {
  const p = pick[kind];
  const all = data.fighters;
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="head"><div class="left"><span class="kicker">${kind === 'play' ? (side === 'a' ? 'Твой боец' : 'Соперник') : side === 'a' ? 'Слева' : 'Справа'}</span><h1 class="title slab">Выбери бойца</h1></div></div>
    <div class="grid">${all.map((f) => {
      const c = colorsOf(f);
      const v = topVersion(f);
      return `<button class="tile ${f.id === p[side].id ? 'sel' : ''}" data-nav data-id="${esc(f.id)}" style="${cssColors(c)}"><img alt="" data-shot="${esc(v.url)}"><div class="meta"><span class="model">${esc(f.model)}</span><div class="name slab">${esc(v.name)}</div></div></button>`;
    }).join('')}</div>`;
  overlay.replaceChildren(m);
  overlay.dataset.closable = '1';
  nav.setRoot(m, `[data-id="${CSS.escape(p[side].id)}"]`);
  fillShots(m);
  m.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => {
    const f = fighterById(b.dataset.id);
    p[side] = { id: f.id, v: topVersion(f).v };
    closeOverlay(false);
    pickerScreen(kind, { focus: `[data-slot="${side}"]` }, false);
  }));
}

function closeOverlay(sound = true) {
  if (sound) menu.back();
  overlay.replaceChildren();
  overlay.dataset.closable = '';
  nav.setRoot(ui.firstElementChild);
}

// ---------- fights ----------

function showOverlay(html, { closable = false, focus = null } = {}) {
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
  backdrop.pause(true);
  ui.hidden = true;
  $('#legend').hidden = true;
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

// a fighter's command list like fighting games show it
function moveListHtml(def, device = 'kb') {
  const SL = { normal: 'Обычные удары', special: 'Особые приёмы', super: 'Суперприём' };
  let last = null;
  const rows = moveList(def).map((m) => {
    const head = m.slot !== last ? `<div class="ml-h">${SL[m.slot]}</div>` : '';
    last = m.slot;
    return `${head}<div class="ml-r"><span class="ml-n">${esc(m.name)}${m.ability ? '<span class="tag">способность</span>' : ''}</span>${commandHtml(m, device)}</div>`;
  }).join('');
  const keys = ['LP', 'HP', 'LK', 'HK'].map((b) => `<span class="kc"><i class="cb ${b.endsWith('P') ? 'p' : 'k'}">${b}</i>${device === 'pad' ? PAD_OF[b] : KEY_OF[b]} · ${BTN_NAME[b]}</span>`).join('');
  const extra = device === 'pad' ? [['LB', 'бросок'], ['LT', 'парирование'], ['RT', 'суперприём']] : [['U+J', 'бросок'], ['N', 'парирование'], ['I+K', 'суперприём']];
  return `<div class="movelist"><div class="ml-keys">${keys}${extra.map(([k, t]) => `<span class="kc"><b>${k}</b>${t}</span>`).join('')}</div>${rows}<div class="ml-note">Стрелки — от бойца к сопернику: → вперёд, ← назад. <i class="ca hold">←</i> — держать.</div></div>`;
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
  const el = showOverlay(`<div class="pauseov ${list ? 'has-list' : ''}"><div class="p-left"><span class="kicker">${esc(fighting.kind === 'live' ? 'Ты против бойца' : fighting.kind === 'custom' ? 'Свой бой' : 'Матч')}</span><div class="slab hot p-big">Пауза</div>
    <nav class="mm">
    <button class="item" data-nav data-autofocus data-k="go">Продолжить</button>
    ${fighting.restart ? '<button class="item" data-nav data-k="again">Начать заново</button>' : ''}
    <button class="item" data-nav data-k="out">Выйти в меню</button></nav></div>${list ? `<div class="p-list"><div class="label">Приёмы · ${esc(ctrlDef.card.name)}</div>${list}</div>` : ''}</div>`);
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

async function roundShow(m, r, { intro = true } = {}) {
  const [assets, stage, replay] = await Promise.all([Promise.all(r.dirs.map(fighterAssets)), stageAssets(stageById(r.stage)?.dir, { hd: settings.quality !== 'medium' }), fetch(r.replay, { cache: 'no-store' }).then((x) => x.json())]);
  return fightView.show({
    assets, urls: r.dirs, names: [m.models[r.left], m.models[r.right]], stage, steps: expand(replay.steps), seed: replay.seed, intro,
    show: { round: r.num, rerun: r.rerun, wins: r.wins, firstTo: m.firstTo, final: r.final, result: false }, totalTicks: replay.result?.ticks || 1,
  });
}

async function watchRound(m, n) {
  const r = m.rounds.find((x) => x.n === n);
  enterFight('round');
  fighting.restart = () => watchRound(m, n);
  busy('Загружаю раунд');
  try {
    const p = roundShow(m, r);
    overlay.replaceChildren();
    nav.enabled = false;
    const res = await p;
    if (res.stopped || !fighting) return;
    const next = m.rounds.find((x) => x.n === n + 1);
    const buttons = [['Ещё раз', () => watchRound(m, n)], ...(next ? [['Следующий раунд', () => watchRound(m, n + 1)]] : []), ['К матчу', leaveFight]];
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
    for (let i = 0; i < m.rounds.length; i++) {
      const r = m.rounds[i];
      const prev = m.rounds[i - 1];
      const changed = prev ? [m.red, m.blue].filter((cid) => prev.versions[cid] !== r.versions[cid]) : [];
      for (const cid of changed) {
        await betweenScreen((html) => lockerFor(data, m, r.n, cid, { assetsOf: fighterAssets, buttons: html }), [['Дальше']], { auto: 9, kind: 'locker' });
        if (fighting !== token || token.abort) return;
      }
      busy('Загружаю раунд');
      const p = roundShow(m, r, { intro: i === 0 || changed.length > 0 });
      overlay.replaceChildren();
      nav.enabled = false;
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
  refreshing = fetch('/api/game', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
    const changed = JSON.stringify(d) !== JSON.stringify(data);
    data = d;
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
  try {
    await document.fonts.load('700 italic 40px Oswald');
    await document.fonts.load('500 20px Oswald');
  } catch {}
  data = await (await fetch('/api/game', { cache: 'no-store' })).json();
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
  if (q.get('screen') || q.get('match')) startMenuBackdrop();
  // shots of the roster are made while the title is on: menus open with their pictures ready
  (async () => {
    for (const f of contestants().slice(-2)) await figureShot(await fighterAssets(topVersion(f).url), { w: 680, h: 900, crop: 'knees' }).catch(() => {});
    for (const f of data.fighters) await figureShot(await fighterAssets(topVersion(f).url)).catch(() => {});
  })();
  // links: ?screen=roster, ?match=<id>&round=N&auto=round
  // ?match=<id>&round=N&auto=result (the round's result screen) or auto=locker&cid=<id> (its locker room)
  if (q.get('match') && ['result', 'locker'].includes(q.get('auto'))) {
    stack.push({ name: 'main', args: {} }, { name: 'match', args: { id: q.get('match') } });
    render(stack[stack.length - 1]);
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
    stack.push({ name: 'main', args: {} }, { name: 'match', args: { id: q.get('match') } });
    render(stack[stack.length - 1]);
    const m = data.matches.find((x) => x.id === q.get('match'));
    if (m) watchRound(m, Number(q.get('round') || 1));
    return;
  }
  if (q.get('screen') && SCREENS[q.get('screen')]) {
    stack.push({ name: 'main', args: {} });
    const args = q.get('id') ? { id: q.get('id'), v: q.get('v') ? Number(q.get('v')) : null, tab: q.get('tab') || undefined } : {};
    go(q.get('screen'), args);
    return;
  }
  go('title');
}

boot().catch((e) => {
  console.error(e);
  ui.innerHTML = `<section class="screen"><div class="empty">Игра не загрузилась: ${esc(e.message)}</div></section>`;
});

// for tests and agents: the game state and a direct way into a live fight
window.__game = { get data() { return data; }, go, back, get stack() { return stack; }, nav, fightView, startLive, startCustom };
