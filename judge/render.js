// Broadcast clips of a match round: the judge's own lab (kit/arena) renders the recorded fight with the VS
// screen, the round board, the fight, the result and — in the deciding round — the knockout replay and the match
// winner. Fighter sounds, ring sounds and announcer lines are mixed in.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RING, getContestant } from './contestants.js';
import { loadMatch, matchDir, roundInfo } from './match.js';
import { renderClip } from '../kit/arena/tools/preview.js';

// The judge renders on the video card unless told otherwise (RING_GPU=0 for the software renderer).
process.env.RING_GPU ??= '1';

export const ANNOUNCER = join(RING, 'announcer');
export const ADS = join(RING, 'ads', 'sponsor');

// The round plays on its own engine snapshot (round-N/<id>/arena/engine), for the show's code and for the brains
// alike: the recording replays frame for frame even after the ring's engine changed (the rehearsal's round 2
// rendered a different fight once the ring moved to 2.2). The lab server picks the longest prefix.
export function snapshotEngine(roundDir, cid) {
  const engine = join(roundDir, cid, 'arena', 'engine');
  // a file the snapshot does not have (a module of the show added later, engine/body.js) comes from the kit
  const kit = join(RING, 'kit', 'arena', 'engine');
  return existsSync(join(engine, 'index.js')) ? { '/arena/engine/': [engine, kit], '/f/arena/engine/': [engine, kit] } : {};
}

export async function renderRound(id, n, { vertical = false, ads = false, intro = true, out = null, w = null, h = null, fps = 60, log = console.log } = {}) {
  const m = loadMatch(id);
  const { r, wins, final, num, rerun } = roundInfo(m, n);
  const roundDir = join(matchDir(id), `round-${n}`);
  const stageDir = join(RING, 'stages', r.stage);
  const left = join(roundDir, r.left, 'fighter');
  const right = join(roundDir, r.right, 'fighter');
  const folders = { ...snapshotEngine(roundDir, r.left), '/f/0/': left, '/f/1/': right, '/rep/': roundDir, ...(existsSync(join(stageDir, 'stage.json')) ? { '/stage/': stageDir } : {}), '/ads/': ADS };
  const hasRing = existsSync(join(ANNOUNCER, 'voice'));
  const query = {
    mode: 'replay', a: '/f/0/', b: '/f/1/', replay: '/rep/replay.json', show: 1, intro: intro ? 1 : 0, round: num, ...(rerun ? { rerun: 1 } : {}), wins: wins.join('-'), firstTo: m.firstTo, final: final ? 1 : 0,
    // the model's name from the match itself: a match renders again after its contestants left the registry
    na: m.models?.[r.left] || getContestant(r.left).model, nb: m.models?.[r.right] || getContestant(r.right).model,
    ...(folders['/stage/'] ? { stage: '/stage/' } : {}),
    ...(hasRing ? { ring: 1 } : {}),
    ...(ads ? { ads: '/ads/', adsForce: 1 } : {}),
  };
  const [W, H] = vertical ? [w || 1080, h || 1920] : [w || 1920, h || 1080];
  const file = out || join(roundDir, `fight-${vertical ? '9x16' : '16x9'}${ads ? '-ads' : ''}.mp4`);
  log(`Снимаю раунд ${n} (${vertical ? '9:16' : '16:9'}${fps !== 30 ? `, ${fps} к/с` : ''}${ads ? ', с рекламой' : ''}) → ${file}`);
  const res = await renderClip({ folders, query, out: file, w: W, h: H, fps, maxFrames: fps * 600, voiceDirs: { 0: join(left, 'voice'), 1: join(right, 'voice'), ring: join(ANNOUNCER, 'voice') }, log: (s) => log(s) });
  // where the fight is in the clip (frame → fight tick) and what sounded when: the reel and the commentator use them
  writeFileSync(file.replace(/\.mp4$/, '.timing.json'), JSON.stringify({ ...res.timing, says: res.says, sounds: res.soundList, seconds: res.seconds }) + '\n');
  log(`  готово: ${res.seconds.toFixed(1)} с, реплик ${res.voiced}, звуков ${res.sounds}${res.errors.length || res.console.length ? `\n  консоль: ${[...res.errors, ...res.console].slice(0, 8).join('\n  ')}` : ''}`);
  return { ...res, file };
}
