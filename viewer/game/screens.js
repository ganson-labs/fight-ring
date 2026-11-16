// The screens between rounds, drawn like the VS: the round result (the winner big in the victory pose with a back
// light, the loser in the shade, the outcome slammed in, the match score, two or three numbers of the round and
// the health of both as a glowing curve with the key moments on it) and the locker room (the fighter before and
// after, what changed as cards with icons, the model's own words). The same screens play in the game (live, over
// the fight frame) and in the match reel (viewer/card.html records them frame by frame): every animation is a
// function of the screen's time, seek(t) shows any frame. Plus the «История» tab of a match page.
import * as PIXI from 'pixi.js';
import { solvePose, sampleAnim, STAT_MAX } from '/kit/arena/engine/index.js';
import { litFigure } from './figure.js';
import { keyNumbers, changeCards, plainSay, saidHtml } from './screen-data.js';

export { keyNumbers, changeCards };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export { saidHtml, saidPlain } from './screen-data.js';
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const k01 = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const easeOut = (k) => 1 - (1 - clamp(k, 0, 1)) ** 3;
const hash = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const hexNum = (h) => parseInt(String(h || '#ffffff').slice(1), 16);
const fmt = (v) => String(v).replace('.', ',');

// ---------- icons (24×24, stroke) ----------

