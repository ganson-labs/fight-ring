// Living stage effects described by stage.json "ambient": lights, glow, fog, steam, sparks, embers, wind, rays, heat.
// Every effect is a pure function of the scene time and a seed (no Math.random): the same fight renders the same frames.
//
// Where an effect lives ("layer"):
//   "<image>.png" — inside that stage layer: moves with its parallax and blur, drawn above it and below the next layer;
//   "back"        — behind the fighters, above all stage layers, own "parallax" (default 1);
//   "front"       — in front of the fighters, own "parallax" (default 1), dimmed during a super.
// Where it spawns (coordinates: scene units, x 0…2200 across the stage, y up from the floor line; uv: fractions of the layer image):
//   area [x0, y0, x1, y1] · at [[x, y], …] · uv [u0, v0, u1, v1] · atUv [[u, v], …] · match { color, tolerance, min, contrast }
//   (match finds bright spots of that colour in the layer image, e.g. indicator LEDs, and puts the effect exactly on them).
import * as PIXI from 'pixi.js';
import { STAGE } from '../engine/constants.js';

const W = STAGE.width;
const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const hexNum = (h) => (typeof h === 'number' ? h : parseInt(String(h || '#ffffff').slice(1), 16));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mod = (a, n) => ((a % n) + n) % n;
const pair = (v, d) => (Array.isArray(v) ? v : v === undefined ? d : [v, v]);

// integer hash → [0, 1)
function hash(i, salt = 0) {
  let t = (Math.imul(i | 0, 0x9e3779b1) ^ Math.imul((salt | 0) + 0x632be5ab, 0x85ebca77)) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x7feb352d);
  t = Math.imul(t ^ (t >>> 15), 0x846ca68b);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

// smooth 1D value noise in [0, 1]
function noise(x, salt) {
  const i = Math.floor(x);
  const f = x - i;
  const k = f * f * (3 - 2 * f);
  return hash(i, salt) * (1 - k) + hash(i + 1, salt) * k;
}

