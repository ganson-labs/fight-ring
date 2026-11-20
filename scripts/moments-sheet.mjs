// The key moments of the rounds of the bracket with their time in the round's clip, for the editor:
//   node scripts/moments-sheet.mjs t50-semi-1,t50-semi-2,t50-final,t50-show > show/pack/moments.md
// It tells the results: not for the host before the shoot.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTiming, clipTime } from '../judge/moments.js';

const RING = join(dirname(fileURLToPath(import.meta.url)), '..');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const out = [];
for (const id of String(process.argv[2] || '').split(',').filter(Boolean)) {
  const m = JSON.parse(readFileSync(join(RING, 'matches', id, 'match.json'), 'utf8'));
  const st = JSON.parse(readFileSync(join(RING, 'matches', id, 'stats.json'), 'utf8'));
  out.push(`\n## ${id}: ${m.models[m.red]} против ${m.models[m.blue]}${m.winner ? ` — победила ${m.models[m.winner]}` : ''}\n`);
  for (const r of st.rounds) {
    const info = m.rounds.find((x) => x.n === r.n);
    const dir = join(RING, 'matches', id, `round-${r.n}`);
    const timing = readTiming(join(dir, 'fight-16x9.timing.json'));
    const rep = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8'));
    const c = r.counters;
    out.push(`### Раунд ${r.n} — ${r.names[r.result.winner] ?? 'ничья'}, ${r.result.reason === 'ko' ? 'нокаут' : 'по времени'}, ${Math.round(r.result.seconds)} с. Слева ${r.names[0]}, справа ${r.names[1]}. Сцена ${info.stage}, старт ${info.start}.`);
    out.push(`Здоровье в конце: ${r.names[0]} ${Math.round(rep.result.hp[0])}, ${r.names[1]} ${Math.round(rep.result.hp[1])}. Ролик: \`matches/${id}/round-${r.n}/fight-16x9.mp4\`, в 4K: \`show/pack/fights/${id}-round-${r.n}-4k.mp4\`.\n`);
    out.push('| | ' + r.names.join(' | ') + ' |\n|---|---|---|');
    for (const [k, ru] of [['hits', 'попаданий'], ['damage', 'урон'], ['blocks', 'ударов в блок'], ['parries', 'парирований'], ['throws', 'бросков'], ['supers', 'суперприёмов'], ['maxCombo', 'самая длинная серия'], ['knockdowns', 'падений']]) out.push(`| ${ru} | ${c[0][k]} | ${c[1][k]} |`);
    out.push('\n| Время в ролике | Что |\n|---|---|');
    for (const t of [...r.top].sort((a, b) => a.at - b.at)) out.push(`| ${timing ? `${mmss(clipTime(timing, t.from))}–${mmss(clipTime(timing, t.to))}` : `тик ${t.at}`} | ${t.text} |`);
    out.push('');
  }
}
console.log(out.join('\n'));
