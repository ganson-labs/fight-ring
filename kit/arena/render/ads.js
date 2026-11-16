// Sponsor pieces for the broadcast, all driven by an ad config (ads/<sponsor>/ad.json in the ring folder) and
// all off unless the config says enabled and the page is asked for them (lab ?ads=1, viewer checkbox):
//   costPlate  — a corner plate «счёт боя»: what the match costs in foreign services, numbers set by hand;
//   cardFlip   — the loser's card turns over and becomes a neutral virtual bank card with the sponsor's name;
//   billboard  — a lit billboard on a stage layer (the stage's stage.json → ads.billboard says where).
// A missing sponsor picture leaves a marked empty slot: logos are never drawn by the ring.
import * as PIXI from 'pixi.js';
import { ringText, fitText } from './text.js';
import { solvePose, sampleAnim } from '../engine/index.js';
import { Rig } from './scene.js';

const FONT = 'Oswald, "Arial Narrow", Impact, sans-serif';
const MONO = '"Roboto Mono", Consolas, monospace';
const hexNum = (h) => parseInt(String(h || '#ffffff').slice(1), 16);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeOut = (k) => 1 - (1 - clamp(k, 0, 1)) ** 3;

export async function loadAds(base, { force = false } = {}) {
  if (!base) return null;
  try {
    const r = await fetch(`${base}ad.json`, { cache: 'no-store' });
    if (!r.ok) return null;
    const def = await r.json();
    if (!def.enabled && !force) return null;
    const tex = {};
    for (const key of ['logo', 'billboard']) {
      const file = def[key === 'logo' ? 'cardFlip' : 'billboard']?.image;
      if (!file) continue;
      try {
        tex[key] = await PIXI.Assets.load({ src: `${base}${file}`, loadParser: 'loadTextures' });
      } catch {
        tex[key] = null;
      }
    }
    return { base, def, tex };
  } catch {
    return null;
  }
}

function txt(text, size, fill, k, { weight = '700', italic = false, font = FONT, spacing = 1 } = {}) {
  return ringText({ text, style: { fontFamily: font, fontSize: size * k, fontWeight: weight, fontStyle: italic ? 'italic' : 'normal', fill, letterSpacing: spacing * k } });
}

const money = (v, cur) => `${cur === '₽' ? '' : cur}${v.toLocaleString('ru-RU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}${cur === '₽' ? ' ₽' : ''}`;

// ---------- the cost plate ----------

export class CostPlate {
  constructor(app, ads, { width, height, vertical }) {
    this.cfg = ads?.def?.costPlate;
    this.on = !!(this.cfg && this.cfg.enabled !== false);
    if (!this.on) return;
    this.W = width;
    this.H = height;
    this.vertical = vertical;
    this.k = vertical ? width / 1080 : width / 1920;
    this.c = new PIXI.Container();
    app.stage.addChild(this.c);
    const k = this.k;
    const cfg = this.cfg;
    this.cur = cfg.currency || '$';
    this.g = new PIXI.Graphics();
    this.title = txt((cfg.title || 'СЧЁТ БОЯ').toUpperCase(), 20, 0xf3c64d, k, { spacing: 4 });
    this.total = txt('', 30, 0xffffff, k, { font: MONO });
    this.rows = txt('', 16, 0xc9ceda, k, { weight: '500' });
    this.foot = txt(cfg.footer || '', 15, 0x9aa0b0, k, { weight: '500' });
    this.c.addChild(this.g, this.title, this.total, this.rows, this.foot);
    this.c.alpha = 0;
  }

