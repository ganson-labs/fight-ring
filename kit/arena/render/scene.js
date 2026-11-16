// WebGL scene of the ring (PixiJS): parallax stage, rigged fighters, effects, camera, HUD.
// It only draws: the fight itself is the engine's state, passed in every frame.
import * as PIXI from 'pixi.js';
import { ringText, fitText } from './text.js';
import { AdvancedBloomFilter, GlowFilter, ShockwaveFilter } from 'pixi-filters';
import { BONE, DEFAULT_Z, solvePose } from '../engine/skeleton.js';
import { solveBody, buildMesh, skinMesh } from '../engine/body.js';
import { drawOrder, placeBones } from './fit.js';
import { STAGE, METER_MAX, METER_BAR, STUN_MAX, TICK_RATE, PROJECTILE } from '../engine/constants.js';
import { debugBoxes } from '../engine/sim.js';
import { poseFor } from './animstate.js';
import { Ambient } from './ambient.js';
import { AbilityFx } from './abilityfx.js';

const D2R = Math.PI / 180;
const W = STAGE.width;
const FONT = 'Oswald, "Arial Narrow", Impact, sans-serif';
const hexNum = (h) => parseInt(String(h || '#ffffff').slice(1), 16);
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- generated textures ----------

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  return PIXI.Texture.from(c);
}

