// Node side of the ring's sound: the recorded sounds of kit/arena/sounds decoded once (ffmpeg) and mixed into one
// stereo track under a clip — effects at their frames, the stage's music and ambience under the whole clip, the
// music pulled down while someone speaks. Same names and levels as the viewer (render/sound.js).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARENA_DIR } from './load.js';
import { SOUNDS, soundFile, MIX } from '../render/sound.js';

export const MIX_RATE = 48000;
const cache = new Map();

export function decodeFile(file) {
  if (!cache.has(file)) {
    const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(MIX_RATE), '-'], { maxBuffer: 1 << 30 });
    cache.set(file, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice());
  }
  return cache.get(file);
}

const soundData = (name, variant) => {
  const f = soundFile(name, variant);
  const p = f && join(ARENA_DIR, 'sounds', f);
  return p && existsSync(p) ? decodeFile(p) : null;
};

// lines: [{ at, seconds }] — where the music ducks. Returns interleaved stereo Float32Array.
export function mixFight({ sounds = [], beds = null, lines = [], seconds }) {
  const n = Math.ceil((seconds + 1) * MIX_RATE);
  const out = new Float32Array(n * 2);
  const add = (data, gain, at) => {
    const o = Math.floor(at * MIX_RATE) * 2;
    for (let i = 0; i < data.length && o + i < out.length; i++) if (o + i >= 0) out[o + i] += data[i] * gain;
  };
  for (const s of sounds) {
    const d = soundData(s.name, s.variant ?? 0);
    if (d) add(d, (s.gain ?? 1) * (SOUNDS[s.name]?.gain ?? 1) * MIX.sfx, s.at);
  }
  // beds loop under everything: 1 s fade in, 2 s fade out; music ducks under lines
  const duck = new Float32Array(n).fill(1);
  for (const l of lines) {
    const a = Math.floor(l.at * MIX_RATE);
    const b = Math.floor((l.at + l.seconds) * MIX_RATE);
    const r = Math.floor(0.25 * MIX_RATE);
    for (let i = Math.max(0, a - r); i < Math.min(n, b + r); i++) {
      const k = i < a ? (a - i) / r : i > b ? (i - b) / r : 0;
      duck[i] = Math.min(duck[i], MIX.duck + (1 - MIX.duck) * k);
    }
  }
  for (const [kind, name] of Object.entries(beds || {})) {
    if (!name) continue;
    const d = soundData(name, 0);
    if (!d) continue;
    const g = (SOUNDS[name]?.gain ?? 0.3) * (kind === 'music' ? MIX.music : MIX.ambience);
    const len = d.length / 2;
    const fin = MIX_RATE;
    const fout = 2 * MIX_RATE;
    const end = Math.floor(seconds * MIX_RATE);
    for (let i = 0; i < Math.min(n, end); i++) {
      const env = Math.min(1, i / fin, (end - i) / fout) * (kind === 'music' ? duck[i] : 1);
      const j = (i % len) * 2;
      out[i * 2] += d[j] * g * env;
      out[i * 2 + 1] += d[j + 1] * g * env;
    }
  }
  return out;
}

export function wavStereo(data, sr = MIX_RATE) {
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const x = Math.tanh(data[i] * 1.1) / Math.tanh(1.1); // soft limit, unity at full scale
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32000), 44 + i * 2);
  }
  return buf;
}

// seconds of an audio file (for ducking under a line)
export function fileSeconds(file) {
  try {
    return decodeFile(file).length / 2 / MIX_RATE;
  } catch {
    return 2;
  }
}

// the catalogue a fighter may use in moves.json → sounds
export function catalogueText() {
  const rows = Object.entries(SOUNDS).filter(([, s]) => s.kind === 'sfx');
  const w = Math.max(...rows.map(([n]) => n.length));
  return rows.map(([n, s]) => `  ${n.padEnd(w)}  ${s.what}${s.files.length > 1 ? ` (${s.files.length} варианта)` : ''}`).join('\n');
}
