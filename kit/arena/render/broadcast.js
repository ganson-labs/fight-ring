// The broadcast of one fight, frame by frame: VS presentation, round board, the fight, the winner's moment,
// the round result, and in a deciding round the knockout replay from another camera, the match winner and the
// sponsor's card. The lab (recorded clips) and the viewer (live screen) both drive it, so they show the same.
import { createFight, stepFight, ringLine } from '../engine/index.js';
import { Player } from './player.js';
import { Show } from './show.js';
import { soundsFor } from './sound.js';
import { CostPlate, CardFlip } from './ads.js';

export class Broadcast {
  // opts: { app, scene, assets: [A, B], fight, source, steps (recording, for the replay), names, width, height, vertical,
  //   show, intro, final, round (by the match's course), rerun (a replay after a draw), wins, firstTo, ads, banner, totalTicks, onSound(name, gain, variant, delay), onSay(side, line) }
  constructor(o) {
    Object.assign(this, { onSound: () => {}, onSay: () => {} }, o);
    const { app, scene, assets, width: W, height: H, vertical, names = [] } = o;
    this.defs = assets.map((a) => a.def);
    this.endStep = null;
    const src = o.source;
    this.player = new Player({ fight: o.fight, source: (f, i) => {
      const a = src(f, i);
      return a === undefined && this.phase?.kind === 'after' ? null : a;
    }, scene });
    this.player.onEvents = (ev, f, i) => {
      for (const e of ev) {
        if (e.type === 'say') this.onSay(e.side, e.line);
        for (const snd of soundsFor(e, f.tick, this.defs)) this.onSound(snd.name, snd.gain, snd.variant, snd.at || 0);
        if (e.type === 'end' && this.endStep === null) {
          this.endStep = i;
          if (o.show) this.ring(e.reason === 'ko' ? (e.double ? 'double_ko' : 'ko') : e.winner === null ? 'draw' : 'time');
        }
      }
    };
    if (o.show) scene.matchInfo = { round: o.round, rerun: !!o.rerun, wins: o.wins, firstTo: o.firstTo };
    this.board = new Show(app, { width: W, height: H, vertical, assets, names, wins: o.wins || [0, 0], round: o.round || 1, rerun: !!o.rerun, firstTo: o.firstTo || 2, scene });
    this.plate = o.ads ? new CostPlate(app, o.ads, { width: W, height: H, vertical }) : null;
    const phases = [];
    if (o.show && o.intro) phases.push({ kind: 'vs' });
    if (o.show) phases.push({ kind: 'board' });
    phases.push({ kind: 'fight' });
    if (o.show) phases.push({ kind: 'after', dur: 2.4 });
    // result: false — the caller shows the round result on its own screen (the game, viewer/game/screens.js)
    if (o.show && !o.final && o.result !== false) phases.push({ kind: 'result' });
    if (o.show && o.final) phases.push({ kind: 'replay' }, { kind: 'final' });
    if (o.show && o.final && o.ads?.def.cardFlip && o.ads.def.cardFlip.enabled !== false) phases.push({ kind: 'card' });
    this.phases = phases;
    this.pi = -1;
    this.phase = null;
    this.fired = new Set();
    this.replayPlayer = null;
    this.card = null;
    this.tail = 0;
    this.next();
  }

  ring(line) {
    if (this.announcer) this.onSay('ring', line);
  }

  get done() {
    return !this.phase;
  }

