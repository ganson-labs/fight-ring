// Engine events → the ring's recorded sounds (kit/arena/sounds, catalogue in catalog.js). The same choice plays in
// the viewer (Web Audio) and is mixed into the judge's MP4 (Node). A fighter may pick sounds of the catalogue for
// its moves: moves.json → "sounds": { "start" | "active" | "hit" | "block" | "projectile" | "ability": name }.
// Pure: no DOM, no randomness (variants go by tick).
import { SOUNDS } from '../sounds/catalog.js';

export { SOUNDS };

// a file of the sound: variants by tick, so a flurry of jabs does not repeat the same sample
export function soundFile(name, variant = 0) {
  const s = SOUNDS[name];
  if (!s) return null;
  return s.files[Math.abs(variant | 0) % s.files.length];
}

const own = (defs, side, move, on) => (side != null && move ? defs?.[side]?.movesById?.[move]?.sounds?.[on] : null) || null;
const limb = (defs, side, move) => defs?.[side]?.movesById?.[move]?.limb || 'P';
const slot = (defs, side, move) => defs?.[side]?.movesById?.[move]?.slot || 'normal';

// [{ name, gain, variant }] for one engine event. defs: the two compiled fighters (for their own move sounds).
export function soundsFor(e, tick = 0, defs = null) {
  const v = tick;
  switch (e.type) {
    case 'hit': {
      const pick = own(defs, e.attacker, e.move, 'hit');
      if (pick) return [{ name: pick, gain: 1, variant: v }];
      if (defs?.[e.attacker]?.movesById?.[e.move]?.hasProjectile && slot(defs, e.attacker, e.move) !== 'super') return [{ name: 'projectile-hit', gain: 1, variant: v }];
      if (e.super || slot(defs, e.attacker, e.move) === 'super') return [{ name: 'super-hit', gain: 1, variant: v }];
      const heavy = e.heavy || e.counter || e.launch || e.damage >= 60;
      const kick = limb(defs, e.attacker, e.move) === 'K';
      return [{ name: kick ? (heavy ? 'kick-heavy' : 'kick') : heavy ? 'hit-heavy' : 'hit-light', gain: 1, variant: v }];
    }
    case 'block':
      return [{ name: own(defs, e.attacker, e.move, 'block') || 'block', gain: 0.9, variant: v }];
    case 'parry':
      return [{ name: 'parry', gain: 1 }];
    case 'armor':
      return [{ name: 'block', gain: 0.8, variant: v }, { name: 'bass-hit', gain: 0.35 }];
    case 'move': {
      const pick = own(defs, e.side, e.move, 'start');
      if (pick) return [{ name: pick, gain: 0.9, variant: v }];
      if (e.slot === 'super') return [];
      return [{ name: e.slot === 'special' ? 'whoosh-heavy' : 'whoosh-light', gain: 0.8, variant: v }];
    }
    case 'active': {
      const pick = own(defs, e.side, e.move, 'active');
      return pick ? [{ name: pick, gain: 0.9, variant: v }] : [];
    }
    case 'dash':
      return [{ name: 'dash', gain: 1, variant: v }];
    case 'jump':
      return [{ name: 'jump', gain: 1, variant: v }];
    case 'land':
      return [{ name: 'land', gain: 1, variant: v }];
    case 'grab':
      return [{ name: 'grab', gain: 1, variant: v }];
    case 'throw':
    case 'knockdown':
      return [{ name: 'bodyfall', gain: 1, variant: v }];
    case 'wall':
      return [{ name: 'hit-heavy', gain: 0.7, variant: v }];
    case 'tech':
      return [{ name: 'block', gain: 0.7, variant: v }];
    case 'projectile':
      return [{ name: own(defs, e.side, e.move, 'projectile') || 'projectile', gain: 0.9, variant: v }];
    case 'clash':
      return [{ name: 'parry', gain: 0.7, variant: v }];
    case 'teleport':
      return [{ name: 'teleport', gain: 0.9 }];
    case 'ability': {
      const pick = own(defs, e.side, e.move, 'ability');
      return pick ? [{ name: pick, gain: 0.9, variant: v }] : [];
    }
    case 'super':
      return [{ name: own(defs, e.side, e.move, 'start') || 'super-start', gain: 1 }];
    case 'end':
      return e.reason === 'ko' ? [{ name: 'ko', gain: 1 }, { name: 'crowd', gain: 0.8, variant: v, at: 0.35 }] : [{ name: 'gong', gain: 1 }];
    default:
      return [];
  }
}

// the stage's beds: music and ambience loops named after the stage (stage.json "sound" may name others)
export function stageBeds(stage) {
  const id = stage?.def?.sound || stage?.id || null;
  const pick = (k) => (typeof id === 'object' && id ? id[k] : id ? `${k === 'music' ? 'music' : 'amb'}-${id}` : null);
  const music = pick('music');
  const ambience = pick('ambience');
  return { music: SOUNDS[music] ? music : null, ambience: SOUNDS[ambience] ? ambience : null };
}

// levels of the ring's mix (linear): effects on top, lines just under them, the beds well below both
export const MIX = { sfx: 1, voice: 0.9, music: 0.55, ambience: 0.6, duck: 0.45 };
