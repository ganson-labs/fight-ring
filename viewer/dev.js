// Developer mode of the viewer (dev.html): the old form. A match round plays its recording (computed by the judge in Node); a free fight is computed here
// first (brains in Web Workers, the judge's engine copy). Both are shown by the same broadcast as recorded clips.
import * as PIXI from 'pixi.js';
import * as E from '/kit/arena/engine/index.js';
import { loadFighterAssets, loadStage } from '/kit/arena/render/assets.js';
import { Scene } from '/kit/arena/render/scene.js';
import { Broadcast } from '/kit/arena/render/broadcast.js';
import { loadAds, attachBillboard } from '/kit/arena/render/ads.js';
import { BrainHost } from './brain-host.js';
import { Sfx } from './sfx.js';

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const sfx = new Sfx();
let fighters = [];
let stages = [];
let matches = [];
let app = null;
let scene = null;
let bc = null;
let current = null;
let raf = 0;
let runId = 0;

function status(msg, error = false) {
  $('#status').textContent = msg;
  $('#status').classList.toggle('error', error);
}

async function lists() {
  [fighters, stages, matches] = await Promise.all(['fighters', 'stages', 'matches'].map(async (k) => (await fetch(`/api/${k}`)).json()));
  for (const sel of [$('#fa'), $('#fb')]) sel.innerHTML = fighters.map((f) => `<option value="${f.id}">${f.name} — ${f.model}</option>`).join('');
  $('#stage').innerHTML = '<option value="">Тренировочный зал</option>' + stages.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  const contest = fighters.filter((f) => f.id.startsWith('c/'));
  $('#fa').value = q.get('a') || contest[0]?.id || 'kit/fighter';
  $('#fb').value = q.get('b') || contest[1]?.id || 'sparring/dummy';
  $('#stage').value = q.get('stage') ?? (stages[0]?.id || '');
  if (q.get('aspect')) $('#aspect').value = q.get('aspect');
  if (q.get('dummy')) $('#dummy').value = q.get('dummy');
  if (q.get('ads') === '1') $('#ads').checked = true;
  $('#match').innerHTML = matches.length ? matches.map((m) => `<option value="${m.id}">${m.id}: ${m.models[m.red]} — ${m.models[m.blue]}, ${m.score[m.red]}:${m.score[m.blue]}${m.over ? ' (окончен)' : ''}</option>`).join('') : '<option value="">матчей пока нет</option>';
  if (q.get('match')) $('#match').value = q.get('match');
  fillRounds();
}

function fillRounds() {
  const m = matches.find((x) => x.id === $('#match').value);
  $('#round').innerHTML = m ? m.rounds.map((r) => `<option value="${r.n}">Раунд ${r.num}${r.rerun ? ' · переигровка' : ''}: ${r.winner ? `победа ${m.models[r.winner]}` : 'ничья'}</option>`).join('') : '';
  if (q.get('round')) $('#round').value = q.get('round');
  $('#btnRound').disabled = !m || !m.rounds.length;
}
$('#match').onchange = fillRounds;

async function ensureApp(aspect) {
  const vertical = aspect === '9:16';
  const [w, h] = vertical ? [1080, 1920] : [1920, 1080];
  if (app && app.renderer.width === w && app.renderer.height === h) return;
  if (app) {
    cancelAnimationFrame(raf);
    app.destroy(true, { children: true });
  }
  app = new PIXI.Application();
  await app.init({ width: w, height: h, background: 0x07080c, antialias: true, preference: 'webgl', autoStart: false, resolution: 1 });
  $('#frame').innerHTML = '';
  $('#frame').appendChild(app.canvas);
}

