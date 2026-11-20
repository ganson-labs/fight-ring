// Fights in the game: a recorded round of a match, a whole match as a show, a fight of two brains computed here,
// and a live fight of a player against a brain. All go through the same broadcast as the judge's clips.
import * as PIXI from 'pixi.js';
import * as E from '../../kit/arena/engine/index.js';
import { loadFighterAssets, loadStage } from '../../kit/arena/render/assets.js';
import { Scene } from '../../kit/arena/render/scene.js';
import { Broadcast } from '../../kit/arena/render/broadcast.js';
import { loadAds, attachBillboard } from '../../kit/arena/render/ads.js';
import { BrainHost } from '../brain-host.js';
import { at } from '../data.js';
import { Controls } from './input.js';
import { stageBeds } from '../../kit/arena/render/sound.js';

const assetCache = new Map();
export function fighterAssets(url) {
  if (!assetCache.has(url)) assetCache.set(url, loadFighterAssets(url).catch((e) => {
    assetCache.delete(url);
    throw e;
  }));
  return assetCache.get(url);
}

const stageCache = new Map();
export function stageAssets(dir, { hd = true } = {}) {
  if (!dir) return Promise.resolve(null);
  const key = `${dir}|${hd}`;
  if (!stageCache.has(key)) stageCache.set(key, loadStage(dir, { hd }));
  return stageCache.get(key);
}

export const expand = (runs) => runs.flatMap(([n, s]) => Array(n).fill(s));

// Two brains fight here, in Web Workers, by the ring's rules; the recording is then shown like a round.
export async function computeFight(urls, assets, { seed = E.RING_SEED, options = {}, progress = () => {} } = {}) {
  const hosts = urls.map((u, i) => new BrainHost(`${u}brain.js`, assets[i].def.card.name));
  try {
    await Promise.all(hosts.map((h) => h.load()));
    const fight = E.createFight({ fighters: assets.map((a) => a.def), seed });
    await Promise.all(hosts.map((h, s) => h.init({ side: s, opponent: { name: assets[1 - s].def.card.name }, options, view: E.brainView(fight, s) })));
    const steps = [];
    let tail = 0;
    let shown = 0;
    while (tail < 150 && fight.tick < E.ROUND_TICKS + 600) {
      let acts = null;
      if (!fight.over && !fight.freeze && !fight.hitstop) acts = (await Promise.all(hosts.map((h, s) => h.tick(E.brainView(fight, s))))).map((a) => E.sanitizeAction(a));
      steps.push(acts);
      E.stepFight(fight, acts);
      if (fight.over) tail++;
      if (performance.now() - shown > 200) {
        shown = performance.now();
        progress(fight.tick / E.ROUND_TICKS);
      }
    }
    return { steps, seed, hash: E.fightHash(fight), winner: fight.winner, reason: fight.endReason };
  } finally {
    hosts.forEach((h) => h.dispose());
  }
}

// The fight screen: one PIXI app in #frame, a scene and a broadcast at a time.
export class FightView {
  constructor({ frame, settings, sfx }) {
    this.frame = frame;
    this.settings = settings;
    this.sfx = sfx;
    this.app = null;
    this.bc = null;
    this.scene = null;
    this.raf = 0;
    this.run = 0;
    this.paused = false;
  }

  async ensure() {
    const vertical = this.settings().aspect === '9:16';
    const [w, h] = vertical ? [1080, 1920] : [1920, 1080];
    // one app per frame shape, kept for the whole session: destroying a PIXI app breaks the others
    this.apps ||= {};
    const key = `${w}x${h}`;
    if (!this.apps[key]) {
      const app = new PIXI.Application();
      await app.init({ width: w, height: h, background: 0x07080c, antialias: true, preference: 'webgl', autoStart: false, resolution: 1, autoDensity: false, powerPreference: 'high-performance' });
      this.apps[key] = app;
    }
    this.app = this.apps[key];
    this.W = w;
    this.H = h;
    if (!this.bgCanvas) {
      // the letterbox: the same picture, small and blurred, fills the window where its shape is not the frame's
      this.bgCanvas = document.createElement('canvas');
      this.bgCanvas.className = 'frame-bg';
      this.bgCanvas.width = 192;
      this.bgCanvas.height = 108;
      this.bgCtx = this.bgCanvas.getContext('2d');
      window.addEventListener('resize', () => this.fit());
      document.addEventListener('fullscreenchange', () => this.fit());
    }
    if (this.app.canvas.parentNode !== this.frame) this.frame.replaceChildren(this.bgCanvas, this.app.canvas);
    this.frame.hidden = false;
    this.fit();
    return { W: w, H: h, vertical };
  }

