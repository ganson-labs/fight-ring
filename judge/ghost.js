// The ghost of the last round (node ring.mjs match ghost <match> --round N --cid <id> [--tick T | --moment kind]):
// a stretch of round N where the fighter of <id> fights as recorded, and over it, translucent and cold, its version
// from before the locker room in the same situation. The old version can not be replayed identically (it was not in
// this round), so it starts from the state of that tick — places, health, meters — and its brain plays on from there
// against the same opponent, whose brain plays on too, on the round's own engine snapshot. 16:9 and 9:16, 3–6 s.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RING } from './contestants.js';
import { loadMatch, matchDir, roundInfo } from './match.js';
import { replayRound, loadWith } from './protocol.js';
import { folderHash } from './gamedata.js';
import { snapshotEngine, ANNOUNCER } from './render.js';
import { loadBrain } from '../kit/arena/tools/load.js';
import { poseFor } from '../kit/arena/render/animstate.js';
import { renderClip } from '../kit/arena/tools/preview.js';

const readJSON = (f, fb = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb);

// the snapshot of <cid> in the latest round before n where it was another version than in round n
export function previousVersion(id, cid, n) {
  const dir = (k) => join(matchDir(id), `round-${k}`, cid, 'fighter');
  if (!existsSync(join(dir(n), 'fighter.json'))) throw new Error(`в раунде ${n} нет снимка «${cid}»`);
  const now = folderHash(dir(n));
  for (let k = n - 1; k >= 1; k--) if (existsSync(join(dir(k), 'fighter.json')) && folderHash(dir(k)) !== now) return { round: k, dir: dir(k), root: join(matchDir(id), `round-${k}`, cid) };
  return null;
}

// the moment to show: --tick, or the best moment of the round of this kind (and of this side, when it has one)
export function pickTick(st, side, { tick = null, moment = null } = {}) {
  if (Number.isFinite(tick)) return { tick, what: `тик ${tick}` };
  const list = (st?.moments || []).filter((x) => (!moment || x.kind === moment) && (x.side === undefined || x.side === side || !moment));
  const mine = list.filter((x) => x.side === side);
  const best = [...(mine.length ? mine : list)].sort((a, b) => b.score - a.score)[0];
  if (!best) throw new Error('в раунде нет такого момента: задай --tick');
  return { tick: best.at, what: best.text, moment: best };
}

// The old version in the round's situation from tick `from` for `ticks`: per tick where it stands and how it moves.
export async function ghostFrames(id, n, cid, from, ticks) {
  const m = loadMatch(id);
  const { r } = roundInfo(m, n);
  const side = [r.left, r.right].indexOf(cid);
  if (side < 0) throw new Error(`«${cid}» не дрался в раунде ${n}`);
  const prev = previousVersion(id, cid, n);
  if (!prev) throw new Error(`у «${cid}» в раунде ${n} та же версия, что и раньше: призраку не с чем сравнивать`);
  // the round as recorded up to the tick
  let state = null;
  const { E, fighters } = await replayRound(matchDir(id), r, (fight) => {
    if (!state && fight.tick >= from) state = fight.f.map((F) => ({ x: F.x, y: F.y, facing: F.facing, hp: F.hp / F.maxHp, meter: F.meter, stun: F.stun, tick: fight.tick, timer: fight.timer }));
  });
  if (!state) throw new Error(`раунд ${n} короче тика ${from}`);
  const I = await import(pathToFileURL(join(matchDir(id), `round-${n}`, r.left, 'arena', 'engine', 'instrument.js')).href);
  const oldDef = await loadWith(E, I, prev.dir);
  const defs = side === 0 ? [oldDef, fighters[1]] : [fighters[0], oldDef];
  const replay = readJSON(join(matchDir(id), `round-${n}`, 'replay.json'));
  const G = E.createFight({ fighters: defs, seed: replay.seed ?? E.RING_SEED });
  G.f.forEach((F, s) => {
    const x = state[s];
    Object.assign(F, { x: x.x, y: 0, facing: x.facing, hp: Math.max(1, Math.round(x.hp * F.maxHp)), meter: x.meter, stun: x.stun });
  });
  G.tick = state[0].tick;
  G.timer = state[0].timer;
  const dirs = side === 0 ? [prev.dir, join(matchDir(id), `round-${n}`, r.right, 'fighter')] : [join(matchDir(id), `round-${n}`, r.left, 'fighter'), prev.dir];
  const brains = [];
  for (const d of dirs) brains.push(await loadBrain(d));
  brains.forEach((b, s) => {
    try {
      b.init?.({ side: s, opponent: { name: defs[1 - s].card.name }, options: { round: n }, view: E.brainView(G, s) });
    } catch {}
  });
  const frames = [];
  const push = () => {
    const F = G.f[side];
    frames.push({ tick: G.tick, x: F.x, y: F.y, facing: F.facing, pose: poseFor(F, G).pose, state: F.state });
  };
  push();
  for (let i = 0; i < ticks * 3 && G.tick < from + ticks && !G.over; i++) {
    let acts = null;
    if (!G.freeze && !G.hitstop) {
      acts = brains.map((b, s) => {
        try {
          return E.sanitizeAction(b.tick(E.brainView(G, s)));
        } catch {
          return E.IDLE_ACTION;
        }
      });
    }
    E.stepFight(G, acts);
    push();
  }
  return { side, prev, frames, oldName: oldDef.card.name, result: { hp: G.f.map((F) => F.hp), over: G.over, winner: G.winner } };
}

