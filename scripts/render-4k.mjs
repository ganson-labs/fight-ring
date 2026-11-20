// The rounds of the bracket again in 4K for the montage (the show plays the 1080p clips the judge made with the round):
//   node scripts/render-4k.mjs t50-semi-1,t50-semi-2,t50-final,t50-show  →  show/pack/fights/<match>-round-N-4k.mp4
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatch } from '../judge/match.js';
import { renderRound } from '../judge/render.js';

const RING = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(RING, 'show', 'pack', 'fights');
mkdirSync(out, { recursive: true });
for (const id of String(process.argv[2] || '').split(',').filter(Boolean)) {
  for (const r of loadMatch(id).rounds) {
    // --size 2k renders 2560×1440 (twice as fast); a round that already exists in 4K is kept as it is
    const two = process.argv.includes('2k');
    const file = join(out, `${id}-round-${r.n}-${two ? '2k' : '4k'}.mp4`);
    if (existsSync(file) || existsSync(join(out, `${id}-round-${r.n}-4k.mp4`))) continue;
    await renderRound(id, r.n, { w: two ? 2560 : 3840, h: two ? 1440 : 2160, fps: 60, out: file, log: (s) => console.log(s) });
  }
}
console.log('Раунды в 4K готовы:', out);