  // progress 0..1 — how much of the match is already «spent» (the plate counts up as the fight goes)
  draw(dt, progress = 1, visible = true) {
    if (!this.on) return;
    const k = this.k;
    const p = clamp(progress, 0, 1);
    let total = 0;
    const parts = (this.cfg.rows || []).map((r) => {
      const v = (r.amount || 0) * (r.fixed ? 1 : p);
      total += v;
      return `${r.label} ${money(Math.round(v * 100) / 100, this.cur)}`;
    });
    this.total.text = money(Math.round(total * 100) / 100, this.cur);
    this.rows.text = parts.join('  ·  ');
    const pad = 16 * k;
    const gap = 14 * k;
    const head = this.title.width + gap + this.total.width + (this.cfg.footer ? gap * 2 + this.foot.width : 0);
    const w = Math.max(head, this.rows.width) + pad * 2;
    const h = 64 * k;
    const x = this.W / 2 - w / 2;
    const y = (this.vertical ? 240 : 146) * k;
    this.c.alpha += ((visible ? 1 : 0) - this.c.alpha) * Math.min(1, dt * 6);
    this.g.clear();
    this.g.roundRect(x, y, w, h, 8 * k).fill({ color: 0x07080c, alpha: 0.78 }).stroke({ width: 1.5 * k, color: 0xf3c64d, alpha: 0.55 });
    const x0 = this.W / 2 - head / 2;
    this.title.position.set(x0, y + 9 * k);
    this.total.position.set(x0 + this.title.width + gap, y + 2 * k);
    this.foot.anchor.set(0, 0);
    this.foot.position.set(x0 + this.title.width + gap + this.total.width + gap * 2, y + 12 * k);
    this.rows.anchor.set(0.5, 0);
    this.rows.position.set(this.W / 2, y + 40 * k);
  }
}

// ---------- the card flip ----------

export class CardFlip {
  constructor(app, ads, { width, height, vertical, assets, names, side }) {
    this.cfg = ads?.def?.cardFlip;
    this.on = !!(this.cfg && this.cfg.enabled !== false);
    if (!this.on) return;
    this.ads = ads;
    this.W = width;
    this.H = height;
    this.vertical = vertical;
    this.k = vertical ? width / 1080 : width / 1920;
    this.dur = this.cfg.seconds || 4.5;
    this.t = 0;
    const k = this.k;
    const cw = (vertical ? 880 : 860) * k;
    const ch = cw / 1.586; // a bank card's proportions
    this.cw = cw;
    this.ch = ch;
    this.c = new PIXI.Container();
    this.c.position.set(width / 2, height / 2);
    app.stage.addChild(this.c);
    this.bg = new PIXI.Graphics();
    this.bg.rect(0, 0, width, height).fill({ color: 0x05060a, alpha: 0.9 });
    this.bg.position.set(-width / 2, -height / 2);
    this.c.addChild(this.bg);
    this.card = new PIXI.Container();
    this.c.addChild(this.card);
    this.front = this.fighterFace(assets[side], names[side]);
    this.back = this.bankFace();
    this.back.visible = false;
    this.card.addChild(this.front, this.back);
  }

  fighterFace(a, model) {
    const k = this.k;
    const { cw, ch } = this;
    const accent = hexNum(a.def.card.colors.accent);
    const f = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.roundRect(-cw / 2, -ch / 2, cw, ch, 34 * k).fill({ color: 0x14161d }).stroke({ width: 4 * k, color: accent });
    g.roundRect(-cw / 2, -ch / 2, cw * 0.42, ch, 34 * k).fill({ color: accent, alpha: 0.25 });
    f.addChild(g);
    const rig = new Rig(a);
    rig.apply(solvePose(sampleAnim(a.def.anims.defeat || a.def.anims.idle, 0)));
    const holder = new PIXI.Container();
    holder.addChild(rig.root);
    const sc = (ch * 0.85) / 340;
    rig.root.scale.set(sc);
    holder.position.set(-cw * 0.29, ch * 0.42);
    const mask = new PIXI.Graphics().roundRect(-cw / 2, -ch / 2, cw * 0.42, ch, 34 * k).fill({ color: 0xffffff });
    holder.mask = mask;
    f.addChild(mask, holder);
    const name = txt(a.def.card.name.toUpperCase(), 64, 0xffffff, k, { italic: true });
    name.position.set(-cw * 0.04, -ch * 0.32);
    const m = txt((model || '').toUpperCase(), 24, accent, k, { spacing: 5 });
    m.position.set(-cw * 0.04, -ch * 0.4);
    const lost = txt('ВЫБЫВАЕТ', 30, 0x9aa0b0, k, { spacing: 8 });
    lost.position.set(-cw * 0.04, ch * 0.22);
    f.addChild(name, m, lost);
    return f;
  }

