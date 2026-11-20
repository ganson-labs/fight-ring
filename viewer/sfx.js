// Viewer sound: the ring's recorded sounds (kit/arena/sounds, the same ones the judge mixes into clips), the stage's
// music and ambience loops and the fighters' lines. One AudioContext; buses for effects, lines, music, ambience
// and menus; the music ducks while someone speaks. Levels: render/sound.js MIX and each sound's catalogue gain.
import { SOUNDS, soundFile, MIX } from '../kit/arena/render/sound.js';

const BASE = new URL('../kit/arena/sounds/', import.meta.url).href;

export class Sfx {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.volume = 1;
    this.menuVolume = 1;
    this.buffers = new Map(); // file → Promise<AudioBuffer>
    this.beds = {}; // kind → { name, src, gain }
    this.lines = new Map();
  }

  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const c = this.ctx;
      this.master = c.createGain();
      const comp = c.createDynamicsCompressor(); // glue and a safety limit on the sum
      comp.threshold.value = -6;
      comp.knee.value = 6;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      this.master.connect(comp).connect(c.destination);
      this.bus = {};
      for (const k of ['sfx', 'voice', 'music', 'ambience', 'ui']) {
        this.bus[k] = c.createGain();
        this.bus[k].connect(this.master);
      }
      this.bus.sfx.gain.value = MIX.sfx;
      this.bus.voice.gain.value = MIX.voice;
      this.bus.music.gain.value = MIX.music;
      this.bus.ambience.gain.value = MIX.ambience;
      this.apply();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // seconds the loop of this kind has been playing (0 when it is not)
  bedTime(kind = 'music') {
    const b = this.beds[kind];
    return b?.src ? this.ctx.currentTime - b.t0 : 0;
  }

  apply() {
    if (!this.master) return;
    this.master.gain.value = this.on ? this.volume : 0;
    this.bus.ui.gain.value = this.menuVolume;
  }

  set(on, volume, menuVolume = this.menuVolume) {
    this.on = on;
    this.volume = volume;
    this.menuVolume = menuVolume;
    this.apply();
  }

  buffer(file) {
    if (!this.buffers.has(file)) {
      this.buffers.set(file, fetch(BASE + file).then((r) => {
        if (!r.ok) throw new Error(`${file}: ${r.status}`);
        return r.arrayBuffer();
      }).then((b) => this.ctx.decodeAudioData(b)).catch((e) => {
        console.warn('звук', e.message);
        this.buffers.delete(file);
        return null;
      }));
    }
    return this.buffers.get(file);
  }

  // warm the cache: names of the catalogue (all of them when omitted)
  preload(names = Object.keys(SOUNDS)) {
    if (!this.ctx) return;
    for (const n of names) for (const f of SOUNDS[n]?.files || []) this.buffer(f);
  }

  // one sound of the catalogue; delay in seconds
  play(name, gain = 1, variant = 0, delay = 0) {
    if (!this.on || !this.ctx) return;
    const s = SOUNDS[name];
    if (!s) return;
    const file = soundFile(name, variant);
    const when = this.ctx.currentTime + (delay || 0);
    this.buffer(file).then((buf) => {
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = gain * (s.gain ?? 1);
      src.connect(g).connect(s.kind === 'ui' ? this.bus.ui : this.bus.sfx);
      src.start(Math.max(when, this.ctx.currentTime));
    });
  }

  // the stage's loops: { music, ambience } names (render/sound.js stageBeds); null stops. Crossfades in 1.2 s.
  // at: seconds into the loop to start from (the site keeps the menu music going from page to page).
  bed({ music = null, ambience = null } = {}, fade = 1.2, at = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [kind, name] of [['music', music], ['ambience', ambience]]) {
      const cur = this.beds[kind];
      if (cur?.name === name) continue;
      if (cur) {
        cur.gain.gain.setTargetAtTime(0, t, fade / 4);
        cur.src.stop(t + fade * 1.5);
        delete this.beds[kind];
      }
      if (!name || !SOUNDS[name]) continue;
      const entry = { name };
      this.beds[kind] = entry;
      this.buffer(SOUNDS[name].files[0]).then((buf) => {
        if (!buf || this.beds[kind] !== entry) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const g = this.ctx.createGain();
        g.gain.value = 0;
        g.gain.setTargetAtTime(SOUNDS[name].gain ?? 0.3, this.ctx.currentTime, fade / 3);
        src.connect(g).connect(this.bus[kind]);
        src.start(0, at > 0 ? at % buf.duration : 0);
        entry.t0 = this.ctx.currentTime - (at > 0 ? at % buf.duration : 0);
        entry.src = src;
        entry.gain = g;
      });
    }
  }

  // base: URL of a folder with voice/<id>.mp3; the music ducks while the line plays
  line(base, id) {
    if (!this.on || !base || !this.ctx) return;
    const url = `${base}voice/${id}.mp3`;
    if (!this.lines.has(url)) this.lines.set(url, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? this.ctx.decodeAudioData(b) : null)).catch(() => null));
    this.lines.get(url).then((buf) => {
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.bus.voice);
      const t = this.ctx.currentTime;
      src.start(t);
      const m = this.bus.music.gain;
      m.cancelScheduledValues(t);
      m.setTargetAtTime(MIX.music * MIX.duck, t, 0.06);
      m.setTargetAtTime(MIX.music, t + buf.duration, 0.3);
    });
  }
}
