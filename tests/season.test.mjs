// A published season must play the same for good: every round of seasons/<season>/ is replayed from its record by
// the engine of today and gives the hash the judge wrote down on the day of the tournament. A change of the engine
// that moves a single tick of an old fight fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { loadFighter, replayFight } from '../kit/arena/tools/load.js';

E.setRuleset('standard'); // seasons are fights of ring 4

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SEASONS = join(root, 'seasons');
const rounds = [];
for (const season of existsSync(SEASONS) ? readdirSync(SEASONS).sort() : []) {
  const file = join(SEASONS, season, 'game.json');
  if (!existsSync(file)) continue;
  for (const m of JSON.parse(readFileSync(file, 'utf8')).matches) for (const r of m.rounds) rounds.push({ season, match: m.id, ...r });
}
const local = (url) => join(root, ...url.split('/').filter(Boolean));

test('у каждого раунда сезона в репозитории лежат запись боя и обе версии бойцов', { skip: !rounds.length && 'сезонов нет' }, () => {
  for (const r of rounds) {
    assert.ok(r.replay && existsSync(local(r.replay)), `${r.season} ${r.match} раунд ${r.n}: нет записи ${r.replay}`);
    for (const d of r.dirs) assert.ok(d && existsSync(join(local(d), 'fighter.json')), `${r.season} ${r.match} раунд ${r.n}: нет бойца ${d}`);
  }
});

test('записи сезона воспроизводятся сегодняшним движком тик в тик', { skip: !rounds.length && 'сезонов нет', timeout: 300000 }, async () => {
  const loaded = new Map();
  const fighter = async (url) => {
    if (!loaded.has(url)) {
      const r = await loadFighter(local(url));
      assert.ok(r.ok, `${url}: ${(r.errors || []).slice(0, 3).join('; ')}`);
      loaded.set(url, r.fighter);
    }
    return loaded.get(url);
  };
  let seen = 0;
  for (const r of rounds) {
    const replay = JSON.parse(readFileSync(local(r.replay), 'utf8'));
    const fight = replayFight([await fighter(r.dirs[0]), await fighter(r.dirs[1])], replay);
    assert.equal(E.fightHash(fight), replay.hash, `${r.season} ${r.match} раунд ${r.n}: бой пошёл иначе, чем записан`);
    // and it ends as the season's table says
    assert.equal(fight.over, true);
    assert.deepEqual(fight.f.map((x) => Math.max(0, Math.round(x.hp))), r.hp, `${r.season} ${r.match} раунд ${r.n}: здоровье в конце`);
    seen++;
  }
  assert.equal(seen, rounds.length);
});
