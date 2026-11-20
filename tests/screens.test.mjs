// The screens between rounds say the right things: a locker room's changes become cards (a stat moved by one
// point, the changed line of the brain word for word), a round's big numbers, the model's words cut whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffFighters } from '../judge/match.js';
import { changeCards, keyNumbers, plainSay } from '../viewer/game/screen-data.js';

const KIT = new URL('./fixtures/ring3/fighter/', import.meta.url);

function twoVersions(change) {
  const dir = mkdtempSync(join(tmpdir(), 'ring-locker-'));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  cpSync(KIT, a, { recursive: true });
  cpSync(KIT, b, { recursive: true });
  change(b);
  return { dir, a, b };
}

test('раздевалка: очко характеристики и строка мозгов становятся карточками, строка кода дословно', () => {
  const { dir, a, b } = twoVersions((b) => {
    const card = JSON.parse(readFileSync(join(b, 'fighter.json'), 'utf8'));
    const [up, down] = Object.keys(card.stats).filter((k, i, all) => i < 2);
    card.stats[up] += 1;
    card.stats[down] -= 1;
    writeFileSync(join(b, 'fighter.json'), JSON.stringify(card, null, 1));
    const brain = readFileSync(join(b, 'brain.js'), 'utf8');
    writeFileSync(join(b, 'brain.js'), `${brain}\nconst waitForTheBlow = true; // ждать удар\n`);
  });
  try {
    const ch = diffFighters(a, b);
    assert.equal(ch.brain, true);
    assert.deepEqual(ch.brainLines.added, ['const waitForTheBlow = true; // ждать удар']);
    const cards = changeCards(ch);
    const stats = cards.filter((c) => c.kind === 'stat');
    assert.equal(stats.length, 2);
    assert.deepEqual(stats.map((c) => c.delta).sort(), [-1, 1]);
    assert.ok(stats.every((c) => c.to - c.from === c.delta && c.main));
    const brain = cards.find((c) => c.kind === 'brain');
    assert.equal(brain.title, 'Мозги · одна строка');
    assert.deepEqual(brain.code.added, ['const waitForTheBlow = true; // ждать удар']);
    assert.deepEqual(changeCards(diffFighters(a, a)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('итог раунда: две-три главные цифры, у победы — сколько здоровья осталось у победителя', () => {
  const c = (hits, maxCombo = 1, supers = 0) => ({ hits, maxCombo, supers, damage: hits * 50 });
  const win = { hp: [[0, 1, 1], [17.4, 0.06, 0]], counters: [c(21, 5), c(18)], juicy: { side: 0, name: 'Хвост лисы', damage: 54 } };
  const n = keyNumbers(win, 0);
  assert.equal(n.length, 3);
  assert.deepEqual([n[0].label, n[0].one, n[0].side], ['Здоровья осталось', 6, 0]);
  assert.deepEqual([n[1].label, n[1].one], ['Лучшая серия', 5]);
  assert.deepEqual([n[2].label, n[2].one, n[2].sub], ['Самый сочный удар', 54, '«Хвост лисы»']);
  const draw = keyNumbers({ hp: [[0, 1, 1], [16.7, 0, 0]], counters: [c(19, 1, 1), c(19, 1, 1)], juicy: null }, null);
  assert.deepEqual(draw.map((x) => x.label), ['Попадания', 'Суперприёмы']);
  assert.deepEqual(draw[0].pair, [19, 19]);
});

test('слова модели на экране обрезаются по целым предложениям', () => {
  const said = 'Посмотрел запись. Поменял одну строку в мозгах: супер только после промаха соперника. Первым не бить, ждать удар.';
  assert.equal(plainSay(said, 90), 'Посмотрел запись. Поменял одну строку в мозгах: супер только после промаха соперника.');
  assert.equal(plainSay('**Жирный** `код`'), 'Жирный код');
});

test('слова модели: жирный и код показываются как текст, без звёздочек и обратных кавычек', async () => {
  const { saidHtml, saidPlain } = await import('../viewer/game/screen-data.js');
  const md = '**Что было в раунде 1.** Удар `keel` <быстрый>\n- первое\n1. **Раз.** два';
  const html = saidHtml(md);
  assert.ok(html.startsWith('<b>Что было в раунде 1.</b> Удар <code>keel</code> &lt;быстрый&gt;'));
  assert.ok(html.includes('\n• первое\n1. <b>Раз.</b> два'));
  assert.ok(!/\*\*|`/.test(html));
  assert.equal(saidPlain('**a** `b`'), 'a b');
});
