// Pose sheet PNG and clips MP4 through the lab page in headless Chrome, encoded by ffmpeg.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync, readdirSync } from 'node:fs';
import { mixFight, wavStereo, fileSeconds, decodeFile, MIX_RATE } from './sounds.js';
import { basename, dirname, join } from 'node:path';
import { cpus } from 'node:os';
import { ARENA_DIR } from './load.js';
import { launch } from './browser.js';
import { serveFolders } from './serve.js';

export function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function withLab({ folders, w = 1280, h = 720 }, fn) {
  // /f/arena/: a fighter's own modules import ../arena/engine/index.js from /f/<n>/
  const server = await serveFolders({ '/arena/': ARENA_DIR, '/f/arena/': ARENA_DIR, ...folders });
  const browser = await launch({ width: w, height: h });
  try {
    return await fn(server, browser);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function openLab(browser, server, query, w, h, tries = 3) {
  for (let i = 1; ; i++) {
    const page = await browser.open(`${server.url}/arena/render/lab.html?${new URLSearchParams(query)}`, { w, h });
    const ok = await page.evaluate('window.lab ? window.lab.ready : Promise.resolve(false)', { timeout: 120000 });
    const errs = await page.evaluate('window.lab ? window.lab.errors : ["страница лаборатории не загрузилась"]');
    if (ok) return page;
    await page.close().catch(() => {});
    // a picture of the stage Chrome once could not decode while the game played a round next to it: tried again
    if (i >= tries) throw new Error(`лаборатория не запустилась:\n${[...errs, ...page.console].join('\n')}`);
    await new Promise((r) => setTimeout(r, 3000 * i));
  }
}

export async function renderSheet({ fighterDir, out }) {
  return withLab({ folders: { '/f/0/': fighterDir } }, async (server, browser) => {
    const page = await openLab(browser, server, { mode: 'sheet', a: '/f/0/' }, 1800, 1000);
    const info = await page.evaluate('window.lab.info');
    const url = await page.evaluateText('window.lab.frame()');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
    return { out, ...info, console: page.console };
  });
}

// Figures of one fighter on a transparent background, one PNG per pose: [{ anim, t, out }] (t: tick or 'end').
// A pose the fighter has no animation for is skipped. Returns [{ anim, t, out, width, height, k }].
export async function renderFigures({ fighterDir, poses, k = null }) {
  return withLab({ folders: { '/f/0/': fighterDir } }, async (server, browser) => {
    const done = [];
    for (const p of poses) {
      const page = await browser.open(`${server.url}/arena/render/lab.html?${new URLSearchParams({ mode: 'figure', a: '/f/0/', anim: p.anim || 'idle', ...(p.move ? { move: p.move } : {}), t: String(p.t ?? 'end'), ...(k ? { k: String(k) } : {}), ...(p.box ? { box: p.box.join(',') } : {}) })}`, { w: 400, h: 300 });
      const ok = await page.evaluate('window.lab ? window.lab.ready : Promise.resolve(false)', { timeout: 120000 });
      if (!ok) {
        await page.close();
        continue;
      }
      const info = await page.evaluate('window.lab.info');
      const url = await page.evaluateText('window.lab.frame()');
      mkdirSync(dirname(p.out), { recursive: true });
      writeFileSync(p.out, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      done.push({ ...p, ...info });
      await page.close();
    }
    return done;
  });
}

// The video card's H.264 encoder when the machine has one (NVIDIA NVENC: the processor stays free for filming the
// frames), otherwise x264. Tried once with a real encode: ffmpeg lists NVENC also where no such card is.
let videoArgs = null;
export function videoCodec() {
  if (videoArgs) return videoArgs;
  const x264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'medium'];
  if (process.env.RING_NVENC === '0') return (videoArgs = x264);
  // cq 26 with adaptive quantization: the quality of x264 crf 19 (SSIM 0.988 on a round) at ~1.3× its size
  const nvenc = ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', '26', '-b:v', '0', '-spatial-aq', '1', '-temporal-aq', '1', '-pix_fmt', 'yuv420p'];
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', ...nvenc, '-f', 'null', '-'], { stdio: 'ignore', timeout: 20000 });
    videoArgs = nvenc;
  } catch {
    videoArgs = x264;
  }
  return videoArgs;
}

function encoder(out, fps) {
  mkdirSync(dirname(out), { recursive: true });
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', ...videoCodec(), '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let closed = null;
  const waiting = new Set();
  const fail = () => new Error(`ffmpeg закрылся: ${(err.length > 700 ? `${err.slice(0, 300)} … ${err.slice(-300)}` : err).trim() || `код ${closed}`}`);
  ff.stderr.on('data', (d) => (err += d));
  // ffmpeg gone in the middle (the video card's encoder had no free session, say): the clip fails with its words,
  // not the whole process on a write into a closed pipe, and no write waits for a drain that never comes
  ff.stdin.on('error', () => {});
  const done = new Promise((res, rej) => ff.on('close', (code) => {
    closed = code;
    if (code === 0) return res();
    for (const w of waiting) w(fail());
    rej(fail());
  }));
  done.catch(() => {});
  return {
    write: (buf) => new Promise((res, rej) => {
      if (closed !== null) return rej(fail());
      if (ff.stdin.write(buf)) return res();
      const w = (e) => {
        waiting.delete(w);
        if (e) rej(e);
        else res();
      };
      waiting.add(w);
      ff.stdin.once('drain', () => w());
    }),
    end: () => {
      ff.stdin.end();
      return done;
    },
  };
}

// Ring sounds (recorded, kit/arena/sounds; see tools/sounds.js), the stage's music and ambience, and the recorded
// lines mixed under the picture. says: [{ frame, side, line }] — side indexes voiceDirs (0, 1 or "ring").
function mixAudio(video, { says = [], sounds = [], beds = null, voiceDirs = null, fps, seconds }) {
  const clips = voiceDirs ? says.map((s) => ({ ...s, file: voiceDirs[s.side] ? join(voiceDirs[s.side], `${s.line}.mp3`) : null })).filter((s) => s.file && existsSync(s.file)) : [];
  if (!clips.length && !sounds.length && !beds) return 0;
  const tmp = video.replace(/\.mp4$/, '.tmp.mp4');
  const wav = video.replace(/\.mp4$/, '.sfx.wav');
  const args = ['-y', '-v', 'error', '-i', video];
  const inputs = [];
  const track = mixFight({ sounds: sounds.map((x) => ({ ...x, at: x.frame / fps })), beds, lines: clips.map((c) => ({ at: c.frame / fps, seconds: fileSeconds(c.file) })), seconds });
  // The lines go into the same track here, not as ffmpeg inputs: a three-minute round of two talkative fighters has
  // hundreds of lines, and that many -i arguments did not fit a Windows command line (ENAMETOOLONG, the final of 4.0)
  for (const c of clips) {
    const d = decodeFile(c.file);
    const o = Math.floor((c.frame / fps) * MIX_RATE) * 2;
    for (let i = 0; i < d.length && o + i < track.length; i++) track[o + i] += d[i] * 1.5;
  }
  writeFileSync(wav, wavStereo(track));
  args.push('-i', wav);
  inputs.push('[1]alimiter=limit=0.85,loudnorm=I=-16:TP=-1.5:LRA=14[aout]');
  args.push('-filter_complex', inputs.join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', tmp);
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
  rmSync(video);
  if (existsSync(wav)) rmSync(wav);
  renameSync(tmp, video);
  return clips.length;
}

// query: lab parameters (mode, move, replay, dummy, debug, stage…). folders: url prefix → folder.
// How many pages film one clip at once: a frame takes ~35 ms in one page (drawing, JPEG and its way out of Chrome),
// and pages in parallel add up nearly in full (measured: 1 page 25 frames/s, 5 pages 107). RING_PARTS overrides.
export function clipParts(query) {
  if (query.from || query.to || query.ghost || query.mode !== 'replay') return 1;
  const env = Number(process.env.RING_PARTS);
  if (env >= 1) return Math.floor(env);
  return Math.max(1, Math.min(4, Math.floor(cpus().length / 4)));
}

const PIECE = 600; // frames of one piece of a clip filmed in parallel (10 s at 60 frames/s)

// One page films the pieces k, k + parts, k + 2·parts… of the clip, each into its own file; the frames of the other
// pieces it plays without a picture. A page that stops answering (it happens now and then with four pages on one
// video card: a frame never comes back) is closed and a fresh one plays up to the same piece and films it again —
// the show is the same from the start, so the joins still meet. Returns its files by piece.
async function filmPieces(slot, { k, parts, piece: size, out, fps, maxFrames, log, reopen }) {
  const files = [];
  let tries = 0;
  for (let p = k; p * size < maxFrames; p += parts) {
    const start = p * size;
    const file = out.replace(/\.mp4$/, `.part${String(p).padStart(3, '0')}.mp4`);
    let enc = null;
    try {
      const page = slot.page;
      // up to the piece's first frame, without pictures
      let cur = await page.evaluate('window.lab.frames');
      while (cur < start) {
        if (await page.evaluate(`window.lab.skip(${Math.min(size, start - cur)})`, { timeout: 120000 })) return files;
        cur = await page.evaluate('window.lab.frames');
      }
      if (await page.evaluate('window.lab.done')) return files;
      enc = encoder(file, fps);
      let n = 0;
      let done = false;
      while (n < size && start + n < maxFrames) {
        let url;
        try {
          url = await page.evaluateText('window.lab.frame()', { timeout: 60000 });
        } catch (e) {
          throw new Error(`страница ${k + 1} из ${parts}, кадр ${start + n}: ${e.message}`);
        }
        await enc.write(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')).catch((e) => {
          throw new Error(`страница ${k + 1} из ${parts}, кадр ${start + n}, ${url.length} байт: ${e.message}`);
        });
        n++;
        if (await page.evaluate('window.lab.done')) {
          done = true;
          break;
        }
      }
      await enc.end();
      enc = null;
      files.push({ piece: p, file, frames: n });
      if (log) log(`  … кусок ${p + 1}, ${start + n} кадров`);
      if (done) return files;
    } catch (e) {
      if (enc) await enc.end().catch(() => {});
      rmSync(file, { force: true });
      if (tries++ >= 2) throw e;
      if (log) log(`  ${e.message.split('\n')[0]} — страница заново`);
      await reopen(slot);
      p -= parts;
    }
  }
  return files;
}

// The same clip filmed by several Chrome pages at once, each its own pieces, joined without encoding again. The
// sounds, the lines and the timing of frames come from the first page, played to the end (every page plays the
// whole show the same: the scene is a function of the fight and the time).
async function renderClipParallel({ folders, query, out, w, h, fps, maxFrames, voiceDirs, sound, log, parts, piece }) {
  const server = await serveFolders({ '/arena/': ARENA_DIR, '/f/arena/': ARENA_DIR, ...folders });
  const slots = [];
  const open = async (slot) => {
    slot.browser = await launch({ width: w, height: h });
    slot.page = await openLab(slot.browser, server, { ...query, w, h, fps }, w, h);
    return slot;
  };
  const reopen = async (slot) => {
    await slot.browser?.close().catch(() => {});
    return open(slot);
  };
  try {
    for (let k = 0; k < parts; k++) slots.push(await open({}));
    if (log) log(`  снимаю в ${parts} страницах сразу`);
    const res = await Promise.all(slots.map((slot, k) => filmPieces(slot, { k, parts, piece, out, fps, maxFrames, log, reopen })));
    const pieces = res.flat().sort((a, b) => a.piece - b.piece);
    const files = pieces.map((x) => x.file);
    const list = out.replace(/\.mp4$/, '.parts.txt');
    // the exact length of every piece: the container rounds its own, and the joins would drift off the frames
    writeFileSync(list, pieces.map((x) => `file '${x.file.replace(/\\/g, '/')}'\nduration ${(x.frames / fps).toFixed(6)}`).join('\n') + '\n');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'ignore' });
    for (const f of [...files, list]) rmSync(f, { force: true });
    if (log) log('  куски склеены');
    const page = slots[0].page;
    while (!(await page.evaluate('window.lab.done')) && (await page.evaluate('window.lab.frames')) < maxFrames) await page.evaluate(`window.lab.skip(${piece})`, { timeout: 600000 });
    const frames = Math.min(maxFrames, pieces.reduce((a, x) => a + x.frames, 0));
    const says = await page.evaluate('window.lab.says');
    const sounds = (await page.evaluate('window.lab.sounds || []')) || [];
    const errors = await page.evaluate('window.lab.errors');
    const info = await page.evaluate('window.lab.info');
    const timing = { fps, phases: await page.evaluate('window.lab.phases'), ticks: [], phase: [] };
    for (const [t, p] of ((await page.evaluate('window.lab.timing')) || []).slice(0, frames)) {
      timing.ticks.push(t);
      timing.phase.push(p);
    }
    if (log) log('  звук…');
    const voiced = mixAudio(out, { says, sounds: sound ? sounds : [], beds: sound ? info?.beds : null, voiceDirs, fps, seconds: frames / fps });
    return { out, frames, seconds: frames / fps, says, voiced, sounds: sounds.length, soundList: sounds, errors, info, timing, parts, console: slots.flatMap((x) => x.page?.console || []) };
  } finally {
    for (const x of slots) await x.browser?.close().catch(() => {});
    await server.close();
    // the pieces of a clip that failed half-way
    const base = basename(out).replace(/\.mp4$/, '');
    try {
      for (const n of readdirSync(dirname(out))) if (n.startsWith(`${base}.part`)) rmSync(join(dirname(out), n), { force: true });
    } catch {}
  }
}

