// Builds fighter/body.json, fighter/moves.json and fighter/anims-spare.json for «Метроном».
// Run from the repo root: node fighter/art/build/build.mjs
import fs from 'fs';
import { parts } from './parts.mjs';
import { states } from './states.mjs';

const body = {
  parts: {
    ...parts,
    needle: { image: 'parts/needle.png', pivot: [6.5, 119], tip: [40, 9], z: 8.5, width: 1.25, seat: false },
    key: { image: 'parts/key.png', pivot: [40, 125], tip: [311, 125], z: 6.8, seat: false },
  },
  bones: {
    // the metronome's pendulum needle on the face of the head: ticks in idle, flails when hit
    needle: { parent: 'head', attach: 29.3, side: 11.3, angle: 0, length: 28, spring: { stiffness: 0.35, damping: 0.3, gravity: 0, lag: 35 } },
    // the wind-up key in his back
    key: { parent: 'torso', attach: 44, side: -27, angle: 90, length: 26, spring: { stiffness: 0.5, damping: 0.45, gravity: 0.2, lag: 12 } },
  },
  ik: { feet: true },
  anims: states(),
};
fs.writeFileSync('fighter/body.json', JSON.stringify(body, null, 1) + '\n');

const movesMod = fs.existsSync(new URL('./moves.mjs', import.meta.url)) ? await import('./moves.mjs') : null;
if (movesMod) {
  fs.writeFileSync('fighter/moves.json', JSON.stringify({ moves: movesMod.moves() }, null, 1) + '\n');
  fs.writeFileSync('fighter/anims-spare.json', JSON.stringify({ note: 'Облик запасных спецприёмов Метронома: перенеси запись в moves.json → moves, когда мозги берут этот приём.', moves: movesMod.spare() }, null, 1) + '\n');
}
console.log('built');