async function computeFight(entries, assets, options, seed) {
  const hosts = entries.map((e, i) => new BrainHost(`${e.dir}brain.js`, assets[i].def.card.name));
  try {
    await Promise.all(hosts.map((h) => h.load()));
    const fight = E.createFight({ fighters: assets.map((a) => a.def), seed });
    await Promise.all(hosts.map((h, s) => h.init({ side: s, opponent: { name: assets[1 - s].def.card.name }, options, view: E.brainView(fight, s) })));
    const steps = [];
    let tail = 0;
    let lastShown = 0;
    while (tail < 150 && fight.tick < E.ROUND_TICKS + 600) {
      let acts = null;
      if (!fight.over && !fight.freeze && !fight.hitstop) {
        const raw = await Promise.all(hosts.map((h, s) => h.tick(E.brainView(fight, s))));
        acts = raw.map((a) => E.sanitizeAction(a));
      }
      steps.push(acts);
      E.stepFight(fight, acts);
      if (fight.over) tail++;
      if (performance.now() - lastShown > 250) {
        lastShown = performance.now();
        status(`Считаю бой… ${(fight.tick / 60).toFixed(0)} с боя`);
      }
    }
    return { steps, seed, stats: hosts.map((h) => h.stats), abilities: fight.abilityStats.map((s) => ({ hooks: s.hooks, cuts: s.cuts, errors: s.errors })), hash: E.fightHash(fight), result: { winner: fight.winner, reason: fight.endReason, hp: fight.f.map((F) => F.hp), ticks: fight.endTick ?? fight.tick } };
  } finally {
    hosts.forEach((h) => h.dispose());
  }
}

function compress(steps) {
  const out = [];
  let prev;
  for (const s of steps) {
    const k = JSON.stringify(s);
    if (out.length && k === prev) out[out.length - 1][0]++;
    else {
      out.push([1, s]);
      prev = k;
    }
  }
  return out;
}

const expand = (runs) => runs.flatMap(([n, s]) => Array(n).fill(s));

async function prepareFree() {
  const entries = [$('#fa').value, $('#fb').value].map((id) => fighters.find((f) => f.id === id));
  status('Загружаю бойцов…');
  const assets = await Promise.all(entries.map((e) => loadFighterAssets(e.dir)));
  const stage = $('#stage').value ? await loadStage(stages.find((s) => s.id === $('#stage').value).dir) : null;
  const options = { dummy: $('#dummy').value };
  const seed = Number(q.get('seed')) || E.RING_SEED;
  const rec = await computeFight(entries, assets, options, seed);
  for (const [i, s] of rec.abilities.entries()) if (s.errors.length || Object.keys(s.cuts).length) console.warn(`способности ${assets[i].def.card.name}: срезано ${JSON.stringify(s.cuts)}${s.errors.length ? `, отключены: ${s.errors.map((e) => e.script + ' — ' + e.message).join('; ')}` : ''}`);
  for (const [i, s] of rec.stats.entries()) if (s.slow || s.errors || s.cut) console.warn(`мозги ${assets[i].def.card.name}: пропущено ${s.slow}, ошибок ${s.errors}${s.cut ? ', отключены' : ''} ${s.lastError}`);
  return { entries, assets, stage, replay: { ring: 1, seed: rec.seed, options, steps: compress(rec.steps), hash: rec.hash, result: rec.result, fighters: entries.map((e) => e.id), stats: rec.stats }, show: { round: 1, wins: [0, 0], firstTo: 2, final: false } };
}

async function prepareRound() {
  const m = matches.find((x) => x.id === $('#match').value);
  const r = m.rounds.find((x) => String(x.n) === $('#round').value);
  status('Загружаю раунд…');
  const entries = r.dirs.map((dir, i) => ({ dir, model: m.models[i === 0 ? r.left : r.right] }));
  const assets = await Promise.all(entries.map((e) => loadFighterAssets(e.dir)));
  const st = stages.find((s) => s.id === r.stage);
  const stage = st ? await loadStage(st.dir) : null;
  const replay = await (await fetch(r.replay, { cache: 'no-store' })).json();
  return { entries, assets, stage, replay, show: { round: r.num, rerun: r.rerun, wins: r.wins, firstTo: m.firstTo, final: r.final } };
}

const wait = (ms, id) => new Promise((res) => setTimeout(() => res(id === runId), ms));

