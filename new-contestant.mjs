// Kept for the stage-1 command line: same as `node ring.mjs new <id> ...` (the judge's CLI).
//   node new-contestant.mjs red  --agent claude --model "Claude Opus 5.5" --color "#e8825a"
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ring = fileURLToPath(new URL('./ring.mjs', import.meta.url));
const r = spawnSync(process.execPath, [ring, 'new', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
