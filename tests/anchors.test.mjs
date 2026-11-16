// Anchors: children grow out of the spot their parent's picture shows (an armhole, a neckline), looks do not touch the fight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../kit/arena/engine/index.js';
import { placeBones, pictureFrame, findOpenings, bodyFit, fitWarnings, suggestAnchors, crotch, ANCHOR_MAX } from '../kit/arena/render/fit.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KIT = join(root, 'kit', 'fighter');
const raw = () => Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(join(KIT, `${f}.json`), 'utf8'))]));
const rest = { root: [0, 0], bones: {} };

// An upright 200×300 torso facing right: pivot at the bottom, tip at the top, 85 units → 300 px.
const TORSO = { image: 't.png', pivot: [100, 300], tip: [100, 0], width: 1 };
function picture(w, h, paint) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint(x, y);
    if (!c) continue;
    data.set([...c, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const RED = [170, 35, 35];
const BROWN = [64, 28, 21];
// a red vest with a flat brown armhole at the back (left), centre [60, 110]
const vest = picture(200, 300, (x, y) => (x < 20 || x > 180 ? null : (x - 60) ** 2 / 30 ** 2 + (y - 110) ** 2 / 40 ** 2 < 1 ? BROWN : RED));

test('без якорей части рисуются на суставах ринга', () => {
  const s = E.solvePose(rest);
  const p = placeBones(s, { torso: TORSO }, {});
  for (const b of E.BONES) {
    assert.equal(p[b.name].x, s[b.name].x);
    assert.equal(p[b.name].y, s[b.name].y);
  }
});

test('якорь сажает ребёнка в точку картинки родителя, его потомки идут следом, кости ринга не меняются', () => {
  const anchor = [60, 110];
  const parts = { torso: { ...TORSO, anchors: { upper_arm_front: anchor } } };
  const pose = { root: [0, 0], bones: { torso: -20, upper_arm_front: 70 } };
  const s = E.solvePose(pose);
  const before = JSON.stringify(s);
  const p = placeBones(s, parts, {});
  assert.equal(JSON.stringify(s), before);
  const [along, side] = pictureFrame(TORSO, 1, 85).toBone(anchor);
  const a = (p.torso.angle * Math.PI) / 180;
  const want = [p.torso.x + along * Math.cos(a) + side * Math.sin(a), p.torso.y + along * Math.sin(a) - side * Math.cos(a)];
  assert.ok(Math.hypot(p.upper_arm_front.x - want[0], p.upper_arm_front.y - want[1]) < 1e-9);
  const shift = [p.upper_arm_front.x - s.upper_arm_front.x, p.upper_arm_front.y - s.upper_arm_front.y];
  for (const c of ['forearm_front', 'hand_front']) {
    assert.ok(Math.abs(p[c].x - s[c].x - shift[0]) < 1e-9 && Math.abs(p[c].y - s[c].y - shift[1]) < 1e-9, c);
    assert.equal(p[c].angle, s[c].angle);
  }
  assert.equal(p.upper_arm_back.x, s.upper_arm_back.x);
});

test('якорь дальше предела ринг подтягивает к суставу', () => {
  const parts = { torso: { ...TORSO, anchors: { head: [100, 1000] } } };
  const s = E.solvePose(rest);
  const p = placeBones(s, parts, {});
  assert.ok(Math.abs(Math.hypot(p.head.x - s.head.x, p.head.y - s.head.y) - ANCHOR_MAX) < 1e-9);
  assert.ok(p.head.clamped);
});

test('проверка принимает якоря детей и отклоняет чужие кости и плохие точки', () => {
  const ok = raw();
  ok.body.parts.torso.anchors = { upper_arm_front: [40, 60], head: [230, 72] };
  const r = E.checkFighter(ok);
  assert.ok(r.ok, r.errors.join('\n'));
  assert.deepEqual(r.fighter.parts.torso.anchors.head, [230, 72]);
  const bad = raw();
  bad.body.parts.torso.anchors = { forearm_front: [1, 2], head: [1] };
  bad.body.parts.hand_front.anchors = { head: [1, 2] };
  const errs = E.checkFighter(bad).errors.join('\n');
  assert.match(errs, /torso\.anchors\.forearm_front: не ребёнок torso/);
  assert.match(errs, /torso\.anchors\.head: \[x, y\]/);
  assert.match(errs, /hand_front\.anchors: у hand_front нет детей/);
});

test('внешность не меняет бой: с якорями та же запись', () => {
  const a = raw();
  const b = raw();
  b.body.parts.torso.anchors = { upper_arm_front: [40, 60] };
  b.body.parts.pelvis.anchors = { thigh_front: [10, 10] };
  const run = (input) => {
    const def = E.checkFighter(input).fighter;
    const fight = E.createFight({ fighters: [def, E.checkFighter(raw()).fighter] });
    for (let i = 0; i < 600; i++) E.stepFight(fight, fight.freeze || fight.hitstop ? null : [{ walk: 1, attack: i % 40 === 0 ? def.moves[0].id : null }, {}]);
    return E.fightHash(fight);
  };
  assert.equal(run(a), run(b));
});

test('пройма находится: ровная тёмная область внутри части, тени и контур — нет', () => {
  const ops = findOpenings(vest);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'dark');
  assert.ok(Math.abs(ops[0].center[0] - 60) < 3 && Math.abs(ops[0].center[1] - 110) < 3);
  // a shadow is the same red, only darker; a hole through the picture is empty
  const shaded = picture(200, 300, (x, y) => (x < 20 || x > 180 ? null : x > 120 ? [95, 18, 20] : RED));
  assert.equal(findOpenings(shaded).length, 0);
  const holed = picture(200, 300, (x, y) => (x < 20 || x > 180 || (x - 60) ** 2 + (y - 110) ** 2 < 900 ? null : RED));
  assert.equal(findOpenings(holed)[0]?.kind, 'empty');
});

// a near upper arm: a 40×120 bar, pivot near its top
const ARM = { image: 'a.png', pivot: [20, 20], tip: [20, 110], z: 12, width: 1 };
const arm = picture(40, 130, () => [200, 160, 130]);

test('открытую пройму проверка называет и советует якорь; с якорем рука её закрывает', () => {
  const parts = { torso: { ...TORSO, z: 6 }, upper_arm_front: ARM };
  const images = { torso: vest, upper_arm_front: arm };
  const open = bodyFit(parts, {}, images, []);
  const w = fitWarnings(open, parts).join('\n');
  assert.match(w, /parts\.torso: тёмная область .* открыта/);
  assert.match(w, /поставь torso\.anchors\.upper_arm_front/);
  const s = suggestAnchors(vest, 'torso', { parts, seat: {}, images, poses: [] });
  assert.ok(s.anchors.upper_arm_front);
  const fixed = { ...parts, torso: { ...parts.torso, anchors: { upper_arm_front: s.anchors.upper_arm_front } } };
  assert.equal(fitWarnings(bodyFit(fixed, {}, images, []), fixed).length, 0);
});

test('ближняя рука под торсом пройму не закрывает: проверка так и говорит', () => {
  const parts = { torso: { ...TORSO, z: 6, anchors: { upper_arm_front: [60, 110] } }, upper_arm_front: { ...ARM, z: 2 } };
  const w = fitWarnings(bodyFit(parts, {}, { torso: vest, upper_arm_front: arm }, []), parts).join('\n');
  assert.match(w, /upper_arm_front рисуется под torso/);
  const s = suggestAnchors(vest, 'torso', { parts, seat: {}, images: { torso: vest, upper_arm_front: arm }, poses: [] });
  assert.ok(s.z.upper_arm_front > 6);
});

// a pelvis 200×200, joint at [100, 60]: a skirt down to y 190, or trousers split from y 120
const PELVIS = { image: 'p.png', pivot: [100, 60], tip: [100, 0], z: 7, width: 1 };
const skirt = picture(200, 200, (x, y) => (x > 30 && x < 170 && y < 190 ? RED : null));
const trousers = picture(200, 200, (x, y) => (x > 30 && x < 170 && y < 190 && !(y > 120 && x > 90 && x < 110) ? RED : null));
const THIGH = { image: 'th.png', pivot: [20, 20], tip: [20, 150], z: 8, width: 1 };
const thigh = picture(40, 170, () => [20, 20, 20]);

test('бедро поверх юбки растёт из её середины: проверка и подсказка ставят его под таз', () => {
  const parts = { pelvis: PELVIS, thigh_front: THIGH };
  const images = { pelvis: skirt, thigh_front: thigh };
  const w = fitWarnings(bodyFit(parts, {}, images, []), parts).join('\n');
  assert.match(w, /thigh_front: рисуется поверх pelvis .* растёт из середины части/);
  const s = suggestAnchors(skirt, 'pelvis', { parts, seat: {}, images, poses: [] });
  assert.ok(s.z.thigh_front < 7);
  const under = { ...parts, thigh_front: { ...THIGH, z: s.z.thigh_front } };
  assert.equal(fitWarnings(bodyFit(under, {}, images, []), under).length, 0);
});

test('у штанов подсказка находит развилку и ставит бёдра над штанинами на высоте ринга', () => {
  const c = crotch(trousers);
  assert.ok(c && Math.abs(c.notch[0] - 100) < 12);
  assert.ok(c.lobes[0] < 90 && c.lobes[1] > 110);
  const parts = { pelvis: PELVIS, thigh_front: THIGH, thigh_back: { ...THIGH, z: 3 } };
  const s = suggestAnchors(trousers, 'pelvis', { parts, seat: {}, images: { pelvis: trousers, thigh_front: thigh, thigh_back: thigh }, poses: [] });
  assert.ok(s.anchors.thigh_front[0] > s.anchors.thigh_back[0]);
  const fixed = { ...parts, pelvis: { ...PELVIS, anchors: s.anchors } };
  const p = placeBones(E.solvePose(rest), fixed, {});
  assert.ok(Math.abs(p.foot_front.y - E.solvePose(rest).foot_front.y) < 0.5, 'стопа на полу');
});

test('якорь бедра выше или ниже сустава ринга: проверка говорит, что стопа оторвётся от пола', () => {
  const parts = { pelvis: { ...PELVIS, anchors: { thigh_front: [100, 20] } }, thigh_front: THIGH };
  const w = fitWarnings(bodyFit(parts, {}, { pelvis: skirt, thigh_front: thigh }, []), parts).join('\n');
  assert.match(w, /anchors\.thigh_front: поднимает ногу на \d+ ед\. — в покое стопа висит над полом/);
});
