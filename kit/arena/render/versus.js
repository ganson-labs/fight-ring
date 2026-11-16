// The VS presentation: the fight scene blurred behind, two diagonal halves in each fighter's colours with smoke,
// speed lines and embers, an energy seam between them, both fighters big with a rim light in their colour, the
// VS slammed in with a flash, a shock ring, sparks and a shake, names with the model that made each fighter,
// compact stats and the round plate. 16:9 puts the fighters left and right, 9:16 top and bottom.
// Everything is a function of the screen time, so recorded clips and the live viewer show the same frames.
import * as PIXI from 'pixi.js';
import { ringText, fitText } from './text.js';
import { solvePose, sampleAnim, STAT_KEYS, STAT_MAX } from '../engine/index.js';
import { Rig } from './scene.js';

const FONT = 'Oswald, "Arial Narrow", Impact, sans-serif';
const STAT_NAMES = { health: 'ЗДОРОВЬЕ', power: 'СИЛА', speed: 'СКОРОСТЬ', defense: 'ЗАЩИТА' };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const k01 = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const easeOut = (k) => 1 - (1 - clamp(k, 0, 1)) ** 3;
const easeBack = (k) => {
  k = clamp(k, 0, 1);
  const s = 1.4;
  return 1 + (s + 1) * (k - 1) ** 3 + s * (k - 1) ** 2;
};
const hexNum = (h) => parseInt(String(h || '#ffffff').slice(1), 16);
const rgb = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a, b, k) => {
  const A = rgb(a);
  const B = rgb(b);
  return (Math.round(A[0] + (B[0] - A[0]) * k) << 16) | (Math.round(A[1] + (B[1] - A[1]) * k) << 8) | Math.round(A[2] + (B[2] - A[2]) * k);
};
const css = (n, a = 1) => `rgba(${rgb(n).join(',')},${a})`;
// deterministic noise: the same screen time gives the same frame
const hash = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export const VS_DUR = 4;

// ---------- canvas textures ----------

function canvasTex(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  paint(c.getContext('2d'), c.width, c.height);
  return PIXI.Texture.from(c);
}

