// The judge films a round's clip in several Chrome pages at once, each its own pieces, joined without encoding again
// (a round took 10 minutes in one page, the pause between rounds on the day of a shoot). The joined clip must be the
// clip of one page: as many frames, the same timing of frames, and no jump at the joins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadFighter, runFight } from '../kit/arena/tools/load.js';
import { renderClip, hasFfmpeg } from '../kit/arena/tools/preview.js';

import { setRuleset } from '../kit/arena/engine/standard.js';

setRuleset('standard'); // the page plays ring 4: the template fighter of the kit
const KIT_FIGHTER = new URL('../kit/fighter/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

test('ролик в несколько страниц совпадает с роликом одной страницы: кадры, разметка, стыки', { timeout: 300000, skip: !hasFfmpeg() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ring-clip-'));
  try {
    const r = await loadFighter(KIT_FIGHTER);
    assert.ok(r.ok, r.errors?.join('\n'));
    const run = await runFight({ dirs: [KIT_FIGHTER, KIT_FIGHTER], fighters: [r.fighter, r.fighter], maxTicks: 400, log: () => {} });
    writeFileSync(join(dir, 'replay.json'), JSON.stringify(run.replay));
    const folders = { '/f/0/': KIT_FIGHTER, '/f/1/': KIT_FIGHTER, '/rep/': dir };
    const query = { mode: 'replay', a: '/f/0/', b: '/f/1/', replay: '/rep/replay.json', show: 1, intro: 0 };
    const opts = { folders, query, w: 640, h: 360, fps: 30, maxFrames: 150, sound: false };
    const one = await renderClip({ ...opts, out: join(dir, 'one.mp4'), parts: 1 });
    const two = await renderClip({ ...opts, out: join(dir, 'two.mp4'), parts: 2, piece: 40 });
    assert.equal(two.parts, 2);
    assert.equal(two.frames, Math.min(one.frames, 150));
    assert.deepEqual(two.timing.ticks, one.timing.ticks.slice(0, two.frames));
    assert.ok(!existsSync(join(dir, 'two.part000.mp4')), 'куски убраны после склейки');
    // frame by frame against the clip of one page: only the noise of encoding, the joins (40, 80, 120) included
    const stats = join(dir, 'psnr.txt');
    execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'two.mp4'), '-i', join(dir, 'one.mp4'), '-lavfi', `[0:v]setpts=N/30/TB[a];[1:v]setpts=N/30/TB[b];[a][b]psnr=stats_file='${stats.replace(/\\/g, '/').replace(/:/g, '\\:')}'`, '-f', 'null', '-']);
    const psnr = readFileSync(stats, 'utf8').trim().split(/\r?\n/).map((l) => {
      const v = /psnr_avg:(\S+)/.exec(l)[1];
      return v === 'inf' ? 99 : Number(v);
    });
    assert.equal(psnr.length, two.frames);
    const worst = Math.min(...psnr);
    assert.ok(worst > 35, `кадр с разницей: PSNR ${worst} дБ на кадре ${psnr.indexOf(worst)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