  // The frame fills the window by its larger fitting side and renders at the window's real pixels
  // (devicePixelRatio included); the quality setting caps the pixel density.
  fit() {
    if (!this.app) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const s = Math.min(vw / this.W, vh / this.H);
    const cssW = Math.round(this.W * s);
    const cssH = Math.round(this.H * s);
    const c = this.app.canvas;
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    const high = (this.settings().quality || 'high') === 'high';
    const dpr = Math.min(window.devicePixelRatio || 1, high ? 2 : 1);
    // at most 4K worth of pixels on the high setting, 1080p on the medium one
    // never below the frame's own pixels (filters cut the picture below 1), at most 4K on the high setting
    const res = Math.max(1, Math.min(s * dpr, high ? 3840 / Math.max(this.W, this.H) : 1));
    if (Math.abs((this.app.renderer.resolution || 1) - res) > 0.01) this.app.renderer.resize(this.W, this.H, res);
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    this.bgCanvas.style.display = cssW < vw - 2 || cssH < vh - 2 ? 'block' : 'none';
    // where the frame is, for the overlays drawn over it (the controls hint)
    const r = document.documentElement.style;
    r.setProperty('--frame-w', `${cssW}px`);
    r.setProperty('--frame-h', `${cssH}px`);
    r.setProperty('--frame-b', `${Math.round((vh - cssH) / 2)}px`);
  }

  // copies the frame into the blurred letterbox now and then (right after a render, while the buffer is fresh)
  letterbox() {
    if (!this.bgCanvas || this.bgCanvas.style.display === 'none') return;
    this.lbTick = (this.lbTick || 0) + 1;
    if (this.lbTick % 6) return;
    try {
      this.bgCtx.drawImage(this.app.canvas, 0, 0, this.bgCanvas.width, this.bgCanvas.height);
    } catch {}
  }

  // Shows one broadcast; resolves when it is over (or stopped). o: { assets, urls, names, stage, steps|source,
  // show: { round, rerun, wins, firstTo, final }, intro, seed, onFrame }
  async show(o) {
    const id = ++this.run;
    const { W, H, vertical } = await this.ensure();
    const app = this.app;
    cancelAnimationFrame(this.raf);
    this.bc?.destroy();
    app.stage.removeChildren();
    const scene = new Scene(app, { width: W, height: H, vertical, names: o.names, quality: this.settings().quality || 'high' });
    scene.setStage(o.stage);
    const ads = this.settings().ads ? await loadAds(at('ads/demo/'), { force: true }).catch(() => null) : null;
    if (ads) attachBillboard(scene, ads);
    scene.setFighters(o.assets);
    const fight = E.createFight({ fighters: o.assets.map((a) => a.def), seed: o.seed ?? E.RING_SEED });
    scene.reset(fight);
    const steps = o.steps || [];
    const source = o.source || ((f, i) => (i < steps.length ? steps[i] : undefined));
    const bc = new Broadcast({
      app, scene, assets: o.assets, fight, steps, source, names: o.names, width: W, height: H, vertical, show: true, intro: o.intro !== false,
      ...o.show, ads, announcer: true, totalTicks: o.totalTicks || 1, seed: o.seed ?? E.RING_SEED,
      onSound: (name, gain, variant, delay) => this.sfx.play(name, gain, variant, delay),
      onSay: (side, line) => this.sfx.line(side === 'ring' ? at('announcer/') : o.urls[side], line),
    });
    this.bc = bc;
    this.fight = fight;
    this.sfx.bed(stageBeds(o.stage));
    this.scene = scene;
    this.paused = false;
    return new Promise((resolve) => {
      let last = performance.now();
      const loop = (now) => {
        if (id !== this.run) return resolve({ stopped: true });
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!this.paused) {
          o.onFrame?.(dt, bc, fight);
          bc.frame(dt);
        }
        try {
          app.render();
          this.letterbox();
        } catch (e) {
          console.error('[бой]', e);
        }
        if (bc.done && bc.tail > 45) return resolve({ fight, stopped: false });
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    });
  }

