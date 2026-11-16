// Plays a fight in real time: steps the engine, slows time for supers and the knockout, feeds the scene.
import { stepFight } from '../engine/sim.js';

export class Player {
  // source(fight, index) -> actions for this step or null; returns undefined when the recording ends.
  constructor({ fight, source, scene, maxSteps = Infinity }) {
    this.fight = fight;
    this.source = source;
    this.scene = scene;
    this.i = 0;
    this.acc = 0;
    this.done = false;
    this.maxSteps = maxSteps;
    this.paused = false;
    this.speed = 1;
    this.onEvents = null;
  }

  timeScale() {
    const f = this.fight;
    const s = this.scene;
    if (f.freeze > 0) return 0.6;
    if (s.koFx && s.koFx.t < 1.6 && s.koFx.reason === 'ko') return 0.28;
    if (s.superFx && !s.superFx.out) return s.superFx.d.slowmo ?? 0.5;
    return 1;
  }

  advance(dt) {
    if (!this.paused && !this.done) {
      this.acc += dt * 60 * this.timeScale() * this.speed;
      let n = 0;
      while (this.acc >= 1 && n < 16) {
        this.acc -= 1;
        n++;
        if (this.i >= this.maxSteps) {
          this.done = true;
          break;
        }
        const acts = this.source(this.fight, this.i);
        if (acts === undefined) {
          this.done = true;
          break;
        }
        this.i++;
        this.scene.interp = this.fight.f.map((F) => [F.x, F.y]);
        const ev = stepFight(this.fight, acts);
        this.scene.handle(ev, this.fight);
        this.onEvents?.(ev, this.fight, this.i);
      }
      if (n === 16) this.acc = 0;
    }
    const sub = this.fight.freeze > 0 || this.fight.hitstop > 0 ? 0 : Math.min(this.acc, 1);
    this.scene.draw(this.fight, dt, sub);
  }
}
