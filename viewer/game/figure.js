// Fighters drawn from their own skeleton and parts (never a separate picture): still shots for tiles and a live
// animated figure for the fighter card. Both use the VS screen's light: a flat accent copy behind the body,
// shifted to the outer edge (rim light), and a blurred one (aura).
import * as PIXI from 'pixi.js';
import { solvePose, sampleAnim, BONE, createFight, RING_SEED } from '../../kit/arena/engine/index.js';
import { Rig, Scene } from '../../kit/arena/render/scene.js';
import { Player } from '../../kit/arena/render/player.js';
import { moveDemo, showGap } from '../../kit/arena/render/movedemo.js';

const hexNum = (h) => parseInt(String(h || '#ffffff').slice(1), 16);
const rgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a, b, k) => {
  const A = rgb(a);
  const B = rgb(b);
  return (Math.round(A[0] + (B[0] - A[0]) * k) << 16) | (Math.round(A[1] + (B[1] - A[1]) * k) << 8) | Math.round(A[2] + (B[2] - A[2]) * k);
};

function flatFilter(color) {
  const f = new PIXI.ColorMatrixFilter();
  const [r, g, b] = rgb(mix(color, 0xffffff, 0.25)).map((v) => v / 255);
  f.matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 1, 0];
  return f;
}

// One lit figure: main body, rim copy, aura copy. apply(solved) poses all three. accent: the light's colour
// (the corner's own in a mirror match), tint: the body's (darker for a fighter in the shade).
export function litFigure(assets, { rim = 7, aura = 24, flip = 1, accent = null, tint = mix(0xffffff, 0x8c90a8, 0.25) } = {}) {
  accent = accent ? hexNum(accent) : hexNum(assets.def.card.colors.accent);
  const root = new PIXI.Container();
  const main = new Rig(assets, { tint });
  const rimRig = new Rig(assets);
  const auraRig = new Rig(assets);
  rimRig.root.filters = [flatFilter(accent), new PIXI.BlurFilter({ strength: 2.5, quality: 2 })];
  const auraBox = new PIXI.Container();
  auraBox.addChild(auraRig.root);
  auraBox.filters = [flatFilter(accent), new PIXI.BlurFilter({ strength: aura, quality: 3 })];
  auraBox.alpha = 0.55;
  auraBox.blendMode = 'add';
  root.addChild(auraBox, rimRig.root, main.root);
  const rigs = [main, rimRig, auraRig];
  const fig = {
    root,
    main,
    rimRig,
    auraBox,
    scale(s, f = flip) {
      flip = f;
      for (const r of rigs) r.root.scale.set(s * flip, s);
    },
    apply(solved) {
      for (const r of rigs) r.apply(solved);
    },
    place(x, y) {
      main.root.position.set(x, y);
      auraRig.root.position.set(x, y);
      rimRig.root.position.set(x - rim * flip, y - rim * 0.6);
    },
    // bounds of the body at scale 1 in the given pose
    bounds(solved) {
      main.root.scale.set(1, 1);
      main.apply(solved);
      return main.root.getLocalBounds();
    },
  };
  return fig;
}

const idlePose = (def, tick = 0) => solvePose(sampleAnim(def.anims.idle, tick));

// ---------- still shots ----------

let shotApp = null;
let liveApp = null;
let demoApp = null;
async function shooter() {
  if (shotApp) return shotApp;
  shotApp = new PIXI.Application();
  await shotApp.init({ width: 8, height: 8, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoStart: false, resolution: 1 });
  return shotApp;
}

const shotCache = new Map();