// ---------- textures ----------

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
      r.addColorStop(0.2, 'rgba(255,255,255,0.85)');
      r.addColorStop(0.5, 'rgba(255,255,255,0.25)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }),
    soft: canvasTexture(128, 128, (g, w, h) => {
      const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.45, 'rgba(255,255,255,0.45)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, w, h);
    }),
    puff: canvasTexture(256, 256, (g, w, h) => {
      for (let i = 0; i < 26; i++) {
        const a = hash(i, 11) * TAU;
        const d = Math.sqrt(hash(i, 12)) * w * 0.26;
        const x = w / 2 + Math.cos(a) * d;
        const y = h / 2 + Math.sin(a) * d * 0.7;
        const rad = w * (0.12 + hash(i, 13) * 0.16);
        const r = g.createRadialGradient(x, y, 0, x, y, rad);
        r.addColorStop(0, `rgba(255,255,255,${0.22 + hash(i, 14) * 0.18})`);
        r.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = r;
        g.fillRect(0, 0, w, h);
      }
      g.globalCompositeOperation = 'destination-in';
      const m = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      m.addColorStop(0, 'rgba(0,0,0,1)');
      m.addColorStop(0.6, 'rgba(0,0,0,0.8)');
      m.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = m;
      g.fillRect(0, 0, w, h);
    }),
    streak: canvasTexture(64, 8, (g, w, h) => {
      const r = g.createLinearGradient(0, 0, w, 0);
      r.addColorStop(0, 'rgba(255,255,255,0)');
      r.addColorStop(0.75, 'rgba(255,255,255,0.9)');
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
    petal: canvasTexture(32, 22, (g, w, h) => {
      const r = g.createRadialGradient(w * 0.4, h * 0.45, 1, w / 2, h / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(1, 'rgba(255,255,255,0.75)');
      g.fillStyle = r;
      g.beginPath();
      g.moveTo(1, h / 2);
      g.bezierCurveTo(w * 0.3, -2, w * 0.85, 1, w - 1, h * 0.35);
      g.lineTo(w * 0.86, h * 0.5);
      g.lineTo(w - 1, h * 0.65);
      g.bezierCurveTo(w * 0.85, h - 1, w * 0.3, h + 2, 1, h / 2);
      g.fill();
    }),
    leaf: canvasTexture(36, 18, (g, w, h) => {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.beginPath();
      g.moveTo(1, h / 2);
      g.quadraticCurveTo(w * 0.5, -h * 0.25, w - 1, h / 2);
      g.quadraticCurveTo(w * 0.5, h * 1.25, 1, h / 2);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(2, h / 2);
      g.lineTo(w - 2, h / 2);
      g.stroke();
    }),
    ray: canvasTexture(64, 256, (g, w, h) => {
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const fy = Math.pow(1 - y / (h - 1), 1.6) * Math.min(1, y / (h * 0.06));
        for (let x = 0; x < w; x++) {
          const fx = Math.pow(Math.sin((Math.PI * (x + 0.5)) / w), 2);
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
          img.data[i + 3] = Math.round(255 * fx * fy);
        }
      }
      g.putImageData(img, 0, 0);
    }),
    heat: canvasTexture(256, 256, (g, w, h) => {
      // tileable displacement map: sums of sines with whole periods, red = x offset, green = y offset
      const img = g.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = (x / w) * TAU;
          const v = (y / h) * TAU;
          const dx = Math.sin(v * 3 + Math.sin(u * 2) * 1.5) * 0.6 + Math.sin(v * 7 + u) * 0.4;
          const dy = Math.sin(u * 2 + v * 5) * 0.5 + Math.sin(v * 4 - u * 3) * 0.5;
          const i = (y * w + x) * 4;
          img.data[i] = Math.round(128 + 127 * dx * 0.9);
          img.data[i + 1] = Math.round(128 + 127 * dy * 0.9);
          img.data[i + 2] = 128;
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    }),
  };
}

// ---------- where effects spawn ----------

// Geometry of a stage layer: maps image fractions to the layer's local coordinates (scene units, y down).
function layerGeometry(l, tex) {
  const width = l.width ?? W * 1.4;
  const scale = width / tex.width;
  const height = l.height ?? tex.height * scale;
  const n = Math.max(1, Math.min(9, l.repeat ?? 1));
  const copies = [];
  for (let i = 0; i < n; i++) copies.push({ cx: W / 2 + (l.x ?? 0) + (i - (n - 1) / 2) * width, flip: l.mirror && i % 2 === 1 ? -1 : 1 });
  const groundAt = l.groundAt ?? 0.95;
  const top = -(l.y ?? 0);
  return {
    copies,
    toLocal: (u, v, c) => ({ x: copies[c].cx + (u - 0.5) * width * copies[c].flip, y: top + (v - groundAt) * height }),
  };
}

// Bright spots of one colour in a texture (LEDs, molten metal): image fractions [u, v], strongest first.
function findSpots(tex, { color = '#4aa0ff', tolerance = 0.3, min = 0.5, contrast = 0.12, cell = 5 } = {}, max = 200) {
  const src = tex.source?.resource;
  if (!src) return [];
  const s = Math.min(1, 640 / tex.source.width);
  const w = Math.max(8, Math.round(tex.source.width * s));
  const h = Math.max(8, Math.round(tex.source.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const tc = hexNum(color);
  const tr = (tc >> 16) & 255;
  const tg = (tc >> 8) & 255;
  const tb = tc & 255;
  const tm = Math.max(tr, tg, tb, 1);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = d[i * 4 + 3] < 40 ? 0 : Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) / 255;
  const best = new Map();
  const R = 3;
  for (let y = R; y < h - R; y++) {
    for (let x = R; x < w - R; x++) {
      const i = y * w + x;
      const b = lum[i];
      if (b < min) continue;
      const m = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 1);
      const dist = Math.hypot(d[i * 4] / m - tr / tm, d[i * 4 + 1] / m - tg / tm, d[i * 4 + 2] / m - tb / tm) / Math.sqrt(3);
      if (dist > tolerance) continue;
      const ring = (lum[i - R] + lum[i + R] + lum[i - R * w] + lum[i + R * w]) / 4;
      if (b - ring < contrast) continue;
      const score = b * (1 - dist / tolerance) + (b - ring);
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      const prev = best.get(key);
      if (!prev || prev.score < score) best.set(key, { u: (x + 0.5) / w, v: (y + 0.5) / h, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, max).map((p) => [p.u, p.v]);
}

// A spawner: picks a point in layer-local coordinates (y down) from three numbers in [0, 1).
function makeSpawner(spec, geo, tex) {
  if (spec.match && geo && tex) {
    const spots = findSpots(tex, spec.match, spec.count ?? 200);
    const pts = [];
    for (let c = 0; c < geo.copies.length; c++) for (const [u, v] of spots) pts.push(geo.toLocal(u, v, c));
    if (pts.length) return { points: pts, pick: (a) => pts[Math.floor(a * pts.length) % pts.length] };
  }
  if (spec.atUv && geo) {
    const pts = [];
    for (let c = 0; c < geo.copies.length; c++) for (const [u, v] of spec.atUv) pts.push(geo.toLocal(u, v, c));
    return { points: pts, pick: (a) => pts[Math.floor(a * pts.length) % pts.length] };
  }
  if (spec.at) {
    const pts = spec.at.map(([x, y]) => ({ x, y: -y }));
    return { points: pts, pick: (a) => pts[Math.floor(a * pts.length) % pts.length] };
  }
  if (spec.uv && geo) {
    const [u0, v0, u1, v1] = spec.uv;
    return { pick: (a, b, c) => geo.toLocal(u0 + (u1 - u0) * a, v0 + (v1 - v0) * b, Math.floor(c * geo.copies.length) % geo.copies.length) };
  }
  const [x0, y0, x1, y1] = spec.area || [-400, 0, W + 400, 300];
  return { pick: (a, b) => ({ x: x0 + (x1 - x0) * a, y: -(y0 + (y1 - y0) * b) }) };
}

// Area of a fog bank or a wind field: "area" in scene units, or "uv" over the layer image (all its copies).
function areaOf(spec, geo, def) {
  if (spec.area) return spec.area;
  if (spec.uv && geo) {
    const [u0, v0, u1, v1] = spec.uv;
    const a = geo.toLocal(u0, v0, 0);
    const b = geo.toLocal(u1, v1, geo.copies.length - 1);
    return [Math.min(a.x, b.x), -Math.max(a.y, b.y), Math.max(a.x, b.x), -Math.min(a.y, b.y)];
  }
  return def;
}

// ---------- effects ----------

function sprite(tex, parent, { color = 0xffffff, blend = 'add', anchor = 0.5 } = {}) {
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(...pair(anchor));
  sp.tint = color;
  sp.blendMode = blend;
  parent.addChild(sp);
  return sp;
}

const colorsOf = (spec, def) => (spec.colors || [spec.color || def]).map(hexNum);

// Twinkling points: indicator LEDs, windows, signal lamps.
function lights(spec, ctx) {
  const n = spec.count ?? 80;
  const sp = makeSpawner(spec, ctx.geo, ctx.tex);
  const pts = sp.points || Array.from({ length: n }, (_, i) => sp.pick(hash(i, ctx.seed), hash(i, ctx.seed + 1), hash(i, ctx.seed + 2)));
  const colors = colorsOf(spec, '#5ab4ff');
  const size = spec.size ?? 9;
  const [lo, hi] = pair(spec.alpha, [0.15, 1]);
  const rate = spec.rate ?? 1;
  const items = pts.map((p, i) => {
    const s = sprite(ctx.tex_.dot, ctx.c, { color: colors[Math.floor(hash(i, ctx.seed + 3) * colors.length)], blend: spec.blend || 'add' });
    s.position.set(p.x, p.y);
    s.scale.set((size * (0.7 + 0.6 * hash(i, ctx.seed + 4))) / 64);
    const r = hash(i, ctx.seed + 5);
    return { s, mode: r < (spec.steady ?? 0.45) ? 0 : r < 0.85 ? 1 : 2, ph: hash(i, ctx.seed + 6) * 10, per: (0.5 + hash(i, ctx.seed + 7) * 2.5) / rate, duty: 0.35 + hash(i, ctx.seed + 8) * 0.5 };
  });
  return (t) => {
    for (const [i, L] of items.entries()) {
      let f;
      if (L.mode === 0) f = 0.75 + 0.25 * Math.sin((t * rate * 0.8 + L.ph) * 1.3);
      else if (L.mode === 1) f = mod(t / L.per + L.ph, 1) < L.duty ? 1 : 0.15;
      else f = hash(Math.floor((t + L.ph) * 14 * rate), i + ctx.seed) > 0.45 ? 1 : 0.1;
      L.s.alpha = lo + (hi - lo) * f;
    }
  };
}

// Big soft pulsing light: molten metal, furnace mouths, a lamp's halo.
function glow(spec, ctx) {
  const n = spec.count ?? 6;
  const sp = makeSpawner(spec, ctx.geo, ctx.tex);
  const pts = sp.points || Array.from({ length: n }, (_, i) => sp.pick(hash(i, ctx.seed), hash(i, ctx.seed + 1), hash(i, ctx.seed + 2)));
  const colors = colorsOf(spec, '#ff8a2a');
  const size = spec.size ?? 260;
  const alpha = spec.alpha ?? 0.4;
  const pulse = spec.pulse ?? 0.25;
  const flicker = spec.flicker ?? 0.15;
  const speed = spec.speed ?? 0.6;
  const items = pts.map((p, i) => {
    const s = sprite(ctx.tex_.soft, ctx.c, { color: colors[i % colors.length], blend: spec.blend || 'add' });
    s.position.set(p.x, p.y);
    const k = 0.75 + 0.5 * hash(i, ctx.seed + 3);
    s.scale.set((size * k * (spec.stretch ?? 1)) / 128, (size * k) / 128);
    return { s, ph: hash(i, ctx.seed + 4) * TAU };
  });
  return (t) => {
    for (const [i, G] of items.entries()) {
      const f = 1 + pulse * Math.sin(t * speed * TAU + G.ph) + flicker * (noise(t * 6 + i * 7.3, ctx.seed) * 2 - 1);
      G.s.alpha = clamp(alpha * f, 0, 1);
    }
  };
}

// Drifting fog banks that wrap around the area (soft puffs, slow wobble).
function fog(spec, ctx) {
  const n = spec.count ?? 14;
  const [x0, y0, x1, y1] = areaOf(spec, ctx.geo, [-600, 0, W + 600, 200]);
  const span = x1 - x0;
  const colors = colorsOf(spec, '#c8d4e6');
  const size = spec.size ?? 420;
  const alpha = spec.alpha ?? 0.18;
  const [vx, vy] = pair(spec.speed, [18, 0]);
  const items = Array.from({ length: n }, (_, i) => {
    const s = sprite(ctx.tex_.puff, ctx.c, { color: colors[i % colors.length], blend: spec.blend || 'normal' });
    const k = 0.7 + 0.6 * hash(i, ctx.seed + 1);
    return { s, bx: hash(i, ctx.seed) * span, by: y0 + (y1 - y0) * hash(i, ctx.seed + 2), v: vx * (0.6 + 0.8 * hash(i, ctx.seed + 3)), sc: (size * k) / 256, ph: hash(i, ctx.seed + 4) * TAU, flat: spec.flat ?? 0.45 };
  });
  return (t) => {
    for (const F of items) {
      const u = mod(F.bx + F.v * t, span);
      const edge = clamp(Math.min(u, span - u) / (span * 0.12), 0, 1);
      F.s.position.set(x0 + u, -(F.by + Math.sin(t * 0.3 + F.ph) * 14 + vy * Math.sin(t * 0.11 + F.ph) * 10));
      const breath = 1 + 0.08 * Math.sin(t * 0.25 + F.ph);
      F.s.scale.set(F.sc * breath * 1.6, F.sc * breath * F.flat * 1.6);
      F.s.rotation = Math.sin(t * 0.05 + F.ph) * 0.15;
      F.s.alpha = alpha * edge * (0.75 + 0.25 * Math.sin(t * 0.4 + F.ph * 2));
    }
  };
}

// Continuous emitter computed analytically from time: particle k is born at k / rate with its own seeded randoms.
// Used by steam (soft puffs that grow and fade), sparks (streaks with gravity) and embers (rising flickering dots).
function emitter(spec, ctx, kind) {
  const D = {
    steam: { rate: 10, life: 3.5, speed: [0, 40], spread: 40, gravity: 0, size: 140, grow: 2.2, alpha: 0.18, color: '#dfe8f5', tex: 'puff', blend: 'normal', wobble: 10 },
    sparks: { rate: 40, life: 1.1, speed: 520, angle: 90, spread: 50, gravity: -900, size: 16, grow: 0, alpha: 1, color: '#ffd27a', tex: 'streak', blend: 'add', wobble: 0 },
    embers: { rate: 14, life: 4, speed: [10, 70], spread: 30, gravity: 6, size: 7, grow: 0, alpha: 0.9, color: '#ff9a3c', tex: 'dot', blend: 'add', wobble: 22 },
  }[kind];
  const o = { ...D, ...spec };
  const life = o.life;
  const rate = o.rate;
  const N = Math.min(600, Math.ceil(rate * life) + 1);
  const sp = makeSpawner(spec, ctx.geo, ctx.tex);
  const colors = colorsOf(o, D.color);
  const tex = ctx.tex_[o.texture || D.tex];
  const streak = tex === ctx.tex_.streak;
  const slots = Array.from({ length: N }, () => sprite(tex, ctx.c, { blend: o.blend, anchor: streak ? [1, 0.5] : 0.5 }));
  const vec = Array.isArray(o.speed);
  const g = Array.isArray(o.gravity) ? o.gravity : [0, o.gravity];
  const bursty = o.bursty ?? 0;
  const S = ctx.seed;
  return (t) => {
    const kk = Math.floor(t * rate);
    for (let j = 0; j < N; j++) {
      const s = slots[j];
      const k = kk - mod(kk - j, N);
      const a = t - k / rate;
      if (a < 0 || a > life * (0.6 + 0.4 * hash(k, S + 9)) || (bursty && noise(k / rate * (o.burstRate ?? 0.7), S + 3) < bursty)) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      const p = sp.pick(hash(k, S), hash(k, S + 1), hash(k, S + 2));
      let vx;
      let vy;
      const r = hash(k, S + 4) * 2 - 1;
      if (vec) {
        const [sx, sy] = o.speed;
        const m = 0.6 + 0.8 * hash(k, S + 5);
        vx = sx * m + r * (o.spread ?? 0);
        vy = sy * m;
        if (o.both) vx *= hash(k, S + 8) < 0.5 ? -1 : 1;
      } else {
        const ang = (o.angle + r * o.spread) * D2R;
        const m = o.speed * (0.45 + 0.75 * hash(k, S + 5));
        vx = Math.cos(ang) * m;
        vy = Math.sin(ang) * m;
      }
      const wob = o.wobble ? Math.sin(a * (1.5 + hash(k, S + 6) * 2) + hash(k, S + 7) * TAU) * o.wobble : 0;
      const x = p.x + vx * a + 0.5 * g[0] * a * a + wob;
      const y = p.y - (vy * a + 0.5 * g[1] * a * a);
      s.position.set(x, y);
      const q = a / life;
      const col = colors[Math.floor(hash(k, S + 10) * colors.length)];
      if (streak) {
        const cvx = vx + g[0] * a;
        const cvy = vy + g[1] * a;
        const v = Math.hypot(cvx, cvy);
        s.rotation = Math.atan2(-cvy, cvx);
        s.scale.set((clamp(v / 600, 0.2, 1.2) * o.size) / 32, (o.size * 0.28 * (1 - q * 0.5)) / 8);
        s.tint = q < 0.12 ? 0xfff4dc : col;
        s.alpha = o.alpha * Math.min(1, (1 - q) * 2.2);
      } else {
        const sz = o.size * (1 + o.grow * q) * (0.7 + 0.6 * hash(k, S + 11));
        s.scale.set(sz / tex.width);
        s.rotation = hash(k, S + 12) * TAU + a * 0.2;
        s.tint = col;
        const fl = kind === 'embers' ? 0.6 + 0.4 * noise(a * 8 + k, S) : 1;
        s.alpha = o.alpha * Math.sin(Math.PI * clamp(q, 0, 1)) * fl;
      }
    }
  };
}

// Wind: petals, leaves, snow or dust crossing the stage, wrapping around the area, tumbling.
function wind(spec, ctx) {
  const n = spec.count ?? 60;
  const [x0, y0, x1, y1] = areaOf(spec, ctx.geo, [-700, -40, W + 700, 1100]);
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const shape = spec.shape || 'petal';
  const tex = shape === 'snow' || shape === 'dust' ? ctx.tex_.dot : ctx.tex_[shape] || ctx.tex_.petal;
  const colors = colorsOf(spec, shape === 'snow' ? '#ffffff' : '#f3b7c6');
  const size = spec.size ?? (shape === 'snow' ? 8 : 16);
  const [vx, vy] = pair(spec.speed, [220, -60]);
  const gust = spec.gust ?? 0.35;
  const spin = spec.spin ?? 1;
  const alpha = spec.alpha ?? 0.9;
  const items = Array.from({ length: n }, (_, i) => {
    const s = sprite(tex, ctx.c, { color: colors[Math.floor(hash(i, ctx.seed + 9) * colors.length)], blend: spec.blend || (shape === 'snow' || shape === 'dust' ? 'add' : 'normal') });
    return { s, bx: hash(i, ctx.seed) * spanX, by: hash(i, ctx.seed + 1) * spanY, k: 0.6 + 0.8 * hash(i, ctx.seed + 2), ph: hash(i, ctx.seed + 3) * TAU, sp: (0.5 + hash(i, ctx.seed + 4)) * spin, sz: size * (0.6 + 0.8 * hash(i, ctx.seed + 5)) };
  });
  return (t) => {
    // gusts: the whole field speeds up and slows down together (integral of 1 + gust * sin)
    const tw = t + (gust / 0.35) * (1 - Math.cos(t * 0.35)) * 0.5 + gust * noise(t * 0.2, ctx.seed) * 3;
    for (const P of items) {
      const u = mod(P.bx + vx * P.k * tw, spanX);
      const v = mod(P.by + vy * P.k * tw + Math.sin(t * 1.3 * P.k + P.ph) * 30, spanY);
      P.s.position.set(x0 + u + Math.sin(t * 0.9 + P.ph) * 20, -(y0 + v));
      const edge = clamp(Math.min(u, spanX - u, v * 4, (spanY - v) * 4) / (spanX * 0.05), 0, 1);
      P.s.rotation = P.ph + t * P.sp * 2;
      const tumble = shape === 'snow' || shape === 'dust' ? 1 : 0.35 + 0.65 * Math.abs(Math.cos(t * P.sp * 3 + P.ph));
      P.s.scale.set(P.sz / tex.width, (P.sz / tex.width) * tumble);
      P.s.alpha = alpha * edge;
    }
  };
}

// Light shafts from one source, slowly breathing and swaying.
function rays(spec, ctx) {
  const n = spec.count ?? 6;
  const sp = makeSpawner(spec, ctx.geo, ctx.tex);
  const src = (sp.points && sp.points[0]) || sp.pick(0.5, 0.5, 0);
  const colors = colorsOf(spec, '#ffd9a0');
  const len = spec.length ?? 1600;
  const width = spec.width ?? 160;
  const angle = spec.angle ?? 110;
  const spread = spec.spread ?? 30;
  const alpha = spec.alpha ?? 0.18;
  const items = Array.from({ length: n }, (_, i) => {
    const s = sprite(ctx.tex_.ray, ctx.c, { color: colors[i % colors.length], blend: spec.blend || 'add', anchor: [0.5, 0] });
    s.position.set(src.x, src.y);
    const k = 0.6 + 0.8 * hash(i, ctx.seed + 1);
    s.scale.set((width * k) / 64, (len * (0.7 + 0.5 * hash(i, ctx.seed + 2))) / 256);
    return { s, a: angle + (n > 1 ? (i / (n - 1) - 0.5) * spread : 0) + (hash(i, ctx.seed) - 0.5) * spread * 0.3, ph: hash(i, ctx.seed + 3) * 50 };
  });
  return (t) => {
    for (const R of items) {
      // sprite points down (+y) at rotation 0; angle is measured from +x towards down, so rotate by angle - 90
      R.s.rotation = (R.a - 90 + Math.sin(t * 0.12 + R.ph) * 2.5) * D2R;
      R.s.alpha = alpha * (0.35 + 0.65 * noise(t * 0.25 + R.ph, ctx.seed));
    }
  };
}

// Heat haze: a moving displacement map over the listed stage layers (or the layer it is attached to).
function heat(spec, ctx) {
  // The filter samples the map in screen space around one small sprite; the repeat address mode tiles it over the
  // whole layer, and moving the sprite by less than one tile scrolls the haze without seams.
  const map = ctx.tex_.heat;
  map.source.addressMode = 'repeat';
  map.source.update?.();
  const ts = new PIXI.Sprite(map);
  const sc = spec.scale ?? 1.4;
  ts.scale.set(sc);
  ts.alpha = 0;
  ctx.c.addChild(ts);
  const strength = spec.strength ?? 6;
  const filter = new PIXI.DisplacementFilter({ sprite: ts, scale: strength * ctx.k });
  const targets = (spec.layers || [ctx.image]).map((im) => ctx.layerByImage(im)).filter(Boolean);
  for (const L of targets) L.c.filters = [...(L.c.filters || []), filter];
  const [vx, vy] = pair(spec.speed, [0, 60]);
  const tile = 256 * sc;
  return {
    update: (t) => {
      ts.position.set(W / 2 - tile + mod(vx * t, tile), -300 - tile + mod(-vy * t, tile));
    },
    destroy: () => {
      for (const L of targets) if (L.c.filters) L.c.filters = L.c.filters.filter((f) => f !== filter);
    },
  };
}

const TYPES = { lights, glow, fog, steam: (s, c) => emitter(s, c, 'steam'), sparks: (s, c) => emitter(s, c, 'sparks'), embers: (s, c) => emitter(s, c, 'embers'), wind, rays, heat };
export const AMBIENT_TYPES = Object.keys(TYPES);

// ---------- the effect set of one stage ----------

export class Ambient {
  // scene: the Scene (its layers are already built by setStage); stage: { def, textures } or null.
  constructor(scene, stage) {
    this.scene = scene;
    this.effects = [];
    this.free = [];
    this.back = new PIXI.Container();
    this.front = new PIXI.Container();
    const root = scene.rainBack.parent; // the scene's graded scenery
    root.addChildAt(this.back, root.getChildIndex(scene.rainBack));
    root.addChildAt(this.front, root.getChildIndex(scene.rainFront));
    const list = stage?.def?.ambient;
    if (!Array.isArray(list) || !list.length) return;
    this.tex = makeTextures();
    const defs = (stage.def.layers || []).filter((l) => stage.textures[l.image]);
    const layerByImage = (im) => {
      const i = defs.findIndex((l) => l.image === im);
      return i >= 0 ? { c: scene.layers[i].c, def: defs[i], tex: stage.textures[im] } : null;
    };
    list.forEach((spec, idx) => {
      const make = TYPES[spec.type];
      if (!make) {
        console.warn(`ambient: неизвестный тип "${spec.type}", есть: ${AMBIENT_TYPES.join(', ')}`);
        return;
      }
      const where = spec.layer || 'back';
      const L = where === 'back' || where === 'front' ? null : layerByImage(where);
      if (where !== 'back' && where !== 'front' && !L) {
        console.warn(`ambient: нет слоя ${where}`);
        return;
      }
      const c = new PIXI.Container();
      if (spec.blur) c.filters = [new PIXI.BlurFilter({ strength: spec.blur * scene.k, quality: 2 })];
      if (L) L.c.addChild(c);
      else (where === 'front' ? this.front : this.back).addChild(c);
      const ctx = { c, k: scene.k, seed: (spec.seed ?? idx + 1) * 7919, tex_: this.tex, geo: L ? layerGeometry(L.def, L.tex) : null, tex: L?.tex || null, image: L ? where : null, layerByImage };
      const made = make(spec, ctx);
      const fx = typeof made === 'function' ? { update: made } : made;
      this.effects.push({ ...fx, c, own: !L, p: spec.parallax ?? 1, front: where === 'front' });
    });
  }

  // view: the camera numbers of Scene.draw, so "back" and "front" effects follow the same parallax as the stage layers.
  update(dt, { cx, cy, zoom, zRef }) {
    const t = this.scene.time;
    const c = this.scene.cam;
    const s = this.scene.superFx;
    const dim = s ? 1 - 0.75 * clamp(s.t / 0.2, 0, 1) * (s.out ? clamp(1 - s.outT / 0.4, 0, 1) : 1) : 1;
    this.front.alpha = dim;
    for (const e of this.effects) {
      if (e.own) {
        const zp = zRef + (zoom - zRef) * e.p;
        e.c.scale.set(zp);
        e.c.x = cx + (-(W / 2) - (c.x - W / 2) * e.p) * zp;
        e.c.y = cy + c.y * e.p * zp;
        e.c.rotation = c.rot * e.p;
      }
      e.update(t, dt);
    }
  }

  destroy() {
    for (const e of this.effects) {
      e.destroy?.();
      e.c.destroy({ children: true });
    }
    this.effects = [];
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
    if (this.tex) for (const t of Object.values(this.tex)) t.destroy(true);
  }
}
