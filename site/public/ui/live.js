// Live fighters on the pages. The game already draws a fighter from its skeleton (play/game/figure.js); this file
// brings that to the site without making a page heavy: nothing of the renderer is fetched until the first figure
// comes near the window, and until a figure is drawn the page shows the fighter's portrait.
//
//   <span class="fig" data-fig data-dir="seasons/…/v5/" [data-flip] [data-play="victory"] [data-again="8"] [data-fit="bust"]>
//   <section data-moves data-dir="…">  <div data-moves-stage></div>  <button data-move="jab">…  </section>
//
// Many figures, one WebGL context: a browser gives a page only a few, so every figure is rendered in the same
// hidden Pixi canvas and handed to its own canvas on the page. The hand-over is a bitmap that never leaves the
// video card (OffscreenCanvas → bitmaprenderer); copying the picture with drawImage cost 5 ms a figure.
const ROOT = new URL('../', import.meta.url).href;
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;

let kitP = null;
const kit = () => (kitP ??= (async () => {
  const [PIXI, figure, assets, engine] = await Promise.all([import('pixi.js'), import(`${ROOT}play/game/figure.js`), import(`${ROOT}kit/arena/render/assets.js`), import(`${ROOT}kit/arena/engine/index.js`)]);
  return { PIXI, litFigure: figure.litFigure, FigureView: figure.FigureView, loadFighterAssets: assets.loadFighterAssets, solvePose: engine.solvePose, sampleAnim: engine.sampleAnim };
})());

