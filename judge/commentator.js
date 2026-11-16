// Voiced commentary over a recorded round, off by default: the reel is voiced by a person, and the facts go to
// captions and notes (judge/captions.js). When asked for (`match comment`), the judge gathers the facts of the
// round, a model writes the lines with `claude -p` in an empty folder with no tools (prompts/commentator-voice.md),
// ElevenLabs voices them, and the lines sit only in the pauses of the clip (before the fight, after the knockout,
// the result), one at a time, never over the fighters or the ring announcer, with the game ducked under them:
// fight-16x9-comment.mp4 with two audio tracks, the first (default) without the commentary, the second with it.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RING, getContestant } from './contestants.js';
import { loadMatch, matchDir, roundInfo, changes } from './match.js';
import { clipTime, readTiming } from './moments.js';
import { voiceServer, mp3Seconds } from '../kit/arena/tools/voice.js';
import { decodeFile, MIX_RATE, wavStereo } from '../kit/arena/tools/sounds.js';

export const COMMENTATOR = join(RING, 'commentator');
const VOICES = join(COMMENTATOR, 'voices.json');
const LEDGER = join(RING, 'ledger', 'commentator.json');
const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb);
const writeJSON = (f, v) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

export const VOICE_SPECS = {
  host: { name: 'Ринг моделей · ведущий', description: 'Азартный спортивный комментатор боёв: энергичный мужской голос средней высоты, быстрый темп, искренний азарт и восклицания, как на большом турнире по файтингам. Русская речь, чистая студийная запись без музыки и эха.', text: 'Вот это удар! Лис прорывает защиту и уходит в серию, зал на ногах, такого в первом раунде никто не ждал!' },
  expert: { name: 'Ринг моделей · эксперт', description: 'Спокойный эксперт-аналитик боёв: низкий ровный мужской голос, неторопливая уверенная речь, лёгкая сухая ирония, объясняет происходящее. Русская речь, чистая студийная запись без музыки и эха.', text: 'Обратите внимание: он держит дистанцию и ждёт ошибки. Модель явно сделала выводы после прошлого раунда.' },
};

// what is spent on the commentators (seconds of speech, voice designs, model calls)
export function commentatorSpend(kind, amount, note) {
  return spend(kind, amount, note);
}
function spend(kind, amount, note) {
  const l = readJSON(LEDGER, { voiceSeconds: 0, voiceDesigns: 0, modelCalls: 0, log: [] });
  l[kind] = +((l[kind] || 0) + amount).toFixed(2);
  l.log.push({ at: new Date().toISOString(), kind, amount, note });
  writeJSON(LEDGER, l);
}
export const commentatorLedger = () => readJSON(LEDGER, { voiceSeconds: 0, voiceDesigns: 0, modelCalls: 0, log: [] });

// The two voices, designed once (the first preview of each) and kept by their ElevenLabs id.
export async function ensureVoices({ log = console.log } = {}) {
  const have = readJSON(VOICES, {});
  for (const [who, spec] of Object.entries(VOICE_SPECS)) {
    if (have[who]?.voice_id) continue;
    log(`Голос комментатора «${who}»: подбираю по описанию…`);
    const d = await voiceServer({ action: 'design', description: spec.description, text: spec.text });
    spend('voiceDesigns', 1, who);
    const dir = join(COMMENTATOR, 'design', who);
    mkdirSync(dir, { recursive: true });
    d.previews.forEach((p, i) => writeFileSync(join(dir, `preview-${i + 1}.mp3`), Buffer.from(p.audio, 'base64')));
    const pick = d.previews[0];
    const c = await voiceServer({ action: 'create', name: spec.name, description: spec.description, generated_voice_id: pick.id });
    have[who] = { voice_id: c.voice_id, name: spec.name, description: spec.description, preview: `design/${who}/preview-1.mp3`, at: new Date().toISOString() };
    writeJSON(VOICES, have);
  }
  return have;
}