export async function buildGhost(id, { round, cid, tick = null, moment = null, seconds = 4, pre = 1, log = console.log } = {}) {
  const m = loadMatch(id);
  const n = Number(round);
  const { r, wins, num, rerun, final } = roundInfo(m, n);
  const st = readJSON(join(matchDir(id), `round-${n}`, 'stats.json'));
  const side = [r.left, r.right].indexOf(cid);
  const at = pickTick(st, side, { tick: tick === null ? null : Number(tick), moment });
  const secs = Math.max(3, Math.min(6, Number(seconds)));
  const from = Math.max(1, Math.round(at.tick - pre * 60));
  const ticks = Math.round(secs * 60);
  const g = await ghostFrames(id, n, cid, from, ticks);
  const dir = join(matchDir(id), 'ghost', `round-${n}-${cid}-${from}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ghost.json'), JSON.stringify({ side: g.side, from, to: from + ticks, frames: g.frames }) + '\n');
  const roundDir = join(matchDir(id), `round-${n}`);
  const stageDir = join(RING, 'stages', r.stage);
  const left = join(roundDir, r.left, 'fighter');
  const right = join(roundDir, r.right, 'fighter');
  const folders = { ...snapshotEngine(roundDir, r.left), '/f/0/': left, '/f/1/': right, '/rep/': roundDir, '/gh/': dir, '/g/': g.prev.dir, ...(existsSync(join(stageDir, 'stage.json')) ? { '/stage/': stageDir } : {}) };
  const query = {
    mode: 'replay', a: '/f/0/', b: '/f/1/', replay: '/rep/replay.json', show: 0, intro: 0, round: num, ...(rerun ? { rerun: 1 } : {}), wins: wins.join('-'), firstTo: m.firstTo, final: final ? 1 : 0,
    na: m.models[r.left], nb: m.models[r.right], ...(folders['/stage/'] ? { stage: '/stage/' } : {}),
    from, to: from + ticks, ghost: '/gh/ghost.json', g: '/g/',
  };
  const out = [];
  for (const [w, h, tag] of [[1920, 1080, '16x9'], [1080, 1920, '9x16']]) {
    const file = join(dir, `ghost-${tag}.mp4`);
    log(`Призрак: раунд ${n}, ${m.models[cid]}, ${at.what}, ${secs} с, ${tag} → ${file}`);
    const res = await renderClip({ folders, query, out: file, w, h, fps: 60, maxFrames: 60 * 60 * 12, voiceDirs: { 0: join(left, 'voice'), 1: join(right, 'voice'), ring: join(ANNOUNCER, 'voice') } });
    if (res.errors.length || res.console.length) log(`  консоль: ${[...res.errors, ...res.console].slice(0, 6).join(' | ')}`);
    out.push({ file, seconds: res.seconds });
  }
  const about = { match: id, round: n, cid, model: m.models[cid], now: `раунд ${n}`, ghost: `версия раунда ${g.prev.round}`, from, to: from + ticks, moment: at.what, clips: out.map((x) => x.file), ghostEnd: g.result };
  writeFileSync(join(dir, 'about.json'), JSON.stringify(about, null, 2) + '\n');
  return { dir, clips: out, about };
}
