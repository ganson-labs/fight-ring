// The opening of the game: darkness and rain, a lightning flash over the rooftop, a short flight over the four
// stages (rooftop, server room, foundry, temple), the title slams in with metal, heat and sparks, then
// «Нажми любую клавишу». The contestants' fighters stand in the shots as silhouettes in back light; the sparring
// dummy never appears. Driven by its own clock: play() in real time, or step(dt) frame by frame for a recording.
import * as PIXI from 'pixi.js';
import * as E from '/kit/arena/engine/index.js';
import { Scene } from '/kit/arena/render/scene.js';

const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

// the shots: stage, start and end of the camera (world units; zoom against the 1080p reference), length
const SHOTS = [
  { stage: 'rooftop', at: 0, dur: 3.1, from: { x: 1240, y: 330, zoom: 1.05 }, to: { x: 1100, y: 250, zoom: 1.22 }, cast: false },
  { stage: 'server', at: 3.1, dur: 1.45, from: { x: 760, y: 230, zoom: 1.5 }, to: { x: 1000, y: 210, zoom: 1.62 }, cast: true },
  { stage: 'foundry', at: 4.55, dur: 1.45, from: { x: 1420, y: 240, zoom: 1.6 }, to: { x: 1180, y: 215, zoom: 1.5 }, cast: true },
  { stage: 'temple', at: 6.0, dur: 1.5, from: { x: 1100, y: 420, zoom: 1.05 }, to: { x: 1100, y: 270, zoom: 1.28 }, cast: true },
];
export const TITLE_AT = 7.5; // the title slams in
export const PRESS_AT = 8.7; // «Нажми любую клавишу»
const LIGHTNING = [1.15, 1.32, 2.4];

// the sounds of the opening, by time (seconds): for the game and for the recorded clip
export const INTRO_CUES = [
  { at: 0.05, name: 'braam', gain: 0.55 },
  { at: 1.1, name: 'thunder', gain: 1 },
  { at: 3.05, name: 'vs-whoosh', gain: 0.7 },
  { at: 4.5, name: 'whoosh-heavy', gain: 0.8 },
  { at: 5.95, name: 'vs-whoosh', gain: 0.6 },
  { at: TITLE_AT - 0.35, name: 'riser', gain: 0.5 },
  { at: TITLE_AT, name: 'title-slam', gain: 1 },
  { at: TITLE_AT + 0.02, name: 'impact-epic', gain: 0.7 },
];

export class Intro {
  // app: the backdrop's PIXI app (1920×1080); stages: { id: stage assets }; cast: fighter assets (contestants
  // only, at most two); title: the DOM element of the title layer; sfx: the game's sound
  // filler: any fighter's assets, only to drive the scene when there is no cast (never drawn)
  constructor({ app, stages, cast = [], filler, title, sfx = null }) {
    Object.assign(this, { app, stages, cast: cast.slice(0, 2), filler, title, sfx });
    this.t = 0;
    this.cueAt = 0;
    this.shot = -1;
    this.sparks = [];
    this.fade = new PIXI.Graphics();
    this.flash = new PIXI.Graphics();
    this.bolt = new PIXI.Graphics();
    this.bolt.blendMode = 'add';
    this.fx = new PIXI.Container();
    this.fx.blendMode = 'add';
    this.dot = PIXI.Texture.from(dotCanvas());
    this.done = false;
  }

  // jump to the end (a key during the opening, or the second time in a session)
  skip() {
    this.step(Math.max(0, PRESS_AT + 0.6 - this.t), { quiet: true });
  }

  buildShot(i) {
    const s = SHOTS[i];
    const app = this.app;
    app.stage.removeChildren();
    this.scene?.ambient?.destroy?.();
    const scene = new Scene(app, { width: 1920, height: 1080, hud: false, calm: true });
    scene.setStage(this.stages[s.stage] || null);
    // the cast stands in the shot as silhouettes against the stage's light; without contestants nobody does
    const cast = s.cast && this.cast.length ? this.cast : [];
    const pair = cast.length === 2 ? cast : cast.length === 1 ? [cast[0], cast[0]] : null;
    if (pair) {
      scene.setFighters(pair);
      for (const rig of scene.rigs) for (const b of Object.values(rig.bones)) b.sprite.tint = 0x0d0f16;
      const f = E.createFight({ fighters: pair.map((a) => a.def), seed: 7 });
      const mid = (s.from.x + s.to.x) / 2;
      f.f[0].x = mid - 170;
      f.f[1].x = mid + 170;
      if (cast.length === 1) for (const x of [scene.rigs[1], scene.rims[1], scene.mirrors[1]]) if (x) x.root.visible = false;
      if (cast.length === 1) scene.shadowSprites[1].visible = false;
      if (cast.length === 1) f.f[0].x = mid;
      scene.reset(f);
      this.fight = f;
    } else {
      // an empty fight only to drive the scene; its fighters are not drawn
      const kit = this.filler;
      scene.setFighters([kit, kit]);
      scene.fighterLayer.visible = false;
      scene.shadows.visible = false;
      scene.reflections.visible = false;
      this.fight = E.createFight({ fighters: [kit.def, kit.def], seed: 7 });
      scene.reset(this.fight);
    }
    scene.camFixed = { ...s.from };
    // the bolt behind the skyline: right after the sky, before the stage's layers
    scene.scenery.addChildAt(this.bolt, scene.scenery.getChildIndex(scene.bg));
    app.stage.addChild(this.fx, this.flash, this.fade);
    this.scene = scene;
    this.shot = i;
  }