async function play(c, { intro }) {
  const id = ++runId;
  $('#menu').hidden = true;
  $('#result').hidden = true;
  const aspect = $('#aspect').value;
  await ensureApp(aspect);
  const vertical = aspect === '9:16';
  app.stage.removeChildren();
  bc?.destroy();
  const W = app.renderer.width;
  const H = app.renderer.height;
  scene = new Scene(app, { width: W, height: H, vertical, names: c.entries.map((e) => e.model), debug: !!scene?.debug });
  scene.setStage(c.stage);
  const ads = $('#ads').checked ? await loadAds('/ads/sponsor/', { force: true }) : null;
  if (ads) attachBillboard(scene, ads);
  scene.setFighters(c.assets);
  const fight = E.createFight({ fighters: c.assets.map((a) => a.def), seed: c.replay.seed ?? E.RING_SEED });
  scene.reset(fight);
  const steps = expand(c.replay.steps);
  const bases = c.entries.map((e) => e.dir);
  bc = new Broadcast({
    app, scene, assets: c.assets, fight, steps, source: (f, i) => (i < steps.length ? steps[i] : undefined), names: c.entries.map((e) => e.model),
    width: W, height: H, vertical, show: true, intro, ...c.show, ads, announcer: true, totalTicks: c.replay.result?.ticks || 1, seed: c.replay.seed ?? E.RING_SEED,
    // the shown fight is a replay of the recorded one: abilities included, it must end in the same state
    onRecordEnd: (f) => {
      if (c.replay.hash && E.fightHash(f) !== c.replay.hash) console.warn(`повтор разошёлся с записью: ${E.fightHash(f)} против ${c.replay.hash}`);
    },
    onSound: (name, gain, variant, delay) => sfx.play(name, gain, variant, delay),
    onSay: (side, line) => sfx.line(side === 'ring' ? '/announcer/' : bases[side], line),
  });
  current = c;
  cancelAnimationFrame(raf);
  let last = performance.now();
  const loop = (t) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (id !== runId) return;
    bc.frame(dt);
    app.render();
    if (bc.done && $('#result').hidden) showResult(c, bc.fight);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  await wait(0, id);
}

function showResult(c, fight) {
  const w = fight.winner;
  const name = w === null ? 'Ничья' : `${c.assets[w].def.card.name} побеждает`;
  const how = { ko: 'нокаутом', time: 'по времени', limit: 'предел' }[fight.endReason] || '';
  const t = fight.f.map((F) => `${F.def.card.name}: урон ${F.tally.damageDealt}, попаданий ${F.tally.hits}, в блок ${F.tally.blocked}, парирований ${F.tally.parries}, бросков ${F.tally.throws}, суперов ${F.tally.supers}`).join('<br>');
  $('#result').innerHTML = `<b>${name}</b>${w !== null ? `<span>${how}, ${((fight.endTick ?? fight.tick) / 60).toFixed(1)} с</span>` : ''}<p>${t}</p><p>R — повтор · Esc — меню · S — сохранить запись</p>`;
  $('#result').hidden = false;
}

async function start(kind, intro) {
  try {
    sfx.unlock();
    const c = kind === 'round' ? await prepareRound() : await prepareFree();
    status('');
    await play(c, { intro });
  } catch (err) {
    console.error(err);
    $('#menu').hidden = false;
    status(String(err.message || err), true);
  }
}

$('#btnRound').onclick = () => start('round', true);
$('#btnIntro').onclick = () => start('free', true);
$('#btnFight').onclick = () => start('free', false);

window.addEventListener('keydown', async (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    runId++;
    $('#result').hidden = true;
    $('#menu').hidden = false;
  }
  if (!bc) return;
  const p = bc.player;
  if (e.code === 'Space') {
    e.preventDefault();
    bc.paused = !bc.paused;
  }
  if (e.key === '1') p.speed = 1;
  if (e.key === '2') p.speed = 2;
  if (e.key === '0') p.speed = 0.5;
  if (e.key === 'd' || e.key === 'D') scene.debug = !scene.debug;
  if (e.key === 'm' || e.key === 'M') sfx.set(!sfx.on, sfx.volume);
  if ((e.key === 'r' || e.key === 'R') && current) play(current, { intro: false });
  if ((e.key === 'f' || e.key === 'F') && document.fullscreenElement == null) document.documentElement.requestFullscreen().catch(() => {});
  if ((e.key === 's' || e.key === 'S') && current) {
    const blob = new Blob([JSON.stringify(current.replay)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fight-${current.replay.hash}.json`;
    a.click();
  }
});

window.__ring = { get broadcast() { return bc; }, get scene() { return scene; }, get current() { return current; } };

lists().then(() => {
  if (q.get('auto') === 'round') start('round', true);
  else if (q.get('auto')) start('free', q.get('auto') === 'intro');
}).catch((err) => status(String(err.message || err), true));
