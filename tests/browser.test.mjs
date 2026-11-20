// Headless Chrome helper: a long answer from the page (a pose sheet's data URL runs to several MB) arrives whole;
// one DevTools answer of ~4.5 MB used to never arrive and `preview --sheet` hung forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { launch } from '../kit/arena/tools/browser.js';

test('длинная строка со страницы приходит целиком (лист поз 6 МБ)', { timeout: 120000 }, async () => {
  const b = await launch({ width: 320, height: 200 });
  try {
    const p = await b.open('about:blank');
    const s = await p.evaluateText('"data:image/png;base64," + "QUJD".repeat(1500000)');
    assert.equal(s.length, 22 + 6000000);
    assert.ok(s.endsWith('QUJDQUJD'));
    assert.equal(await p.evaluate('typeof window.__ringText'), 'undefined');
  } finally {
    await b.close();
  }
});

test('профиль Chrome инструментов участника лежит в его папке, у судьи — во временной', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { profileBase } = await import('../kit/arena/tools/browser.js');
  assert.equal(profileBase(), tmpdir());
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ring-prof-'))); // macOS: the temp folder is a link
  try {
    mkdirSync(join(root, 'arena', 'tools'), { recursive: true });
    copyFileSync(fileURLToPath(new URL('../kit/arena/tools/browser.js', import.meta.url)), join(root, 'arena', 'tools', 'browser.js'));
    writeFileSync(join(root, 'contestant.json'), '{}');
    const m = await import(pathToFileURL(join(root, 'arena', 'tools', 'browser.js')).href);
    assert.equal(m.profileBase(), join(root, 'out', '.chrome'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