  // advance the opening by dt seconds and draw it
  step(dt, { quiet = false } = {}) {
    const t0 = this.t;
    this.t += dt;
    const t = this.t;
    // sounds whose time has come
    if (this.sfx && !quiet) for (const c of INTRO_CUES) if (c.at > t0 && c.at <= t) this.sfx.play(c.name, c.gain);
    // which shot: the last one stays on under the title
    let i = SHOTS.findIndex((s) => t < s.at + s.dur);
    if (i < 0) i = SHOTS.length - 1;
    if (i !== this.shot) this.buildShot(i);
    const s = SHOTS[i];
    const k = clamp((t - s.at) / s.dur, 0, 1);
    const tail = i === SHOTS.length - 1 ? clamp((t - (s.at + s.dur)) / 10, 0, 1) : 0;
    const cam = this.scene.camFixed;
    // under the title the camera rises and pulls back: the cast stays small at the bottom, the title owns the frame
    const lift = i === SHOTS.length - 1 ? ease(clamp((t - TITLE_AT + 0.4) / 1.6, 0, 1)) : 0;
    cam.x = lerp(s.from.x, s.to.x, ease(k)) + tail * 40;
    cam.y = lerp(s.from.y, s.to.y, ease(k)) + lift * 230;
    cam.zoom = lerp(s.from.zoom, s.to.zoom, ease(k)) - lift * 0.36 + tail * 0.04;
    // the frame breathes: a slow push, a tiny roll
    cam.rot = Math.sin(t * 0.7) * 0.004;
    // the fight does not run: the cast keeps its idle pose
    if (this.fight) this.fight.tick = Math.floor(t * 60);
    // big steps (skip) jump straight to the end: no particle storms from a huge dt
    const sd = Math.min(dt, 0.05);
    this.scene.draw(this.fight, sd);
    const W = 1920;
    const H = 1080;
    // darkness before the first lightning, short dips to black between shots, lightning flashes
    let dark = 0;
    if (t < LIGHTNING[0]) dark = 1;
    else if (i === 0) dark = clamp(0.55 - (t - LIGHTNING[0]) * 0.3, 0.1, 0.55);
    for (const sh of SHOTS.slice(1)) {
      const d = Math.abs(t - sh.at);
      if (d < 0.12) dark = Math.max(dark, 1 - d / 0.12);
    }
    if (t > TITLE_AT - 0.25) dark = Math.max(dark, clamp(0.35 + (t < TITLE_AT ? (TITLE_AT - t) * 2 : 0), 0, 1) * 0.85);
    this.fade.clear();
    if (dark > 0.01) this.fade.rect(0, 0, W, H).fill({ color: 0x000000, alpha: dark });
    let fl = 0;
    for (const l of LIGHTNING) if (t >= l) fl = Math.max(fl, Math.exp(-(t - l) * 9) * (l === LIGHTNING[0] ? 1 : 0.6));
    if (t >= TITLE_AT) fl = Math.max(fl, Math.exp(-(t - TITLE_AT) * 6) * 0.85);
    this.flash.clear();
    if (fl > 0.01) this.flash.rect(0, 0, W, H).fill({ color: t >= TITLE_AT ? 0xffd9a0 : 0xdfe8ff, alpha: fl });
    if (t >= TITLE_AT && t0 < TITLE_AT) this.burst(W / 2, H * 0.44);
    // the bolt itself over the rooftop's sky, a new one for every strike
    this.bolt.clear();
    if (i === 0) {
      const l = [...LIGHTNING].reverse().find((x) => t >= x);
      if (l !== undefined) {
        const a = Math.exp(-(t - l) * 7);
        if (a > 0.02) drawBolt(this.bolt, l === LIGHTNING[0] ? 1240 : l === LIGHTNING[1] ? 1300 : 520, Math.round(l * 100), a);
      }
    }
    this.sparksStep(sd);
    if (this.scene && t >= TITLE_AT) {
      const shake = Math.exp(-(t - TITLE_AT) * 5) * 14;
      this.app.stage.x = Math.sin(t * 90) * shake;
      this.app.stage.y = Math.cos(t * 77) * shake * 0.6;
    }
    this.drawTitle(t);
    this.app.render();
    if (t >= PRESS_AT && !this.done) this.done = true;
    document.body.classList.toggle('intro-on', t < PRESS_AT);
  }

