// Broadcast screens around a fight, drawn in the same WebGL frame (so they land in recorded clips too):
// the VS presentation with both fighters' cards, the round board, the round result, the replay label and
// the match final. Each screen is a timed overlay; the lab and the viewer drive them in order.
import * as PIXI from 'pixi.js';
import { ringText, fitText } from './text.js';
import { solvePose, sampleAnim } from '../engine/index.js';
import { Rig } from './scene.js';
import { buildVersus } from './versus.js';

const FONT = 'Oswald, "Arial Narrow", Impact, sans-serif';
const hexNum = (h) => parseInt(String(h || '#ffffff').slice(1), 16);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeOut = (k) => 1 - (1 - clamp(k, 0, 1)) ** 3;

export class Show {
  // assets: [left, right] fighter assets; names: model names; wins: [left, right] before this round.
  constructor(app, { width, height, vertical, assets, names = [], wins = [0, 0], round = 1, rerun = false, firstTo = 2, scene = null }) {
    this.app = app;
    this.W = width;
    this.H = height;
    this.vertical = vertical;
    this.k = vertical ? width / 1080 : width / 1920;
    this.assets = assets;
    this.names = names;
    this.wins = wins;
    this.round = round;
    this.rerun = !!rerun;
    this.scene = scene;
    this.hidden = null;
    this.ownTextures = [];
    this.firstTo = firstTo;
    this.root = new PIXI.Container();
    app.stage.addChild(this.root);
    this.screen = null;
  }

  text(text, size, fill, { weight = '700', italic = true, spacing = 2, stroke = 6, align = 'left', wrap = 0 } = {}) {
    const t = ringText({ text, style: { fontFamily: FONT, fontSize: size * this.k, fontWeight: weight, fontStyle: italic ? 'italic' : 'normal', fill, letterSpacing: spacing * this.k, stroke: stroke ? { color: 0x000000, width: stroke * this.k } : undefined, align, ...(wrap ? { wordWrap: true, wordWrapWidth: wrap * this.k } : {}) } });
    return t;
  }