// A PNG of the fighter in its idle pose. crop: 'waist' (head to hips, tiles) or 'knees' (menu pair).
// The picture is drawn at the screen's real pixels (devicePixelRatio and a window larger than 1080p, at most twice
// the design size: larger textures fail on phones), so a tile never stretches it.
export const shotScale = () => Math.min(2, Math.max(1, (window.devicePixelRatio || 1) * Math.max(1, Math.min(window.innerWidth / 1920, window.innerHeight / 1080))));
export async function figureShot(assets, { w = 360, h = 480, crop = 'waist', key = assets.base } = {}) {
  const S = shotScale();
  w = Math.round(w * S);
  h = Math.round(h * S);
  const ck = `${key}|${w}x${h}|${crop}`;
  if (shotCache.has(ck)) return shotCache.get(ck);
  const app = await shooter();
  const fig = litFigure(assets, { rim: 6 * (h / 480), aura: 18 * (h / 480) });
  const solved = idlePose(assets.def, 0);
  const b = fig.bounds(solved);
  // the visible part (head to hips or knees) fills most of the frame height
  const visible = crop === 'waist' ? 0.62 : 0.8;
  const s = (h * 0.9) / (b.height * visible);
  fig.scale(s);
  fig.apply(solved);
  const cx = (b.x + b.width / 2) * s;
  fig.place(w / 2 - cx, h * 0.08 - b.y * s);
  const rt = PIXI.RenderTexture.create({ width: w, height: h });
  const holder = new PIXI.Container();
  holder.addChild(fig.root);
  app.renderer.render({ container: holder, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
  const url = await app.renderer.extract.base64({ target: rt, format: 'png' });
  rt.destroy(true);
  holder.destroy({ children: true });
  shotCache.set(ck, url);
  return url;
}

// ---------- the reveal of a new fighter (or a new version) on its card ----------

const ORDER = ['pelvis', 'torso', 'head', 'thigh_back', 'shin_back', 'foot_back', 'thigh_front', 'shin_front', 'foot_front', 'upper_arm_back', 'forearm_back', 'hand_back', 'upper_arm_front', 'forearm_front', 'hand_front'];
const easeOutBack = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;
let glowTex = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,240,200,.85)');
  r.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  glowTex = PIXI.Texture.from(c);
  return glowTex;
}

// A plan of the reveal: per part where it starts (the parts laid out as a sheet), where it flies apart to
// (an exploded schematic around the body) and when it lands on its joint. Times in seconds.
function revealPlan(fig, bounds, { short = false, changed = null } = {}) {
  const extra = (fig.main.extra || []).map((b) => b.name);
  const names = [...ORDER, ...extra].filter((n) => fig.main.bones[n]);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  // the sheet: the parts at half size in a compact grid that fits the stage
  const cols = 4;
  const cell = bounds.height / 5;
  const order = short ? names.filter((n) => !changed || changed.has(n)) : names;
  const start = short ? 0.25 : 1.3;
  const span = short ? 1.1 : 2.6;
  const step = order.length ? span / order.length : 0;
  return names.map((n, i) => {
    const k = order.indexOf(n);
    const gx = cx + ((i % cols) - (cols - 1) / 2) * cell;
    const gy = cy + (Math.floor(i / cols) - Math.floor((names.length - 1) / cols) / 2) * cell * 1.1;
    const spin = ((i * 37) % 11) / 11 - 0.5;
    return { name: n, still: k < 0, grid: [gx, gy], spin, land: k < 0 ? 0 : start + k * step, fly: short ? 0.35 : 0.45, flashed: false };
  });
}

export function revealDuration(short) {
  return short ? 3.4 : 7;
}

// ---------- the live figure of the fighter card ----------

export class FigureView {
  // dummy: () => Promise of the sparring dummy's assets, the target a move is shown on
  constructor(el, { dummy = null } = {}) {
    this.el = el;
    this.dummy = dummy;
    this.demoRun = null;
    this.demoSeq = 0;
    this.app = null;
    this.fig = null;
    this.assets = null;
    this.queue = [];
    this.t = 0;
    this.cur = null;
    this.raf = 0;
    this.alive = true;
  }

