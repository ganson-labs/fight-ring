// The live background behind the title and the menus. The opening (intro.js) plays on it first; behind the menus
// one of the stages shows the contestants of the roster: two of them fight with their own brains, one stands
// alone, none — the stage is empty. The sparring dummy and the kit's template never appear here. The scene is
// calm: no screen flashes and softer effects behind the menu items. Rendered at the window's real pixels.
import * as PIXI from 'pixi.js';
import * as E from '/kit/arena/engine/index.js';
import { Scene } from '/kit/arena/render/scene.js';
import { Player } from '/kit/arena/render/player.js';
import { BrainHost } from '../brain-host.js';

export class Backdrop {
  constructor(el) {
    this.el = el;
    this.app = null;
    this.raf = 0;
    this.running = false;
    this.hosts = [];
  }

  async ensure() {
    // one start for everyone: a second call while PIXI starts waits for the same start instead of using a half-made app
    this.starting ||= (async () => {
      const app = new PIXI.Application();
      await app.init({ width: 1920, height: 1080, background: 0x07080c, antialias: true, preference: 'webgl', autoStart: false, resolution: 1, autoDensity: false });
      this.el.appendChild(app.canvas);
      this.app = app;
      window.addEventListener('resize', () => this.fit());
    })();
    await this.starting;
    this.fit();
    return this.app;
  }

  // covers the window; renders at its real pixels (capped at 2 × 1080p)
  fit() {
    if (!this.app) return;
    const s = Math.max(window.innerWidth / 1920, window.innerHeight / 1080);
    const res = Math.max(1, Math.min(s * Math.min(window.devicePixelRatio || 1, 2), this.maxRes || 2)); // below 1 the filters cut the frame
    if (Math.abs(this.app.renderer.resolution - res) > 0.01) this.app.renderer.resize(1920, 1080, res);
    this.app.canvas.style.width = `${Math.ceil(1920 * s)}px`;
    this.app.canvas.style.height = `${Math.ceil(1080 * s)}px`;
  }

  // the opening on this canvas; resolves with the Intro (it keeps drawing its last frame until stopped)
  async intro(make) {
    this.stop();
    const app = await this.ensure();
    this.introRun = make(app);
    return this.introRun;
  }

  // behind the menus: assets/urls of 0–2 contestants and a stage
  async start({ assets, urls, stage }) {
    this.stop();
    const app = await this.ensure();
    app.stage.removeChildren();
    app.stage.position.set(0, 0);
    const scene = new Scene(app, { width: 1920, height: 1080, hud: false, calm: true });
    scene.setStage(stage);
    this.scene = scene;
    const alone = assets.length === 1;
    const two = alone ? [assets[0], assets[0]] : assets;
    if (!two.length) {
      // the stage on its own: a slow drift over it
      this.running = true;
      let t = 0;
      let prev = performance.now();
      scene.camFixed = { x: 1100, y: 230, zoom: 1.25 };
      const fake = this.filler ? E.createFight({ fighters: [this.filler.def, this.filler.def] }) : null;
      if (!fake) return;
      scene.setFighters([this.filler, this.filler]);
      scene.fighterLayer.visible = false;
      scene.shadows.visible = false;
      scene.reflections.visible = false;
      scene.reset(fake);
      const loop = (now) => {
        if (!this.running) return;
        const dt = Math.min(0.05, (now - prev) / 1000);
        prev = now;
        t += dt;
        scene.camFixed.x = 1100 + Math.sin(t * 0.08) * 260;
        if (!this.paused) {
          scene.draw(fake, dt);
          app.render();
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
      return;
    }
    scene.setFighters(two);
    if (alone) for (const x of [scene.rigs[1], scene.rims[1], scene.mirrors[1]]) if (x) x.root.visible = false;
    if (alone) scene.shadowSprites[1].visible = false;
    this.hosts = alone ? [] : urls.map((u, i) => new BrainHost(`${u}brain.js`, two[i].def.card.name));
    const ok = await Promise.all(this.hosts.map((h) => h.load().then(() => true, () => false)));
    let seed = E.RING_SEED;
    const newFight = async () => {
      seed += 101;
      const fight = E.createFight({ fighters: two.map((a) => a.def), seed });
      if (alone) {
        fight.f[0].x = 1100;
        fight.f[1].x = 1900;
      }
      await Promise.all(this.hosts.map((h, s) => (ok[s] ? h.init({ side: s, opponent: { name: two[1 - s].def.card.name }, options: {}, view: E.brainView(fight, s) }) : null)));
      scene.reset(fight);
      const last = [null, null];
      const busy = [false, false];
      let tail = 0;
      return new Player({
        fight, scene,
        source: (f) => {
          if (f.over && ++tail > 200) return undefined;
          if (alone) return [E.IDLE_ACTION, E.IDLE_ACTION];
          if (f.over || f.freeze || f.hitstop) return null;
          for (let s = 0; s < 2; s++) {
            if (!ok[s] || busy[s]) continue;
            busy[s] = true;
            this.hosts[s].tick(E.brainView(f, s)).then((a) => {
              last[s] = a;
              busy[s] = false;
            });
          }
          return last.map((a) => E.sanitizeAction(a));
        },
      });
    };
    let player = await newFight();
    if (alone) scene.camFixed = { x: 1100, y: 220, zoom: 1.6 };
    this.running = true;
    let prev = performance.now();
    let restarting = false;
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      if (!this.paused) {
        try {
          player.advance(dt);
          app.render();
        } catch (e) {
          console.error('[фон]', e);
        }
      }
      if (player.done && !restarting) {
        restarting = true;
        newFight().then((p) => {
          player = p;
          restarting = false;
        });
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause(on) {
    this.paused = on;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.introRun?.stop();
    this.introRun = null;
    this.hosts.forEach((h) => h.dispose());
    this.hosts = [];
  }
}