  bankFace() {
    const k = this.k;
    const { cw, ch } = this;
    const cfg = this.cfg;
    const b = new PIXI.Container();
    const g = new PIXI.Graphics();
    const c1 = hexNum(cfg.colors?.[0] || '#1b1f2a');
    const c2 = hexNum(cfg.colors?.[1] || '#3a4256');
    const steps = 18;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const mix = (a, bb) => Math.round(a + (bb - a) * t);
      const col = (mix((c1 >> 16) & 255, (c2 >> 16) & 255) << 16) | (mix((c1 >> 8) & 255, (c2 >> 8) & 255) << 8) | mix(c1 & 255, c2 & 255);
      g.rect(-cw / 2 + (cw * i) / steps, -ch / 2, cw / steps + 1, ch).fill({ color: col });
    }
    const mask = new PIXI.Graphics().roundRect(-cw / 2, -ch / 2, cw, ch, 34 * k).fill({ color: 0xffffff });
    g.mask = mask;
    const frame = new PIXI.Graphics().roundRect(-cw / 2, -ch / 2, cw, ch, 34 * k).stroke({ width: 2 * k, color: 0xffffff, alpha: 0.25 });
    // chip and contactless mark
    const chip = new PIXI.Graphics();
    chip.roundRect(-cw * 0.38, -ch * 0.1, 92 * k, 70 * k, 12 * k).fill({ color: 0xd6b56a }).stroke({ width: 2 * k, color: 0x9c7d3c });
    for (let i = 1; i < 3; i++) chip.rect(-cw * 0.38, -ch * 0.1 + (70 * k * i) / 3, 92 * k, 1.5 * k).fill({ color: 0x9c7d3c });
    for (let i = 0; i < 3; i++) chip.arc(-cw * 0.38 + 140 * k, -ch * 0.1 + 35 * k, (14 + i * 11) * k, -0.9, 0.9).stroke({ width: 3 * k, color: 0xffffff, alpha: 0.7 });
    const brand = txt(cfg.label || '', 58, 0xffffff, k, { weight: '700', spacing: 2 });
    brand.position.set(-cw * 0.4, -ch * 0.4);
    const kind = txt((cfg.kind || 'VIRTUAL').toUpperCase(), 22, 0xc9ceda, k, { spacing: 6 });
    kind.anchor.set(1, 0);
    kind.position.set(cw * 0.42, -ch * 0.37);
    const num = txt(cfg.number || '••••  ••••  ••••  2026', 40, 0xffffff, k, { font: MONO, weight: '500', spacing: 3 });
    num.position.set(-cw * 0.4, ch * 0.12);
    const holder = txt((cfg.holder || '').toUpperCase(), 24, 0xc9ceda, k, { font: MONO, weight: '500', spacing: 3 });
    holder.position.set(-cw * 0.4, ch * 0.3);
    b.addChild(mask, g, frame, chip, brand, kind, num, holder);
    // logo slot: the sponsor's own PNG, or a marked empty place
    const lw = cw * 0.26;
    const lh = ch * 0.22;
    const lx = cw * 0.42 - lw;
    const ly = ch * 0.42 - lh;
    const tex = this.ads.tex.logo;
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      const s = Math.min(lw / tex.width, lh / tex.height);
      sp.scale.set(s);
      sp.anchor.set(1, 1);
      sp.position.set(cw * 0.42, ch * 0.42);
      b.addChild(sp);
    } else {
      const slot = new PIXI.Graphics();
      for (let i = 0; i < 24; i++) {
        const per = 2 * (lw + lh);
        const a0 = (i / 24) * per;
        const pt = (d) => (d < lw ? [lx + d, ly] : d < lw + lh ? [lx + lw, ly + d - lw] : d < 2 * lw + lh ? [lx + lw - (d - lw - lh), ly + lh] : [lx, ly + lh - (d - 2 * lw - lh)]);
        const [x0, y0] = pt(a0);
        const [x1, y1] = pt(Math.min(per - 0.01, a0 + per / 48));
        slot.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 2 * k, color: 0xffffff, alpha: 0.45 });
      }
      const note = txt('логотип PNG', 18, 0xffffff, k, { weight: '500' });
      note.alpha = 0.5;
      note.anchor.set(0.5);
      note.position.set(lx + lw / 2, ly + lh / 2);
      b.addChild(slot, note);
    }
    return b;
  }

  // returns false when finished
  draw(dt) {
    if (!this.on) return false;
    this.t += dt;
    const t = this.t;
    this.bg.alpha = clamp(t / 0.3, 0, 1);
    const flip = clamp((t - 1.2) / 0.9, 0, 1);
    const ang = easeOut(flip) * Math.PI;
    const sx = Math.cos(ang);
    this.front.visible = sx > 0;
    this.back.visible = sx <= 0;
    this.back.scale.x = -1;
    this.card.scale.set(sx * (1 + 0.08 * Math.sin(ang)), 1 + 0.08 * Math.sin(ang));
    this.card.rotation = -0.06 * Math.sin(ang) + (flip >= 1 ? 0.02 * Math.sin(t * 1.5) : 0);
    this.card.alpha = clamp(t / 0.3, 0, 1); // the card stays on screen to the end of the clip
    const intro = easeOut(t / 0.5);
    this.card.y = (1 - intro) * this.H * 0.3;
    return t < this.dur;
  }
}