// how a line is read aloud: model names and versions in Russian sounds ("Claude Sonnet 5.5" → "Клод Сонет пять точка пять")
const NUM = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
export function speakable(text) {
  return text
    .replace(/Claude/gi, 'Клод').replace(/Sonnet/gi, 'Сонет').replace(/Opus/gi, 'Опус').replace(/Haiku/gi, 'Хайку').replace(/Fable/gi, 'Фейбл')
    .replace(/GPT/gi, 'джи-пи-ти').replace(/Codex/gi, 'Кодекс').replace(/Gemini/gi, 'Джемини')
    .replace(/(\d)\.(\d)/g, (_, a, b) => `${NUM[a]} точка ${NUM[b]}`)
    .replace(/(джи-пи-ти|Клод|Сонет|Опус)[\s-]+(\d)/g, (_, w, d) => `${w} ${NUM[d]}`);
}

// ---------- the facts of a round ----------

export function roundFacts(id, n) {
  const m = loadMatch(id);
  const { r, wins, num, rerun, final } = roundInfo(m, n);
  const rd = join(matchDir(id), `round-${n}`);
  const st = readJSON(join(rd, 'stats.json'));
  if (!st) throw new Error(`нет статистики раунда ${n}: node ring.mjs match stats ${id}`);
  const timing = readTiming(join(rd, 'fight-16x9.timing.json'));
  if (!timing) throw new Error(`нет ролика раунда ${n} с разметкой: node ring.mjs match render ${id} --round ${n}`);
  const t = (tick) => clipTime(timing, tick);
  const phaseAt = (k) => {
    const i = timing.phase.indexOf(timing.phases.indexOf(k));
    return i < 0 ? null : +(i / timing.fps).toFixed(2);
  };
  const names = st.names;
  const models = [r.left, r.right].map((cid) => m.models[cid]);
  const locker = n === 1 ? null : [r.left, r.right].map((cid, side) => {
    const ch = changes(id, cid).find((c) => c.to === n);
    if (!ch) return null;
    return {
      fighter: names[side],
      model: models[side],
      changed: [...ch.stats.map((x) => `характеристики: ${x}`), ...ch.moves.map((x) => `приём ${x}`), ...ch.abilities.map((x) => `способность ${x}`), ...ch.card.map((x) => `карточка: ${x}`)].slice(0, 12),
      brainRewritten: !!ch.changed?.some((f) => f.file === 'brain.js'),
      said: ch.note?.text ? ch.note.text.slice(0, 900) : null,
    };
  });
  const lockerStats = (readJSON(join(matchDir(id), 'stats.json'))?.lockers || []).filter((x) => x.to === n);
  return {
    round: { n, number: num, rerun, final, stage: r.stage, scoreBefore: { [names[0]]: wins[0], [names[1]]: wins[1] } },
    fighters: names.map((nm, i) => ({ name: nm, model: models[i], side: i === 0 ? 'слева' : 'справа' })),
    clip: { seconds: timing.seconds, fightStarts: phaseAt('fight'), fightEnds: phaseAt('after'), result: phaseAt('result') ?? phaseAt('final') },
    announcer: (timing.says || []).filter((s) => s.side === 'ring').map((s) => ({ t: +(s.frame / timing.fps).toFixed(2), line: s.line })),
    // the clip's pauses (no fighting: before the fight, after the knockout, the result) and every voice in the clip
    pauses: clipPauses(timing),
    voices: clipVoices(timing, [r.left, r.right].map((cid) => join(rd, cid, 'fighter', 'voice')), names),
    result: { winner: st.result.winner === null ? 'ничья' : names[st.result.winner], how: st.result.reason === 'ko' ? 'нокаут' : 'по времени', seconds: st.result.seconds },
    counters: Object.fromEntries(names.map((nm, i) => [nm, st.counters[i]])),
    moments: st.moments.map((x) => ({ t: t(x.at), what: x.text, kind: x.kind })).filter((x) => x.t !== null).sort((a, b) => a.t - b.t),
    locker,
    lockerEffect: lockerStats.map((x) => ({ fighter: names[[r.left, r.right].indexOf(x.cid)], effect: x.effect, wonBefore: x.wonBefore, wonAfter: x.wonAfter })),
  };
}

