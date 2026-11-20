// Big figure renders for checking poses: node fighter/art/build/figs.mjs name anim:t[,anim:t...] [k]
// anim may be "move:<id>" to render a move's pose at tick t.
import { renderFigures } from '../../../arena/tools/preview.js';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
const [name, list, k = '1.3'] = process.argv.slice(2);
const poses = list.split(',').map((s, i) => {
  const [a, b, t] = s.split(':');
  const p = a === 'move' ? { move: b, anim: 'idle', t: Number(t) } : { anim: a, t: b === 'end' ? 'end' : Number(b) };
  return { ...p, out: resolve(`out/figs/${name}-${i}.png`), label: s };
});
const done = await renderFigures({ fighterDir: resolve('fighter'), poses, k: Number(k) });
execFileSync('python', ['fighter/art/build/compose.py', `out/figs/${name}.png`, ...done.map((d) => `${d.out}|${d.label}`)], { stdio: 'inherit' });