function makeTextures() {
  return {
    dot: canvasTexture(64, 64, (g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.25, 'rgba(255,255,255,0.8)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }),
    streak: canvasTexture(128, 16, (g, w, h) => {
      const r = g.createLinearGradient(0, 0, w, 0);
      r.addColorStop(0, 'rgba(255,255,255,0)');
      r.addColorStop(0.7, 'rgba(255,255,255,0.9)');
      r.addColorStop(1, 'rgba(255,255,255,1)');
      g.fillStyle = r;
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w * 0.85, 1);
      g.lineTo(w, h / 2);
      g.lineTo(w * 0.85, h - 1);
      g.closePath();
      g.fill();
    }),
    drop: canvasTexture(4, 64, (g, w, h) => {
      const r = g.createLinearGradient(0, 0, 0, h);
      r.addColorStop(0, 'rgba(255,255,255,0)');
      r.addColorStop(1, 'rgba(255,255,255,0.9)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }),
    vignette: canvasTexture(512, 512, (g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, w * 0.25, w / 2, h / 2, w * 0.75);
      r.addColorStop(0, 'rgba(0,0,0,0)');
      r.addColorStop(1, 'rgba(0,0,0,0.75)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }),
    shadow: canvasTexture(128, 32, (g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, 'rgba(0,0,0,0.65)');
      r.addColorStop(1, 'rgba(0,0,0,0)');
      g.setTransform(1, 0, 0, h / w, 0, 0);
      g.fillStyle = r;
      g.fillRect(0, 0, w, w);
    }),
  };
}

// ---------- colour grade ----------

// stage.json "grade": { "contrast": 0.1, "saturation": 0.1, "brightness": 1, "tint": "#ffd9b0", "tintAmount": 0.1 }
export function gradeFilter(g) {
  const f = new PIXI.ColorMatrixFilter();
  if (g.brightness !== undefined) f.brightness(g.brightness, true);
  if (g.contrast) f.contrast(g.contrast, true);
  if (g.saturation) f.saturate(g.saturation, true);
  if (g.tint && g.tintAmount) {
    const t = hexNum(g.tint);
    const k = g.tintAmount;
    const r = ((t >> 16) & 255) / 255;
    const gg = ((t >> 8) & 255) / 255;
    const b = (t & 255) / 255;
    // multiply towards the tint colour
    const m = [1 - k + k * r, 0, 0, 0, 0, 0, 1 - k + k * gg, 0, 0, 0, 0, 0, 1 - k + k * b, 0, 0, 0, 0, 0, 1, 0];
    f._loadMatrix ? f._loadMatrix(m, true) : (f.matrix = m);
  }
  return f;
}

// ---------- rig ----------

// the far arm and leg a little darker than the near ones: the body reads in depth even with one colour for both
const FAR_SHADE = 0.8;
const shade = (c, k) => ((((c >> 16) & 255) * k) << 16) | ((((c >> 8) & 255) * k) << 8) | ((c & 255) * k);

export class Rig {
  // Pictures on the bones of one fighter: the ring's 15 and the fighter's own (engine/body.js), single pictures per
  // bone or meshes bent over a chain, other pictures and scale and draw order from the pose, springs, feet on the
  // floor. grounded and dt are set by the scene before apply (feet and springs); the sheet and cards keep defaults.
  constructor(assets, { tint = 0xffffff, ghost = false } = {}) {
    this.assets = assets;
    this.root = new PIXI.Container();
    this.root.sortableChildren = true;
    this.bones = {};
    this.meshes = [];
    this.springs = new Map();
    this.grounded = true;
    this.dt = 1 / 60;
    const def = assets.def;
    const extra = def.bones || [];
    this.extra = extra;
    const lenOf = (n) => BONE[n]?.length ?? extra.find((x) => x.name === n)?.length ?? 1;
    const zOf = (n) => def.parts[n]?.z ?? DEFAULT_Z[n] ?? (zOf(extra.find((x) => x.name === n)?.parent) ?? 7) + 0.5;
    for (const name of [...drawOrder(def.parts), ...extra.map((x) => x.name)]) {
      const part = def.parts[name];
      if (!part) continue;
      const tex = assets.textures[part.image];
      if (!tex) continue;
      const k = part.shade ?? (name.endsWith('_back') ? 1 - FAR_SHADE : 0);
      const tone = ghost ? tint : shade(tint, 1 - k);
      const z = zOf(name);
      if (part.mesh) {
        const m = buildMesh(tex.width, tex.height, part.mesh.points, { blend: part.mesh.blend });
        const mesh = new PIXI.MeshSimple({ texture: tex, vertices: new Float32Array(m.vertices.length), uvs: m.uvs, indices: m.indices });
        mesh.tint = tone;
        mesh.__tint = tone;
        mesh.zIndex = z;
        this.root.addChild(mesh);
        const entry = { mesh, sprite: mesh, data: m, part, z, isMesh: true, out: new Float32Array(m.vertices.length) };
        this.meshes.push({ name, ...entry });
        this.bones[name] = entry;
        continue;
      }
      const holder = new PIXI.Container();
      holder.zIndex = z;
      // the main picture and the part's skins, each seated on the bone by its own pivot and tip
      const looks = {};
      const make = (at, t, flip = false) => {
        const sp = new PIXI.Sprite(t);
        sp.anchor.set(at.pivot[0] / t.width, at.pivot[1] / t.height);
        const dx = at.tip[0] - at.pivot[0];
        const dy = at.tip[1] - at.pivot[1];
        // flip: the picture mirrored across its bone (drawn the other way round)
        if (flip) sp.scale.y = -1;
        sp.rotation = -Math.atan2(flip ? -dy : dy, dx);
        sp.tint = tone;
        sp.__tint = tone;
        return { sp, scale: lenOf(name) / Math.hypot(dx, dy), width: at.width ?? part.width ?? 1 };
      };
      looks[''] = make(assets.seat?.[name] || part, tex, !!part.flip); // render/seat.js: joints sunk into thin-capped pictures
      for (const [nm, sk] of Object.entries(part.skins || {})) {
        const t2 = assets.textures[sk.image];
        if (t2) looks[nm] = make(sk, t2, !!sk.flip);
      }
      for (const [nm, l] of Object.entries(looks)) {
        l.sp.visible = nm === '';
        holder.addChild(l.sp);
      }
      holder.__scale = looks[''].scale;
      holder.__width = looks[''].width;
      this.root.addChild(holder);
      this.bones[name] = { holder, sprite: looks[''].sp, looks, look: '', z };
    }
    if (ghost) this.root.alpha = 0;
  }

  // solved: solvePose(); the pictures sit where their parents' anchors put them (render/fit.js). Returns those places.
  apply(solved) {
    const def = this.assets.def;
    const pose = solved.__pose || null;
    // the fighter's own bones, feet on the floor and springs (engine/body.js) on top of the ring's skeleton
    if (pose && (def.bones?.length || def.ik?.feet)) {
      solved = solveBody(pose, def, { grounded: this.grounded, springs: this.springs, dt: this.dt });
    }
    const placed = placeBones(solved, def.parts, this.assets.seat);
    for (const b of this.extra) {
      const j = solved[b.name];
      if (!j) continue;
      const sh = placed[b.parent]?.shift || [0, 0];
      placed[b.name] = { ...j, x: j.x + sh[0], y: j.y + sh[1], tipX: j.tipX + sh[0], tipY: j.tipY + sh[1], shift: sh, clamped: false };
    }
    const scale = pose?.scale || {};
    const images = pose?.images || {};
    const zs = pose?.z || {};
    for (const [name, o] of Object.entries(this.bones)) {
      if (o.isMesh) {
        const chain = o.part.mesh.bones.map((n) => {
          const j = placed[n];
          const len = BONE[n]?.length ?? this.extra.find((x) => x.name === n)?.length ?? 1;
          const sc = scale[n]?.[0] ?? 1;
          return { x: j.x, y: j.y, angle: j.angle, length: len * sc };
        });
        skinMesh(o.data, o.part.mesh.points, chain, (o.part.width ?? 1) * (scale[name]?.[1] ?? 1), o.out);
        for (let i = 1; i < o.out.length; i += 2) o.out[i] = -o.out[i];
        o.mesh.vertices = o.out;
        o.mesh.zIndex = zs[name] ?? o.z;
        continue;
      }
      const j = placed[name];
      if (!j) continue;
      const want = images[name] && o.looks[images[name]] ? images[name] : '';
      if (want !== o.look) {
        o.looks[o.look].sp.visible = false;
        o.looks[want].sp.visible = true;
        o.look = want;
        o.sprite = o.looks[want].sp;
      }
      const l = o.looks[o.look];
      const [sa, sc] = scale[name] || [1, 1];
      o.holder.position.set(j.x, -j.y);
      o.holder.rotation = -j.angle * D2R;
      o.holder.scale.set(l.scale * sa, l.scale * l.width * sc);
      o.holder.zIndex = zs[name] ?? o.z;
    }
    return placed;
  }

  copyFrom(rig) {
    for (const [name, o] of Object.entries(this.bones)) {
      const src = rig.bones[name];
      if (!src) continue;
      if (o.isMesh) {
        o.mesh.vertices = src.out;
        o.mesh.zIndex = src.mesh.zIndex;
        continue;
      }
      if (src.look !== o.look && o.looks[src.look]) {
        o.looks[o.look].sp.visible = false;
        o.looks[src.look].sp.visible = true;
        o.look = src.look;
        o.sprite = o.looks[src.look].sp;
      }
      o.holder.position.copyFrom(src.holder.position);
      o.holder.rotation = src.holder.rotation;
      o.holder.scale.copyFrom(src.holder.scale);
      o.holder.zIndex = src.holder.zIndex;
    }
    this.root.position.copyFrom(rig.root.position);
    this.root.scale.copyFrom(rig.root.scale);
  }
}

// ---------- scene ----------

export class Scene {
  constructor(app, { width, height, vertical = false, debug = false, hud = true, names = null, quality = 'high', calm = false } = {}) {
    this.calm = calm; // behind menus: no screen flashes or shock waves, softer bloom and sparks
    this.camFixed = null; // { x, y, zoom } in world units: a camera that does not follow the fighters (intro)
    this.quality = quality; // 'high' | 'medium': the medium one skips the grade, the rim light and the reflections
    this.app = app;
    this.Wpx = width;
    this.Hpx = height;
    this.vertical = vertical;
    this.debug = debug;
    this.hudOn = hud;
    this.names = names || [];
    this.k = (vertical ? width / 1080 : width / 1920); // pixel scale against the 1080p reference
    this.tex = makeTextures();
    this.time = 0;
    this.cam = { x: W / 2, y: 140, zoom: 1.3, shake: 0, rot: 0, punch: 0, push: 0, focusX: W / 2, focusY: 150 };
    this.camMode = 'fight'; // 'fight' | 'replay' (another camera for the knockout replay)
    this.matchInfo = null; // { round, wins: [left, right], firstTo }
    this.superFx = null;
    this.timeScale = 1;
    this.particles = [];
    this.rings = [];
    this.popups = [];
    this.shockwaves = [];
    this.flashA = 0;
    this.flashColor = 0xffffff;
    this.trails = [[], []];
    this.ghosts = [[], []];
    this.glow = [null, null];
    this.activeFx = [[], []];
    this.rainDrops = [];

    const s = app.stage;
    this.sky = new PIXI.Graphics();
    this.bg = new PIXI.Container();
    this.rainBack = new PIXI.Container();
    this.darken = new PIXI.Graphics();
    this.world = new PIXI.Container();
    this.shadows = new PIXI.Container();
    this.fighterLayer = new PIXI.Container();
    this.projLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();
    this.fxLayer.filters = [new AdvancedBloomFilter(calm ? { threshold: 0.5, bloomScale: 0.5, brightness: 0.85, blur: 4, quality: 3 } : { threshold: 0.25, bloomScale: 1.1, brightness: 1.05, blur: 6, quality: 4 })];
    if (calm) this.fxLayer.alpha = 0.3;
    this.debugLayer = new PIXI.Graphics();
    this.reflections = new PIXI.Container(); // the fighters mirrored in a wet floor (stage.json "reflect")
    this.world.addChild(this.reflections, this.shadows, this.fighterLayer, this.projLayer, this.fxLayer, this.debugLayer);
    this.rainFront = new PIXI.Container();
    this.vignette = new PIXI.Sprite(this.tex.vignette);
    this.vignette.width = width;
    this.vignette.height = height;
    this.flash = new PIXI.Graphics();
    this.hud = new PIXI.Container();
    this.titles = new PIXI.Container();
    // everything of the stage and the fight goes through one colour grade of the stage; the HUD stays as drawn
    this.scenery = new PIXI.Container();
    this.scenery.addChild(this.sky, this.bg, this.rainBack, this.darken, this.world, this.rainFront);
    s.addChild(this.scenery, this.vignette, this.flash, this.hud, this.titles);
    this.stage = null;
    this.setStage(null);
    this.abilityFx = new AbilityFx(this);
  }

  // the scene's top-level layers, back to front (the VS screen hides them under its own copy)
  topLayers() {
    return [this.sky, this.bg, this.rainBack, this.darken, this.world, this.rainFront, this.vignette, this.flash, this.hud, this.titles];
  }

  // ---------- stage ----------

  setStage(stage) {
    this.stage = stage;
    this.bg.removeChildren();
    this.layers = [];
    const def = stage?.def || null;
    this.sky.clear();
    const skyTop = hexNum(def?.sky || '#07080c');
    const skyBottom = hexNum(def?.skyBottom || '#1a1c24');
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      const k = i / (steps - 1);
      const c = PIXI.Color.shared.setValue([lerp((skyTop >> 16) & 255, (skyBottom >> 16) & 255, k) / 255, lerp((skyTop >> 8) & 255, (skyBottom >> 8) & 255, k) / 255, lerp(skyTop & 255, skyBottom & 255, k) / 255]).toNumber();
      this.sky.rect(0, (i * this.Hpx) / steps, this.Wpx, this.Hpx / steps + 1).fill(c);
    }
    if (def) {
      for (const l of def.layers || []) {
        const tex = stage.textures[l.image];
        if (!tex) continue;
        const c = new PIXI.Container();
        const width = l.width ?? W * 1.4;
        const scale = width / tex.width;
        const n = Math.max(1, Math.min(9, l.repeat ?? 1));
        for (let i = 0; i < n; i++) {
          const sp = new PIXI.Sprite(tex);
          const flip = l.mirror && i % 2 === 1 ? -1 : 1;
          sp.scale.set(scale * flip, l.height ? l.height / tex.height : scale);
          sp.anchor.set(0.5, l.groundAt ?? 0.95);
          sp.x = W / 2 + (l.x ?? 0) + (i - (n - 1) / 2) * width;
          sp.y = -(l.y ?? 0);
          if (l.tint) sp.tint = hexNum(l.tint);
          if (l.alpha !== undefined) sp.alpha = l.alpha;
          c.addChild(sp);
        }
        if (l.blur) c.filters = [new PIXI.BlurFilter({ strength: l.blur * this.k, quality: 3 })];
        this.bg.addChild(c);
        this.layers.push({ c, p: l.parallax ?? 1 });
      }
    } else {
      // plain training room: dark floor with a perspective grid
      const c = new PIXI.Container();
      const g = new PIXI.Graphics();
      g.rect(-400, 0, W + 800, 600).fill({ color: 0x0d0e12 });
      for (let i = 0; i <= 44; i++) {
        const x = (i / 44) * (W + 800) - 400;
        g.moveTo(x, 0).lineTo(W / 2 + (x - W / 2) * 2.4, 600).stroke({ width: 1.5, color: 0x2a2d38, alpha: 0.8 });
      }
      for (let j = 1; j < 10; j++) {
        const y = (j * j * 600) / 100;
        g.moveTo(-1200, y).lineTo(W + 1200, y).stroke({ width: 1.5, color: 0x2a2d38, alpha: 0.6 });
      }
      g.rect(-400, -4, W + 800, 4).fill({ color: 0x3a3e4c });
      c.addChild(g);
      this.bg.addChild(c);
      this.layers.push({ c, p: 1 });
    }
    this.fighterTint = hexNum(def?.fighterTint || '#ffffff');
    this.rimColor = def?.rim ? hexNum(def.rim.color) : null;
    this.rimAlpha = def?.rim?.alpha ?? 0.7;
    this.reflect = def?.reflect ?? 0;
    this.scenery.filters = this.quality === 'high' && def?.grade ? [gradeFilter(def.grade)] : null;
    this.rain = def?.rain || null;
    this.rainBack.removeChildren();
    this.rainFront.removeChildren();
    this.rainDrops = [];
    if (this.rain) {
      const r = rng(7);
      const n = this.rain.count ?? 300;
      for (let i = 0; i < n; i++) {
        const front = i % 4 === 0;
        const d = new PIXI.Sprite(this.tex.drop);
        d.tint = hexNum(this.rain.color || '#a9b8d0');
        d.alpha = front ? 0.5 : 0.25 + r() * 0.2;
        const len = (front ? 90 : 40 + r() * 30) * this.k;
        d.width = (front ? 2.2 : 1.3) * this.k;
        d.height = len;
        d.rotation = ((this.rain.angle ?? 10) * D2R);
        d.__x = r() * this.Wpx;
        d.__y = r() * this.Hpx;
        d.__v = (front ? 1.6 : 1) * (this.rain.speed ?? 1500) * this.k * (0.8 + r() * 0.4);
        (front ? this.rainFront : this.rainBack).addChild(d);
        this.rainDrops.push(d);
      }
    }
    this.ambient?.destroy();
    this.ambient = new Ambient(this, stage); // living effects of stage.json "ambient"
  }

  // ---------- fighters ----------

  setFighters(assets) {
    this.assets = assets;
    this.fighterLayer.removeChildren();
    this.shadows.removeChildren();
    this.rigs = [];
    this.rims = [];
    this.mirrors = [];
    this.reflections.removeChildren();
    this.ghosts = [[], []];
    this.shadowSprites = [];
    assets.forEach((a, side) => {
      for (let g = 0; g < 5; g++) {
        const ghost = new Rig(a, { tint: hexNum(a.def.card.colors.accent), ghost: true });
        this.fighterLayer.addChild(ghost.root);
        this.ghosts[side].push({ rig: ghost, life: 0 });
      }
    });
    const lit = this.quality === 'high';
    assets.forEach((a) => {
      // rim light: a copy in the stage's light colour behind the fighter, nudged back and up, shows on the edges
      if (lit && this.rimColor !== null) {
        const rim = new Rig(a, { tint: this.rimColor, ghost: true });
        rim.root.blendMode = 'add';
        this.fighterLayer.addChild(rim.root);
        this.rims.push(rim);
      } else this.rims.push(null);
      const rig = new Rig(a, { tint: this.fighterTint });
      this.fighterLayer.addChild(rig.root);
      this.rigs.push(rig);
      if (lit && this.reflect > 0) {
        const m = new Rig(a, { tint: this.fighterTint, ghost: true });
        m.root.filters = [new PIXI.BlurFilter({ strength: 3, quality: 2 })];
        this.reflections.addChild(m.root);
        this.mirrors.push(m);
      } else this.mirrors.push(null);
      const sh = new PIXI.Sprite(this.tex.shadow);
      sh.anchor.set(0.5);
      sh.width = 190;
      sh.height = 34;
      this.shadows.addChild(sh);
      this.shadowSprites.push(sh);
    });
    this.buildHud();
    this.abilityFx.setFighters(assets);
  }

  reset(fight) {
    this.fight = fight;
    this.hpShown = fight.f.map((F) => F.hp);
    this.hpLag = fight.f.map((F) => F.hp);
    this.comboShow = [null, null];
    const mid = (fight.f[0].x + fight.f[1].x) / 2;
    this.cam.x = mid;
    this.camSnap = true;
    this.superFx = null;
    this.koFx = null;
    for (const p of this.particles) p.sp.destroy();
    this.particles = [];
    this.projSprites = new Map();
    this.projLayer.removeChildren();
    this.abilityFx.reset(fight);
  }

  // ---------- events from the engine ----------

  moveFx(side, moveId) {
    return this.assets[side].def.movesById[moveId]?.fx || [];
  }

  handle(events, fight) {
    this.abilityFx.handle(events, fight);
    for (const e of events) {
      switch (e.type) {
        case 'hit': {
          const A = e.attacker;
          const accent = hexNum(this.assets[A].def.card.colors.accent);
          const big = e.heavy || e.counter || e.super || e.launch;
          this.burst(e.x, e.y, { count: big ? 34 : 18, color: 0xfff1c9, color2: accent, speed: big ? 1500 : 1000, size: big ? 1.4 : 1, seed: fight.tick * 3 + A });
          this.ring(e.x, e.y, { color: accent, size: big ? 1.6 : 1, life: 0.28 });
          this.cam.shake = Math.max(this.cam.shake, big ? 22 : 10);
          this.cam.punch = Math.max(this.cam.punch, big ? 0.05 : 0.02);
          // a string of hits pushes in more with every hit: the camera leans into a combo
          const V = fight.f[1 - A];
          this.pushCam(e.x, e.y, (big ? 0.2 : 0.08) + Math.min(0.18, Math.max(0, (V?.combo || 0) - 1) * 0.05));
          if (e.super || e.counter) this.flashScreen(0xffffff, e.super ? 0.25 : 0.18);
          for (const fx of this.moveFx(A, e.move)) if (fx.on === 'hit') this.spawnFx(fx, A, fight, { x: e.x, y: e.y });
          if (e.counter) this.popup(A, 'КОНТРУДАР', 0xffd24a);
          if (e.combo >= 2) this.comboShow[A] = { n: e.combo, t: 1.6 };
          break;
        }
        case 'block':
          this.burst(e.x, e.y, { count: 10, color: 0xbfe3ff, color2: 0x5aa9ff, speed: 700, size: 0.8, seed: fight.tick * 5 });
          this.ring(e.x, e.y, { color: 0x8cc8ff, size: 0.8, life: 0.2 });
          this.cam.shake = Math.max(this.cam.shake, 5);
          for (const fx of this.moveFx(e.attacker, e.move)) if (fx.on === 'block') this.spawnFx(fx, e.attacker, fight, { x: e.x, y: e.y });
          break;
        case 'parry':
          this.flashScreen(0xffffff, 0.35);
          this.ring(e.x, e.y, { color: 0xffffff, size: 2.2, life: 0.4 });
          this.burst(e.x, e.y, { count: 24, color: 0xffffff, color2: 0x9fe8ff, speed: 1200, size: 1, seed: fight.tick });
          this.popup(e.side, 'ПАРИРОВАНИЕ', 0x9fe8ff);
          break;
        case 'armor':
          this.burst(e.x, e.y, { count: 14, color: 0xffd9a0, color2: 0xff8a3d, speed: 800, size: 0.9, seed: fight.tick });
          this.popup(e.side, 'БРОНЯ', 0xffb15a);
          break;
        case 'throw':
          this.cam.shake = 26;
          this.burst(e.x, e.y, { count: 20, color: 0xffffff, color2: 0xcccccc, speed: 900, size: 1, seed: fight.tick });
          this.popup(e.side, 'БРОСОК', 0xffffff);
          break;
        case 'tech':
          this.ring(e.x, 170, { color: 0xffffff, size: 1.4, life: 0.3 });
          this.popup(0, 'УХОД ОТ БРОСКА', 0xdddddd, true);
          break;
        case 'wall':
          this.cam.shake = 30;
          this.burst(e.x, e.y, { count: 26, color: 0xd9d9d9, color2: 0x8a8a8a, speed: 1000, size: 1.2, seed: fight.tick });
          break;
        case 'knockdown':
          this.cam.shake = Math.max(this.cam.shake, 12);
          this.burst(e.x, 10, { count: 16, color: 0xaaaaaa, color2: 0x666666, speed: 500, size: 1.4, seed: fight.tick, up: true });
          break;
        case 'dizzy':
          this.popup(e.side, 'ОГЛУШЁН', 0xfff07a);
          break;
        case 'comboLimit':
          break;
        case 'move':
          for (const fx of this.moveFx(e.side, e.move)) if (fx.on === 'start') this.spawnFx(fx, e.side, fight);
          break;
        case 'active':
        case 'teleport':
          for (const fx of this.moveFx(e.side, fight.f[e.side].move?.def.id || '')) if (fx.on === 'active') this.spawnFx(fx, e.side, fight);
          if (e.type === 'teleport') {
            const F = fight.f[e.side];
            this.burst(F.x, 150, { count: 30, color: hexNum(this.assets[e.side].def.card.colors.accent), color2: 0xffffff, speed: 700, size: 1, seed: fight.tick });
          }
          break;
        case 'projectile':
          this.makeProjectile(e, fight);
          break;
        case 'projectileEnd':
        case 'clash': {
          if (e.type === 'clash') {
            this.burst(e.x, e.y, { count: 30, color: 0xffffff, color2: 0xffd27a, speed: 1200, size: 1.2, seed: fight.tick });
            this.ring(e.x, e.y, { color: 0xffffff, size: 1.8, life: 0.3 });
          }
          if (e.id && this.projSprites.has(e.id)) {
            const p = this.projSprites.get(e.id);
            this.burst(p.c.x, -p.c.y, { count: 12, color: p.color, color2: 0xffffff, speed: 600, size: 0.8, seed: e.id });
            p.c.destroy({ children: true });
            this.projSprites.delete(e.id);
          }
          break;
        }
        case 'super': {
          const def = this.assets[e.side].def;
          const d = e.director || { title: def.movesById[e.move].name, titleColor: '#ffffff', zoom: 1.6, angle: 'close', flash: def.card.colors.accent, background: 'darken', backgroundColor: '#000000', slowmo: 0.5 };
          this.superFx = { side: e.side, d, t: 0, move: e.move };
          this.flashScreen(hexNum(d.flash), 0.7);
          this.showTitle(d.title || def.movesById[e.move].name, hexNum(d.titleColor), hexNum(def.card.colors.accent));
          for (const fx of this.moveFx(e.side, e.move)) if (fx.on === 'start') this.spawnFx(fx, e.side, fight);
          break;
        }
        case 'end':
          this.koFx = { t: 0, reason: e.reason, winner: e.winner };
          if (e.reason === 'ko') {
            this.flashScreen(0xffffff, 0.8);
            this.cam.shake = 34;
            this.banner(e.double ? 'ДВОЙНОЙ НОКАУТ' : 'НОКАУТ', 0xffffff, 0xd8252b);
          } else this.banner('ВРЕМЯ', 0xffffff, 0x3a6fd8);
          break;
        default:
          break;
      }
    }
  }

  // ---------- effects ----------

  addParticle(tex, x, y, o) {
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(tex === this.tex.streak ? 1 : 0.5, 0.5);
    sp.blendMode = 'add';
    sp.tint = o.color;
    sp.position.set(x, -y);
    this.fxLayer.addChild(sp);
    this.particles.push({ sp, vx: o.vx, vy: o.vy, life: o.life, max: o.life, size: o.size, grav: o.grav ?? 0, streak: tex === this.tex.streak, drag: o.drag ?? 2.5 });
  }

  burst(x, y, { count = 16, color = 0xffffff, color2 = 0xffffff, speed = 900, size = 1, seed = 1, up = false }) {
    if (this.calm) count = Math.ceil(count * 0.3);
    const r = rng(seed * 2654435761);
    for (let i = 0; i < count; i++) {
      const a = up ? Math.PI * (0.1 + 0.8 * r()) : r() * Math.PI * 2;
      const v = speed * (0.3 + r() * 0.7);
      this.addParticle(this.tex.streak, x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.18 + r() * 0.25, size: size * (0.5 + r() * 0.6), color: i % 3 ? color : color2, grav: -900 });
    }
    this.addParticle(this.tex.dot, x, y, { vx: 0, vy: 0, life: 0.1, size: size * 1.7, color: 0xffffff });
    this.addParticle(this.tex.dot, x, y, { vx: 0, vy: 0, life: 0.2, size: size * 1.3, color: color2 });
  }

  ring(x, y, { color = 0xffffff, size = 1, life = 0.3 }) {
    const g = new PIXI.Graphics();
    g.blendMode = 'add';
    g.position.set(x, -y);
    this.fxLayer.addChild(g);
    this.rings.push({ g, life, max: life, size, color });
  }

  flashScreen(color, a) {
    if (this.calm) return;
    this.flashColor = color;
    this.flashA = Math.max(this.flashA, a);
  }

  bonePos(side, bone, tip = true) {
    const F = this.fight.f[side];
    const solved = this.lastSolved?.[side];
    if (!solved) return { x: F.x, y: F.y + 150 };
    const j = solved[bone || 'torso'];
    const lx = tip ? j.tipX : j.x;
    const ly = tip ? j.tipY : j.y;
    return { x: F.x + F.facing * lx, y: F.y + ly };
  }

  spawnFx(fx, side, fight, at = null) {
    const color = hexNum(fx.color);
    const color2 = hexNum(fx.color2 || fx.color);
    const size = fx.size ?? 1;
    const dur = (fx.duration ?? 20) / TICK_RATE;
    const pos = at || this.bonePos(side, fx.bone || 'hand_front');
    switch (fx.type) {
      case 'sparks':
        this.burst(pos.x, pos.y, { count: fx.count ?? 20, color, color2, speed: 1100 * size, size, seed: fight.tick * 13 + side });
        break;
      case 'ring':
        this.ring(pos.x, pos.y, { color, size: size * 1.5, life: dur });
        break;
      case 'flash':
        this.flashScreen(color, clamp(0.3 * size, 0.1, 0.9));
        break;
      case 'shockwave': {
        if (!this.calm) this.shockwaves.push({ x: pos.x, y: pos.y, t: 0, max: Math.max(0.4, dur), size });
        break;
      }
      case 'trail':
      case 'particles':
      case 'glow':
      case 'afterimage':
        this.activeFx[side].push({ fx, color, color2, size, left: fx.duration ? dur : null, move: fight.f[side].move?.def.id, emitAcc: 0, seed: fight.tick });
        break;
      default:
        break;
    }
  }

  makeProjectile(e, fight) {
    const def = this.assets[e.side].def;
    const fxList = def.movesById[e.move]?.fx.filter((f) => f.on === 'projectile') || [];
    const look = fxList[0];
    const color = hexNum(look?.color || def.card.colors.accent);
    const c = new PIXI.Container();
    if (look?.image && this.assets[e.side].textures[look.image]) {
      const sp = new PIXI.Sprite(this.assets[e.side].textures[look.image]);
      sp.anchor.set(0.5);
      const s = (PROJECTILE.size * 2.2 * (look.size ?? 1)) / Math.max(sp.texture.width, sp.texture.height);
      sp.scale.set(s * fight.f[e.side].facing, s);
      c.addChild(sp);
    }
    const core = new PIXI.Sprite(this.tex.dot);
    core.anchor.set(0.5);
    core.blendMode = 'add';
    core.tint = 0xffffff;
    core.scale.set(1.4 * (look?.size ?? 1));
    const halo = new PIXI.Sprite(this.tex.dot);
    halo.anchor.set(0.5);
    halo.blendMode = 'add';
    halo.tint = color;
    halo.scale.set(3.4 * (look?.size ?? 1));
    c.addChildAt(halo, 0);
    c.addChild(core);
    this.projLayer.addChild(c);
    this.projSprites.set(e.id, { c, color, color2: hexNum(look?.color2 || '#ffffff'), fx: fxList, side: e.side });
  }

  // A word of the moment (КОНТРУДАР, ПАРИРОВАНИЕ, ОГЛУШЁН) over the fighter's head, one at a time per fighter:
  // a new one fades the old one out. It follows the fighter on screen and never goes under the HUD.
  popup(side, text, color, center = false) {
    const t = ringText({ text, style: { fontFamily: FONT, fontSize: 46 * this.k, fontWeight: '700', fontStyle: 'italic', fill: color, letterSpacing: 2 * this.k, stroke: { color: 0x000000, width: 6 * this.k }, dropShadow: { color: 0x000000, alpha: 0.6, blur: 6, distance: 0 } } });
    t.anchor.set(0.5, 1);
    for (const p of this.popups) if (p.word && p.side === side && !p.center) p.life = Math.min(p.life, 0.15);
    this.titles.addChild(t);
    t.alpha = 0;
    this.popups.push({ t, life: 1.1, max: 1.1, word: true, side, center });
  }

  banner(text, color, band, life = 3.2) {
    const c = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.rect(0, -70 * this.k, this.Wpx, 140 * this.k).fill({ color: band, alpha: 0.85 });
    g.rect(0, -76 * this.k, this.Wpx, 4 * this.k).fill({ color: 0xffffff, alpha: 0.8 });
    g.rect(0, 72 * this.k, this.Wpx, 4 * this.k).fill({ color: 0xffffff, alpha: 0.8 });
    const t = ringText({ text, style: { fontFamily: FONT, fontSize: (this.vertical ? 110 : 130) * this.k, fontWeight: '700', fontStyle: 'italic', fill: color, letterSpacing: 10 * this.k, stroke: { color: 0x000000, width: 8 * this.k } } });
    t.anchor.set(0.5);
    t.x = this.Wpx / 2;
    c.addChild(g, t);
    c.y = this.Hpx * 0.45;
    this.titles.addChild(c);
    this.popups.push({ t: c, life, max: life, banner: true });
  }

  showTitle(title, color, accent) {
    const c = new PIXI.Container();
    const g = new PIXI.Graphics();
    const h = 190 * this.k;
    g.rect(0, -h / 2, this.Wpx, h).fill({ color: 0x000000, alpha: 0.55 });
    g.rect(0, -h / 2, this.Wpx, 5 * this.k).fill({ color: accent });
    g.rect(0, h / 2 - 5 * this.k, this.Wpx, 5 * this.k).fill({ color: accent });
    const size = (this.vertical ? 96 : 150) * this.k * (title.length > 14 ? 14 / title.length : 1);
    const t = ringText({ text: title.toUpperCase(), style: { fontFamily: FONT, fontSize: size, fontWeight: '700', fontStyle: 'italic', fill: color, letterSpacing: 6 * this.k, stroke: { color: accent, width: 3 * this.k }, dropShadow: { color: accent, alpha: 0.9, blur: 18 * this.k, distance: 0 } } });
    t.anchor.set(0.5);
    t.x = this.Wpx / 2;
    c.addChild(g, t);
    c.y = this.Hpx * (this.vertical ? 0.3 : 0.24);
    this.titles.addChild(c);
    this.popups.push({ t: c, life: 1.4, max: 1.4, title: true, inner: t });
  }

  // ---------- HUD ----------

  buildHud() {
    this.hud.removeChildren();
    if (!this.hudOn) return;
    const k = this.k;
    const Wp = this.Wpx;
    const top = (this.vertical ? 70 : 40) * k;
    const barW = (this.vertical ? 440 : 760) * k;
    const barH = (this.vertical ? 34 : 38) * k;
    const gap = (this.vertical ? 100 : 130) * k;
    this.hudGeo = { top, barW, barH, gap };
    this.hudG = new PIXI.Graphics();
    this.hud.addChild(this.hudG);
    const mk = (text, size, fill, weight = '700', italic = false) => ringText({ text, style: { fontFamily: FONT, fontSize: size * k, fontWeight: weight, fontStyle: italic ? 'italic' : 'normal', fill, letterSpacing: 1.5 * k, stroke: { color: 0x000000, width: 4 * k } } });
    this.hudText = this.assets.map((a, side) => {
      const name = mk(a.def.card.name.toUpperCase(), this.vertical ? 34 : 40, 0xffffff, '700', true);
      const model = mk(this.names[side] || '', this.vertical ? 20 : 22, 0xb8bcc8, '500');
      const left = side === 0;
      const x0 = left ? Wp / 2 - gap / 2 - barW : Wp / 2 + gap / 2 + barW;
      name.anchor.set(left ? 0 : 1, 0);
      name.position.set(x0, top + barH + 12 * k);
      fitText(name, barW * 0.92); // a long name (up to 20 letters) shrinks to its bar instead of running off
      fitText(model, barW * 0.92);
      model.anchor.set(left ? 0 : 1, 0);
      model.position.set(x0, top + barH + 12 * k + (this.vertical ? 38 : 46) * k);
      const sup = mk('СУПЕР', 26, 0xffffff, '700', true);
      sup.anchor.set(left ? 0 : 1, 1);
      this.hud.addChild(name, model, sup);
      return { name, model, sup };
    });
    this.timerText = mk('99', this.vertical ? 56 : 64, 0xffffff);
    this.timerText.anchor.set(0.5);
    this.timerText.position.set(Wp / 2, top + barH / 2 + 4 * k);
    this.comboText = [0, 1].map((side) => {
      const t = mk('', 64, 0xffffff, '700', true);
      t.anchor.set(side === 0 ? 0 : 1, 0.5);
      t.position.set(side === 0 ? 50 * k : Wp - 50 * k, this.Hpx * (this.vertical ? 0.22 : 0.3));
      this.hud.addChild(t);
      return t;
    });
    this.hud.addChild(this.timerText);
    this.roundText = mk('', this.vertical ? 22 : 24, 0xf3c64d, '700', true);
    this.roundText.anchor.set(0.5, 0);
    this.roundText.position.set(Wp / 2, top + barH + 14 * k);
    this.hud.addChild(this.roundText);
  }

  drawHud(fight, dt) {
    if (!this.hudOn) return;
    const g = this.hudG;
    const { top, barW, barH, gap } = this.hudGeo;
    const k = this.k;
    const Wp = this.Wpx;
    g.clear();
    fight.f.forEach((F, side) => {
      const left = side === 0;
      this.hpShown[side] = F.hp;
      this.hpLag[side] = this.hpLag[side] > F.hp ? Math.max(F.hp, this.hpLag[side] - F.maxHp * 0.35 * dt) : F.hp;
      const x0 = left ? Wp / 2 - gap / 2 - barW : Wp / 2 + gap / 2;
      const frac = F.hp / F.maxHp;
      const lag = this.hpLag[side] / F.maxHp;
      const slant = 18 * k;
      // frame
      const poly = (x, y, w, h, s, l) => (l ? [x + s, y, x + w, y, x + w, y + h, x, y + h] : [x, y, x + w - s, y, x + w, y + h, x, y + h]);
      g.poly(poly(x0 - 6 * k, top - 6 * k, barW + 12 * k, barH + 12 * k, slant, left)).fill({ color: 0x000000, alpha: 0.7 });
      g.poly(poly(x0, top, barW, barH, slant, left)).fill({ color: 0x24262e });
      const fill = (f, color, alpha = 1) => {
        if (f <= 0) return;
        const w = barW * f;
        const x = left ? x0 + barW - w : x0;
        g.poly(poly(x, top, w, barH, Math.min(slant, w), left)).fill({ color, alpha });
      };
      fill(lag, 0xd23a2a);
      fill(frac, frac > 0.3 ? 0xf3c64d : 0xff7a33);
      fill(frac, 0xffffff, 0.12);
      g.rect(left ? x0 + barW - barW * frac : x0, top, barW * frac, barH * 0.35).fill({ color: 0xffffff, alpha: 0.18 });
      // stun
      const sw = barW * 0.55;
      const sx = left ? x0 + barW - sw : x0;
      const sy = top + barH + 4 * k;
      g.rect(sx, sy, sw, 5 * k).fill({ color: 0x000000, alpha: 0.6 });
      const sf = Math.min(1, F.stun / STUN_MAX);
      g.rect(left ? sx + sw - sw * sf : sx, sy, sw * sf, 5 * k).fill({ color: F.state === 'dizzy' ? 0xfff07a : 0xb0b6c8 });
      // meter
      const mw = (this.vertical ? 300 : 420) * k;
      const mh = 18 * k;
      const my = this.Hpx - (this.vertical ? 150 : 60) * k;
      const mx = left ? 60 * k : Wp - 60 * k - mw;
      const accent = hexNum(this.assets[side].def.card.colors.accent);
      g.rect(mx - 4 * k, my - 4 * k, mw + 8 * k, mh + 8 * k).fill({ color: 0x000000, alpha: 0.7 });
      const bars = METER_MAX / METER_BAR;
      const seg = (mw - (bars - 1) * 6 * k) / bars;
      for (let b = 0; b < bars; b++) {
        const bx = left ? mx + b * (seg + 6 * k) : mx + mw - (b + 1) * seg - b * 6 * k;
        g.rect(bx, my, seg, mh).fill({ color: 0x24262e });
        const part = clamp((F.meter - b * METER_BAR) / METER_BAR, 0, 1);
        if (part > 0) g.rect(left ? bx : bx + seg * (1 - part), my, seg * part, mh).fill({ color: part >= 1 ? accent : 0x6d7385 });
      }
      const full = F.meter >= METER_MAX;
      const sup = this.hudText[side].sup;
      sup.visible = full;
      sup.alpha = 0.6 + 0.4 * Math.sin(this.time * 8);
      sup.position.set(left ? mx : mx + mw, my - 8 * k);
      if (full) g.rect(mx - 4 * k, my - 4 * k, mw + 8 * k, mh + 8 * k).stroke({ width: 2 * k, color: accent, alpha: 0.5 + 0.5 * Math.sin(this.time * 8) });
      // combo counter
      const cs = this.comboShow[side];
      const ct = this.comboText[side];
      if (cs && cs.t > 0) {
        cs.t -= dt;
        ct.text = `${cs.n} ${cs.n < 5 ? 'УДАРА' : 'УДАРОВ'}`;
        ct.alpha = clamp(cs.t * 2, 0, 1);
        ct.scale.set(1 + Math.max(0, cs.t - 1.4) * 2);
        ct.style.fill = hexNum(this.assets[side].def.card.colors.accent);
      } else ct.alpha = 0;
    });
    g.rect(Wp / 2 - gap / 2 + 12 * k, top - 8 * k, gap - 24 * k, barH + 16 * k).fill({ color: 0x000000, alpha: 0.75 });
    this.timerText.text = String(Math.max(0, Math.ceil(fight.timer / TICK_RATE)));
    // match score: one pip per round won, next to the timer
    const mi = this.matchInfo;
    this.roundText.text = mi ? `РАУНД ${mi.round}${mi.rerun ? ' · ПЕРЕИГРОВКА' : ''}` : '';
    if (mi) {
      for (let side = 0; side < 2; side++) {
        const accent = hexNum(this.assets[side].def.card.colors.accent);
        for (let i = 0; i < mi.firstTo; i++) {
          const x = side === 0 ? Wp / 2 - gap / 2 - (18 + i * 30) * k : Wp / 2 + gap / 2 + (18 + i * 30) * k;
          const y = top + barH + (this.vertical ? 62 : 70) * k;
          g.circle(x, y, 10 * k).fill({ color: i < mi.wins[side] ? accent : 0x24262e }).stroke({ width: 2 * k, color: 0xffffff, alpha: 0.6 });
        }
      }
    }
  }

  // ---------- camera ----------

  // Push the camera in towards a point (a landed hit); it eases back out on its own.
  pushCam(x, y, amount) {
    const c = this.cam;
    if (amount >= c.push) {
      c.focusX = x;
      c.focusY = y;
    }
    c.push = Math.max(c.push, amount);
  }

  // The box of the live ability objects in world units (with their picture's margin), or null when there are none.
  objectsBox(fight) {
    let box = null;
    for (const o of fight.objects || []) {
      if (o.dead) continue;
      const r = Math.max(o.w, o.h) * 0.65 + 40; // the picture is drawn 1.3 × the longest side (abilityfx.js)
      if (!box) box = { left: o.x - r, right: o.x + r, top: o.y + r };
      else {
        box.left = Math.min(box.left, o.x - r);
        box.right = Math.max(box.right, o.x + r);
        box.top = Math.max(box.top, o.y + r);
      }
    }
    return box;
  }

  // Zoom follows the distance between the fighters: close in when they meet, wide when they split up.
  // Both always stay in frame (9:16 too); a landed hit pushes in for a moment.
  updateCamera(fight, dt) {
    const [a, b] = fight.f;
    const dist = Math.abs(a.x - b.x);
    const c = this.cam;
    if (this.camFixed) {
      c.x = this.camFixed.x;
      c.y = this.camFixed.y;
      c.zoom = this.camFixed.zoom * this.k;
      c.rot = this.camFixed.rot || 0;
      c.shake *= Math.exp(-dt * 9);
      c.punch *= Math.exp(-dt * 10);
      return;
    }
    let zoom;
    let x = (a.x + b.x) / 2;
    // close: the fighters fill about two thirds of the frame's height; wide only as far as both must stay in
    if (this.vertical) zoom = clamp(1080 / (dist + 240), 0.5, 1.6);
    else zoom = clamp(1920 / (dist + 380), 0.85, 2.25);
    const fit = zoom;
    const push = c.push * clamp(fit / zoom, 0, 1);
    zoom *= 1 + push;
    // keep both fighters inside the frame while pushed in
    const halfFit = (this.vertical ? 1080 : 1920) / 2 / zoom;
    const need = dist / 2 + (this.vertical ? 110 : 150);
    if (need > halfFit) zoom *= halfFit / need;
    x += clamp(c.focusX - x, -halfFit, halfFit) * Math.min(0.5, push * 2.2);
    // the objects of abilities stay in frame too (a piece hanging over the opponent, an orb flying across)
    const objs = this.objectsBox(fight);
    if (objs) {
      const half = (this.vertical ? 1080 : 1920) / 2;
      const reach = Math.max(Math.abs(objs.left - x), Math.abs(objs.right - x));
      if (reach * zoom > half) zoom = Math.max(this.vertical ? 0.45 : 0.6, half / reach);
    }
    zoom *= this.k;
    const groundFrac = this.vertical ? 0.7 : 0.9;
    const lift = Math.max(0, Math.max(a.y, b.y) - 90) * 0.55;
    if (objs && objs.top > lift) zoom = Math.max((this.vertical ? 0.45 : 0.6) * this.k, Math.min(zoom, (groundFrac * this.Hpx) / (objs.top - lift)));
    let y = ((groundFrac - 0.5) * this.Hpx) / zoom + lift;
    let rot = 0;
    if (this.camMode === 'replay') {
      const loser = fight.f.find((F) => F.hp <= 0) || fight.f[fight.winner === 0 ? 1 : 0];
      zoom *= this.vertical ? 1.15 : 1.3;
      x = lerp(x, loser.x, 0.3);
      y = ((0.62 - 0.5) * this.Hpx) / zoom + 40;
      rot = -3.5 * D2R * (loser.x > x ? 1 : -1);
    }
    const sfx = this.superFx;
    if (sfx) {
      const F = fight.f[sfx.side];
      const d = sfx.d;
      const k = clamp(sfx.t / 0.25, 0, 1) * (sfx.out ? clamp(1 - sfx.outT / 0.4, 0, 1) : 1);
      const mul = { close: 1.1, wide: 0.8, low: 1, high: 1, dutch: 1.05 }[d.angle] ?? 1;
      const zt = (zoom / (1 + push)) * Math.max(1, d.zoom * mul * (this.vertical ? 1 : 0.85));
      const yt = d.angle === 'close' ? 175 : d.angle === 'low' ? 90 : d.angle === 'high' ? 240 : y - F.y;
      let yc = F.y + yt;
      let zs = zt;
      // a super's object above the fighters (a piece over the opponent): the close-up rises and widens to keep it
      // in frame together with the fighters' feet
      if (objs && objs.top > yc + this.Hpx / 2 / zs) {
        const feet = F.y - 40;
        const span = objs.top - feet;
        if (span * zs > this.Hpx) zs = this.Hpx / span;
        yc = objs.top - this.Hpx / 2 / zs;
      }
      zoom = lerp(zoom, zs, k);
      x = lerp(x, F.x + F.facing * 60, k);
      y = lerp(y, yc, k);
      rot = d.angle === 'dutch' ? lerp(0, F.facing * 7 * D2R, k) : d.angle === 'low' ? lerp(0, -F.facing * 2 * D2R, k) : 0;
    }
    if (this.koFx && this.koFx.t < 1.4 && this.koFx.reason === 'ko') {
      const loser = fight.f.find((F) => F.hp <= 0) || fight.f[0];
      const k = Math.sin(clamp(this.koFx.t / 1.4, 0, 1) * Math.PI);
      zoom *= 1 + 0.12 * k;
      x = lerp(x, loser.x, 0.35 * k);
    }
    zoom = Math.min(zoom, (this.vertical ? 2.1 : 2.6) * this.k);
    const s = this.camSnap ? 1 : 1 - Math.exp(-dt * (sfx ? 14 : 5));
    const sz = this.camSnap ? 1 : 1 - Math.exp(-dt * (sfx ? 14 : c.push > 0.04 ? 9 : 3.2));
    this.camSnap = false;
    c.zoom = lerp(c.zoom, zoom, sz);
    c.x = lerp(c.x, x, s);
    c.y = lerp(c.y, y, s);
    c.rot = lerp(c.rot, rot, s);
    const halfW = this.Wpx / 2 / c.zoom;
    c.x = clamp(c.x, -60 + halfW, W + 60 - halfW);
    if (halfW * 2 > W + 120) c.x = W / 2;
    c.shake *= Math.exp(-dt * 9);
    c.punch *= Math.exp(-dt * 10);
    c.push *= Math.exp(-dt * 2.6);
  }

  // ---------- frame ----------

  draw(fight, dt, sub = 0) {
    this.fight = fight;
    this.time += dt;
    this.updateCamera(fight, dt);
    const c = this.cam;
    const r = rng(Math.floor(this.time * 60) + 11);
    const sx = (r() - 0.5) * 2 * c.shake * this.k;
    const sy = (r() - 0.5) * 2 * c.shake * this.k;
    const zoom = c.zoom * (1 + c.punch);
    this.world.scale.set(zoom);
    this.world.rotation = c.rot;
    const cx = this.Wpx / 2 + sx;
    const cy = this.Hpx / 2 + sy;
    // rotate around the screen centre
    const cos = Math.cos(c.rot);
    const sin = Math.sin(c.rot);
    const px = -c.x * zoom;
    const py = c.y * zoom;
    this.world.position.set(cx + px * cos - py * sin, cy + px * sin + py * cos);
    const zRef = (this.vertical ? 1.5 : 1.35) * this.k;
    for (const l of this.layers) {
      const zp = zRef + (zoom - zRef) * l.p;
      l.c.scale.set(zp);
      l.c.x = cx + (-(W / 2) - (c.x - W / 2) * l.p) * zp;
      l.c.y = cy + c.y * l.p * zp;
      l.c.rotation = c.rot * l.p;
    }
    this.ambient.update(dt, { cx, cy, zoom, zRef });

    // super: darken the world behind the fighters
    this.darken.clear();
    if (this.superFx) {
      const s = this.superFx;
      s.t += dt;
      if (s.out) s.outT += dt;
      const k = clamp(s.t / 0.2, 0, 1) * (s.out ? clamp(1 - s.outT / 0.4, 0, 1) : 1);
      if (s.d.background !== 'none') this.darken.rect(0, 0, this.Wpx, this.Hpx).fill({ color: s.d.background === 'color' ? hexNum(s.d.backgroundColor) : 0x000000, alpha: 0.72 * k });
      const F = fight.f[s.side];
      if (!s.out && fight.freeze === 0 && !(F.state === 'move' && F.move?.def.id === s.move)) {
        s.out = true;
        s.outT = 0;
      }
      if (s.out && s.outT > 0.4) this.superFx = null;
    }
    if (this.koFx) this.koFx.t += dt;

    // fighters
    this.lastSolved = [];
    fight.f.forEach((F, side) => {
      const rig = this.rigs[side];
      const { pose, charging } = poseFor(F, fight, sub);
      // feet on the floor only while standing on it; springs step with the frame
      rig.grounded = F.y <= 0.5 && !['air', 'juggle', 'prejump', 'thrown', 'grabbed', 'knockdown', 'ko'].includes(F.state);
      rig.dt = dt;
      // effects bound to a bone follow its picture
      this.lastSolved[side] = rig.apply(solvePose(pose));
      let jitter = 0;
      if (charging) jitter = (Math.sin(this.time * 90) * 2.5);
      const ip = this.interp?.[side];
      const X = ip ? lerp(ip[0], F.x, sub) : F.x;
      const Y = ip ? lerp(ip[1], F.y, sub) : F.y;
      rig.root.position.set(X + jitter, -Y);
      rig.root.scale.set(F.facing, 1);
      const hidden = F.state === 'move' && F.move.def.segments.some((s) => s.type === 'teleport' && F.move.t >= s.activeStart - 6 && F.move.t < s.activeStart);
      rig.root.alpha = hidden ? 0.15 : F.invuln > 0 && Math.floor(this.time * 20) % 2 ? 0.55 : 1;
      const rim = this.rims[side];
      if (rim) {
        rim.copyFrom(rig);
        rim.root.position.set(rig.root.x - F.facing * 2.6, rig.root.y - 2.2);
        rim.root.alpha = rig.root.alpha * this.rimAlpha;
      }
      const mirror = this.mirrors[side];
      if (mirror) {
        mirror.copyFrom(rig);
        mirror.root.position.set(rig.root.x, Y);
        mirror.root.scale.set(F.facing, -1);
        mirror.root.alpha = rig.root.alpha * this.reflect * clamp(1 - Y / 260, 0, 1);
      }
      const sh = this.shadowSprites[side];
      sh.position.set(X, 6);
      const lift = clamp(1 - Y / 400, 0.3, 1);
      sh.scale.set((190 / 128) * lift, (34 / 32) * lift);
      sh.alpha = 0.8 * lift;
      // continuous fx bound to the current move
      const keep = [];
      let glowFx = null;
      let trailFx = [];
      for (const a of this.activeFx[side]) {
        const alive = a.left !== null ? (a.left -= dt) > 0 : F.state === 'move' && F.move?.def.id === a.move;
        if (!alive) continue;
        keep.push(a);
        if (a.fx.type === 'glow') glowFx = a;
        if (a.fx.type === 'trail') trailFx.push(a);
        if (a.fx.type === 'particles') {
          a.emitAcc += dt * (a.fx.count ?? 40);
          const rr = rng(a.seed++ * 977);
          while (a.emitAcc >= 1) {
            a.emitAcc--;
            const p = this.bonePos(side, a.fx.bone || 'hand_front');
            const ang = rr() * Math.PI * 2;
            const v = 120 + rr() * 200;
            this.addParticle(this.tex.dot, p.x, p.y, { vx: Math.cos(ang) * v, vy: Math.sin(ang) * v + 120, life: 0.35 + rr() * 0.35, size: a.size * (0.25 + rr() * 0.35), color: rr() > 0.5 ? a.color : a.color2, drag: 1.5 });
          }
        }
        if (a.fx.type === 'afterimage') {
          a.emitAcc += dt;
          if (a.emitAcc > 0.05) {
            a.emitAcc = 0;
            const ghost = this.ghosts[side].reduce((m, g) => (g.life < m.life ? g : m));
            ghost.rig.copyFrom(rig);
            ghost.life = 0.3;
            ghost.max = 0.3;
            for (const b of Object.values(ghost.rig.bones)) b.sprite.tint = a.color;
          }
        }
      }
      this.activeFx[side] = keep;
      if (glowFx) {
        if (!this.glow[side]) this.glow[side] = new GlowFilter({ distance: 16, outerStrength: 2.5 * glowFx.size, innerStrength: 0, color: glowFx.color, quality: 0.2 });
        this.glow[side].color = glowFx.color;
        this.glow[side].outerStrength = (2 + Math.sin(this.time * 20)) * glowFx.size;
        rig.root.filters = [this.glow[side]];
      } else rig.root.filters = null;
      // trails
      const tr = this.trails[side];
      for (const a of trailFx) {
        const p = this.bonePos(side, a.fx.bone || 'hand_front');
        let t = tr.find((x) => x.a === a);
        if (!t) {
          t = { a, pts: [], g: new PIXI.Graphics() };
          t.g.blendMode = 'add';
          this.fxLayer.addChild(t.g);
          tr.push(t);
        }
        t.pts.unshift({ x: p.x, y: p.y });
        if (t.pts.length > 12) t.pts.pop();
      }
      for (let i = tr.length - 1; i >= 0; i--) {
        const t = tr[i];
        if (!trailFx.includes(t.a)) {
          t.pts.pop();
          if (t.pts.length < 2) {
            t.g.destroy();
            tr.splice(i, 1);
            continue;
          }
        }
        t.g.clear();
        for (let j = 0; j < t.pts.length - 1; j++) {
          const k = 1 - j / t.pts.length;
          const w = 26 * t.a.size * k;
          t.g.moveTo(t.pts[j].x, -t.pts[j].y).lineTo(t.pts[j + 1].x, -t.pts[j + 1].y).stroke({ width: w, color: t.a.color, alpha: 0.75 * k, cap: 'round' });
          t.g.moveTo(t.pts[j].x, -t.pts[j].y).lineTo(t.pts[j + 1].x, -t.pts[j + 1].y).stroke({ width: w * 0.35, color: 0xffffff, alpha: 0.9 * k, cap: 'round' });
        }
      }
    });
    for (const list of this.ghosts) for (const g of list) {
      g.life = Math.max(0, g.life - dt);
      g.rig.root.alpha = g.max ? 0.45 * (g.life / g.max) : 0;
    }

    // projectiles
    for (const p of fight.projectiles) {
      const ps = this.projSprites.get(p.id);
      if (!ps) continue;
      ps.c.position.set(p.x, -p.y);
      ps.c.rotation = Math.sin(this.time * 30) * 0.05;
      const rr = rng(p.id * 31 + fight.tick);
      for (let i = 0; i < 2; i++) this.addParticle(this.tex.dot, p.x - Math.sign(p.vx) * 20, p.y + (rr() - 0.5) * 30, { vx: -p.vx * 20 * rr(), vy: (rr() - 0.5) * 120, life: 0.25, size: 0.5, color: rr() > 0.5 ? ps.color : ps.color2 });
    }

    // particles, rings
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sp.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      p.vx *= Math.exp(-dt * p.drag);
      p.vy = p.vy * Math.exp(-dt * p.drag) + p.grav * dt;
      p.sp.x += p.vx * dt;
      p.sp.y -= p.vy * dt;
      const k = p.life / p.max;
      p.sp.alpha = Math.min(1, k * 1.6);
      if (p.streak) {
        p.sp.rotation = Math.atan2(-p.vy, p.vx);
        const v = Math.hypot(p.vx, p.vy);
        p.sp.scale.set(clamp(v / 900, 0.15, 1.2) * p.size, 0.5 * p.size * (0.5 + k * 0.5));
      } else p.sp.scale.set(p.size * (0.6 + 0.4 * k));
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r2 = this.rings[i];
      r2.life -= dt;
      if (r2.life <= 0) {
        r2.g.destroy();
        this.rings.splice(i, 1);
        continue;
      }
      const k = 1 - r2.life / r2.max;
      r2.g.clear();
      r2.g.circle(0, 0, (14 + 78 * k) * r2.size).stroke({ width: 7 * (1 - k) * r2.size + 1, color: r2.color, alpha: 1 - k });
    }
    // shockwave filters on the world
    const sw = [];
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.t += dt;
      if (s.t > s.max) {
        this.shockwaves.splice(i, 1);
        continue;
      }
      if (!s.filter) s.filter = new ShockwaveFilter({ amplitude: 26 * s.size * this.k, wavelength: 140 * this.k, speed: 900 * this.k, brightness: 1.15, radius: -1 });
      const p = this.world.toGlobal({ x: s.x, y: -s.y });
      s.filter.center = { x: p.x, y: p.y };
      s.filter.time = s.t;
      sw.push(s.filter);
    }
    this.bg.filters = null;
    this.world.filters = sw.length ? sw : null;

    // rain
    if (this.rain) {
      for (const d of this.rainDrops) {
        d.__y += d.__v * dt;
        d.__x -= d.__v * dt * Math.tan((this.rain.angle ?? 10) * D2R);
        if (d.__y > this.Hpx + 60) {
          d.__y -= this.Hpx + 120;
          d.__x += this.Hpx * Math.tan((this.rain.angle ?? 10) * D2R);
        }
        if (d.__x < -40) d.__x += this.Wpx + 80;
        d.position.set(d.__x + sx * 0.3, d.__y);
      }
    }

    // flash
    this.flash.clear();
    if (this.flashA > 0.01) this.flash.rect(0, 0, this.Wpx, this.Hpx).fill({ color: this.flashColor, alpha: this.flashA });
    this.flashA *= Math.exp(-dt * 7);

    // popups
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.t.destroy({ children: true });
        this.popups.splice(i, 1);
        continue;
      }
      const age = p.max - p.life;
      if (p.banner) {
        p.t.alpha = clamp(p.life / 0.4, 0, 1);
        p.t.scale.set(1, clamp(age / 0.12, 0.05, 1));
        p.t.pivot.set(0, 0);
      } else if (p.title) {
        p.t.alpha = clamp(p.life / 0.3, 0, 1) * clamp(age / 0.08, 0, 1);
        p.inner.x = this.Wpx / 2 + (1 - clamp(age / 0.18, 0, 1)) * this.Wpx * 0.6 - age * 60 * this.k;
      } else {
        const F = this.fight?.f?.[p.side];
        const g = this.hudOn && this.hudGeo;
        const top = g ? g.top + g.barH + (this.vertical ? 150 : 160) * this.k : 60 * this.k;
        if (p.center || !F) p.t.position.set(this.Wpx / 2, this.Hpx * (this.vertical ? 0.33 : 0.36));
        else {
          const head = this.world.toGlobal({ x: F.x, y: -(F.y + (F.posture === 'crouch' ? 215 : 315)) });
          p.t.position.set(clamp(head.x, p.t.width / 2 + 20 * this.k, this.Wpx - p.t.width / 2 - 20 * this.k), Math.max(top, head.y) - age * 30 * this.k);
        }
        p.t.alpha = clamp(age / 0.1, 0, 1) * clamp(p.life / 0.3, 0, 1);
        p.t.scale.set(1 + Math.max(0, 0.12 - age) * 3);
      }
    }

    this.abilityFx.draw(fight, dt);
    this.drawHud(fight, dt);

    // debug boxes
    this.debugLayer.clear();
    if (this.debug) {
      const boxes = debugBoxes(fight);
      for (const b of boxes) {
        for (const h of b.hurt) this.debugLayer.rect(h[0], -h[3], h[2] - h[0], h[3] - h[1]).stroke({ width: 2, color: 0x4fc3ff, alpha: 0.9 });
        for (const h of b.hit) this.debugLayer.rect(h[0], -h[3], h[2] - h[0], h[3] - h[1]).fill({ color: 0xff3b3b, alpha: 0.35 }).stroke({ width: 2, color: 0xff3b3b });
      }
    }
  }
}