// Stretches of the clip without fighting, at least 2 s long: where a commentator may speak.
export function clipPauses(timing) {
  const fight = timing.phases.indexOf('fight');
  const out = [];
  let start = null;
  for (let i = 0; i <= timing.phase.length; i++) {
    const calm = i < timing.phase.length && timing.phase[i] !== fight;
    if (calm && start === null) start = i;
    if (!calm && start !== null) {
      const from = start / timing.fps;
      const to = i / timing.fps;
      if (to - from >= 2) out.push({ from: +from.toFixed(2), to: +to.toFixed(2), what: timing.phases[timing.phase[start]] === 'vs' || timing.phases[timing.phase[start]] === 'board' ? 'до боя' : 'после боя' });
      start = null;
    }
  }
  return out;
}

// Every recorded line in the clip with its length: the fighters' and the ring announcer's.
export function clipVoices(timing, voiceDirs, names) {
  const ANN = join(RING, 'announcer', 'voice');
  return (timing.says || []).map((x) => {
    const f = x.side === 'ring' ? join(ANN, `${x.line}.mp3`) : join(voiceDirs[x.side] || '', `${x.line}.mp3`);
    const seconds = existsSync(f) ? mp3Seconds(f) : 1.6;
    return { t: +(x.frame / timing.fps).toFixed(2), seconds: +seconds.toFixed(2), who: x.side === 'ring' ? 'ведущий ринга' : names[x.side], line: x.line };
  });
}

// ---------- the lines ----------

export function askModel(prompt, { model = 'claude-opus-5-5' } = {}) {
  // an empty folder, no tools, no MCP, no settings: the model sees only the prompt
  const dir = mkdtempSync(join(tmpdir(), 'ring-commentator-'));
  try {
    return new Promise((res, rej) => {
      const empty = process.platform === 'win32' ? '""' : ''; // through the shell an empty argument needs its quotes
      const p = spawn('claude', ['-p', '--tools', empty, '--restricted', '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--output-format', 'json', '--model', model], { cwd: dir, shell: process.platform === 'win32', windowsHide: true, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => p.kill(), 300000);
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return rej(new Error(`claude -p: код ${code} ${err.slice(-300)}`));
        try {
          const o = JSON.parse(out);
          res({ text: o.result || '', cost: o.total_cost_usd ?? null, usage: o.usage || null });
        } catch {
          res({ text: out, cost: null, usage: null });
        }
      });
      p.stdin.end(prompt);
    });
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 310000).unref();
  }
}

export function parseLines(text, facts, { budget = 60, maxLines = 14 } = {}) {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('модель ответила не JSON-массивом');
  let lines = JSON.parse(m[0]).filter((x) => x && typeof x.text === 'string' && Number.isFinite(x.t) && (x.who === 'host' || x.who === 'expert'));
  // a line is a finished sentence
  lines = lines.map((x) => ({ t: Math.max(0, Math.min(facts.clip.seconds - 1, x.t)), who: x.who, text: x.text.trim().replace(/\s+—\s+/g, ', ').replace(/([^.!?…])$/, '$1.') })).sort((a, b) => a.t - b.t).slice(0, maxLines);
  let est = 0;
  return lines.filter((x) => (est += x.text.length / 14) <= budget * 1.1);
}

// Lines laid out one at a time, only inside the pauses, never over another voice (a fighter, the ring announcer,
// the other commentator). A line goes to the pause it was written for, or the next one if it starts within 4 s;
// a line that does not fit there whole drops.
export function layout(lines, voices, pauses, clipSeconds) {
  const busy = voices.map((v) => [v.t - 0.2, v.t + v.seconds + 0.3]);
  const out = [];
  let free = 0;
  for (const l of lines) {
    const p = pauses.find((x) => l.t >= x.from && l.t < x.to) || pauses.find((x) => x.from >= l.t && x.from - l.t <= 4);
    if (!p) continue;
    let at = Math.max(l.t, p.from + 0.3, free + 0.5);
    for (let moved = true; moved;) {
      moved = false;
      for (const [a, b] of busy) if (at < b && at + l.seconds > a) {
        at = b;
        moved = true;
      }
    }
    if (at + l.seconds > Math.min(p.to - 0.2, clipSeconds)) continue;
    out.push({ ...l, at: +at.toFixed(2) });
    free = at + l.seconds;
  }
  return out;
}