const ICON = {
  stat: '<path d="M4 20V13M10 20V8M16 20V11M22 20V4" />',
  move: '<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V10m0-4.5a1.5 1.5 0 0 1 3 0V10m0-3.5a1.5 1.5 0 0 1 3 0V11m0-2.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4L4.5 15a1.6 1.6 0 0 1 2.7-1.7L9 15" />',
  ability: '<path d="M13 2 4 14h7l-1 8 9-12h-7z" />',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" /><path d="M12 9h2M12 14h3M9 10H8M10 15H8" />',
  card: '<rect x="4" y="3" width="16" height="18" rx="2" /><circle cx="12" cy="10" r="3" /><path d="M7.5 18a5 5 0 0 1 9 0" />',
  same: '<path d="M5 9h14M5 15h14" /><circle cx="12" cy="12" r="10" />',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />',
  replay: '<path d="M4 12a8 8 0 1 0 2.6-5.9" /><path d="M4 4v4h4" /><path d="M10 9v6l5-3z" fill="currentColor" stroke="none" />',
  super: '<path d="m12 2 2.6 6.4L21 9l-5 4.3L17.5 20 12 16.5 6.5 20 8 13.3 3 9l6.4-.6z" />',
  combo: '<path d="M4 17 9 7l3 6 3-4 5 8" />',
  comeback: '<path d="M4 19c4 0 5-12 9-12 3 0 3 6 7 6" /><path d="m17 10 3 3-3 3" />',
  ko: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" />',
  fresh: '<path d="M12 4v16M4 12h16" />',
  juicy: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z" />',
  clock: '<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />',
};
export const icon = (k, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ''}</svg>`;

const MOMENT = {
  super: { icon: 'super', label: (m) => (m.damage ? `Супер · ${m.damage}` : 'Супер') },
  combo: { icon: 'combo', label: (m) => `Серия ×${m.hits}` },
  comeback: { icon: 'comeback', label: () => 'Камбэк' },
  last: { icon: 'ko', label: (m, r) => (r === 'ko' ? 'Нокаут' : 'Последний удар') },
  new: { icon: 'fresh', label: () => 'Новое' },
  juicy: { icon: 'juicy', label: (m) => `−${m.damage}` },
};

// ---------- the health curve ----------

// monotone cubic through the points: no bumps above or below the real values
function monoPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0] || 1e-6);
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

// hp: [[seconds, left 0..1, right 0..1], …]; colors: [left, right]; moments: the round's (judge/moments.js);
// at: when the curves start drawing (seconds of the screen), len: how long they draw
export function glowCurve(hp, colors, names, { w = 1680, h = 260, moments = [], reason = 'ko', at = 1, len = 1.6, uid = 'c', cls = '', end: end0 = null, fs = 1 } = {}) {
  if (!hp?.length) return '';
  // the record goes on a little after the end: the curve stops at the last blow
  if (end0) hp = hp.filter((p) => p[0] <= end0 + 0.3);
  const T = hp[hp.length - 1][0] || 1;
  const L = 8;
  const R = w - 120 * fs;
  const top = 46 * fs;
  const bot = h - 34 * fs;
  const x = (t) => L + (t / T) * (R - L);
  const y = (v) => top + (1 - v) * (bot - top);
  // one smooth line through the samples (every quarter second): a drop reads as a slope, the curve as a story
  const N = 56;
  const at01 = (k, t) => {
    let i = 0;
    while (i < hp.length - 1 && hp[i + 1][0] < t) i++;
    const a = hp[i];
    const b = hp[Math.min(hp.length - 1, i + 1)];
    const f = b[0] > a[0] ? clamp((t - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    return a[k] + (b[k] - a[k]) * f;
  };
  const lines = [1, 2].map((k) => monoPath(Array.from({ length: N + 1 }, (_, i) => {
    const t = (i / N) * T;
    return [x(t), y(at01(k, t))];
  })));
  const end = hp[hp.length - 1];
  // the moments on the curve of the one who took the hit, at most four, never crowded
  const picks = [];
  for (const mo of [...moments].sort((a, b) => b.score - a.score)) {
    if (!MOMENT[mo.kind] || picks.length >= 4) continue;
    const t = mo.at / 60;
    if (picks.some((p) => Math.abs(x(p.t) - x(t)) < 150 * fs)) continue;
    picks.push({ ...mo, t });
  }
  const valueAt = (k, t) => {
    let v = hp[0][k];
    for (const p of hp) {
      if (p[0] > t + 0.3) break;
      v = p[k];
    }
    return v;
  };
  const marks = picks.sort((a, b) => a.t - b.t).map((mo, i) => {
    const victim = mo.kind === 'comeback' ? mo.side : 1 - mo.side;
    const cx = x(mo.t);
    const cy = y(valueAt(victim + 1, mo.t));
    const c = colors[mo.side];
    const delay = at + len * (mo.t / T);
    const label = MOMENT[mo.kind].label(mo, reason);
    const lw = Math.round((label.length * 13.5 + 52) * fs);
    const lh = 38 * fs;
    const up = cy > top + 70 * fs;
    return `<g class="gc-mark" style="--c:${c};animation-delay:${delay.toFixed(2)}s" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})">
      <circle r="20" class="gc-halo" fill="${c}"/><circle r="9" fill="#0b0c12" stroke="${c}" stroke-width="4"/>
      <g transform="translate(${clamp(cx - lw / 2, 0, R - lw) - cx + lw / 2},${up ? -46 * fs : 46 * fs})"><rect x="${-lw / 2}" y="${-lh / 2}" width="${lw}" height="${lh}" rx="4" fill="rgba(6,7,11,.86)" stroke="${c}" stroke-width="2"/>
      <g transform="translate(${-lw / 2 + 9 * fs},${-11 * fs}) scale(${0.92 * fs})" color="${c}">${icon(MOMENT[mo.kind].icon).replace('<svg', '<svg width="24" height="24"')}</g>
      <text x="${-lw / 2 + 40 * fs}" y="${8 * fs}" class="gc-lab" style="font-size:${22 * fs}px">${esc(label.toUpperCase())}</text></g></g>`;
  }).join('');
  // the health left at the end, in each side's colour; the two labels never sit on top of each other
  const ys = [y(end[1]), y(end[2])];
  if (Math.abs(ys[0] - ys[1]) < 40) {
    const lo = ys[0] <= ys[1] ? 0 : 1;
    const mid = (ys[0] + ys[1]) / 2;
    ys[lo] = mid - 20;
    ys[1 - lo] = mid + 20;
    const shift = Math.max(0, ys[1 - lo] - bot) - Math.max(0, top - 6 - ys[lo]);
    ys[0] -= shift;
    ys[1] -= shift;
  }
  const tags = [0, 1].map((k) => `<g class="gc-end" style="animation-delay:${(at + len).toFixed(2)}s" transform="translate(${R + 16},${ys[k].toFixed(1)})"><circle r="${7 * fs}" fill="${colors[k]}"/><text x="${16 * fs}" y="${11 * fs}" class="gc-pct" style="font-size:${34 * fs}px" fill="${colors[k]}">${Math.round(end[k + 1] * 100)}%</text></g>`).join('');
  return `<svg class="gcurve ${cls}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Здоровье по ходу раунда">
    <defs>${[0, 1].map((k) => `<linearGradient id="${uid}f${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colors[k]}" stop-opacity=".28"/><stop offset="1" stop-color="${colors[k]}" stop-opacity="0"/></linearGradient>`).join('')}
      <filter id="${uid}g" x="-5%" y="-40%" width="110%" height="180%"><feGaussianBlur stdDeviation="7"/></filter></defs>
    <line x1="${L}" x2="${R}" y1="${bot}" y2="${bot}" class="gc-base"/>
    <text x="${L}" y="${h - 4}" class="gc-t" style="font-size:${22 * fs}px">0 С</text><text x="${R}" y="${h - 4}" class="gc-t" style="font-size:${22 * fs}px" text-anchor="end">${fmt(T.toFixed(1))} С</text>
    ${[0, 1].map((k) => `<path d="${lines[k]} L${R},${bot} L${L},${bot}Z" fill="url(#${uid}f${k})" class="gc-area" style="animation-delay:${(at + len * 0.6).toFixed(2)}s"/>`).join('')}
    ${[0, 1].map((k) => `<path d="${lines[k]}" pathLength="1" class="gc-glow" stroke="${colors[k]}" filter="url(#${uid}g)" style="animation-delay:${at}s;animation-duration:${len}s"/><path d="${lines[k]}" pathLength="1" class="gc-line" stroke="${colors[k]}" style="animation-delay:${at}s;animation-duration:${len}s"/>`).join('')}
    ${marks}${tags}
  </svg>`;
}

// ---------- the stage of figures (one PIXI app for every screen of the session) ----------

let figApp = null;
async function figureApp() {
  if (figApp) return figApp;
  figApp = new PIXI.Application();
  await figApp.init({ width: 8, height: 8, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoStart: false, resolution: Math.min(2, window.devicePixelRatio || 1) });
  return figApp;
}

// figs: [{ assets, accent, x, foot, height (fractions of the box), flip, anim, dim (0 lit … 1 deep shade), start, from }]
class FigureStage {
  constructor(el, figs) {
    this.el = el;
    this.figs = figs;
  }

  async init() {
    const app = await figureApp();
    this.app = app;
    app.stage.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.el.appendChild(app.canvas);
    this.resize();
    this.embers = new PIXI.Graphics();
    this.embers.blendMode = 'add';
    this.items = this.figs.map((f) => {
      const dim = f.dim || 0;
      const tint = dim ? (Math.round(0xff * (1 - dim * 0.72)) * 0x10101) & 0xffffff : undefined;
      const fig = litFigure(f.assets, { rim: 10, aura: 30, accent: f.accent, ...(tint !== undefined ? { tint } : {}) });
      fig.rimRig.root.alpha = 1 - dim * 0.85;
      fig.auraBox.alpha = 0.6 * (1 - dim);
      const idle = f.assets.def.anims.idle;
      fig.base = fig.bounds(solvePose(sampleAnim(idle, 0)));
      app.stage.addChild(fig.root);
      return { f, fig };
    });
    app.stage.addChild(this.embers);
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.W = Math.max(8, Math.round(r.width));
    this.H = Math.max(8, Math.round(r.height));
    this.app?.renderer.resize(this.W, this.H);
  }

  pose(f, t) {
    const a = f.assets.def.anims;
    const tick = Math.max(0, (t - (f.start || 0)) * 60);
    const anim = a[f.anim] || a.idle;
    if (f.anim === 'defeat') {
      const len = anim.keys[anim.keys.length - 1].t;
      return solvePose(sampleAnim(anim, Math.min(tick + (f.from || 0), len - 1)));
    }
    return solvePose(sampleAnim(anim, tick + (f.from || 0)));
  }

  draw(t) {
    if (!this.app) return;
    const { W, H } = this;
    for (const { f, fig } of this.items) {
      const b = fig.base;
      const s = (H * f.height) / (b.height || 300);
      fig.scale(s, f.flip || 1);
      fig.apply(this.pose(f, t));
      const e = easeOut(k01(t, f.enter ?? 0, (f.enter ?? 0) + 0.55));
      const cx = (b.x + b.width / 2) * s * (f.flip || 1);
      fig.place(W * f.x - cx + (1 - e) * (f.slide || 0) * W, H * f.foot - (b.y + b.height) * s);
      // a whole figure fades with the canvas (CSS): alpha on a rig of parts shows the parts through each other
      fig.root.alpha = f.alpha ?? 1;
    }
    // embers rising around the winner (deterministic: the same time, the same frame)
    const g = this.embers;
    g.clear();
    const lit = this.items.find((i) => !i.f.dim);
    if (lit) {
      const col = hexNum(lit.f.accent || '#ffb02a');
      for (let i = 0; i < 46; i++) {
        const life = 2.6 + hash(i) * 2.2;
        const ph = (t + hash(i + 7) * life) % life;
        const k = ph / life;
        const x = W * (lit.f.x + (hash(i + 3) - 0.5) * 0.34) + Math.sin(t * 1.3 + i) * 12;
        const y = H * (1.02 - k * (0.55 + hash(i + 9) * 0.45));
        const a = Math.sin(k * Math.PI) * (0.35 + hash(i + 5) * 0.5) * k01(t, 0.3, 1);
        g.circle(x, y, (1.2 + hash(i + 11) * 2.6) * (H / 1080)).fill({ color: i % 4 ? col : 0xfff1c9, alpha: a });
      }
    }
    this.app.render();
  }

  destroy() {
    if (!this.app) return;
    this.app.stage.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.app.canvas.remove();
  }
}

// ---------- a screen with its own clock ----------

// root: the screen's element; parts: { figs, numbers } — JS-driven parts; CSS animations of the root run live and
// are stepped by seek() when the reel records the screen
class Screen {
  constructor(root, { figs = [], counts = [], dur = 6 }) {
    this.root = root;
    this.dur = dur;
    this.counts = counts;
    this.stage = figs.length ? new FigureStage(root.querySelector('.sx-figs'), figs) : null;
    this.t = 0;
    this.raf = 0;
  }

  async ready() {
    await this.stage?.init();
    await document.fonts?.ready;
    this.fit();
    this.update(0);
    return this;
  }

  // the screen's words fit their boxes (a transform of an animation does not change the measure)
  fitWords() {
    for (const el of this.root.querySelectorAll('[data-fit]')) fitText(el);
  }

  // sizes of the screen follow its box: --u is one pixel of the 1920×1080 (or 1080×1920) design
  fit() {
    const r = this.root.getBoundingClientRect();
    const v = r.width / r.height < 0.85;
    this.root.classList.toggle('sx-v', v);
    this.root.classList.toggle('sx-h', !v);
    this.root.style.setProperty('--u', `${(v ? Math.min(r.width / 1080, r.height / 1920) : Math.min(r.width / 1920, r.height / 1080)).toFixed(4)}px`);
    this.stage?.resize();
    this.vertical = v;
    this.fitWords();
  }

  update(t) {
    this.t = t;
    for (const c of this.counts) {
      const k = easeOut(k01(t, c.at, c.at + 0.7));
      c.el.textContent = c.format(c.to * k);
    }
    this.stage?.draw(t);
  }

  play() {
    const t0 = performance.now();
    const loop = (now) => {
      this.update((now - t0) / 1000);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.onResize = () => this.fit();
    window.addEventListener('resize', this.onResize);
  }

  // a recorded frame: every CSS animation of the screen is held at t
  seek(t) {
    for (const a of this.root.getAnimations({ subtree: true })) {
      a.pause();
      a.currentTime = t * 1000;
    }
    this.update(t);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.stage?.destroy();
  }
}

// numbers that count up: <b data-count="54" data-at="1.4" data-fmt="int|pct|x">
function countsIn(root) {
  return [...root.querySelectorAll('[data-count]')].map((el) => {
    const to = Number(el.dataset.count);
    const f = el.dataset.fmt;
    return { el, to, at: Number(el.dataset.at || 0), format: (v) => (f === 'x' ? `×${Math.round(v)}` : f === 'pct' ? `${Math.round(v)}%` : String(Math.round(v))) };
  });
}

let uidSeq = 0;

// A heading that must stay one line gets smaller until it fits the room its parent gives it (in a row, the
// parent's width less its neighbours), at most to 55 %, then wraps. The heading itself is as wide as its words with
// the room for the italic slant, so the measure is the painted width.
export function fitText(el) {
  el.style.fontSize = '';
  el.classList.remove('fit-wrap');
  const par = el.parentElement;
  if (!par?.clientWidth) return;
  const cs = getComputedStyle(par);
  const row = cs.display.includes('flex') && cs.flexDirection.startsWith('row');
  const gap = parseFloat(cs.columnGap) || 0;
  const room = par.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (row ? [...par.children].filter((c) => c !== el).reduce((a, c) => a + c.offsetWidth + gap, 0) : 0);
  const over = () => el.scrollWidth > room * 0.98;
  const base = parseFloat(getComputedStyle(el).fontSize);
  let size = base;
  while (over() && size > base * 0.55) {
    size -= Math.max(1, base * 0.04);
    el.style.fontSize = `${size}px`;
  }
  if (over()) el.classList.add('fit-wrap');
}

// ---------- the round result ----------

function numberTiles(nums, colors, names, at) {
  return nums.map((n, i) => {
    const d = (at + i * 0.18).toFixed(2);
    const body = n.pair
      ? `<div class="sx-pair"><b class="slab" style="--c:${colors[0]}" data-count="${n.pair[0]}" data-at="${d}">${n.pair[0]}</b><i>:</i><b class="slab" style="--c:${colors[1]}" data-count="${n.pair[1]}" data-at="${d}">${n.pair[1]}</b></div>`
      : `<b class="slab sx-one" style="--c:${colors[n.side] || '#fff'}" data-count="${n.one}" data-at="${d}" data-fmt="${n.fmt || 'int'}">${n.one}</b>`;
    const who = n.pair ? '' : `<span class="sx-who" style="color:${colors[n.side]}">${esc(names[n.side])}${n.sub ? ` · ${esc(n.sub)}` : ''}</span>`;
    return `<div class="sx-num" style="animation-delay:${d}s"><span class="sx-lab">${esc(n.label)}</span>${body}${who}</div>`;
  }).join('');
}

// opts: { title (Раунд 2 · переигровка), winner: 0|1|null, reason: ko|time, sides: [{ name, model, color, assets }],
// score: [left, right] after the round, firstTo, st: { hp, counters, juicy, moments, result }, final (the match is
// won), bg (an image behind, else the screen is see-through over the fight), buttons: html }
export function resultScreen(opts) {
  const { winner, reason, sides, score = [0, 0], firstTo = 2, st = {}, title = 'Раунд', bg = null, buttons = '' } = opts;
  const colors = sides.map((s) => s.color);
  const names = sides.map((s) => s.name);
  const draw = winner === null;
  const word = draw ? (reason === 'ko' ? 'Двойной нокаут' : 'Ничья') : reason === 'ko' ? 'Нокаут' : 'По времени';
  const sub = draw ? (reason === 'ko' ? 'Ничья: раунд переигрывается' : 'Раунд переигрывается') : opts.final ? 'Победа в матче' : '';
  const w = draw ? 0 : winner;
  const l = 1 - w;
  const el = document.createElement('div');
  el.className = `sx sx-result ${draw ? 'is-draw' : ''} ${bg ? 'has-bg' : ''}`;
  el.style.setProperty('--wc', colors[w]);
  el.style.setProperty('--lc', colors[l]);
  const pips = (s) => Array.from({ length: firstTo }, (_, i) => `<i class="${i < score[s] ? 'on' : ''}" style="--c:${colors[s]}"></i>`).join('');
  el.innerHTML = `
    ${bg ? `<div class="sx-bg" style="background-image:url('${esc(bg)}')"></div>` : '<div class="sx-bg sx-glass"></div>'}
    <div class="sx-wash"></div><div class="sx-rays"></div><div class="sx-back"></div>
    <div class="sx-figs"></div>
    <div class="sx-shade"></div>
    <div class="sx-flash"></div>
    <div class="sx-top">
      <span class="kicker sx-k">${esc(title)}</span>
      <h1 class="slab hot sx-word" data-fit>${esc(word)}</h1>
      ${sub ? `<div class="sx-sub">${sub}</div>` : ''}
    </div>
    <div class="sx-side">
      ${draw ? '' : `<div class="sx-win"><span class="plate" style="--a:${colors[w]}">${esc(sides[w].model)}</span><div class="slab sx-name" data-fit style="--c:${colors[w]}">${esc(names[w])}</div></div>`}
      <div class="sx-score">
        <div class="sx-sc" style="--c:${colors[0]}"><span class="sx-sn">${esc(names[0])}</span><span class="sx-pips">${pips(0)}</span></div>
        <div class="sx-sv"><b class="slab hot">${score[0]}</b><i></i><b class="slab hot">${score[1]}</b></div>
        <div class="sx-sc r" style="--c:${colors[1]}"><span class="sx-pips">${pips(1)}</span><span class="sx-sn">${esc(names[1])}</span></div>
      </div>
      <div class="sx-nums">${numberTiles(keyNumbers(st, winner), colors, names, 1.5)}</div>
      <div class="sx-curve">${[['gc-h', 900, 250, 1], ['gc-v', 980, 330, 1.3]].map(([cls, w, h, fs]) => glowCurve(st.hp, colors, names, { w, h, cls, fs, moments: st.moments || [], reason, at: 1.2, len: 1.7, uid: `${cls}${uidSeq++}`, end: st.result?.seconds ?? null })).join('')}</div>
    </div>
    ${buttons ? `<div class="sx-buttons">${buttons}</div>` : ''}`;
  const figs = [];
  const def = (s) => sides[s].assets?.def;
  // a win: the loser in the shade behind, on the floor after a knockout; a draw: both face each other in the half light
  if (sides[l].assets) figs.push({ assets: sides[l].assets, accent: colors[l], anim: draw ? 'idle' : reason === 'ko' && def(l).anims.defeat ? 'defeat' : 'idle', from: draw ? 0 : 20, dim: draw ? 0.3 : 0.74, x: draw ? 0.39 : 0.37, foot: draw ? 1.02 : 0.97, height: draw ? 0.74 : 0.56, flip: -1, enter: 0.05, slide: 0.02 });
  if (sides[w].assets) figs.push({ assets: sides[w].assets, accent: colors[w], anim: draw ? 'idle' : def(w).anims.victory ? 'victory' : 'intro', dim: draw ? 0.3 : 0, x: draw ? 0.13 : 0.22, foot: 1.02, height: draw ? 0.74 : 0.86, flip: 1, enter: 0.12, slide: -0.04, start: 0.12 });
  const scr = new Screen(el, { figs, dur: 6 });
  scr.counts = countsIn(el);
  // the 9:16 frame puts the fighters in the middle
  scr.layout = () => {
    if (!scr.stage) return;
    const v = el.classList.contains('sx-v');
    for (const it of scr.stage.figs) {
      const lit = !it.dim || draw;
      it.__h ||= { x: it.x, foot: it.foot, height: it.height };
      if (v) Object.assign(it, lit && !draw ? { x: 0.44, foot: 0.6, height: 0.44 } : draw ? { x: it === scr.stage.figs[0] ? 0.7 : 0.3, foot: 0.6, height: 0.4 } : { x: 0.7, foot: 0.58, height: 0.26 });
      else Object.assign(it, it.__h);
    }
  };
  const fit = scr.fit.bind(scr);
  scr.fit = () => {
    fit();
    scr.layout();
  };
  return scr;
}

// ---------- the locker room ----------

const statBar = (from, to) => `<span class="sx-seg">${Array.from({ length: STAT_MAX }, (_, i) => {
  const was = i < from;
  const now = i < to;
  return `<i class="${now ? 'on' : ''} ${now && !was ? 'plus' : ''} ${was && !now ? 'minus' : ''}"></i>`;
}).join('')}</span>`;

function cardHtml(c, i, at) {
  const d = (at + i * 0.16).toFixed(2);
  const sign = c.delta > 0 ? 'plus' : c.delta < 0 ? 'minus' : 'tilde';
  let body = '';
  if (c.kind === 'stat') body = `<div class="sx-cm">${esc(c.main)} <em class="${sign}">${c.delta > 0 ? '+' : ''}${c.delta}</em></div>${statBar(c.from, c.to)}`;
  else if (c.kind === 'brain' && c.code) body = `<div class="sx-code">${c.code.removed.map((l) => `<code class="minus">${esc(l)}</code>`).join('')}${c.code.added.map((l) => `<code class="plus">${esc(l)}</code>`).join('')}</div>`;
  else body = `<div class="sx-cm">${esc(c.main || '')}</div>${c.detail ? `<div class="sx-cd">${esc(c.detail)}</div>` : ''}`;
  return `<div class="sx-card ${sign} k-${c.kind}" style="animation-delay:${d}s"><span class="sx-ci">${icon(c.kind)}</span><div class="sx-cb"><span class="sx-ct">${esc(c.title)}</span>${body}</div></div>`;
}

// opts: { title (Перед раундом 2), side: { name, model, color, assets, assetsBefore }, before: v1, after: v2,
// changes (gamedata version.changes), said (the model's reply), other: { name, model, changed: bool } — a line
// for the other corner, bg, buttons }
export function lockerScreen(opts) {
  const { side, changes, said, other = null, bg = null, buttons = '', title = '' } = opts;
  const cards = changeCards(changes);
  const none = !cards.length;
  const el = document.createElement('div');
  el.className = `sx sx-locker ${none ? 'is-none' : ''} ${bg ? 'has-bg' : ''}`;
  el.style.setProperty('--wc', side.color);
  const quote = said ? plainSay(said, cards.length > 2 ? 200 : 260) : null;
  el.innerHTML = `
    ${bg ? `<div class="sx-bg" style="background-image:url('${esc(bg)}')"></div>` : '<div class="sx-bg sx-glass"></div>'}
    <div class="sx-wash"></div><div class="sx-back"></div>
    <div class="sx-figs"></div>
    <div class="sx-shade"></div>
    <div class="sx-flash"></div>
    <div class="sx-tags">${none ? '' : `<span class="sx-vt was">До · v${opts.before}</span><span class="sx-vt now" style="--c:${side.color}">После · v${opts.after}</span>`}</div>
    <div class="sx-top">
      <span class="kicker sx-k">${esc(title)}</span>
      <h1 class="slab hot sx-word">Раздевалка</h1>
      <div class="sx-who"><span class="plate" style="--a:${side.color}">${esc(side.model)}</span><span class="slab sx-name" data-fit style="--c:${side.color}">${esc(side.name)}</span></div>
    </div>
    <div class="sx-side">
      ${none ? `<div class="sx-none">${icon('same')}<span>Ничего не поменял: выходит той же версией</span></div>` : `<div class="sx-cards n${Math.min(cards.length, 4)}">${cards.slice(0, 4).map((c, i) => cardHtml(c, i, 1.0)).join('')}${cards.length > 4 ? `<div class="sx-more">и ещё ${cards.length - 4}</div>` : ''}</div>`}
      ${quote ? `<blockquote class="sx-quote" style="animation-delay:${(1.2 + Math.min(cards.length, 4) * 0.16).toFixed(2)}s"><p>${esc(quote)}</p><cite>${esc(side.model)} в раздевалке</cite></blockquote>` : ''}
      ${other ? `<div class="sx-other" style="--c:${other.color}"><b>${esc(other.name)}</b> · ${esc(other.model)}: ${other.changed ? 'тоже доработал бойца' : 'ничего не поменял'}</div>` : ''}
    </div>
    ${buttons ? `<div class="sx-buttons">${buttons}</div>` : ''}`;
  const figs = [];
  if (!none && side.assetsBefore) figs.push({ assets: side.assetsBefore, accent: side.color, anim: 'idle', dim: 0.72, x: 0.13, foot: 0.95, height: 0.7, flip: 1, enter: 0.3, slide: -0.02 });
  if (side.assets) figs.push({ assets: side.assets, accent: side.color, anim: side.assets.def.anims.intro ? 'intro' : 'idle', dim: 0, x: none ? 0.24 : 0.33, foot: 1.03, height: 0.9, flip: 1, enter: 0.7, slide: 0.03, start: 0.7 });
  const scr = new Screen(el, { figs, dur: 6.5 });
  scr.counts = [];
  scr.layout = () => {
    if (!scr.stage) return;
    const v = el.classList.contains('sx-v');
    for (const it of scr.stage.figs) {
      it.__h ||= { x: it.x, foot: it.foot, height: it.height };
      if (!v) Object.assign(it, it.__h);
      else Object.assign(it, it.dim ? { x: 0.27, foot: 0.5, height: 0.27 } : { x: none ? 0.5 : 0.66, foot: 0.52, height: 0.32 });
    }
  };
  const fit = scr.fit.bind(scr);
  scr.fit = () => {
    fit();
    scr.layout();
  };
  return scr;
}

// ---------- the match's story (the «История» tab) ----------

// m: the game's match; ctx: { col(cid) → colour, stageOf(id), nameOf(cid), verOf(cid, v) }
export function storyHtml(m, ctx) {
  const s = m.story;
  const byN = Object.fromEntries((s?.rounds || []).map((x) => [x.n, x]));
  const r0 = m.rounds[0];
  const opening = s?.opening || (r0 ? `${m.models[r0.left]} и ${m.models[r0.right]} сами собрали бойцов: ${r0.names[r0.left]} против ${r0.names[r0.right]}. Дерутся до ${m.firstTo} побед, между раундами каждая модель смотрит запись и дорабатывает своего бойца.` : 'Раундов пока нет.');
  const best = s?.best || [];
  const head = `<div class="st-open"><span class="kicker">С чего началось</span><p>${esc(opening)}</p>${s?.model ? `<span class="st-by">Рассказ: ${esc(prettyModel(s.model))} по записи судьи</span>` : ''}</div>`;
  const rounds = m.rounds.map((r) => {
    const x = byN[r.n];
    const st = m.roundStats?.[r.n];
    const w = r.winner ? [r.left, r.right].indexOf(r.winner) : null;
    const story = x?.story || autoStory(r, st);
    const stg = ctx.stageOf(r.stage);
    const res = w === null ? (r.reason === 'ko' ? 'Двойной нокаут' : 'Ничья') : `${r.names[r.winner]} · ${r.reason === 'ko' ? 'нокаут' : 'по времени'}`;
    const lockers = r.n > 1 ? [r.left, r.right].map((cid) => lockerBlock(m, r, cid, x?.lockers?.find((l) => l.cid === cid), ctx)).join('') : '';
    const moments = best.filter((b) => b.round === r.n);
    return `${lockers ? `<div class="st-lockers"><div class="st-lt">${icon('brain')}<span>Раздевалка перед раундом</span></div>${lockers}</div>` : ''}
      <article class="st-round" style="--wc:${w === null ? '#8a90a4' : ctx.col(r.winner)}">
        <div class="st-pic" style="background-image:url('${esc(stg?.thumb || '')}')"><span class="slab">${esc(ctx.title(r))}</span></div>
        <div class="st-body">
          <div class="st-res">${icon(r.reason === 'ko' ? 'ko' : 'clock')}<b>${esc(res)}</b><span>${fmt(((r.ticks || 0) / 60).toFixed(1))} с · ${esc(stg?.name || r.stage)}</span></div>
          <p>${esc(story)}</p>
          <div class="st-acts"><button class="btn" data-nav data-round="${r.n}">${icon('play')}Смотреть раунд</button>${moments.map((b) => `<button class="btn ghost" data-nav data-moment="${r.n}" data-from="${b.from ?? b.tick - 90}" data-to="${b.to ?? b.tick + 60}">${icon('replay')}${esc(momentName(b))}</button>`).join('')}</div>
        </div>
      </article>`;
  }).join('');
  const top = best.length ? `<div class="st-best"><div class="st-lt">${icon('super')}<span>Лучшие моменты</span></div><div class="st-mlist">${best.map((b) => `<button class="st-m" data-nav data-moment="${b.round}" data-from="${b.from ?? b.tick - 90}" data-to="${b.to ?? b.tick + 60}" style="--c:${b.side != null ? ctx.col([m.rounds.find((r) => r.n === b.round)?.left, m.rounds.find((r) => r.n === b.round)?.right][b.side]) : 'var(--gold)'}"><span class="st-mi">${icon(MOMENT[b.kind === 'final' ? 'last' : b.kind]?.icon || 'replay')}</span><span class="st-mt"><b>${esc(b.what)}</b>${b.say ? `<em>${esc(b.say)}</em>` : ''}</span><span class="st-mr">${icon('replay')}${esc(ctx.title(m.rounds.find((r) => r.n === b.round) || { n: b.round }))}</span></button>`).join('')}</div></div>` : '';
  return `<div class="story">${head}<div class="st-rounds">${rounds}</div>${top}</div>`;
}

function momentName(b) {
  const k = b.kind === 'final' ? 'last' : b.kind;
  return { super: 'Суперприём', combo: 'Серия', comeback: 'Камбэк', last: 'Нокаут', new: 'Новое', juicy: 'Сочный удар' }[k] || 'Повтор';
}

function autoStory(r, st) {
  if (!st?.counters) return '';
  const c = st.counters;
  const nm = [r.names[r.left], r.names[r.right]];
  const w = r.winner ? [r.left, r.right].indexOf(r.winner) : null;
  const s = Math.round((r.ticks || 0) / 60);
  const head = w === null ? (r.reason === 'ko' ? `Двойной нокаут на ${s}-й секунде: оба бойца упали одновременно.` : 'Время вышло, здоровья поровну: ничья.') : `${nm[w]} ${r.reason === 'ko' ? `нокаутирует соперника на ${s}-й секунде` : 'берёт раунд по времени'}.`;
  return `${head} Попадания ${c[0].hits} : ${c[1].hits} (${nm[0]} : ${nm[1]}).`;
}

function lockerBlock(m, r, cid, told, ctx) {
  const prev = m.rounds[m.rounds.findIndex((x) => x.n === r.n) - 1];
  const was = prev?.versions[cid];
  const now = r.versions[cid];
  const v = ctx.verOf(cid, now);
  const ch = was !== now ? v?.changes : null;
  const cards = changeCards(ch);
  const said = v?.note && was !== now ? v.note.text : told?.said;
  const col = ctx.col(cid);
  return `<div class="st-lk" style="--c:${col}">
    <div class="st-lh"><span class="plate" style="--a:${col}">${esc(m.models[cid])}</span><b>${esc(r.names[cid])}</b><span class="st-v">${was !== now && now ? `v${was} → v${now}` : 'та же версия'}</span></div>
    ${cards.length ? `<div class="st-chips">${cards.map((c) => `<span class="st-chip ${c.delta > 0 ? 'plus' : c.delta < 0 ? 'minus' : 'tilde'}">${icon(c.kind)}<b>${esc(c.kind === 'stat' ? `${c.main} ${c.from} → ${c.to}` : c.kind === 'brain' ? c.title : `${c.title}: ${c.main}`)}</b></span>`).join('')}</div>${cards.filter((c) => c.code).map((c) => `<div class="sx-code small">${c.code.removed.map((l) => `<code class="minus">${esc(l)}</code>`).join('')}${c.code.added.map((l) => `<code class="plus">${esc(l)}</code>`).join('')}</div>`).join('')}` : '<div class="st-none">Ничего не поменял</div>'}
    ${told?.summary ? `<p class="st-sum">${esc(told.summary)}</p>` : ''}
    ${said ? `<blockquote class="st-q"><p>${saidHtml(said)}</p><cite>${esc(m.models[cid])}, своими словами</cite></blockquote>` : ''}
  </div>`;
}


// ---------- the screens from the game's data (/api/game) ----------

// a corner's colour: the fighter's accent, or the contestant's own colour when both wear the same (a mirror match)
export function cornerColor(data, m) {
  const f = (cid) => data.fighters.find((x) => x.id === `c/${cid}`);
  const acc = (cid) => f(cid)?.colors?.accent || f(cid)?.versions?.at(-1)?.colors?.accent || null;
  const mirror = String(acc(m.red)).toLowerCase() === String(acc(m.blue)).toLowerCase();
  return (cid) => (mirror ? f(cid)?.color || (cid === m.red ? '#ff7a33' : '#4fc3ff') : acc(cid) || f(cid)?.color || '#ffc94a');
}

export function roundLabel(m, r) {
  const decider = r.wins?.[0] === m.firstTo - 1 && r.wins?.[1] === m.firstTo - 1;
  const head = decider ? 'Решающий раунд' : `Раунд ${r.num}`;
  return r.rerun ? `${head} · переигровка` : head;
}

// assetsOf(url) → fighter assets (viewer/game/fight.js → fighterAssets)
// the picture behind a screen: the reel passes a frame of the round, the game the round's stage
const stageBg = (data, id) => data.stages?.find((s) => s.id === id)?.thumb || null;

export async function resultFor(data, m, n, { assetsOf, bg = null, buttons = '' } = {}) {
  const r = m.rounds.find((x) => x.n === n);
  bg ||= stageBg(data, r.stage);
  const col = cornerColor(data, m);
  const cids = [r.left, r.right];
  const assets = await Promise.all(r.dirs.map((u) => assetsOf(u).catch(() => null)));
  const w = r.winner ? cids.indexOf(r.winner) : null;
  const score = [r.wins[0] + (w === 0 ? 1 : 0), r.wins[1] + (w === 1 ? 1 : 0)];
  const scr = resultScreen({
    title: `${roundLabel(m, r)} · ${fmt(((r.ticks || 0) / 60).toFixed(1))} с`, winner: w, reason: r.reason, final: r.final, firstTo: m.firstTo, score, bg, buttons,
    sides: cids.map((cid, i) => ({ name: r.names[cid], model: m.models[cid], color: col(cid), assets: assets[i] })),
    st: m.roundStats?.[n] || {},
  });
  return scr;
}

// the locker room of corner cid before round n (null when there is no round before)
export async function lockerFor(data, m, n, cid, { assetsOf, bg = null, buttons = '' } = {}) {
  const i = m.rounds.findIndex((x) => x.n === n);
  const r = m.rounds[i];
  const prev = m.rounds[i - 1];
  if (!r || !prev) return null;
  bg ||= stageBg(data, r.stage);
  const col = cornerColor(data, m);
  const f = data.fighters.find((x) => x.id === `c/${cid}`);
  const was = prev.versions[cid];
  const now = r.versions[cid];
  const vNow = f?.versions.find((v) => v.v === now);
  const vWas = f?.versions.find((v) => v.v === was);
  const changed = was !== now && !!vNow?.changes;
  const told = m.story?.rounds?.find((x) => x.n === n)?.lockers?.find((x) => x.cid === cid);
  const [aNow, aWas] = await Promise.all([vNow ? assetsOf(vNow.url).catch(() => null) : null, changed && vWas ? assetsOf(vWas.url).catch(() => null) : null]);
  const oid = cid === m.red ? m.blue : m.red;
  return lockerScreen({
    title: `Перед раундом ${r.num}${r.rerun ? ' · переигровка' : ''}`, before: was, after: now, bg, buttons,
    side: { name: r.names[cid], model: m.models[cid], color: col(cid), assets: aNow, assetsBefore: aWas },
    changes: changed ? vNow.changes : null,
    said: changed ? vNow.note?.text || told?.said : told?.said || null,
    other: { name: r.names[oid], model: m.models[oid], color: col(oid), changed: prev.versions[oid] !== r.versions[oid] },
  });
}

// ---------- numbers of a fight computed here (a fight of two brains, a fight against the player) ----------

// defs: the two compiled fighters, steps: the recording (one entry per tick), seed. The same shape as the judge's
// round stats (judge/moments.js), the part the result screen shows.
export async function quickStats(defs, steps, seed) {
  const E = await import('/kit/arena/engine/index.js');
  const fight = E.createFight({ fighters: defs, seed });
  const hp = [];
  const hits = [];
  const supers = [];
  let endTick = null;
  for (let i = 0; i < steps.length; i++) {
    const ev = E.stepFight(fight, steps[i]);
    for (const e of ev) {
      if (e.type === 'hit') hits.push({ ...e, tick: fight.tick });
      if (e.type === 'super') supers.push({ ...e, tick: fight.tick });
      if (e.type === 'end' && endTick === null) endTick = fight.tick;
    }
    if (fight.tick % 15 === 0) hp.push([fight.tick / 60, fight.f[0].hp / fight.f[0].maxHp, fight.f[1].hp / fight.f[1].maxHp]);
  }
  hp.push([fight.tick / 60, fight.f[0].hp / fight.f[0].maxHp, fight.f[1].hp / fight.f[1].maxHp]);
  const name = (s, id) => defs[s].movesById?.[id]?.name || id;
  const counters = [0, 1].map((s) => {
    const mine = hits.filter((h) => h.attacker === s);
    return { hits: mine.length, damage: mine.reduce((a, h) => a + h.damage, 0), supers: supers.filter((x) => x.side === s).length, maxCombo: Math.max(0, ...mine.map((h) => h.combo || 0)) };
  });
  const top = [...hits].sort((a, b) => b.damage - a.damage)[0];
  const moments = [];
  for (const x of supers) {
    const dmg = hits.filter((h) => h.attacker === x.side && h.move === x.move && h.tick >= x.tick && h.tick < x.tick + 360).reduce((a, h) => a + h.damage, 0);
    moments.push({ kind: 'super', side: x.side, at: x.tick, damage: dmg, score: 8 + (dmg ? 3 : 0) });
  }
  const last = hits[hits.length - 1];
  if (last) moments.push({ kind: 'last', side: last.attacker, at: last.tick, damage: last.damage, score: fight.endReason === 'ko' ? 10 : 5 });
  if (top) moments.push({ kind: 'juicy', side: top.attacker, at: top.tick, damage: top.damage, score: 4 + top.damage / 20 });
  const end = endTick ?? fight.tick;
  return { hp, counters, moments, juicy: top ? { side: top.attacker, move: top.move, name: name(top.attacker, top.move), damage: top.damage, tick: top.tick } : null, result: { winner: fight.winner, reason: fight.endReason, ticks: end, seconds: end / 60 } };
}

// the sounds of the screens (the judge's reel mixes the same, judge/reel.js → SCREEN_SOUNDS)
export const SCREEN_SOUNDS = {
  round: [['vs-whoosh', 0, 0.55], ['vs-impact', 0.22, 0.8], ['crowd-1', 0.3, 0.35]],
  locker: [['vs-whoosh', 0, 0.55], ['vs-impact', 0.2, 0.6], ['sparkle', 0.7, 0.5]],
};

// ---------- the match page: numbers and protocol as cards ----------

// a still version of the curve (no drawing in): the page, not the show
const stillCurve = (st, colors, names, reason) => `<div class="mc-curve">${glowCurve(st.hp, colors, names, { w: 1000, h: 250, cls: 'still', moments: st.moments || [], reason, at: 0, len: 0.01, uid: `s${uidSeq++}`, end: st.result?.seconds ?? null })}</div>`;

// m: the game's match; col(cid) → the corner's colour; title(r) → the round's name
export function matchStatsView(m, col, title) {
  if (!m.rounds.length) return '<div class="empty">Раундов пока нет</div>';
  const rounds = m.rounds.map((r) => {
    const st = m.roundStats?.[r.n];
    const cids = [r.left, r.right];
    const colors = cids.map(col);
    const names = cids.map((c) => r.names[c]);
    const w = r.winner ? cids.indexOf(r.winner) : null;
    const res = w === null ? (r.reason === 'ko' ? 'Двойной нокаут' : 'Ничья') : `${names[w]} · ${r.reason === 'ko' ? 'нокаут' : 'по времени'}`;
    if (!st?.hp) return `<section class="mc"><div class="mc-h"><span class="slab">${esc(title(r))}</span><b>${esc(res)}</b></div><div class="empty">Статистики нет: node ring.mjs match stats</div></section>`;
    const nums = keyNumbers(st, w);
    const j = st.juicy;
    return `<section class="mc" style="--wc:${w === null ? '#8a90a4' : colors[w]}">
      <div class="mc-h"><span class="slab">${esc(title(r))}</span><span class="mc-res">${icon(r.reason === 'ko' ? 'ko' : 'clock')}<b>${esc(res)}</b><em>${fmt(((r.ticks || 0) / 60).toFixed(1))} с</em></span></div>
      <div class="mc-body">${stillCurve(st, colors, names, r.reason)}
        <div class="mc-nums">${numberTiles(nums, colors, names, 0).replace(/ data-count="[^"]*"/g, '')}
          ${j ? `<button class="btn ghost" data-nav data-juicy="${r.n}" data-tick="${j.tick}">${icon('replay')}Самый сочный удар</button>` : ''}</div>
      </div>
      <div class="mc-legend">${names.map((n, i) => `<span style="--c:${colors[i]}">${esc(n)} · ${esc(m.models[cids[i]])}</span>`).join('')}</div>
    </section>`;
  }).join('');
  const lockers = (m.stats?.lockers || []).map((x) => {
    const r = m.rounds.find((y) => y.n === x.to);
    const c = col(x.cid);
    const helped = !x.wonBefore && x.wonAfter ? ['plus', 'Помогло', 'проиграл до, выиграл после'] : x.wonBefore && !x.wonAfter ? ['minus', 'Не помогло', 'выиграл до, проиграл после'] : x.wonAfter ? ['tilde', 'Держит победу', 'выиграл и до, и после'] : ['tilde', 'Пока без победы', 'не выиграл ни до, ни после'];
    const d = (k, label) => {
      const v = x.effect[k];
      if (!v || (!v.before && !v.after)) return '';
      return `<div class="lk-d"><span>${label}</span><b class="${v.delta > 0 ? 'plus' : v.delta < 0 ? 'minus' : ''}">${v.delta > 0 ? '+' : ''}${v.delta}</b><em>${v.before} → ${v.after}</em></div>`;
    };
    return `<div class="lk-card" style="--c:${c}">
      <div class="lk-top"><span class="plate" style="--a:${c}">${esc(m.models[x.cid])}</span><b>${esc(r?.names[x.cid] || x.cid)}</b><span class="lk-r">после: ${esc(title(m.rounds.find((y) => y.n === x.from) || { n: x.from }))}</span></div>
      <div class="lk-verdict ${helped[0]}"><span class="slab">${helped[1]}</span><em>${helped[2]}</em></div>
      <div class="lk-ds">${d('damage', 'Урон')}${d('hits', 'Попадания')}${d('maxCombo', 'Лучшая серия')}${d('supers', 'Суперприёмы')}</div>
    </div>`;
  }).join('');
  return `<div class="mstats2">${rounds}${lockers ? `<div class="st-lt">${icon('brain')}<span>Раздевалки: помогло ли</span></div><div class="lk-grid">${lockers}</div>` : ''}</div>`;
}

const kTok = (n) => (n >= 1e6 ? `${fmt((n / 1e6).toFixed(1))} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс` : String(n));

export function protocolView(p, m, col) {
  if (!p) return '<div class="empty">Протокола нет: node ring.mjs match protocol &lt;матч&gt;</div>';
  const people = Object.entries(p.people).map(([cid, x]) => {
    const c = col(cid);
    const sum = (f) => x.periods.reduce((a, per) => a + (f(per) || 0), 0);
    const minutes = sum((per) => per.work?.activeMinutes);
    const tokens = sum((per) => (per.work?.tokens ? per.work.tokens.input + per.work.tokens.output : 0));
    const cost = x.periods.some((per) => per.work?.costUSD != null) ? sum((per) => per.work?.costUSD) : null;
    const logged = x.periods.some((per) => per.work);
    const big = [
      ['clock', 'Работа', logged ? `${Math.round(minutes)}` : '—', logged ? 'минут' : 'нет журнала'],
      ['brain', 'Токены', logged ? kTok(tokens) : '—', 'вход и выход'],
      ['card', 'Картинки', String(sum((per) => per.spent.paint)), 'нарисовано'],
      ['play', 'Голос', String(sum((per) => per.spent.voiceSeconds)), 'секунд'],
      ...(cost != null ? [['juicy', 'Стоимость', `$${fmt(cost.toFixed(2))}`, 'по журналу']] : []),
    ];
    return `<div class="pc" style="--c:${c}">
      <div class="pc-h"><span class="plate" style="--a:${c}">${esc(x.agent || 'агент')}</span><span class="slab">${esc(x.model)}</span><em>${esc(x.modelId || '—')}${x.effort ? ` · рассуждение ${esc(x.effort)}` : ''}</em></div>
      <div class="pc-big">${big.map(([ic, l, v, u]) => `<div class="pc-n">${icon(ic)}<span class="sx-lab">${l}</span><b class="slab">${esc(v)}</b><em>${esc(u)}</em></div>`).join('')}</div>
      <details class="pc-more"><summary>По этапам: сборка и раздевалки</summary>${x.periods.map((per) => `<div class="pc-row"><b>${esc(per.what)}</b><span>${per.work ? `${per.work.activeMinutes} мин · ${kTok(per.work.tokens.input + per.work.tokens.output)} токенов` : 'нет журнала'}</span><span>картинок ${per.spent.paint} · голос ${per.spent.voiceSeconds} с</span></div>`).join('')}</details>
    </div>`;
  }).join('');
  const checks = p.rounds.map((r) => {
    const v = p.verify?.find((x) => x.n === r.n);
    const ok = v ? v.same : null;
    const rr = m.rounds.find((x) => x.n === r.n);
    return `<div class="pv ${ok === null ? '' : ok ? 'ok' : 'bad'}">${icon(ok === false ? 'ko' : 'replay')}<b>${esc(rr ? `Раунд ${rr.num}${rr.rerun ? ' · переигровка' : ''}` : `Раунд ${r.n}`)}</b><span>${ok === null ? 'не проверялся' : ok ? 'переигровка совпала кадр в кадр' : 'переигровка НЕ совпала'}</span><em>запись ${esc(r.hash)}</em></div>`;
  }).join('');
  return `<div class="proto2">
    <div class="pr-ring">${p.ring ? `<span class="slab hot">Ринг ${esc(p.ring.ring)}</span><span>движок ${esc(p.ring.engine)} · правила ${esc(p.ring.rules)} · инструменты ${esc(p.ring.tools)}</span>` : '<span>Версия ринга не записана</span>'}</div>
    <div class="pc-grid">${people}</div>
    <div class="st-lt">${icon('replay')}<span>Каждый раунд переигран на своём движке</span></div>
    <div class="pv-grid">${checks}</div>
  </div>`;
}

// a version's changes as cards (the «Что изменил» tab of a fighter)
export function changesView(ver) {
  const cards = changeCards(ver.changes);
  const ch = ver.changes;
  const files = ch.changed.length + ch.added.length + ch.removed.length;
  return `<div class="chg2">
    ${ver.note ? `<blockquote class="st-q"><p>${saidHtml(ver.note.text)}</p><cite>Модель после раунда ${ver.note.round}, своими словами</cite></blockquote>` : ''}
    ${cards.length ? `<div class="sx-cards">${cards.map((c, i) => cardHtml(c, i, 0)).join('')}</div>` : '<div class="empty">Без изменений</div>'}
    ${files ? `<div class="chg-files">Файлов: изменено ${ch.changed.length}, добавлено ${ch.added.length}, удалено ${ch.removed.length}</div>` : ''}
  </div>`;
}

// «claude-opus-5-5» → «Claude Opus 5.5», «gpt-6.2» → «GPT-6.2»; уже красивое имя не трогаем
function prettyModel(id) {
  if (!id || /[A-ZА-Я ]/.test(id)) return id || '';
  const parts = id.split('-');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p) && /^\d+$/.test(parts[i + 1] || '')) { out.push(p + '.' + parts[++i]); continue; }
    out.push(p === 'gpt' ? 'GPT' : p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ').replace(/^GPT (\d)/, 'GPT-$1');
}