export async function renderClip({ folders, query, out, w = 1280, h = 720, fps = 30, maxFrames = 3600, voiceDirs = null, sound = true, log = null, parts = null, piece = PIECE }) {
  parts ??= clipParts(query);
  if (parts > 1) {
    try {
      return await renderClipParallel({ folders, query, out, w, h, fps, maxFrames, voiceDirs, sound, log, parts, piece });
    } catch (e) {
      // the clip is made all the same, the old way in one page
      if (log) log(`  в ${parts} страницах не вышло (${e.message.split('\n')[0]}): снимаю в одной`);
    }
  }
  return withLab({ folders, w, h }, async (server, browser) => {
    const page = await openLab(browser, server, { ...query, w, h, fps }, w, h);
    const enc = encoder(out, fps);
    let frames = 0;
    for (; frames < maxFrames; frames++) {
      const url = await page.evaluateText('window.lab.frame()');
      await enc.write(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      if (log && frames % 150 === 149) log(`  … ${frames + 1} кадров`);
      if (await page.evaluate('window.lab.done')) break;
    }
    await enc.end();
    const says = await page.evaluate('window.lab.says');
    const sounds = (await page.evaluate('window.lab.sounds || []')) || [];
    const errors = await page.evaluate('window.lab.errors');
    const info = await page.evaluate('window.lab.info');
    const timing = { fps, phases: await page.evaluate('window.lab.phases'), ticks: [], phase: [] };
    for (const [t, p] of (await page.evaluate('window.lab.timing')) || []) {
      timing.ticks.push(t);
      timing.phase.push(p);
    }
    const voiced = mixAudio(out, { says, sounds: sound ? sounds : [], beds: sound ? info?.beds : null, voiceDirs, fps, seconds: (frames + 1) / fps });
    return { out, frames: frames + 1, seconds: (frames + 1) / fps, says, voiced, sounds: sounds.length, soundList: sounds, errors, info, timing, console: page.console };
  });
}
