// Drawing of abilities: objects on the field, effects on fighters (label, icon, tint, particles), resource bars,
// and the fighter's own fx on ability events. Only draws: the state is the engine's, passed in every frame.
// The scene creates one AbilityFx and calls setFighters, reset, handle and draw (see scene.js).
import * as PIXI from 'pixi.js';
import { ringText, fitText } from './text.js';

const FONT = 'Oswald, "Arial Narrow", Impact, sans-serif';
const hexNum = (h) => parseInt(String(h || '#ffffff').slice(1), 16);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, k) => {
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k) << s;
  return ch(16) | ch(8) | ch(0);
};

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class AbilityFx {
  constructor(scene) {
    this.scene = scene;
    this.objLayer = new PIXI.Container();
    this.markLayer = new PIXI.Container();
    const w = scene.world;
    w.addChildAt(this.objLayer, w.getChildIndex(scene.projLayer) + 1);
    w.addChildAt(this.markLayer, w.getChildIndex(scene.debugLayer));
    this.hud = new PIXI.Container();
    this.hudG = new PIXI.Graphics();
    this.hud.addChild(this.hudG);
    const st = scene.app.stage;
    st.addChildAt(this.hud, st.getChildIndex(scene.hud) + 1);
    this.sprites = new Map();
    this.marks = [new Map(), new Map()];
    this.assets = [];
    this.resText = [[], []];
    this.loading = new Set();
    this.emit = 0;
  }

  setFighters(assets) {
    this.assets = assets;
    this.hud.removeChildren();
    this.hud.addChild(this.hudG);
    const k = this.scene.k;
    this.resText = assets.map((a) => (a.def.resources || []).map((r) => {
      const t = ringText({ text: r.name.toUpperCase(), style: { fontFamily: FONT, fontSize: 18 * k, fontWeight: '700', fill: 0xffffff, letterSpacing: 1 * k, stroke: { color: 0x000000, width: 3 * k } } });
      this.hud.addChild(t);
      return t;
    }));
  }

  reset() {
    for (const s of this.sprites.values()) s.c.destroy({ children: true });
    this.sprites.clear();
    for (const m of this.marks) {
      for (const v of m.values()) v.c.destroy({ children: true });
      m.clear();
    }
  }

  texture(side, path) {
    const a = this.assets[side];
    if (!path || !a) return null;
    if (a.textures[path]) return a.textures[path];
    const key = `${side}:${path}`;
    if (!this.loading.has(key)) {
      this.loading.add(key);
      PIXI.Assets.load({ src: `${a.base}${path}`, loadParser: 'loadTextures' }).then((t) => (a.textures[path] = t)).catch(() => console.warn('картинка способности не загрузилась', a.base + path));
    }
    return null;
  }

  abilityFx(side, moveId) {
    return (this.assets[side]?.def.movesById[moveId]?.fx || []).filter((f) => f.on === 'ability');
  }

  handle(events, fight) {
    const s = this.scene;
    for (const e of events) {
      switch (e.type) {
        case 'ability':
          for (const fx of this.abilityFx(e.side, e.move)) s.spawnFx(fx, e.side, fight);
          break;
        case 'abilityFx':
          for (const fx of this.abilityFx(e.side, e.move)) s.spawnFx(fx, e.side, fight, { x: e.x, y: e.y });
          break;
        case 'object':
          this.makeObject(e);
          break;
        case 'objectEnd': {
          const o = this.sprites.get(e.id);
          s.burst(e.x, e.y, { count: 14, color: hexNum(e.color), color2: 0xffffff, speed: 650, size: 0.8, seed: e.id * 7 });
          if (o) {
            o.c.destroy({ children: true });
            this.sprites.delete(e.id);
          }
          break;
        }
        case 'effect': {
          const F = fight.f[e.side];
          const color = hexNum(e.color);
          s.ring(F.x, F.y + 160, { color, size: 1.3, life: 0.35 });
          s.burst(F.x, F.y + 170, { count: 18, color, color2: 0xffffff, speed: 700, size: 0.9, seed: fight.tick * 11 + e.side });
          break;
        }
        case 'dot': {
          const eff = fight.f[e.side].effects.find((x) => x.id === e.id && x.from === e.from);
          const color = hexNum(eff?.color || this.assets[e.from]?.def.card.colors.accent);
          const r = rng(fight.tick * 5 + 3);
          for (let i = 0; i < 8; i++) s.addParticle(s.tex.streak, e.x + (r() - 0.5) * 60, e.y + (r() - 0.5) * 120, { vx: (r() - 0.5) * 300, vy: 200 + r() * 300, life: 0.25 + r() * 0.2, size: 0.45, color: r() > 0.3 ? color : 0xffffff, grav: -600 });
          break;
        }
        case 'stance': {
          const a = this.assets[e.side]?.def;
          s.popup(e.side, (e.name || 'ОБЫЧНАЯ СТОЙКА').toUpperCase(), hexNum(a?.card.colors.accent));
          break;
        }
        case 'abilityOff':
          console.warn(`способность ${e.script} бойца ${this.assets[e.side]?.def.card.name} отключена: ${e.reason}`);
          break;
        default:
          break;
      }
    }
  }

  makeObject(e) {
    const c = new PIXI.Container();
    const color = hexNum(e.color);
    const size = Math.max(e.w, e.h);
    if (e.glow) {
      const halo = new PIXI.Sprite(this.scene.tex.dot);
      halo.anchor.set(0.5);
      halo.blendMode = 'add';
      halo.tint = color;
      halo.alpha = e.image ? 0.4 : 0.9; // the fighter's own picture stays readable
      halo.scale.set((size * (e.image ? 1.8 : 2.4)) / 64);
      c.addChild(halo);
    }
    const holder = new PIXI.Container();
    c.addChild(holder);
    if (e.solid || !e.image) {
      const g = new PIXI.Graphics();
      if (e.solid) g.rect(-e.w / 2, -e.h / 2, e.w, e.h).fill({ color, alpha: 0.55 }).stroke({ width: 3, color: 0xffffff, alpha: 0.7 });
      else {
        g.roundRect(-e.w / 2, -e.h / 2, e.w, e.h, Math.min(e.w, e.h) / 2).fill({ color, alpha: 0.35 });
        const core = new PIXI.Sprite(this.scene.tex.dot);
        core.anchor.set(0.5);
        core.blendMode = 'add';
        core.scale.set((Math.min(e.w, e.h) * 1.2) / 64);
        holder.addChild(core);
      }
      holder.addChildAt(g, 0);
    }
    let label = null;
    if (e.label) {
      label = ringText({ text: e.label, style: { fontFamily: FONT, fontSize: 22, fontWeight: '700', fill: color, stroke: { color: 0x000000, width: 4 } } });
      label.anchor.set(0.5, 1);
      label.y = -e.h / 2 - 8;
      c.addChild(label);
    }
    this.objLayer.addChild(c);
    this.sprites.set(e.id, { c, holder, color, image: e.image, side: e.side, w: e.w, h: e.h, hasImage: false, acc: 0, particles: e.particles, label });
  }

  draw(fight, dt) {
    const s = this.scene;
    this.emit++;
    const r = rng(fight.tick * 977 + this.emit);
    // objects
    const live = new Set();
    for (const o of fight.objects) {
      if (o.dead) continue;
      live.add(o.id);
      let sp = this.sprites.get(o.id);
      if (!sp) {
        this.makeObject({ id: o.id, side: o.side, x: o.x, y: o.y, w: o.w, h: o.h, image: o.image, color: o.color, glow: o.glow, particles: o.particles, label: o.label, solid: o.solid });
        sp = this.sprites.get(o.id);
      }
      if (sp.image && !sp.hasImage) {
        const tex = this.texture(o.side, sp.image);
        if (tex) {
          const img = new PIXI.Sprite(tex);
          img.anchor.set(0.5);
          const k = Math.max(o.w, o.h) / Math.max(tex.width, tex.height);
          img.scale.set(k * 1.3);
          sp.holder.addChild(img);
          sp.hasImage = true;
          sp.img = img;
        }
      }
      sp.c.position.set(o.x, -o.y);
      sp.holder.scale.x = o.facing;
      if (sp.img) sp.img.rotation = Math.atan2(-o.vy, Math.abs(o.vx) || 1) * o.facing * 0.6;
      sp.c.alpha = clamp(o.life / 12, 0, 1) * clamp(o.age / 4, 0.3, 1);
      if (sp.particles) {
        sp.acc += dt * sp.particles;
        while (sp.acc >= 1) {
          sp.acc--;
          s.addParticle(s.tex.dot, o.x + (r() - 0.5) * o.w, o.y + (r() - 0.5) * o.h, { vx: -o.vx * 10 + (r() - 0.5) * 80, vy: (r() - 0.5) * 80 + 40, life: 0.3 + r() * 0.3, size: 0.35 + r() * 0.3, color: r() > 0.5 ? sp.color : 0xffffff, drag: 2 });
        }
      }
    }
    for (const [id, sp] of this.sprites) {
      if (!live.has(id)) {
        sp.c.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
    // effects on fighters
    fight.f.forEach((F, side) => {
      const marks = this.marks[side];
      const seen = new Set();
      let tint = 0xffffff;
      let row = 0;
      for (const e of F.effects) {
        const key = `${e.from}:${e.id}`;
        seen.add(key);
        const color = hexNum(e.color);
        if (tint === 0xffffff && (e.stop || e.speed < 1 || e.dot > 0 || e.taken > 1)) tint = mix(0xffffff, color, e.stop ? 0.6 : 0.4 + 0.1 * Math.sin(s.time * 10));
        // the effect's label is a chip under the fighter's health bar (the HUD), not a stack over the fighters
        let m = marks.get(key);
        if (!m && (e.label || e.icon)) {
          const k = s.k || 1;
          const c = new PIXI.Container();
          const text = ringText({ text: e.label || '', style: { fontFamily: FONT, fontSize: (s.vertical ? 20 : 22) * k, fontWeight: '700', fontStyle: 'italic', fill: color, letterSpacing: 1.5 * k, stroke: { color: 0x000000, width: 4 * k } } });
          text.anchor.set(side === 0 ? 0 : 1, 0);
          c.addChild(text);
          m = { c, text, icon: null, iconPath: e.icon, bar: new PIXI.Graphics(), born: s.time };
          c.addChild(m.bar);
          this.hud.addChild(c);
          marks.set(key, m);
        }
        if (m) {
          const k = s.k || 1;
          if (m.iconPath && !m.icon) {
            const tex = this.texture(e.from, m.iconPath);
            if (tex) {
              m.icon = new PIXI.Sprite(tex);
              m.icon.anchor.set(side === 0 ? 0 : 1, 0);
              m.icon.scale.set((26 * k) / Math.max(tex.width, tex.height));
              m.c.addChild(m.icon);
            }
          }
          const dir = side === 0 ? 1 : -1;
          const iconW = m.icon ? 30 * k : 0;
          if (m.icon) m.icon.x = 0;
          m.text.x = dir * iconW;
          const w = iconW + m.text.width;
          const left = clamp(e.left / e.ticks, 0, 1);
          m.bar.clear();
          const bx = dir > 0 ? 0 : -w;
          const by = m.text.height + 2 * k;
          m.bar.rect(bx, by, w, 4 * k).fill({ color: 0x000000, alpha: 0.6 });
          m.bar.rect(dir > 0 ? bx : bx + w * (1 - left), by, w * left, 4 * k).fill({ color });
          m.w = w;
          // appears with a slide, fades out at its end
          const age = s.time - m.born;
          m.c.alpha = clamp(age / 0.18, 0, 1) * clamp(e.left / 12, 0, 1);
          m.row = row;
          row++;
        }
        if (e.particles) {
          const n = Math.floor(e.particles * dt + r());
          for (let i = 0; i < n; i++) s.addParticle(s.tex.dot, F.x + (r() - 0.5) * 80, F.y + 20 + r() * 260, { vx: (r() - 0.5) * 60, vy: 80 + r() * 120, life: 0.4 + r() * 0.4, size: 0.3 + r() * 0.35, color: r() > 0.35 ? color : 0xffffff, drag: 1.2 });
        }
      }
      for (const [key, m] of marks) {
        if (!seen.has(key)) {
          m.c.destroy({ children: true });
          marks.delete(key);
        }
      }
      const rig = s.rigs?.[side];
      if (rig) rig.root.tint = tint;
      this.layoutChips(side);
    });
    this.drawResources(fight);
  }

  // The effect chips of one side in a row under its name in the HUD, from its bar's outer edge inwards; at most
  // three, the newest first (older ones wait their turn).
  layoutChips(side) {
    const s = this.scene;
    const g = s.hudOn && s.hudGeo;
    const k = s.k || 1;
    const list = [...this.marks[side].values()].sort((a, b) => b.born - a.born);
    const y = g ? g.top + g.barH + (s.vertical ? 96 : 104) * k : 16 * k;
    const x0 = g ? (side === 0 ? s.Wpx / 2 - g.gap / 2 - g.barW : s.Wpx / 2 + g.gap / 2 + g.barW) : side === 0 ? 24 * k : s.Wpx - 24 * k;
    let x = x0;
    list.forEach((m, i) => {
      m.c.visible = i < 3;
      if (!m.c.visible) return;
      const slide = (1 - clamp((s.time - m.born) / 0.18, 0, 1)) * 18 * k;
      m.c.position.set(x + (side === 0 ? -slide : slide), y);
      x += (side === 0 ? 1 : -1) * ((m.w || 0) + 18 * k);
    });
  }

  // Resource bars under the super meter. scene.meterGeo[side] = { x, y, w, h } wins when the scene provides it.
  drawResources(fight) {
    const s = this.scene;
    const g = this.hudG;
    g.clear();
    if (!s.hudOn) return;
    const k = s.k;
    fight.f.forEach((F, side) => {
      const list = F.def.resources || [];
      if (!list.length) return;
      const left = side === 0;
      const geo = s.meterGeo?.[side] || (() => {
        const w = (s.vertical ? 300 : 420) * k;
        return { x: left ? 60 * k : s.Wpx - 60 * k - w, y: s.Hpx - (s.vertical ? 150 : 60) * k, w, h: 18 * k };
      })();
      list.forEach((res, i) => {
        const h = 8 * k;
        const y = geo.y + geo.h + 10 * k + i * (h + 8 * k);
        const v = clamp((F.res[res.id] ?? 0) / res.max, 0, 1);
        const color = hexNum(res.color || this.assets[side]?.def.card.colors.accent);
        g.rect(geo.x - 3 * k, y - 3 * k, geo.w + 6 * k, h + 6 * k).fill({ color: 0x000000, alpha: 0.7 });
        g.rect(geo.x, y, geo.w, h).fill({ color: 0x24262e });
        if (v > 0) g.rect(left ? geo.x : geo.x + geo.w * (1 - v), y, geo.w * v, h).fill({ color });
        const t = this.resText[side]?.[i];
        if (t) {
          t.anchor.set(left ? 0 : 1, 0.5);
          t.position.set(left ? geo.x + geo.w + 10 * k : geo.x - 10 * k, y + h / 2);
        }
      });
    });
  }
}