let shared = null;
function sharedTex() {
  if (shared) return shared;
  shared = {
    dot: canvasTex(128, 128, (g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.3, 'rgba(255,255,255,0.45)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }),
    streak: canvasTex(256, 8, (g, w, h) => {
      const r = g.createLinearGradient(0, 0, w, 0);
      r.addColorStop(0, 'rgba(255,255,255,0)');
      r.addColorStop(0.8, 'rgba(255,255,255,0.9)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }),
    // soft smoke: many overlapping blobs, tiled sideways
    smoke: canvasTex(512, 512, (g, w, h) => {
      for (let i = 0; i < 70; i++) {
        const x = hash(i) * w;
        const y = hash(i + 100) * h;
        const r = (0.08 + hash(i + 200) * 0.2) * w;
        for (const dx of [-w, 0, w]) {
          const gr = g.createRadialGradient(x + dx, y, 0, x + dx, y, r);
          const a = 0.05 + hash(i + 300) * 0.12;
          gr.addColorStop(0, `rgba(255,255,255,${a})`);
          gr.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = gr;
          g.fillRect(x + dx - r, y - r, r * 2, r * 2);
        }
      }
    }),
  };
  return shared;
}

// Heavy display lettering: blurred drop shadow, coloured glow, thick dark outline, a light rim (the bevel edge),
// a gradient fill and highlight/shade strips on the top-left and bottom-right edges.
export function slabText(text, size, { fill = ['#ffffff', '#cfd3dc'], stops = null, outline = 0.06, outlineColor = '#0a0a10', rim = null, rimWidth = 0.018, glow = null, glowBlur = 0.12, bevel = 0.022, shadow = 0.05, spacing = 0, italic = true } = {}) {
  const font = `${italic ? 'italic ' : ''}700 ${size}px ${FONT}`;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  probe.letterSpacing = `${spacing}px`;
  const m = probe.measureText(text);
  const ol = size * outline;
  const pad = ol + size * (glow ? glowBlur : 0) + size * shadow + size * 0.12;
  const tw = m.width + size * 0.25;
  const asc = size * 0.95;
  const W = tw + pad * 2;
  const H = asc + size * 0.25 + pad * 2;
  const x0 = pad + size * 0.06;
  const y0 = pad + asc;
  const setup = (g) => {
    g.font = font;
    g.letterSpacing = `${spacing}px`;
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.miterLimit = 2;
  };
  const tex = canvasTex(W, H, (g) => {
    setup(g);
    // the fill layer with its bevel strips
    const L = document.createElement('canvas');
    L.width = g.canvas.width;
    L.height = g.canvas.height;
    const l = L.getContext('2d');
    setup(l);
    const grad = l.createLinearGradient(0, y0 - asc, 0, y0 + size * 0.05);
    const st = stops || fill.map((c, i) => [i / Math.max(1, fill.length - 1), c]);
    for (const [o, c] of st) grad.addColorStop(o, c);
    l.fillStyle = grad;
    l.fillText(text, x0, y0);
    if (bevel) {
      const b = size * bevel;
      const strip = (dx, dy, color, alpha) => {
        const S = document.createElement('canvas');
        S.width = L.width;
        S.height = L.height;
        const s = S.getContext('2d');
        setup(s);
        s.fillStyle = color;
        s.fillText(text, x0, y0);
        s.globalCompositeOperation = 'destination-out';
        s.fillText(text, x0 + dx, y0 + dy);
        l.globalCompositeOperation = 'source-atop';
        l.globalAlpha = alpha;
        l.filter = `blur(${b * 0.35}px)`;
        l.drawImage(S, 0, 0);
        l.filter = 'none';
        l.globalAlpha = 1;
        l.globalCompositeOperation = 'source-over';
      };
      strip(b, b, '#ffffff', 0.8);
      strip(-b, -b, '#000000', 0.4);
    }
    if (shadow) {
      g.save();
      g.filter = `blur(${size * 0.03}px)`;
      g.fillStyle = 'rgba(0,0,0,0.75)';
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.lineWidth = ol * 2;
      const sx = x0 + size * shadow * 0.7;
      const sy = y0 + size * shadow;
      g.strokeText(text, sx, sy);
      g.fillText(text, sx, sy);
      g.restore();
    }
    if (glow) {
      g.save();
      g.shadowColor = glow;
      g.shadowBlur = size * glowBlur;
      g.strokeStyle = glow;
      g.lineWidth = ol * 2 + size * 0.02;
      g.strokeText(text, x0, y0);
      g.strokeText(text, x0, y0);
      g.restore();
    }
    g.strokeStyle = outlineColor;
    g.lineWidth = ol * 2;
    g.strokeText(text, x0, y0);
    if (rim) {
      g.strokeStyle = rim;
      g.lineWidth = size * rimWidth * 2;
      g.strokeText(text, x0, y0);
    }
    g.drawImage(L, 0, 0);
  });
  const sp = new PIXI.Sprite(tex);
  // the anchor sits on the text box, not on the padding: left/right/centre alignments land where expected
  sp.__box = { x0: x0 - size * 0.02, x1: x0 + m.width + size * 0.12, top: y0 - asc * 0.82, base: y0, W, H };
  return sp;
}

function anchorSlab(sp, ax, ay) {
  const b = sp.__box;
  const x = b.x0 + (b.x1 - b.x0) * ax;
  const y = b.top + (b.base - b.top) * ay;
  sp.anchor.set(x / b.W, y / b.H);
}

// ---------- the screen ----------

export function buildVersus(show, { dur = VS_DUR } = {}) {
  const { W, H, k, vertical } = show;
  const tex = sharedTex();
  const c = show.root;
  const scene = show.scene;
  const defs = show.assets.map((a) => a.def);
  const colors = defs.map((d) => ({ accent: hexNum(d.card.colors.accent), primary: hexNum(d.card.colors.primary) }));

  // the fight scene behind, blurred and darkened; its HUD and titles are hidden for the whole screen
  const back = new PIXI.Container();
  const backSharp = new PIXI.Sprite();
  const backBlur = new PIXI.Sprite();
  const dim = new PIXI.Graphics();
  back.addChild(backSharp, backBlur, dim);
  c.addChild(back);
  let snapped = false;
  const snap = () => {
    snapped = true;
    if (!scene) return;
    const r = show.app.renderer;
    const layers = scene.topLayers();
    for (const l of layers) l.__vsVis = l.visible;
    scene.hud.visible = false;
    scene.titles.visible = false;
    show.root.visible = false;
    const rt = PIXI.RenderTexture.create({ width: W, height: H });
    r.render({ container: show.app.stage, target: rt });
    show.root.visible = true;
    const blurred = PIXI.RenderTexture.create({ width: W, height: H });
    const bs = new PIXI.Sprite(rt);
    bs.filters = [new PIXI.BlurFilter({ strength: 22 * k, quality: 4 })];
    const holder = new PIXI.Container();
    holder.addChild(bs);
    r.render({ container: holder, target: blurred });
    bs.filters = null;
    holder.destroy();
    backSharp.texture = rt;
    backBlur.texture = blurred;
    show.ownTextures.push(rt, blurred);
    show.hideScene(layers);
  };

  // two halves: gradient, smoke, speed lines, embers and the fighter, each clipped to its side of the seam
  const D = vertical ? H * 0.035 : W * 0.075;
  const seam = (off = 0) => (vertical ? [[0 + off, H / 2 + D], [W + off, H / 2 - D]] : [[W / 2 + D + off, 0], [W / 2 - D + off, H]]);
  const poly = (side, off) => {
    if (vertical) return side === 0 ? [off, 0, W + off, 0, W + off, H / 2 - D, off, H / 2 + D] : [off, H / 2 + D, W + off, H / 2 - D, W + off, H, off, H];
    return side === 0 ? [off - W, 0, W / 2 + D + off, 0, W / 2 - D + off, H, off - W, H] : [W / 2 + D + off, 0, W * 2 + off, 0, W * 2 + off, H, W / 2 - D + off, H];
  };
  const halves = [0, 1].map((side) => {
    const col = colors[side];
    const g = new PIXI.Container();
    const mask = new PIXI.Graphics();
    // deep gradient: lit near the seam, almost black at the outer edge
    const hw = vertical ? W : W / 2 + D;
    const hh = vertical ? H / 2 + D : H;
    const grad = new PIXI.Sprite(canvasTex(hw / 2, hh / 2, (x, w, h) => {
      const inner = vertical ? (side === 0 ? [w * 0.5, h] : [w * 0.5, 0]) : side === 0 ? [w, h * 0.45] : [0, h * 0.45];
      const r = x.createRadialGradient(inner[0], inner[1], 0, inner[0], inner[1], Math.hypot(w, h) * 0.95);
      r.addColorStop(0, css(mix(col.primary, col.accent, 0.15)));
      r.addColorStop(0.35, css(mix(col.primary, 0x000000, 0.45)));
      r.addColorStop(0.75, css(mix(col.primary, 0x000000, 0.82)));
      r.addColorStop(1, css(mix(col.primary, 0x000000, 0.93)));
      x.fillStyle = r;
      x.fillRect(0, 0, w, h);
    }));
    grad.width = hw;
    grad.height = hh;
    grad.alpha = 0.9;
    const smoke = [0, 1, 2].map((i) => {
      const s = new PIXI.TilingSprite({ texture: tex.smoke, width: hw, height: hh });
      s.tileScale.set((1.4 + i * 0.6) * k);
      s.tint = i === 2 ? 0x000000 : mix(col.accent, 0xffffff, 0.1 * i);
      s.alpha = i === 2 ? 0.55 : 0.32 - i * 0.08;
      s.blendMode = i === 2 ? 'normal' : 'add';
      return s;
    });
    const lines = new PIXI.Container();
    const lineSprites = Array.from({ length: 34 }, (_, i) => {
      const s = new PIXI.Sprite(tex.streak);
      s.anchor.set(1, 0.5);
      s.tint = i % 3 === 0 ? 0xffffff : mix(col.accent, 0xffffff, 0.3);
      s.blendMode = 'add';
      lines.addChild(s);
      return s;
    });
    const light = new PIXI.Sprite(tex.dot);
    light.anchor.set(0.5);
    light.tint = col.accent;
    light.blendMode = 'add';
    const embers = new PIXI.Graphics();
    embers.blendMode = 'add';
    const shade = new PIXI.Sprite(canvasTex(8, 256, (x, w, h) => {
      const r = x.createLinearGradient(0, 0, 0, h);
      r.addColorStop(0, 'rgba(0,0,0,0)');
      r.addColorStop(1, 'rgba(0,0,0,0.9)');
      x.fillStyle = r;
      x.fillRect(0, 0, w, h);
    }));
    const fig = makeFigure(show, side, col);
    const inner = new PIXI.Container();
    inner.addChild(grad, ...smoke, light, lines, fig.root, embers, shade);
    g.addChild(inner, mask);
    inner.mask = mask;
    c.addChild(g);
    return { side, col, g, inner, mask, grad, smoke, lines, lineSprites, light, embers, shade, fig, hw, hh };
  });

  // the seam: lightning, its glow and sparks along it
  const fx = new PIXI.Container();
  const seamGlow = new PIXI.Graphics();
  seamGlow.filters = [new PIXI.BlurFilter({ strength: 14 * k, quality: 3 })];
  seamGlow.blendMode = 'add';
  const bolt = new PIXI.Graphics();
  bolt.blendMode = 'add';
  const sparks = new PIXI.Graphics();
  sparks.blendMode = 'add';
  fx.addChild(seamGlow, bolt, sparks);
  c.addChild(fx);

  // names, model plates, mottos and stats
  const cards = [0, 1].map((side) => makeCard(show, side, colors[side]));
  for (const cd of cards) c.addChild(cd.g);

  // the VS: two letters that slam together
  const vsSize = (vertical ? 250 : 290) * k;
  const vsStyle = {
    stops: [[0, '#fffdf2'], [0.32, '#ffe27a'], [0.5, '#ffb02a'], [0.53, '#d2440f'], [0.78, '#ff8a1e'], [1, '#ffd46a']],
    outline: 0.075,
    outlineColor: '#120607',
    rim: '#ffeec0',
    rimWidth: 0.014,
    glow: 'rgba(255,120,30,0.85)',
    glowBlur: 0.14,
    bevel: 0.024,
    shadow: 0.06,
  };
  const vsV = slabText('V', vsSize, vsStyle);
  const vsS = slabText('S', vsSize, vsStyle);
  anchorSlab(vsV, 1, 0.5);
  anchorSlab(vsS, 0, 0.5);
  const vs = new PIXI.Container();
  vs.addChild(vsV, vsS);
  const vsAt = vertical ? [W / 2, H / 2] : [W / 2, H * 0.44];
  vs.position.set(vsAt[0], vsAt[1]);
  const vsHalo = new PIXI.Sprite(tex.dot);
  vsHalo.anchor.set(0.5);
  vsHalo.blendMode = 'add';
  vsHalo.tint = 0xffa040;
  vsHalo.position.set(vsAt[0], vsAt[1]);
  const shock = new PIXI.Graphics();
  shock.blendMode = 'add';
  const flash = new PIXI.Graphics();
  c.addChild(vsHalo, shock, vs, flash);

  // the round plate
  const plate = makeRoundPlate(show);
  c.addChild(plate.g);

  const IMPACT = 0.78;
  const shake = { x: 0, y: 0 };
  const draw = (t) => {
    if (!snapped && t > 0) snap();
    // backdrop
    const bk = k01(t, 0, 0.3);
    backBlur.alpha = bk;
    dim.clear();
    dim.rect(0, 0, W, H).fill({ color: 0x03040a, alpha: 0.55 * bk });

    // shake after the impact
    const sk = t > IMPACT ? Math.max(0, 1 - (t - IMPACT) / 0.4) ** 2 : 0;
    shake.x = (hash(Math.floor(t * 60)) - 0.5) * 34 * k * sk;
    shake.y = (hash(Math.floor(t * 60) + 7) - 0.5) * 26 * k * sk;

    for (const h of halves) drawHalf(h, t);

    // seam
    const sa = k01(t, 0.5, 0.62);
    const [p0, p1] = seam();
    seamGlow.clear();
    bolt.clear();
    sparks.clear();
    if (sa > 0) {
      const strike = t < 0.62 ? 1 - k01(t, 0.5, 0.62) : 0;
      const flick = 0.75 + 0.25 * hash(Math.floor(t * 20) + 3);
      const nx = -(p1[1] - p0[1]);
      const ny = p1[0] - p0[0];
      const nl = Math.hypot(nx, ny);
      const [ux, uy] = [nx / nl, ny / nl];
      const pts = (seed, amp, n) => {
        const out = [];
        for (let i = 0; i <= n; i++) {
          const f = i / n;
          const j = i === 0 || i === n ? 0 : (hash(seed * 31 + i) - 0.5) * 2 * amp;
          out.push(p0[0] + (p1[0] - p0[0]) * f + ux * j, p0[1] + (p1[1] - p0[1]) * f + uy * j);
        }
        return out;
      };
      const seed = Math.floor(t * 15);
      const main = pts(seed, 16 * k, 22);
      // each side's glow sits on its own side of the seam
      for (const side of [0, 1]) {
        const s = side === 0 ? -1 : 1;
        const sh = 14 * k * s * (vertical ? -1 : 1);
        seamGlow.poly(main.map((v, i) => v + (i % 2 === 0 ? ux * sh : uy * sh)), false).stroke({ width: 44 * k, color: colors[side].accent, alpha: 0.7 * sa * flick });
      }
      seamGlow.poly(main, false).stroke({ width: (26 + 60 * strike) * k, color: 0xffffff, alpha: 0.55 * sa });
      bolt.poly(main, false).stroke({ width: (7 + 10 * strike) * k, color: 0xfff6e0, alpha: sa, join: 'round' });
      bolt.poly(main, false).stroke({ width: 2.5 * k, color: 0xffffff, alpha: sa, join: 'round' });
      // forks
      for (let b = 0; b < 4; b++) {
        const at = 2 + Math.floor(hash(seed * 7 + b) * 13);
        const x = main[at * 2];
        const y = main[at * 2 + 1];
        const side = hash(seed * 11 + b) > 0.5 ? 1 : -1;
        const len = (40 + hash(seed + b * 3) * 70) * k;
        const dx = (p1[0] - p0[0]) / Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const dy = (p1[1] - p0[1]) / Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const mx = x + ux * side * len * 0.5 + dx * len * 0.4 + (hash(seed + b * 13) - 0.5) * 20 * k;
        const my = y + uy * side * len * 0.5 + dy * len * 0.4;
        bolt.poly([x, y, mx, my, x + ux * side * len + dx * len * 0.7, y + uy * side * len + dy * len * 0.7], false).stroke({ width: 2.5 * k, color: 0xffffff, alpha: 0.8 * sa * flick, join: 'round' });
      }
      // sparks flying off the seam
      for (let i = 0; i < 46; i++) {
        const life = 0.55 + hash(i * 5) * 0.5;
        const born = 0.5 + hash(i * 3) * life;
        if (t < born) continue;
        const age = (t - born) % life;
        const f = hash(i * 9 + Math.floor((t - born) / life) * 17);
        const side = hash(i * 13 + Math.floor((t - born) / life)) > 0.5 ? 1 : -1;
        const sp = (160 + hash(i * 19) * 420) * k;
        const x = p0[0] + (p1[0] - p0[0]) * f + ux * side * sp * age;
        const y = p0[1] + (p1[1] - p0[1]) * f + uy * side * sp * age + 700 * k * age * age;
        const a = (1 - age / life) * sa;
        sparks.circle(x, y, (2 + hash(i) * 3) * k * (1 - age / life * 0.5)).fill({ color: i % 4 === 0 ? 0xffffff : colors[side > 0 === !vertical ? 1 : 0].accent, alpha: a });
      }
    }

    // VS letters fly in from opposite corners and collide
    const vk = k01(t, IMPACT - 0.16, IMPACT);
    const ve = vk * vk;
    vs.visible = vk > 0;
    const fly = (1 - ve) * (vertical ? W * 0.6 : W * 0.5);
    vsV.position.set(-fly, -fly * 0.35);
    vsS.position.set(fly, fly * 0.35);
    const settle = t > IMPACT ? 1 + 0.22 * Math.exp(-(t - IMPACT) * 14) * Math.cos((t - IMPACT) * 40) : 1.25 - 0.25 * ve;
    const breathe = 1 + 0.015 * Math.sin(Math.max(0, t - IMPACT) * 5);
    vs.scale.set(settle * breathe);
    vs.rotation = -0.06 + (1 - ve) * 0.2;
    vs.position.set(vsAt[0] + shake.x * 1.5, vsAt[1] + shake.y * 1.5);
    vs.alpha = clamp(vk * 3, 0, 1);
    vsHalo.visible = t > IMPACT - 0.05;
    vsHalo.width = vsHalo.height = (vertical ? 900 : 1000) * k * (1 + 0.6 * Math.exp(-(t - IMPACT) * 6));
    vsHalo.alpha = (0.35 + 0.08 * Math.sin(t * 9)) * clamp((t - IMPACT + 0.05) / 0.1, 0, 1);
    // impact: flash, shock ring, burst of sparks
    flash.clear();
    shock.clear();
    if (t > IMPACT) {
      const at = t - IMPACT;
      const fa = Math.max(0, 1 - at / 0.16);
      if (fa > 0) flash.rect(0, 0, W, H).fill({ color: 0xfff4dd, alpha: 0.6 * fa * fa });
      // one fast shock ring, thick and hot at first, gone in a third of a second
      if (at < 0.32) {
        const q = at / 0.32;
        const r = (80 + 1100 * easeOut(q)) * k;
        shock.circle(vsAt[0], vsAt[1], r).stroke({ width: (30 * (1 - q) + 2) * k, color: 0xfff0d0, alpha: 0.8 * (1 - q) ** 1.5 });
      }
      for (let i = 0; i < 60; i++) {
        const life = 0.35 + hash(i * 3 + 1) * 0.55;
        if (at > life) continue;
        const ang = hash(i * 7 + 2) * Math.PI * 2;
        const sp = (500 + hash(i * 11 + 4) * 1500) * k;
        const d = sp * at * (1 - at / life * 0.5);
        const x = vsAt[0] + Math.cos(ang) * d;
        const y = vsAt[1] + Math.sin(ang) * d + 500 * k * at * at;
        const len = (18 + 40 * (1 - at / life)) * k;
        shock.moveTo(x, y).lineTo(x - Math.cos(ang) * len, y - Math.sin(ang) * len).stroke({ width: 3 * k, color: i % 3 ? 0xffc060 : 0xffffff, alpha: 1 - at / life });
      }
    }

    for (const cd of cards) cd.draw(t);
    plate.draw(t);

    // the whole screen slowly pushes in, then fades into the round board
    const out = k01(t, dur - 0.35, dur);
    c.alpha = 1 - out;
    for (const o of [...halves.map((h) => h.g), fx, ...cards.map((cd) => cd.g)]) o.position.set(shake.x, shake.y);
  };

  function drawHalf(h, t) {
    const { side } = h;
    const start = side === 0 ? 0.04 : 0.14;
    const e = easeOut(k01(t, start, start + 0.42));
    const dir = side === 0 ? -1 : 1;
    const off = (1 - e) * W * 1.05 * dir;
    h.mask.clear();
    h.mask.poly(poly(side, off)).fill({ color: 0xffffff });
    // the gradient and smoke live in their half; vertically the top half starts at 0, the bottom half below the seam
    const ox = vertical ? off : side === 0 ? off : W / 2 - D + off;
    const oy = vertical ? (side === 0 ? 0 : H / 2 - D) : 0;
    h.grad.position.set(ox, oy);
    h.smoke.forEach((s, i) => {
      s.position.set(ox, oy);
      s.tilePosition.set((side === 0 ? 1 : -1) * t * (40 + i * 30) * k, -t * (25 + i * 12) * k);
    });
    // speed lines rushing towards the seam
    h.lineSprites.forEach((s, i) => {
      const speed = (1600 + hash(i * 5 + side) * 1800) * k;
      const len = (220 + hash(i * 7 + side) * 520) * k;
      const thick = (2 + hash(i * 11 + side) * 6) * k;
      const span = (vertical ? W : W * 0.6) + len;
      const p = ((t * speed + hash(i * 13 + side) * span) % span) - len * 0.5;
      const across = hash(i * 17 + side);
      if (vertical) {
        const y0 = side === 0 ? 0 : H / 2;
        s.position.set(side === 0 ? p : W - p, y0 + across * H * 0.5);
        s.rotation = side === 0 ? 0 : Math.PI;
      } else {
        s.position.set(side === 0 ? p : W - p, across * H);
        s.rotation = side === 0 ? 0 : Math.PI;
      }
      s.position.x += off;
      s.width = len;
      s.height = thick;
      s.alpha = (0.08 + hash(i * 19) * 0.14) * e;
    });
    // embers rising
    h.embers.clear();
    for (let i = 0; i < 36; i++) {
      const life = 1.6 + hash(i * 3 + side * 50) * 1.6;
      const ph = (t + hash(i * 5 + side * 50) * life) % life;
      const x0 = vertical ? hash(i * 7 + side * 50) * W : side === 0 ? hash(i * 7) * W * 0.55 : W * 0.45 + hash(i * 7 + 50) * W * 0.55;
      const yb = vertical ? (side === 0 ? H * 0.5 : H) : H;
      const span = vertical ? H * 0.55 : H;
      const x = x0 + Math.sin(ph * 2 + i) * 30 * k + off;
      const y = yb - (ph / life) * span * (0.7 + hash(i * 9) * 0.5);
      const a = Math.sin((ph / life) * Math.PI) * 0.8 * e;
      h.embers.circle(x, y, (1.5 + hash(i * 11) * 3) * k).fill({ color: mix(h.col.accent, 0xffffff, 0.35), alpha: a });
    }
    // fighter: slides in further than its half, with a little parallax, then drifts towards the seam
    const fe = easeBack(k01(t, start + 0.08, start + 0.6));
    const drift = Math.max(0, t - 0.7) * 10 * k;
    h.fig.place(t, (1 - fe) * W * 0.7 * dir + off * 0.2 - dir * drift, fe);
    h.light.position.set(h.fig.cx + off * 0.2, h.fig.cy);
    h.light.width = h.light.height = (vertical ? 1100 : 1300) * k;
    h.light.alpha = 0.5 * e;
    // the bottom shade under the name
    if (vertical) {
      const y1 = side === 0 ? H / 2 + D : H;
      h.shade.position.set(off, y1 - H * 0.22);
      h.shade.width = W;
      h.shade.height = H * 0.22;
    } else {
      h.shade.position.set(side === 0 ? off : W / 2 - D + off, H * 0.52);
      h.shade.width = W / 2 + D;
      h.shade.height = H * 0.48;
    }
  }

  return {
    dur,
    tick: draw,
    cues: [
      { at: 0.04, sound: 'vs-whoosh' },
      { at: 0.16, sound: 'whoosh-heavy' },
      { at: 0.25, line: 0 },
      { at: IMPACT - 0.02, sound: 'braam' },
      { at: IMPACT, sound: 'vs-impact' },
      { at: 2.15, line: 1 },
    ],
  };
}

// A fighter's own figure, big: the intro animation once (if it has one), then idle; a flat copy in the
// fighter's accent behind it, shifted to the outer edge, is the rim light, and a blurred one is the aura.
function makeFigure(show, side, col) {
  const { W, H, k, vertical } = show;
  const a = show.assets[side];
  const def = a.def;
  const root = new PIXI.Container();
  const shadeTint = mix(0xffffff, 0x8c90a8, 0.3);
  const main = new Rig(a, { tint: shadeTint });
  const rim = new Rig(a);
  const aura = new PIXI.Container();
  const auraRig = new Rig(a);
  aura.addChild(auraRig.root);
  const flat = () => {
    const f = new PIXI.ColorMatrixFilter();
    const [r, g, b] = rgb(mix(col.accent, 0xffffff, 0.25)).map((v) => v / 255);
    f.matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 1, 0];
    return f;
  };
  rim.root.filters = [flat(), new PIXI.BlurFilter({ strength: 3 * k, quality: 2 })];
  aura.filters = [flat(), new PIXI.BlurFilter({ strength: 28 * k, quality: 3 })];
  aura.alpha = 0.55;
  aura.blendMode = 'add';
  root.addChild(aura, rim.root, main.root);
  const idle = def.anims.idle;
  const intro = def.anims.intro || null;
  const introLen = intro ? intro.length || intro.keys[intro.keys.length - 1].t : 0;
  const pose = (tick) => solvePose(intro && tick >= 0 && tick < introLen ? sampleAnim(intro, tick) : sampleAnim(idle, Math.max(0, tick - introLen)));
  // size from the idle pose: head near the top, the frame cuts around the knees
  main.apply(pose(-1));
  const b = main.root.getLocalBounds();
  const bodyH = b.height || 300;
  const fullH = vertical ? H * 0.47 / 0.74 : H * 0.88 / 0.74;
  const s = fullH / bodyH;
  const flip = vertical ? (side === 0 ? -1 : 1) : side === 0 ? 1 : -1;
  const cxLocal = (b.x + b.width / 2) * flip * s;
  const topY = vertical ? (side === 0 ? H * 0.095 : H * 0.53) : H * 0.11;
  const baseX = vertical ? (side === 0 ? W * 0.64 : W * 0.36) : side === 0 ? W * 0.235 : W * 0.765;
  for (const r of [main, rim, auraRig]) r.root.scale.set(s * flip, s);
  const rimOff = [-(side === 0 ? 1 : -1) * 9 * k * (vertical ? -1 : 1), -6 * k];
  const fig = {
    root,
    cx: baseX,
    cy: topY + fullH * 0.4,
    place(t, dx, e) {
      const start = side === 0 ? 0.5 : 0.62;
      const tick = (t - start) * 60;
      const solved = pose(tick);
      main.apply(solved);
      rim.apply(solved);
      auraRig.apply(solved);
      const x = baseX - cxLocal + dx;
      const y = topY - b.y * s;
      main.root.position.set(x, y);
      rim.root.position.set(x + rimOff[0], y + rimOff[1]);
      auraRig.root.position.set(x, y);
      root.alpha = clamp(e * 3, 0, 1);
      fig.cx = baseX + dx;
    },
  };
  return fig;
}

// Name card: the model that made the fighter on a plate, the name in heavy lettering, the motto, the stats.
function makeCard(show, side, col) {
  const { W, H, k, vertical } = show;
  const def = show.assets[side].def;
  const g = new PIXI.Container();
  const right = vertical ? side === 1 : side === 1;
  const ax = right ? 1 : 0;
  const nameSize = (vertical ? 104 : 118) * k;
  const name = slabText(def.card.name.toUpperCase(), nameSize, {
    stops: [[0, '#ffffff'], [0.55, '#f1f2f6'], [0.58, '#c9ccd8'], [1, '#ffffff']],
    outline: 0.085,
    rim: css(mix(col.accent, 0xffffff, 0.2)),
    rimWidth: 0.012,
    glow: css(col.accent, 0.55),
    glowBlur: 0.1,
    bevel: 0.018,
    shadow: 0.05,
  });
  anchorSlab(name, ax, 1);
  const maxW = (vertical ? 0.9 : 0.46) * W;
  const nw = name.__box.x1 - name.__box.x0;
  if (nw > maxW) name.scale.set(maxW / nw);
  const modelText = ringText({ text: (show.names[side] || '').toUpperCase(), style: { fontFamily: FONT, fontSize: 30 * k, fontWeight: '700', fill: 0x0b0c12, letterSpacing: 3 * k } });
  const plate = new PIXI.Graphics();
  const motto = ringText({ text: def.card.motto, style: { fontFamily: FONT, fontSize: (vertical ? 32 : 30) * k, fontWeight: '500', fontStyle: 'italic', fill: 0xe7e9f0, stroke: { color: 0x000000, width: 5 * k }, dropShadow: { color: 0x000000, alpha: 0.7, blur: 4 * k, distance: 3 * k, angle: Math.PI / 2 }, wordWrap: true, wordWrapWidth: maxW, align: right ? 'right' : 'left' } });
  motto.anchor.set(ax, 0);
  const stats = new PIXI.Graphics();
  const labels = STAT_KEYS.map((key) => ringText({ text: STAT_NAMES[key], style: { fontFamily: FONT, fontSize: 23 * k, fontWeight: '500', fill: 0xdfe2ea, letterSpacing: 2.5 * k, stroke: { color: 0x000000, width: 4 * k } } }));
  const nums = STAT_KEYS.map((key) => ringText({ text: String(def.stats[key]), style: { fontFamily: FONT, fontSize: 30 * k, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 5 * k } } }));
  g.addChild(name, plate, modelText, motto, stats, ...labels, ...nums);

  // geometry: the block sits at the bottom of the fighter's half (16:9) or by the seam / bottom edge (9:16)
  const x = right ? W * (vertical ? 0.95 : 0.965) : W * (vertical ? 0.05 : 0.035);
  const statsH = 2 * 40 * k;
  const bottom = vertical ? (side === 0 ? H * 0.41 : H * 0.965) : H * 0.955;
  const statsY = bottom - statsH;
  const mottoH = motto.height;
  const mottoY = statsY - 16 * k - mottoH;
  const nameBase = mottoY - 8 * k;
  const nameTop = nameBase - nameSize * 0.82 * name.scale.y;
  // above the caps: Й and Ё reach about 0.17 of the size higher, the plate stays clear of them
  const plateY = nameTop - 52 * k - nameSize * 0.17 * name.scale.y;
  const SEG = STAT_MAX;
  const segW = 30 * k;
  const segH = 15 * k;
  const segGap = 6 * k;
  const labelW = 150 * k;
  const cellW = labelW + SEG * (segW + segGap) + 44 * k;
  const gridW = cellW * 2 + 26 * k;

  const draw = (t) => {
    const start = side === 0 ? 0.88 : 0.98;
    const dir = right ? 1 : -1;
    // plate
    const pk = easeOut(k01(t, start, start + 0.25));
    const pw = modelText.width + 44 * k;
    const ph = 44 * k;
    const px = right ? x - pw : x;
    const pdx = (1 - pk) * 200 * k * dir;
    plate.clear();
    plate.poly([px + 12 * k + pdx, plateY, px + pw + 12 * k + pdx, plateY, px + pw - 12 * k + pdx, plateY + ph, px - 12 * k + pdx, plateY + ph]).fill({ color: col.accent });
    plate.poly([px + pw + 18 * k + pdx, plateY, px + pw + 30 * k + pdx, plateY, px + pw + 18 * k + pdx, plateY + ph, px + pw + 6 * k + pdx, plateY + ph]).fill({ color: mix(col.accent, 0xffffff, 0.4), alpha: right ? 0 : 1 });
    plate.poly([px - 18 * k + pdx, plateY, px - 6 * k + pdx, plateY, px - 18 * k + pdx, plateY + ph, px - 30 * k + pdx, plateY + ph]).fill({ color: mix(col.accent, 0xffffff, 0.4), alpha: right ? 1 : 0 });
    plate.alpha = pk;
    modelText.anchor.set(0.5);
    modelText.position.set(px + pw / 2 + pdx, plateY + ph / 2 + 1 * k);
    modelText.alpha = pk;
    // name: slams in from the side
    const nk = k01(t, start + 0.06, start + 0.26);
    const ne = easeBack(nk);
    name.position.set(x + (1 - ne) * 260 * k * dir, nameBase);
    name.alpha = clamp(nk * 2.5, 0, 1);
    const ns = name.__fit || (name.__fit = name.scale.x);
    name.scale.set(ns * (1 + 0.25 * (1 - easeOut(nk))));
    // motto
    const mk = easeOut(k01(t, start + 0.25, start + 0.5));
    motto.position.set(x + (1 - mk) * 60 * k * dir, mottoY);
    motto.alpha = mk;
    // stats: a 2×2 grid, segments light up one by one
    stats.clear();
    const gx = right ? x - gridW : x;
    STAT_KEYS.forEach((key, i) => {
      const col0 = i % 2;
      const row = Math.floor(i / 2);
      const cx = gx + col0 * (cellW + 26 * k);
      const cy = statsY + row * 40 * k;
      const lk = k01(t, start + 0.3 + i * 0.05, start + 0.5 + i * 0.05);
      labels[i].anchor.set(0, 0.5);
      labels[i].position.set(cx, cy + segH / 2 + 2 * k);
      labels[i].alpha = lk;
      const v = def.stats[key];
      for (let p = 0; p < SEG; p++) {
        const sx = cx + labelW + p * (segW + segGap);
        const on = p < v && t > start + 0.38 + i * 0.05 + p * 0.05;
        stats.poly([sx + 5 * k, cy, sx + segW + 5 * k, cy, sx + segW - 5 * k, cy + segH, sx - 5 * k, cy + segH]).fill({ color: on ? col.accent : 0x1a1c24, alpha: (on ? 1 : 0.85) * lk });
        if (on) stats.poly([sx + 5 * k, cy, sx + segW + 5 * k, cy, sx + segW + 3 * k, cy + 4 * k, sx + 3 * k, cy + 4 * k]).fill({ color: 0xffffff, alpha: 0.45 * lk });
      }
      nums[i].anchor.set(0, 0.5);
      nums[i].position.set(cx + labelW + SEG * (segW + segGap) + 8 * k, cy + segH / 2 + 1 * k);
      nums[i].alpha = k01(t, start + 0.38 + i * 0.05 + v * 0.05, start + 0.5 + i * 0.05 + v * 0.05);
    });
  };
  return { g, draw };
}

// Round plate: the round by the match's course; a rerun after a draw says so, 1:1 is the deciding round.
function makeRoundPlate(show) {
  const { W, H, k, vertical } = show;
  const g = new PIXI.Container();
  const text = show.roundTitle();
  const title = ringText({ text, style: { fontFamily: FONT, fontSize: (vertical ? 40 : 42) * k, fontWeight: '700', fontStyle: 'italic', fill: 0xffffff, letterSpacing: 6 * k, stroke: { color: 0x000000, width: 5 * k } } });
  title.anchor.set(0.5);
  const score = ringText({ text: `${show.wins[0]} : ${show.wins[1]}`, style: { fontFamily: FONT, fontSize: (vertical ? 34 : 34) * k, fontWeight: '700', fill: 0xffd46a, letterSpacing: 4 * k, stroke: { color: 0x000000, width: 4 * k } } });
  score.anchor.set(0.5);
  const bg = new PIXI.Graphics();
  g.addChild(bg, title, score);
  const cx = W / 2;
  const cy = vertical ? H * 0.04 : H * 0.075;
  const draw = (t) => {
    const e = easeOut(k01(t, 1.05, 1.35));
    const w = title.width + 90 * k;
    const h = 64 * k;
    const y = cy - (1 - e) * 40 * k;
    bg.clear();
    bg.poly([cx - w / 2 + 14 * k, y - h / 2, cx + w / 2 + 14 * k, y - h / 2, cx + w / 2 - 14 * k, y + h / 2, cx - w / 2 - 14 * k, y + h / 2]).fill({ color: 0x07080d, alpha: 0.88 }).stroke({ width: 3 * k, color: 0xffc94a, alpha: 0.95 });
    title.position.set(cx, y);
    const sw = score.width + 40 * k;
    const sy = y + h / 2 + 22 * k;
    const showScore = show.wins[0] + show.wins[1] > 0;
    if (showScore) bg.poly([cx - sw / 2 + 8 * k, sy - 20 * k, cx + sw / 2 + 8 * k, sy - 20 * k, cx + sw / 2 - 8 * k, sy + 20 * k, cx - sw / 2 - 8 * k, sy + 20 * k]).fill({ color: 0x07080d, alpha: 0.88 });
    score.position.set(cx, sy);
    score.visible = showScore;
    g.alpha = e;
  };
  return { g, draw };
}