// The commentary of round n: facts → lines → voices → track → clip with two audio tracks.
export async function commentRound(id, n, { budget = 30, model = 'claude-opus-5-5', log = console.log, voice = true } = {}) {
  const rd = join(matchDir(id), `round-${n}`);
  const facts = roundFacts(id, n);
  writeJSON(join(rd, 'comment', 'facts.json'), facts);
  const tpl = readFileSync(join(RING, 'prompts', 'commentator-voice.md'), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
  const maxLines = Math.max(3, Math.min(8, Math.round(budget / 4)));
  const prompt = tpl.replace('{{FACTS}}', JSON.stringify(facts, null, 1)).replace('{{BUDGET}}', String(budget)).replace('{{LINES}}', String(maxLines));
  log(`Комментарий раунда ${n}: пишет ${model}…`);
  const ans = await askModel(prompt, { model });
  spend('modelCalls', 1, `${id} раунд ${n}${ans.cost !== null ? ` $${ans.cost}` : ''}`);
  const lines = parseLines(ans.text, facts, { budget, maxLines });
  writeJSON(join(rd, 'comment', 'lines.json'), { model, cost: ans.cost, usage: ans.usage, lines });
  if (!voice) return { lines };
  const voices = await ensureVoices({ log });
  let spoken = 0;
  for (const [i, l] of lines.entries()) {
    const f = join(rd, 'comment', `line-${String(i + 1).padStart(2, '0')}.mp3`);
    if (!existsSync(f)) {
      const r = await voiceServer({ action: 'tts', voice_id: voices[l.who].voice_id, text: speakable(l.text), language: 'ru' });
      writeFileSync(f, Buffer.from(r.audio, 'base64'));
      const s = mp3Seconds(f);
      spend('voiceSeconds', s, `${id} раунд ${n} ${l.who}`);
    }
    l.file = f;
    l.seconds = mp3Seconds(f);
    spoken += l.seconds;
    if (spoken > budget * 1.15) {
      lines.length = i + 1;
      break;
    }
  }
  const placed = layout(lines, facts.voices, facts.pauses, facts.clip.seconds);
  writeJSON(join(rd, 'comment', 'lines.json'), { model, cost: ans.cost, usage: ans.usage, lines: placed.map(({ file, ...x }) => ({ ...x, file: file.split(/[\\/]/).pop() })) });
  // the commentary track: the lines at their seconds, stereo
  const n2 = Math.ceil((facts.clip.seconds + 2) * MIX_RATE) * 2;
  const track = new Float32Array(n2);
  for (const l of placed) {
    const d = decodeFile(l.file);
    const o = Math.floor(l.at * MIX_RATE) * 2;
    for (let i = 0; i < d.length && o + i < n2; i++) track[o + i] += d[i] * 0.95;
  }
  const wav = join(rd, 'comment', 'commentary.wav');
  writeFileSync(wav, wavStereo(track));
  const clip = join(rd, 'fight-16x9.mp4');
  const out = join(rd, 'fight-16x9-comment.mp4');
  muxCommentary(clip, wav, out);
  if (existsSync(join(rd, 'fight-9x16.mp4'))) muxCommentary(join(rd, 'fight-9x16.mp4'), wav, join(rd, 'fight-9x16-comment.mp4'));
  log(`  реплик ${placed.length} из ${lines.length}, речи ${placed.reduce((a, l) => a + l.seconds, 0).toFixed(1)} с → ${out}`);
  return { lines: placed, out, wav };
}

// the clip with two audio tracks: 1 (default) — the mix as it was, 2 — the commentary over it, the game ducked
// well under every line (about −12 dB) and back after it.
export function muxCommentary(clip, wav, out) {
  const fc = '[1:a]volume=1.35,asplit=2[c1][c2];[0:a][c1]sidechaincompress=threshold=0.015:ratio=10:attack=20:release=500:makeup=1[duck];[duck][c2]amix=inputs=2:normalize=0:dropout_transition=0,alimiter=limit=0.85,loudnorm=I=-15:TP=-1.5:LRA=14[with]';
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', clip, '-i', wav, '-filter_complex', fc, '-map', '0:v', '-map', '0:a', '-map', '[with]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-metadata:s:a:0', 'title=Без комментатора', '-metadata:s:a:1', 'title=С комментатором', '-disposition:a:0', 'default', '-disposition:a:1', '0', '-shortest', out], { stdio: 'ignore' });
}

void getContestant;