  burst(x, y) {
    for (let n = 0; n < 160; n++) {
      const a = Math.random() * Math.PI * 2;
      const v = 500 + Math.random() * 1500;
      const sp = new PIXI.Sprite(this.dot);
      sp.anchor.set(0.5);
      sp.tint = [0xffe7b0, 0xffb347, 0xff7a1e, 0xffffff][n % 4];
      sp.position.set(x + (Math.random() - 0.5) * 900, y + (Math.random() - 0.5) * 120);
      this.fx.addChild(sp);
      this.sparks.push({ sp, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - 300, life: 0.6 + Math.random() * 1.1, max: 1.7 });
    }
    // embers that keep drifting up under the title
    this.embers = true;
  }

  sparksStep(dt) {
    if (this.embers && Math.random() < dt * 40) {
      const sp = new PIXI.Sprite(this.dot);
      sp.anchor.set(0.5);
      sp.tint = Math.random() < 0.5 ? 0xffb347 : 0xff7a1e;
      sp.position.set(Math.random() * 1920, 1100);
      this.fx.addChild(sp);
      this.sparks.push({ sp, vx: (Math.random() - 0.5) * 60, vy: -(90 + Math.random() * 160), life: 4 + Math.random() * 3, max: 7, ember: true });
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sp.destroy();
        this.sparks.splice(i, 1);
        continue;
      }
      if (!p.ember) p.vy += 1400 * dt;
      p.sp.x += p.vx * dt + (p.ember ? Math.sin(p.life * 3) * 0.4 : 0);
      p.sp.y += p.vy * dt;
      const k = p.life / p.max;
      p.sp.alpha = Math.min(1, k * 2) * (p.ember ? 0.7 : 1);
      const v = Math.hypot(p.vx, p.vy);
      p.sp.rotation = Math.atan2(p.vy, p.vx);
      p.sp.scale.set(p.ember ? 0.18 : Math.min(1.4, v / 900) * 0.5 + 0.1, p.ember ? 0.18 : 0.12);
    }
  }

  // the title layer is DOM (the game's font and metal); its animation runs on this clock
  drawTitle(t) {
    const el = this.title;
    if (!el) return;
    const logo = el.querySelector('.intro-logo');
    const press = el.querySelector('.press');
    const k = clamp((t - (TITLE_AT - 0.22)) / 0.22, 0, 1); // flies in from far and big
    const after = t - TITLE_AT;
    const scale = k < 1 ? lerp(3.2, 1, ease(k)) : 1 + Math.exp(-after * 7) * 0.06 * Math.cos(after * 30);
    logo.style.opacity = String(k);
    logo.style.transform = `scale(${scale.toFixed(4)})`;
    logo.style.filter = k < 1 ? `blur(${((1 - k) * 14).toFixed(1)}px)` : '';
    // heat: the glow breathes after the hit
    el.style.setProperty('--heat', String(after > 0 ? (0.55 + 0.45 * Math.exp(-after * 1.5) + 0.08 * Math.sin(after * 4)).toFixed(3) : 0));
    press.style.opacity = String(clamp((t - PRESS_AT) / 0.4, 0, 1) * (t > PRESS_AT + 0.4 ? 0.65 + 0.35 * Math.cos((t - PRESS_AT) * 3.6) : 1));
  }

  // real time until it is stopped
  play() {
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      try {
        this.step(dt);
      } catch (e) {
        console.error('[заставка]', e);
        this.running = false;
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    document.body.classList.remove('intro-on');
    cancelAnimationFrame(this.raf);
    this.app.stage.position.set(0, 0);
    this.app.stage.removeChildren();
    for (const p of this.sparks) p.sp.destroy();
    this.sparks = [];
  }
}

// a jagged bolt from the top of the frame with a few branches; seed picks its shape
function drawBolt(g, x0, seed, a) {
  let s = seed * 9301 + 49297;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const path = (x, y, len, w, depth) => {
    const pts = [[x, y]];
    for (let i = 0; i < len; i++) {
      x += (r() - 0.5) * 70;
      y += 28 + r() * 26;
      pts.push([x, y]);
      if (depth < 2 && r() < 0.12) path(x, y, Math.floor(len * 0.4), w * 0.5, depth + 1);
    }
    for (const [width, alpha, color] of [[w * 6, 0.18, 0x7fa6ff], [w * 2.2, 0.5, 0xbfd4ff], [w, 1, 0xffffff]]) {
      g.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
      g.stroke({ width, color, alpha: alpha * a, cap: 'round', join: 'round' });
    }
  };
  path(x0, -20, 17, 6, 0);
}

function dotCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,.8)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return c;
}