// ---------- the billboard ----------

// Adds a lit billboard to the stage layer named in stage.json → ads.billboard ({ layer, x, y, w, h }), in that
// layer's own units (x along the stage, y up). Without the sponsor's picture the panel shows a marked slot.
export function attachBillboard(scene, ads) {
  const spot = scene.stage?.def?.ads?.billboard;
  if (!ads || !spot || ads.def.billboard?.enabled === false) return null;
  const layer = scene.layers[spot.layer ?? 0];
  if (!layer) return null;
  const c = new PIXI.Container();
  const w = spot.w;
  const h = spot.h;
  const g = new PIXI.Graphics();
  // legs and frame
  g.rect(-w * 0.32, 0, w * 0.04, (spot.legs ?? h * 0.6)).fill({ color: 0x15171d });
  g.rect(w * 0.28, 0, w * 0.04, (spot.legs ?? h * 0.6)).fill({ color: 0x15171d });
  g.rect(-w / 2 - 8, -h - 8, w + 16, h + 16).fill({ color: 0x0d0f14 });
  c.addChild(g);
  const tex = ads.tex.billboard;
  if (tex) {
    const sp = new PIXI.Sprite(tex);
    sp.width = w;
    sp.height = h;
    sp.anchor.set(0.5, 1);
    c.addChild(sp);
  } else {
    const p = new PIXI.Graphics();
    p.rect(-w / 2, -h, w, h).fill({ color: 0x1a1f2c });
    for (let i = 0; i < 30; i++) {
      const per = 2 * (w + h);
      const a0 = (i / 30) * per;
      const pt = (d) => (d < w ? [-w / 2 + d, -h] : d < w + h ? [w / 2, -h + d - w] : d < 2 * w + h ? [w / 2 - (d - w - h), 0] : [-w / 2, -(d - 2 * w - h)]);
      const [x0, y0] = pt(a0);
      const [x1, y1] = pt(Math.min(per - 0.01, a0 + per / 60));
      p.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 3, color: 0xffffff, alpha: 0.35 });
    }
    const name = ringText({ text: ads.def.billboard?.label || '', style: { fontFamily: FONT, fontSize: h * 0.32, fontWeight: '700', fill: 0xffffff, letterSpacing: 4 } });
    name.anchor.set(0.5);
    name.position.set(0, -h * 0.58);
    const sub = ringText({ text: ads.def.billboard?.sub || 'место под картинку', style: { fontFamily: FONT, fontSize: h * 0.11, fontWeight: '500', fill: 0xc9ceda, letterSpacing: 2 } });
    sub.anchor.set(0.5);
    sub.position.set(0, -h * 0.25);
    c.addChild(p, name, sub);
  }
  // light spill
  const glow = new PIXI.Graphics();
  glow.rect(-w / 2 - 30, -h - 30, w + 60, h + 60).fill({ color: hexNum(ads.def.billboard?.glow || '#9fc4ff'), alpha: 0.08 });
  glow.blendMode = 'add';
  c.addChildAt(glow, 0);
  c.position.set(spot.x, -spot.y);
  if (spot.scale) c.scale.set(spot.scale);
  if (spot.tint) for (const ch of c.children) if (ch.tint !== undefined) ch.tint = hexNum(spot.tint);
  layer.c.addChild(c);
  return c;
}