  clear() {
    if (this.hidden) for (const l of this.hidden) l.visible = l.__vsVis ?? true;
    this.hidden = null;
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }));
    for (const t of this.ownTextures) t.destroy(true);
    this.ownTextures = [];
    this.root.alpha = 1;
    this.screen = null;
  }

  get busy() {
    return !!this.screen && this.screen.t < this.screen.dur;
  }

  update(dt) {
    const s = this.screen;
    if (!s) return;
    s.t += dt;
    s.tick?.(s.t, dt);
    if (s.t >= s.dur && s.autoClear) this.clear();
  }

  // ---------- fighter figure ----------

  figure(side, anim = 'intro', scale = 1) {
    const a = this.assets[side];
    const rig = new Rig(a);
    const holder = new PIXI.Container();
    holder.addChild(rig.root);
    const def = a.def;
    holder.__pose = (t) => {
      const an = def.anims[anim] || def.anims.idle;
      rig.apply(solvePose(sampleAnim(an, t * 60)));
    };
    holder.__pose(0);
    rig.root.scale.set(scale * this.k, scale * this.k);
    return holder;
  }

  // ---------- VS ----------

  vs(opts = {}) {
    this.clear();
    this.screen = { t: 0, autoClear: true, ...buildVersus(this, opts) };
    this.screen.tick(0, 0);
    return this.screen;
  }

  // The round by the match's course: a rerun after a draw keeps its number, 1:1 is the deciding round.
  get decider() {
    return this.wins[0] === this.firstTo - 1 && this.wins[1] === this.firstTo - 1;
  }

  roundTitle() {
    const head = this.decider ? 'РЕШАЮЩИЙ РАУНД' : `РАУНД ${this.round}`;
    return this.rerun ? `${head} · ПЕРЕИГРОВКА` : head;
  }

  // the VS hides the fight scene under its own blurred copy; clear() brings it back
  hideScene(layers) {
    this.hidden = layers;
    for (const l of layers) l.visible = false;
  }

  // ---------- round board ----------

  roundBoard({ dur = 2.4 } = {}) {
    this.clear();
    const c = this.root;
    const W = this.W;
    const H = this.H;
    const k = this.k;
    const decider = this.decider;
    const band = new PIXI.Graphics();
    const title = this.text(decider ? 'РЕШАЮЩИЙ РАУНД' : `РАУНД ${this.round}`, this.vertical ? 120 : 150, 0xffffff, { stroke: 10, spacing: 10 });
    title.anchor.set(0.5);
    title.position.set(W / 2, H * 0.42);
    const fit = Math.min(1, (W * 0.9) / title.width);
    const sub = this.text(this.rerun ? 'ПЕРЕИГРОВКА ПОСЛЕ НИЧЬЕЙ' : decider ? `РАУНД ${this.round}` : 'ДО ДВУХ ПОБЕД', 34, 0xf3c64d, { spacing: 8, stroke: 5 });
    sub.anchor.set(0.5);
    sub.position.set(W / 2, H * 0.42 + 110 * k);
    const pips = new PIXI.Graphics();
    c.addChild(band, title, sub, pips);
    const draw = (t) => {
      const a = clamp(t / 0.15, 0, 1) * (1 - clamp((t - (dur - 0.3)) / 0.3, 0, 1));
      band.clear();
      band.rect(0, H * 0.42 - 120 * k, W, 280 * k).fill({ color: 0x000000, alpha: 0.6 * a });
      band.rect(0, H * 0.42 - 124 * k, W * clamp(t / 0.3, 0, 1), 4 * k).fill({ color: 0xf3c64d, alpha: a });
      band.rect(W * (1 - clamp(t / 0.3, 0, 1)), H * 0.42 + 156 * k, W, 4 * k).fill({ color: 0xf3c64d, alpha: a });
      title.alpha = a;
      title.scale.set(fit * (1 + 0.25 * (1 - easeOut(t / 0.25))));
      sub.alpha = clamp((t - 0.3) / 0.3, 0, 1) * a;
      pips.clear();
      [0, 1].forEach((side) => {
        const accent = hexNum(this.assets[side].def.card.colors.accent);
        for (let i = 0; i < this.firstTo; i++) {
          const x = side === 0 ? W / 2 - 220 * k - i * 50 * k : W / 2 + 220 * k + i * 50 * k;
          const y = H * 0.42 + 200 * k;
          pips.circle(x, y, 15 * k).fill({ color: i < this.wins[side] ? accent : 0x24262e, alpha: a }).stroke({ width: 3 * k, color: 0xffffff, alpha: 0.5 * a });
        }
      });
    };
    this.screen = { t: 0, dur, tick: draw, autoClear: true, cues: [{ at: 0, sound: 'gong' }, { at: 0.2, ring: decider ? 'round_final' : `round_${this.round}` }] };
    draw(0);
    return this.screen;
  }

  // ---------- after the round ----------

  roundResult(winnerSide, wins, { dur = 3, reason = 'ko' } = {}) {
    this.clear();
    const c = this.root;
    const W = this.W;
    const H = this.H;
    const k = this.k;
    const draw0 = winnerSide === null;
    const def = draw0 ? null : this.assets[winnerSide].def;
    const accent = draw0 ? 0x9aa0b0 : hexNum(def.card.colors.accent);
    const g = new PIXI.Graphics();
    const head = this.text(draw0 ? 'НИЧЬЯ' : def.card.name.toUpperCase(), this.vertical ? 96 : 120, 0xffffff, { stroke: 9 });
    head.anchor.set(0.5);
    head.position.set(W / 2, H * 0.3);
    const subT = this.text(draw0 ? 'РАУНД ПЕРЕИГРЫВАЕТСЯ' : `ПОБЕДА В РАУНДЕ ${{ ko: '· НОКАУТ', time: '· ПО ВРЕМЕНИ' }[reason] || ''}`, 36, accent, { spacing: 6, stroke: 5 });
    subT.anchor.set(0.5);
    subT.position.set(W / 2, H * 0.3 + 100 * k);
    const score = this.text(`${wins[0]} : ${wins[1]}`, 110, 0xf3c64d, { stroke: 8, spacing: 6 });
    score.anchor.set(0.5);
    score.position.set(W / 2, H * 0.3 + 220 * k);
    c.addChild(g, head, subT, score);
    const draw = (t) => {
      const a = clamp(t / 0.25, 0, 1) * (1 - clamp((t - (dur - 0.35)) / 0.35, 0, 1));
      g.clear();
      g.rect(0, H * 0.3 - 110 * k, W, 420 * k).fill({ color: 0x000000, alpha: 0.62 * a });
      g.rect(0, H * 0.3 - 110 * k, W, 5 * k).fill({ color: accent, alpha: a });
      for (const o of [head, subT, score]) o.alpha = a;
      score.scale.set(1 + 0.3 * (1 - easeOut((t - 0.3) / 0.3)));
    };
    this.screen = { t: 0, dur, tick: draw, autoClear: true, cues: [] };
    draw(0);
    return this.screen;
  }

  replayLabel({ dur }) {
    this.clear();
    const c = this.root;
    const W = this.W;
    const H = this.H;
    const k = this.k;
    const bars = new PIXI.Graphics();
    const label = this.text('ПОВТОР', 44, 0xffffff, { spacing: 10, stroke: 5 });
    label.position.set(60 * k, (this.vertical ? 230 : 120) * k);
    const dot = new PIXI.Graphics();
    c.addChild(bars, label, dot);
    const draw = (t) => {
      const a = clamp(t / 0.3, 0, 1) * (1 - clamp((t - (dur - 0.3)) / 0.3, 0, 1));
      const bh = (this.vertical ? 180 : 110) * k * a;
      bars.clear();
      bars.rect(0, 0, W, bh).fill({ color: 0x000000 });
      bars.rect(0, H - bh, W, bh).fill({ color: 0x000000 });
      label.alpha = a;
      dot.clear();
      if (Math.floor(t * 2) % 2 === 0) dot.circle(40 * k, label.y + 30 * k, 10 * k).fill({ color: 0xe33b3b, alpha: a });
    };
    this.screen = { t: 0, dur, tick: draw, autoClear: false, cues: [] };
    draw(0);
    return this.screen;
  }

  matchFinal(winnerSide, wins, { dur = 5 } = {}) {
    this.clear();
    const c = this.root;
    const W = this.W;
    const H = this.H;
    const k = this.k;
    const def = this.assets[winnerSide].def;
    const accent = hexNum(def.card.colors.accent);
    const bg = new PIXI.Graphics();
    const fig = this.figure(winnerSide, 'victory', this.vertical ? 2.1 : 2.2);
    const crown = this.text('ПОБЕДИТЕЛЬ МАТЧА', this.vertical ? 56 : 60, 0xf3c64d, { spacing: 10, stroke: 6 });
    const name = this.text(def.card.name.toUpperCase(), this.vertical ? 110 : 140, 0xffffff, { stroke: 10 });
    const model = this.text((this.names[winnerSide] || '').toUpperCase(), 40, accent, { spacing: 8, stroke: 5 });
    const score = this.text(`${wins[0]} : ${wins[1]}`, 90, 0xffffff, { stroke: 7, spacing: 6 });
    for (const t of [crown, name, model, score]) t.anchor.set(0.5);
    c.addChild(bg, fig, crown, name, model, score);
    const draw = (t) => {
      const a = clamp(t / 0.4, 0, 1);
      bg.clear();
      bg.rect(0, 0, W, H).fill({ color: 0x05060a, alpha: 0.9 * a });
      for (let i = 0; i < 14; i++) {
        const ang = (i / 14) * Math.PI * 2 + t * 0.15;
        const cx = this.vertical ? W / 2 : W * 0.3;
        const cy = this.vertical ? H * 0.42 : H * 0.55;
        const r = Math.max(W, H);
        bg.poly([cx, cy, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, cx + Math.cos(ang + 0.12) * r, cy + Math.sin(ang + 0.12) * r]).fill({ color: accent, alpha: 0.12 * a });
      }
      fig.__pose(t);
      if (this.vertical) {
        fig.position.set(W / 2, H * 0.62);
        crown.position.set(W / 2, H * 0.08);
        name.position.set(W / 2, H * 0.7);
        model.position.set(W / 2, H * 0.7 + 100 * k);
        score.position.set(W / 2, H * 0.7 + 200 * k);
      } else {
        fig.position.set(W * 0.3, H * 0.92);
        crown.position.set(W * 0.68, H * 0.28);
        name.position.set(W * 0.68, H * 0.42);
        model.position.set(W * 0.68, H * 0.54);
        score.position.set(W * 0.68, H * 0.7);
      }
      const ka = (d) => clamp((t - d) / 0.35, 0, 1);
      fig.alpha = ka(0.1);
      crown.alpha = ka(0.3);
      name.alpha = ka(0.5);
      name.scale.set(1 + 0.2 * (1 - easeOut((t - 0.5) / 0.3)));
      model.alpha = ka(0.75);
      score.alpha = ka(1.0);
    };
    this.screen = { t: 0, dur, tick: draw, autoClear: false, cues: [{ at: 0.3, sound: 'impact-epic' }, { at: 0.6, sound: 'crowd' }, { at: 0.5, ring: 'match_winner' }, { at: 1.6, line: winnerSide, kind: 'victory' }] };
    draw(0);
    return this.screen;
  }
}
