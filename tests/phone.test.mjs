// The game on a phone (a touch screen of 390×844, no keys and no gamepad): a touch gives the sound, the fight a player cannot control is not offered, the fight frame stands up while the phone is
// held upright and lies down when it is turned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch } from '../kit/arena/tools/browser.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('телефон: касание включает звук, боя без управления нет, кадр боя поворачивается вместе с телефоном', { timeout: 480000 }, async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, ['serve.mjs', '--port', String(port)], { cwd: root, stdio: 'ignore' });
  const browser = await launch({ width: 390, height: 844 });
  try {
    for (let i = 0; i < 50; i++) if (await fetch(`http://127.0.0.1:${port}/viewer/index.html`).then((r) => r.ok, () => false)) break; else await sleep(100);
    // a link of the site into «Ты против нейросети»: on a phone it opens the fight of two programs. (The title with
    // «Коснись экрана» and the main menu were watched in a browser with a video card: the software renderer of a
    // test spends minutes on the opening when the other tests run beside it.)
    const p = await browser.open(`http://127.0.0.1:${port}/viewer/?screen=play`, { w: 390, h: 844, scale: 2, mobile: true });
    const tap = async (x, y) => {
      await p.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await p.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const until = async (expr, ms = 60000) => {
      for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (await p.evaluate(expr)) return true;
      assert.fail(`не дождался: ${expr}`);
    };
    await until(`!!document.querySelector('#versus')?.classList.contains('mode-cpu')`, 360000);
    assert.equal(await p.evaluate(`document.body.classList.contains('touch')`), true);
    assert.equal(await p.evaluate(`document.querySelectorAll('[data-mode="play"]').length`), 0);
    assert.equal(await p.evaluate(`window.__game.pick.mode`), 'cpu');
    assert.equal(await p.evaluate(`getComputedStyle(document.querySelector('#backBtn')).display !== 'none' && !document.querySelector('#backBtn').hidden`), true, 'есть кнопка «назад»');
    // the sound comes with the first touch: a finger gives it on the way up
    const r = JSON.parse(await p.evaluate(`JSON.stringify((() => { const b = document.querySelector('.vs-name').getBoundingClientRect(); return [b.left + 10, b.top + 5]; })())`));
    await tap(r[0], r[1]);
    await until(`window.__game.sfx.ctx?.state === 'running'`, 20000);
    // the fight frame: 9:16 upright, 16:9 on its side, whole inside the window. (A whole show turned in the middle —
    // it is built again and goes on from the same tick — was watched in a browser with a video card: the software
    // renderer of a test spends minutes on one VS screen.)
    const shape = () => p.evaluate(`(async () => { const v = window.__game.fightView; await v.ensure(); const r = v.app.canvas.getBoundingClientRect(); v.frame.hidden = true; return JSON.stringify({ W: v.W, H: v.H, w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top) }); })()`).then(JSON.parse);
    const up = await shape();
    assert.deepEqual([up.W, up.H], [1080, 1920]);
    assert.ok(up.w === 390 && up.l === 0 && up.t >= 0 && up.t + up.h <= 844, `кадр целиком в окне: ${JSON.stringify(up)}`);
    await p.cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
    await until(`window.innerWidth === 844`, 5000);
    const side = await shape();
    assert.deepEqual([side.W, side.H], [1920, 1080]);
    assert.ok(side.h === 390 && side.l >= 0 && side.l + side.w <= 844, `кадр целиком в окне: ${JSON.stringify(side)}`);
    assert.deepEqual(p.console.filter((l) => !/звук|GPU|WebGL|swiftshader/i.test(l)), []);
  } finally {
    await browser.close();
    server.kill();
  }
});