  async init() {
    // one long-lived app for every card: destroying a PIXI app breaks the others (shared GPU resources)
    if (!liveApp) {
      liveApp = new PIXI.Application();
      await liveApp.init({ width: 8, height: 8, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoStart: false, resolution: Math.min(2, window.devicePixelRatio || 1) });
    }
    if (!this.alive) return;
    const app = liveApp;
    this.app = app;
    this.el.appendChild(app.canvas);
    const fit = () => {
      const r = this.el.getBoundingClientRect();
      if (r.width && r.height) app.renderer.resize(Math.round(r.width), Math.round(r.height));
    };
    fit();
    this.ro = new ResizeObserver(fit);
    this.ro.observe(this.el);
    let last = performance.now();
    const loop = (now) => {
      if (!this.alive) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      try {
        if (this.demoRun) this.demoFrame(dt);
        else {
          this.tick(dt);
          app.render();
        }
      } catch (e) {
        console.error('[фигура]', e);
        this.stopDemo();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  set(assets) {
    this.demoSeq++;
    this.stopDemo();
    this.assets = assets;
    if (!this.app) return;
    this.app.stage.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.fig = litFigure(assets, { rim: 7, aura: 26 });
    this.app.stage.addChild(this.fig.root);
    this.bodyBounds = this.fig.bounds(idlePose(assets.def, 0));
    this.cur = null;
    this.queue = [];
    if (assets.def.anims.intro && !this.noIntro) this.play('intro');
  }

  // an animation by name (intro, victory, …) or a move: plays once, then back to idle. A move with the sparring
  // dummy at hand is shown as in a fight (moveDemo): its fx, projectiles and the objects of its ability.
  play(what) {
    const def = this.assets?.def;
    if (!def) return;
    this.demoSeq++;
    this.stopDemo();
    if (typeof what !== 'string' && this.dummy) {
      this.demo(what);
      return;
    }
    const anim = typeof what === 'string' ? def.anims[what] : what.anim;
    if (!anim) return;
    const len = typeof what === 'string' ? (anim.loop ? anim.length * 2 : anim.keys[anim.keys.length - 1].t + 20) : what.duration + 18;
    this.cur = { anim, len, loop: !!anim.loop && typeof what === 'string' && what !== 'idle' };
    this.t = 0;
  }

  tick(dt) {
    if (!this.fig || !this.app) return;
    const def = this.assets.def;
    this.t += dt * 60;
    let pose;
    if (this.cur && this.t < this.cur.len) pose = sampleAnim(this.cur.anim, this.t);
    else {
      if (this.cur) {
        this.cur = null;
        this.t = 0;
      }
      pose = sampleAnim(def.anims.idle, this.t);
    }
    const W = this.app.renderer.width / this.app.renderer.resolution;
    const H = this.app.renderer.height / this.app.renderer.resolution;
    const b = this.bodyBounds;
    // feet slightly below the frame edge on a phone, whole body on a desktop
    const s = Math.min((H * 0.9) / b.height, (W * 0.8) / b.width);
    this.fig.scale(s);
    this.fig.apply(solvePose(pose));
    const cx = (b.x + b.width / 2) * s;
    this.fig.place(W / 2 - cx, H * 0.97 - (b.y + b.height) * s);
    if (this.rv) this.revealFrame(dt);
  }

  // The reveal: the parts laid out as a sheet fly apart into a schematic and land one by one on the skeleton with a
  // flash at each joint, a scanner runs over the finished figure, it strikes its entrance pose. short: a new
  // version — only its changed parts (changed: Set of bones) fly in. onBeat(kind, i): sounds and the card's titles.
  reveal({ short = false, changed = null, onBeat = () => {} } = {}) {
    if (!this.fig) return;
    this.demoSeq++;
    this.stopDemo();
    this.cleanReveal();
    this.cur = null;
    this.t = 0;
    this.rv = { t: 0, short, changed, onBeat, plan: null, fx: [], beats: new Set(), dur: revealDuration(short) };
    this.fig.auraBox.alpha = 0;
    this.fig.rimRig.root.alpha = 0;
    onBeat('start');
  }

  cleanReveal() {
    if (!this.rv) return;
    for (const f of this.rv.fx) f.sp.destroy();
    this.rv.scan?.destroy();
    for (const o of Object.values(this.fig?.main.bones || {})) {
      o.mesh?.scale.set(1);
      if (o.mesh) {
        o.mesh.position.set(0, 0);
        o.mesh.alpha = 1;
      } else o.holder.alpha = 1;
    }
    if (this.fig) {
      this.fig.auraBox.alpha = 0.55;
      this.fig.rimRig.root.alpha = 1;
    }
    this.rv = null;
  }

  revealFrame(dt) {
    const rv = this.rv;
    const fig = this.fig;
    rv.t += dt;
    const t = rv.t;
    const beat = (k, at) => {
      if (t >= at && !rv.beats.has(k)) {
        rv.beats.add(k);
        rv.onBeat(k);
        return true;
      }
      return false;
    };
    rv.plan ||= revealPlan(fig, this.bodyBounds, rv);
    const b = this.bodyBounds;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const scanAt = rv.short ? 1.5 : 4.2;
    const scanLen = rv.short ? 0.7 : 0.9;
    rv.plan.forEach((p, i) => {
      const o = fig.main.bones[p.name];
      if (!o || p.still) return;
      const tx = o.holder ? o.holder.x : 0;
      const ty = o.holder ? o.holder.y : 0;
      const tr = o.holder ? o.holder.rotation : 0;
      const bx = o.holder ? tx : (o.mesh.getLocalBounds().x + o.mesh.getLocalBounds().width / 2);
      const by = o.holder ? ty : (o.mesh.getLocalBounds().y + o.mesh.getLocalBounds().height / 2);
      // the exploded place: out from the body's centre, kept inside the stage
      const ex = Math.max(b.x - b.width * 0.15, Math.min(b.x + b.width * 1.15, bx + (bx - cx) * 0.7 + p.spin * 40));
      const ey = Math.max(b.y + b.height * 0.04, Math.min(b.y + b.height * 0.98, by + (by - cy) * 0.45));
      let x;
      let y;
      let r = tr;
      let a = 1;
      let sc = 1;
      const upright = -(BONE[p.name]?.rest ?? 90) * (Math.PI / 180);
      if (!rv.short && t < 0.7) {
        x = p.grid[0];
        y = p.grid[1];
        r = upright;
        sc = 0.5;
        a = clamp01((t - i * 0.03) / 0.2);
      } else if (!rv.short && t < 1.3) {
        const k = easeInOut(clamp01((t - 0.7) / 0.6));
        x = lerp(p.grid[0], ex, k);
        y = lerp(p.grid[1], ey, k);
        r = lerp(upright, tr + p.spin, k);
        sc = lerp(0.5, 1, k);
      } else {
        const k = clamp01((t - p.land) / p.fly);
        if (k <= 0) {
          x = ex;
          y = ey + Math.sin((t + i) * 3) * 4;
          r = tr + p.spin;
          a = rv.short ? clamp01(t / 0.2) : 1;
        } else {
          const e = easeOutBack(k);
          x = lerp(ex, bx, e);
          y = lerp(ey, by, e);
          r = lerp(tr + p.spin, tr, Math.min(1, e));
        }
        if (k >= 1 && !p.flashed) {
          p.flashed = true;
          const g = (o.holder || o.mesh).getGlobalPosition();
          const at = o.holder ? g : { x: g.x + bx * fig.main.root.scale.x, y: g.y + by * fig.main.root.scale.y };
          const sp = new PIXI.Sprite(glow());
          sp.anchor.set(0.5);
          sp.blendMode = 'add';
          sp.position.set(at.x, at.y);
          this.app.stage.addChild(sp);
          rv.fx.push({ sp, t: 0 });
          rv.onBeat('land', i);
          o.mesh?.scale.set(1);
          if (o.mesh) o.mesh.position.set(0, 0);
          (o.holder || o.mesh).alpha = 1;
          return;
        }
        if (k >= 1) {
          o.mesh?.scale.set(1);
          if (o.mesh) o.mesh.position.set(0, 0);
          (o.holder || o.mesh).alpha = 1;
          return;
        }
      }
      if (o.holder) {
        o.holder.position.set(x, y);
        o.holder.rotation = r;
        if (sc !== 1) o.holder.scale.set(o.holder.scale.x * sc, o.holder.scale.y * sc);
        o.holder.alpha = a;
      } else {
        o.mesh.scale.set(sc);
        o.mesh.position.set(x - bx * sc, y - by * sc);
        o.mesh.alpha = a;
      }
    });
    // flashes at the joints
    for (const f of rv.fx) {
      f.t += dt;
      const k = clamp01(f.t / 0.35);
      f.sp.scale.set(0.35 + k * 1.1);
      f.sp.alpha = 1 - k;
    }
    // the scanner over the finished figure, then the light comes on
    if (t >= scanAt && t < scanAt + scanLen + 0.1) {
      if (!rv.scan) {
        rv.onBeat('scan');
        rv.scan = new PIXI.Graphics();
        rv.scan.blendMode = 'add';
        this.app.stage.addChild(rv.scan);
      }
      const gb = fig.main.root.getBounds();
      const k = clamp01((t - scanAt) / scanLen);
      const y = gb.y + gb.height * k;
      const acc = hexNum(this.assets.def.card.colors.accent);
      rv.scan.clear();
      rv.scan.rect(gb.x - 40, y - 50, gb.width + 80, 50).fill({ color: acc, alpha: 0.18 });
      rv.scan.rect(gb.x - 40, y - 3, gb.width + 80, 6).fill({ color: 0xffffff, alpha: 0.9 });
    } else if (rv.scan && t >= scanAt + scanLen + 0.1) {
      rv.scan.destroy();
      rv.scan = null;
    }
    const lit = clamp01((t - scanAt - scanLen) / 0.4);
    fig.auraBox.alpha = 0.55 * lit;
    fig.rimRig.root.alpha = lit;
    if (beat('pose', scanAt + scanLen) && this.assets.def.anims.intro) this.play('intro');
    beat('title', scanAt + scanLen + 0.2);
    beat('voice', scanAt + scanLen + 0.3);
    if (t >= rv.dur) {
      rv.onBeat('end');
      this.cleanReveal();
    }
  }

  // ---------- a move as in a fight: the ring's own scene, the fighter against the sparring dummy ----------

  async demo(move) {
    const seq = ++this.demoSeq;
    this.cleanReveal();
    let dummy;
    try {
      dummy = await this.dummy();
    } catch (e) {
      console.warn('[фигура] манекен не загрузился', e);
    }
    if (seq !== this.demoSeq || !this.alive || !this.assets) return;
    if (!dummy) {
      this.dummy = null; // poses only from now on
      this.play(move);
      return;
    }
    if (!demoApp) {
      demoApp = new PIXI.Application();
      await demoApp.init({ width: 8, height: 8, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoStart: false, resolution: 1 });
      demoApp.canvas.classList.add('demo');
    }
    if (seq !== this.demoSeq || !this.alive) return;
    const r = this.el.getBoundingClientRect();
    const aspect = r.width && r.height ? r.width / r.height : 1;
    // the scene's own reference sizes: 1080 wide when the stage is tall (a phone, the card's column), else 1920
    const vertical = aspect < 1.2;
    const w = vertical ? 1080 : 1920;
    const h = Math.round(w / aspect);
    const res = Math.min(2, Math.max(1, (r.width * Math.min(2, window.devicePixelRatio || 1)) / w)); // below 1 the filters cut the frame
    if (demoApp.renderer.width !== Math.round(w * res) || demoApp.renderer.height !== Math.round(h * res)) demoApp.renderer.resize(w, h, res);
    demoApp.stage.removeChildren().forEach((c) => c.destroy({ children: true }));
    const scene = new Scene(demoApp, { width: w, height: h, vertical, hud: false });
    // the card's own background stays: no sky, floor or vignette of the training room
    scene.sky.visible = false;
    scene.bg.visible = false;
    scene.vignette.visible = false;
    scene.abilityFx.hud.visible = false; // resource bars and effect chips belong to the fight's HUD
    scene.setFighters([this.assets, dummy]);
    const fighters = [this.assets.def, dummy.def];
    const fight = createFight({ fighters, seed: RING_SEED });
    const source = moveDemo(fight, move, { gap: showGap(fighters, move) });
    scene.reset(fight);
    this.demoRun = { scene, fight, player: new Player({ fight, source, scene }), tail: 0 };
    this.el.appendChild(demoApp.canvas);
    if (this.app) this.app.canvas.style.visibility = 'hidden';
  }

  demoFrame(dt) {
    const d = this.demoRun;
    d.player.advance(dt);
    // the dummy is only the target: dimmed, the fighter is the one looked at
    const rig = d.scene.rigs?.[1];
    if (rig) rig.root.alpha *= 0.55;
    demoApp.render();
    if (d.player.done && (d.tail += dt) > 0.5) this.stopDemo();
  }

  stopDemo() {
    if (!this.demoRun) return;
    this.demoRun = null;
    demoApp?.canvas.remove();
    if (this.app) this.app.canvas.style.visibility = '';
    this.cur = null;
    this.t = 0;
  }

  destroy() {
    this.demoSeq++;
    this.stopDemo();
    this.cleanReveal?.();
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    if (this.app) {
      this.app.stage.removeChildren().forEach((c) => c.destroy({ children: true }));
      this.app.canvas.remove();
    }
    this.app = null;
  }
}
