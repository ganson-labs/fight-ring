// The version of the ring's rules. A match records it; a recorded fight replays frame for frame on the engine
// snapshot the judge keeps with each round (round-N/<id>/arena/engine). Bump:
//   engine — anything that changes how a fight plays out (the simulation, the constructor's numbers, abilities);
//   rules  — what a fighter may write (ARENA.md, the checker: new fields, limits);
//   tools  — the workshop (preview, paint, parts, voice, sounds) and the show; a fight does not change.
export const RING_VERSION = { ring: '2.3', engine: '2.2', rules: '2.3', tools: '2.2' };

export const ringVersionText = (v = RING_VERSION) => `ринг ${v.ring} (движок ${v.engine}, правила ${v.rules}, инструменты ${v.tools})`;