  next() {
    const { scene, board, fight } = this;
    this.pi++;
    this.fired = new Set();
    const phase = (this.phase = this.phases[this.pi] || null);
    if (!phase) return;
    phase.t = 0;
    if (phase.kind === 'vs') board.vs();
    if (phase.kind === 'board') board.roundBoard();
    if (phase.kind === 'fight') {
      board.clear();
      if (this.banner !== false) scene.banner('БОЙ', 0xffffff, 0x8a1c1c, 1.3);
      if (this.show) {
        this.ring('fight');
        this.onSound('gong', 0.9, 0);
      }
    }
    if (phase.kind === 'result') {
      const after = [...this.wins];
      if (fight.winner !== null) after[fight.winner]++;
      board.roundResult(fight.winner, after, { reason: fight.endReason });
    }
    if (phase.kind === 'replay') {
      if (this.endStep === null || fight.endReason !== 'ko' || !this.steps?.length) return this.next();
      // the last seconds before the knockout again, slowed down, from a low close camera
      const from = Math.max(0, this.endStep - 110);
      const rf = createFight({ fighters: this.defs, seed: this.seed });
      for (let i = 0; i < from; i++) stepFight(rf, this.steps[i]);
      scene.reset(rf);
      scene.camMode = 'replay';
      scene.matchInfo = null;
      scene.hud.visible = false;
      const until = this.endStep + 70;
      const steps = this.steps;
      this.replayPlayer = new Player({ fight: rf, source: (f, i) => (from + i < until ? (from + i < steps.length ? steps[from + i] : null) : undefined), scene });
      this.replayPlayer.speed = 0.5;
      this.replayPlayer.onEvents = (ev, f) => {
        for (const e of ev) for (const snd of soundsFor(e, f.tick, this.defs)) this.onSound(snd.name, snd.gain * 0.8, snd.variant, snd.at || 0);
      };
      board.replayLabel({ dur: 999 });
    }
    if (phase.kind === 'final') {
      const w = fight.winner ?? 0;
      const after = [...this.wins];
      after[w]++;
      board.matchFinal(w, after);
      phase.dur = 5;
    }
    if (phase.kind === 'card') {
      board.clear();
      const loser = (fight.winner ?? 0) === 0 ? 1 : 0;
      this.card = new CardFlip(this.app, this.ads, { width: this.width, height: this.height, vertical: this.vertical, assets: this.assets, names: this.names, side: loser });
      this.onSound('vs-whoosh', 0.8, 0);
    }
  }

  cues() {
    const sc = this.board.screen;
    if (!sc?.cues) return;
    sc.cues.forEach((c, i) => {
      if (this.fired.has(i) || sc.t < c.at) return;
      this.fired.add(i);
      if (c.sound) this.onSound(c.sound, 1, 0);
      if (c.ring) this.ring(c.ring);
      if (c.line !== undefined) {
        const id = ringLine(this.defs[c.line], c.kind || 'intro');
        if (id) this.onSay(c.line, id);
      }
    });
  }

  frame(dt) {
    const { player, board } = this;
    const k = this.phase?.kind;
    if (!this.phase) {
      this.tail++;
      if (this.card) this.card.draw(dt);
      else if (!this.replayPlayer) player.advance(dt);
      else this.scene.draw(this.replayPlayer.fight, dt);
    } else if (k === 'vs' || k === 'board') {
      player.paused = true;
      player.advance(dt);
      board.update(dt);
      this.cues();
      if (!board.busy) this.next();
    } else if (k === 'fight') {
      player.paused = this.paused || false;
      player.advance(dt);
      if (player.done) {
        this.onRecordEnd?.(this.fight);
        if (this.show) player.done = false;
        this.next();
      }
    } else if (k === 'after') {
      this.phase.t += dt;
      player.advance(dt);
      if (this.phase.t >= this.phase.dur) this.next();
    } else if (k === 'result') {
      player.advance(dt);
      board.update(dt);
      if (!board.busy) this.next();
    } else if (k === 'replay') {
      this.replayPlayer.advance(dt);
      board.update(dt);
      if (this.replayPlayer.done) {
        board.clear();
        this.next();
      }
    } else if (k === 'final') {
      this.phase.t += dt;
      board.update(dt);
      this.cues();
      if (this.phase.t >= this.phase.dur) this.next();
    } else if (k === 'card') {
      if (!this.card.draw(dt)) this.next();
    }
    if (this.plate) this.plate.draw(dt, this.fight.tick / (this.totalTicks || 1), k === 'fight' || k === 'after');
  }

  // drop everything this broadcast added on top of the scene
  destroy() {
    this.board.clear();
    this.board.root.destroy({ children: true });
    this.plate?.c?.destroy({ children: true });
    this.card?.c?.destroy({ children: true });
  }
}