let rigsP = null;
const rigs = () => (rigsP ??= fetch(`${ROOT}ui/rigs.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));

const fighters = new Map();
/** The fighter of a folder (relative to the site root), loaded once for every figure of the page. */
export function fighter(dir) {
  if (!fighters.has(dir)) {
    fighters.set(dir, (async () => {
      const [k, map] = await Promise.all([kit(), rigs()]);
      const light = map[dir] || {};
      return k.loadFighterAssets(ROOT + dir, { src: (img) => ROOT + (light[img] || dir + img), portrait: false });
    })());
  }
  return fighters.get(dir);
}

let appP = null;
const stageApp = (PIXI) => (appP ??= (async () => {
  const app = new PIXI.Application();
  await app.init({ canvas: new OffscreenCanvas(8, 8), width: 8, height: 8, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoStart: false, resolution: 1 });
  return app;
})());

const slots = new Set();
let raf = 0;
let prev = 0;
let gap = 16; // the time between frames, ms, smoothed
let budget = 3; // how many figures one frame may draw
let next = 0;
let settle = 0;
let late = 0;
// The figures in the window take turns: a frame draws at most `budget` of them, the rest wait for the next frame
// with their time kept, so six fighters on a screen breathe at 30 frames a second while the page scrolls at 60.
// What a figure costs is the video card's work, which a script cannot time, so the budget follows the frames
// themselves: frames coming late take a figure off it, frames on time give one back.
function loop(now) {
  raf = 0;
  gap += (Math.min(100, now - prev) - gap) * 0.1;
  late = now - prev > 250 ? late + 1 : 0;
  prev = now;
  if (++settle > 30) {
    if (gap > 21 && budget > 1) budget--;
    else if (gap < 17.5 && budget < 3) budget++;
    settle = 0;
  }
  const inView = [];
  let busy = false;
  for (const s of slots) {
    if (!s.ready || !s.seen) continue;
    busy = true;
    const r = s.el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) inView.push(s);
  }
  for (let i = 0; i < Math.min(budget, inView.length); i++) {
    const s = inView[next++ % inView.length];
    try {
      s.draw(Math.min(0.1, (now - s.last) / 1000));
      s.last = now;
    } catch (e) {
      console.warn('[боец]', e);
      s.ready = false;
    }
  }
  // a machine that draws without a video card: the figures stay as they stand, the page stays usable
  if (late >= 3) return;
  if (busy && !document.hidden) raf = requestAnimationFrame(loop);
}
function wake() {
  if (raf || STILL) return;
  const now = performance.now();
  for (const s of slots) s.last = now;
  prev = now;
  late = 0;
  raf = requestAnimationFrame(loop);
}
document.addEventListener('visibilitychange', wake);

class Slot {
  constructor(el) {
    this.el = el;
    this.canvas = el.querySelector('canvas') || el.appendChild(document.createElement('canvas'));
    this.ctx = this.canvas.getContext('bitmaprenderer');
    this.seen = false;
    this.ready = false;
    this.seq = 0;
    this.t = 0;
    this.cur = null;
    this.idleFor = 0;
    this.last = performance.now();
    new ResizeObserver(() => this.size() && this.ready && STILL && this.draw(0)).observe(el);
    el.addEventListener('fig:set', () => this.load());
    el.addEventListener('fig:play', (e) => this.play(e.detail));
    slots.add(this);
  }

  size() {
    const r = this.el.getBoundingClientRect();
    // sharp enough on a phone's screen, and no larger: the light around a figure is a blur, its price grows with
    // the square of the size
    const k = Math.min(1.5, window.devicePixelRatio || 1, 760 / Math.max(1, r.height));
    const w = Math.round(r.width * k);
    const h = Math.round(r.height * k);
    if (!w || !h || (w === this.canvas.width && h === this.canvas.height)) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  async load() {
    const seq = ++this.seq;
    const dir = this.el.dataset.dir;
    try {
      const [k, assets] = await Promise.all([kit(), fighter(dir)]);
      const app = await stageApp(k.PIXI);
      if (seq !== this.seq) return;
      this.size();
      this.holder?.destroy({ children: true });
      const H = this.canvas.height || 480;
      this.k = k;
      this.app = app;
      this.assets = assets;
      this.flip = this.el.hasAttribute('data-flip') ? -1 : 1;
      this.fig = k.litFigure(assets, { rim: 6 * (H / 480), aura: 18 * (H / 480), flip: this.flip });
      this.b = this.fig.bounds(k.solvePose(k.sampleAnim(assets.def.anims.idle, 0)));
      this.holder = new k.PIXI.Container();
      this.holder.addChild(this.fig.root);
      this.t = 0;
      this.cur = null;
      this.idleFor = 0;
      this.ready = true;
      if (!STILL && this.el.dataset.play) this.play(this.el.dataset.play);
      this.draw(0);
      this.el.classList.add('live');
      wake();
    } catch (e) {
      // the portrait stays: a browser without WebGL, a fighter that did not load
      console.warn('[боец]', dir, e);
    }
  }

  // an animation by name plays once, then the fighter is back in its stance
  play(name) {
    const anim = this.assets?.def.anims[name];
    if (!anim || STILL) return;
    this.cur = { anim, len: anim.loop ? anim.length * 2 : anim.keys[anim.keys.length - 1].t + 30 };
    this.t = 0;
  }

  draw(dt) {
    const { app, fig, b, k, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return;
    this.t += dt * 60;
    let pose;
    if (this.cur && this.t < this.cur.len) pose = k.sampleAnim(this.cur.anim, this.t);
    else {
      if (this.cur) {
        this.cur = null;
        this.t = 0;
        this.idleFor = 0;
      }
      pose = k.sampleAnim(this.assets.def.anims.idle, this.t);
      // data-again: the fighter repeats its number every so many seconds (the champion's victory)
      this.idleFor += dt;
      const again = Number(this.el.dataset.again);
      if (again && this.idleFor > again && this.el.dataset.play) this.play(this.el.dataset.play);
    }
    // the hidden canvas only grows: resizing it for every figure of a frame costs more than the figures themselves
    if (app.renderer.width < W || app.renderer.height < H) app.renderer.resize(Math.max(app.renderer.width, W), Math.max(app.renderer.height, H));
    const bust = this.el.dataset.fit === 'bust';
    const s = bust ? (H * 0.94) / (b.height * 0.7) : Math.min((H * 0.9) / b.height, (W * 0.92) / b.width);
    fig.scale(s, this.flip);
    fig.apply(k.solvePose(pose));
    const x = W / 2 - this.flip * s * (b.x + b.width / 2);
    fig.place(x, bust ? H * 0.05 - b.y * s : H * 0.97 - (b.y + b.height) * s);
    app.renderer.render({ container: this.holder, clear: true, clearColor: [0, 0, 0, 0] });
    // the bitmap is the whole hidden canvas with the figure in its top left corner: the page's canvas is laid out
    // larger than its box by the same ratio, and the box cuts off the rest
    this.ctx.transferFromImageBitmap(app.canvas.transferToImageBitmap());
    const sx = `${(app.renderer.width / W) * 100}%`;
    const sy = `${(app.renderer.height / H) * 100}%`;
    if (canvas.style.width !== sx) canvas.style.width = sx;
    if (canvas.style.height !== sy) canvas.style.height = sy;
  }
}

// ---------- the move list of a fighter: a move plays on the figure as it does in a fight ----------

async function moveStage(root) {
  const stage = root.querySelector('[data-moves-stage]');
  const rows = [...root.querySelectorAll('[data-move]')];
  const k = await kit();
  const assets = await fighter(root.dataset.dir);
  const view = new k.FigureView(stage, { dummy: () => fighter('kit/arena/sparring/dummy/') });
  await view.init();
  view.set(assets);
  stage.classList.add('live');
  let on = null;
  const play = (row) => {
    const m = assets.def.movesById[row.dataset.move];
    if (!m) return;
    on?.classList.remove('on');
    on = row;
    row.classList.add('on');
    // on a phone the ring is closed until the first move (the page's styles open it on .playing); the move
    // starts on the next frame, when the ring has its size
    if (!root.classList.contains('playing')) {
      root.classList.add('playing');
      requestAnimationFrame(() => requestAnimationFrame(() => on === row && view.play(m)));
    } else view.play(m);
  };
  let hover = 0;
  for (const row of rows) {
    row.addEventListener('click', () => play(row));
    row.addEventListener('focus', () => row.matches(':focus-visible') && play(row));
    // a pointer crossing the list does not start every move on its way
    row.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(hover);
      hover = setTimeout(() => play(row), 140);
    });
    row.addEventListener('pointerleave', () => clearTimeout(hover));
  }
}

// ---------- start: nothing is fetched until a figure is near the window ----------

const near = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target;
    if (el.hasAttribute('data-moves')) {
      if (!e.isIntersecting) continue;
      near.unobserve(el);
      moveStage(el).catch((err) => console.warn('[приёмы]', err));
      continue;
    }
    el.__slot ??= new Slot(el);
    const slot = el.__slot;
    slot.seen = e.isIntersecting;
    if (e.isIntersecting && !slot.seq) slot.load();
    if (e.isIntersecting) wake();
  }
}, { rootMargin: '240px 0px' });
for (const el of document.querySelectorAll('[data-fig], [data-moves]')) near.observe(el);
