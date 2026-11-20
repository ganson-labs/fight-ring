// Viewer sound: the ring's recorded sounds (kit/arena/sounds, the same ones the judge mixes into clips), the stage's
// music and ambience loops and the fighters' lines. One AudioContext; buses for effects, lines, music, ambience
// and menus; the music ducks while someone speaks. Levels: render/sound.js MIX and each sound's catalogue gain.
import { SOUNDS, soundFile, MIX } from '../kit/arena/render/sound.js';
import { SOUND_ALT } from '../kit/arena/sounds/catalog.js';

const BASE = new URL('../kit/arena/sounds/', import.meta.url).href;

// What a browser takes for a press that gives a page its sound. A finger is not a mouse: «pointerdown» and
// «touchstart» of a touch give nothing (HTML, «activation triggering input event»), the sound starts on the way up —
// «pointerup», «touchend», «click». A page that listened to «pointerdown» alone stayed silent on an iPhone for good:
// Safari wants the press at the very moment of resume(), an earlier one does not count.
export const GESTURES = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend', 'click'];

// The ring's sounds are Opus in Ogg. Safari decodes that from 18.4 on (iOS 18.4, macOS 15.4); an older one gets the
// AAC copy that lies beside every sound (scripts/build-sounds.mjs).
function decodesOgg() {
  try {
    return !!new Audio().canPlayType('audio/ogg; codecs="opus"');
  } catch {
    return true;
  }
}
const altOf = (file) => file.replace(/\.ogg$/, `.${SOUND_ALT}`);

// An iPhone treats Web Audio as the sound of a page that may be hushed: the switch on its side («без звука») mutes it,
// while a film in the same page plays on. A page that says it plays media is heard with the switch on:
// navigator.audioSession where Safari has it (16.4 and later); before that, an <audio> element that plays silence
// puts the whole page into the same class.
function loudOnPhone() {
  try {
    if (navigator.audioSession) {
      if (navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
      return;
    }
  } catch {}
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios) return;
  if (!loudOnPhone.el) {
    // a second of silence: 8-bit mono PCM, 8 kHz
    const n = 8000;
    const wav = new Uint8Array(44 + n).fill(128);
    const v = new DataView(wav.buffer);
    [0x52494646, 36 + n, 0x57415645, 0x666d7420].forEach((x, i) => v.setUint32(i * 4, x, i === 1));
    [16, 1 | (1 << 16), 8000, 8000, 1 | (8 << 16)].forEach((x, i) => v.setUint32(16 + i * 4, x, true));
    v.setUint32(36, 0x64617461);
    v.setUint32(40, n, true);
    const el = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
    el.loop = true;
    el.setAttribute('playsinline', '');
    loudOnPhone.el = el;
    document.addEventListener('visibilitychange', () => document.hidden && el.pause());
  }
  if (loudOnPhone.el.paused) loudOnPhone.el.play().catch(() => {});
}

export class Sfx {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.volume = 1;
    this.menuVolume = 1;
    this.musicVolume = 1;
    this.buffers = new Map(); // file → Promise<AudioBuffer>
    this.beds = {}; // kind → { name, src, gain }
    this.lines = new Map();
    this.alt = !decodesOgg(); // the AAC copies instead of Opus in Ogg
  }

  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
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
    if (this.on) loudOnPhone();
    // «interrupted» is an iPhone's third state: a call or another app took the sound away
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // the promise of every browser and the callbacks of Safari before 14.1
  decode(bytes) {
    return new Promise((res, rej) => this.ctx.decodeAudioData(bytes, res, rej)?.catch?.(rej));
  }

  async load(file) {
    const r = await fetch(BASE + file);
    if (!r.ok) throw new Error(`${file}: ${r.status}`);
    const bytes = await r.arrayBuffer();
    try {
      return await this.decode(bytes);
    } catch (e) {
      // a browser that says it plays Opus in Ogg and does not decode it: the AAC copies from here on
      if (this.alt || !file.endsWith('.ogg')) throw new Error(`${file}: ${e?.message || 'не декодируется'}`);
      this.alt = true;
      return this.load(altOf(file));
    }
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
    this.bus.music.gain.value = MIX.music * this.musicVolume;
  }

  set(on, volume, menuVolume = this.menuVolume, musicVolume = this.musicVolume) {
    this.on = on;
    this.volume = volume;
    this.menuVolume = menuVolume;
    this.musicVolume = musicVolume;
    this.apply();
  }

  buffer(file) {
    if (!this.buffers.has(file)) {
      this.buffers.set(file, this.load(this.alt ? altOf(file) : file).catch((e) => {
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

  // one sound of the catalogue; delay in seconds; from: seconds into the sound to start at (a press that was cut
  // by a change of pages is finished on the next page)
  play(name, gain = 1, variant = 0, delay = 0, from = 0) {
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
      if (from < buf.duration) src.start(Math.max(when, this.ctx.currentTime), Math.max(0, from));
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
    if (!this.lines.has(url)) this.lines.set(url, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? this.decode(b) : null)).catch(() => null));
    this.lines.get(url).then((buf) => {
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.bus.voice);
      const t = this.ctx.currentTime;
      src.start(t);
      const m = this.bus.music.gain;
      m.cancelScheduledValues(t);
      m.setTargetAtTime(MIX.music * this.musicVolume * MIX.duck, t, 0.06);
      m.setTargetAtTime(MIX.music * this.musicVolume, t + buf.duration, 0.3);
    });
  }
}