  pause(on) {
    this.paused = on;
  }

  stop() {
    this.run++;
    this.sfx.bed({});
    cancelAnimationFrame(this.raf);
    this.bc?.destroy();
    this.bc = null;
    if (this.app) this.app.stage.removeChildren();
    this.frame.hidden = true;
  }
}

// A live fight: the player on the left against a brain on the right. Rounds until one side has two wins.
export class LiveMatch {
  constructor(view, { me, cpu, stage, names, onRound }) {
    Object.assign(this, { view, me, cpu, stage, names, onRound });
    this.wins = [0, 0];
    this.round = 1;
    this.rerun = false;
    this.stopped = false;
  }

  async playRound() {
    const assets = [this.me.assets, this.cpu.assets];
    const host = new BrainHost(`${this.cpu.url}brain.js`, assets[1].def.card.name);
    await host.load();
    const seed = E.RING_SEED + this.round * 7919;
    const probe = E.createFight({ fighters: assets.map((a) => a.def), seed });
    await host.init({ side: 1, opponent: { name: assets[0].def.card.name }, options: {}, view: E.brainView(probe, 1) });
    const controls = new Controls(assets[0].def);
    this.controls = controls;
    let cpuAct = null;
    let inflight = false;
    let tail = 0;
    const steps = [];
    const source = (f) => {
      if (f.over) {
        tail++;
        if (tail > 150) return undefined;
      }
      let acts = null;
      if (!f.over && !f.freeze && !f.hitstop) {
        if (!inflight) {
          inflight = true;
          host.tick(E.brainView(f, 1)).then((a) => {
            cpuAct = a;
            inflight = false;
          });
        }
        acts = [E.sanitizeAction(controls.act(f, 0)), E.sanitizeAction(cpuAct)];
      }
      steps.push(acts);
      return acts;
    };
    // the broadcast is built before the result is known: when this round decides the match, its ending
    // becomes the match's ending (knockout replay and the winner) instead of the round result
    let patched = false;
    let fightOn = false;
    const onFrame = (dt, bc, f) => {
      if (!fightOn && bc.phase?.kind === 'fight') {
        fightOn = true;
        this.onFight?.();
      }
      if (patched || !f.over || bc.phase?.kind !== 'after') return;
      patched = true;
      if (f.winner === null) return;
      const w = [...this.wins];
      w[f.winner]++;
      if (w[0] < 2 && w[1] < 2) return;
      const at = bc.phases.findIndex((p) => p.kind === 'result');
      if (at >= 0) bc.phases.splice(at, 1, { kind: 'replay' }, { kind: 'final' });
      else bc.phases.push({ kind: 'replay' }, { kind: 'final' });
    };
    try {
      const res = await this.view.show({
        assets, urls: [this.me.url, this.cpu.url], names: this.names, stage: this.stage, steps, source, seed,
        show: { round: this.round, rerun: this.rerun, wins: [...this.wins], firstTo: 2, final: false, result: false }, intro: this.round === 1, totalTicks: E.ROUND_TICKS, onFrame,
      });
      if (res.stopped) return res;
      const f = res.fight;
      if (f.winner === null) this.rerun = true;
      else {
        this.wins[f.winner]++;
        this.round++;
        this.rerun = false;
      }
      return { ...res, winner: f.winner, reason: f.endReason, steps, seed, over: this.wins[0] >= 2 || this.wins[1] >= 2 };
    } finally {
      controls.dispose();
      host.dispose();
      this.controls = null;
    }
  }
}
