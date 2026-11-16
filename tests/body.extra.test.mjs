// A fighter's body beyond the ring's 15 bones (engine/body.js): own bones in chains with springs, pictures, scale
// and draw order in keys, meshes bending one picture over several bones, feet held on the floor. All optional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as E from '../kit/arena/engine/index.js';

const KIT = new URL('../kit/fighter/', import.meta.url);
const raw = () => Object.fromEntries(['fighter', 'body', 'moves', 'voice'].map((f) => [f, JSON.parse(readFileSync(new URL(`${f}.json`, KIT), 'utf8'))]));
const files = new Set(['parts/a.png', 'parts/b.png', ...readdirSync(new URL('parts/', KIT)).map((f) => `parts/${f}`)]);
const check = (input) => E.checkFighter(input, { files });

test('свои кости: цепочка от кости ринга, позы их поворачивают, пружина отстаёт и догоняет', () => {
  const input = raw();
  input.body.bones = {
    tail_1: { parent: 'pelvis', attach: 0, side: -20, angle: 180, length: 40, spring: { stiffness: 0.2, damping: 0.2 } },
    tail_2: { parent: 'tail_1', angle: 0, length: 30 },
  };
  input.body.parts.tail_1 = { image: 'parts/a.png', pivot: [0, 0], tip: [0, 100] };
  input.body.poses.stance.bones.tail_2 = 25;
  const r = check(input);
  assert.ok(r.ok, r.errors.join('\n'));
  assert.deepEqual(r.fighter.bones.map((b) => b.name), ['tail_1', 'tail_2']);
  const pose = r.fighter.poses.stance;
  const s = E.solveBody(pose, r.fighter);
  // tail_2 starts at tail_1's tip and turns by the pose
  assert.ok(Math.abs(s.tail_2.x - s.tail_1.tipX) < 1e-6 && Math.abs(s.tail_2.y - s.tail_1.tipY) < 1e-6);
  assert.ok(Math.abs(s.tail_2.angle - (s.tail_1.angle + 25)) < 1e-6);
  // a spring: the pelvis turns at once, the tail follows over frames
  const springs = new Map();
  E.solveBody(pose, r.fighter, { springs });
  const turned = { ...pose, bones: { ...pose.bones, pelvis: 40 } };
  const first = E.solveBody(turned, r.fighter, { springs }).tail_1.angle;
  let last = first;
  for (let i = 0; i < 120; i++) last = E.solveBody(turned, r.fighter, { springs }).tail_1.angle;
  const target = E.solveBody(turned, r.fighter).tail_1.angle;
  assert.ok(Math.abs(first - target) > 5, 'в первый кадр отстаёт');
  assert.ok(Math.abs(last - target) < 1, 'потом догоняет');
});

test('свои кости: ошибки формата — имя кости ринга, чужой родитель, круг, больше 12', () => {
  const bad = (bones) => {
    const input = raw();
    input.body.bones = bones;
    return check(input).errors.join('\n');
  };
  assert.match(bad({ torso: { parent: 'pelvis', length: 10 } }), /так зовут кость ринга/);
  assert.match(bad({ x: { parent: 'nope', length: 10 } }), /parent: кость ринга или своя кость/);
  assert.match(bad({ a: { parent: 'b', length: 10 }, b: { parent: 'a', length: 10 } }), /по кругу/);
  assert.match(bad(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`b${i}`, { parent: 'torso', length: 5 }]))), /не больше 12/);
});

test('в ключе: другая картинка части и порядок держатся до следующей правки, масштаб плавно', () => {
  const input = raw();
  input.body.parts.hand_front.skins = { open: { image: 'parts/a.png', pivot: [0, 0], tip: [10, 0] } };
  input.body.anims.idle = { loop: true, length: 60, keys: [
    { t: 0, pose: { bones: {}, images: { hand_front: 'open' }, z: { upper_arm_back: 20 }, scale: { torso: [1.2, 0.8] } } },
    { t: 30, pose: { bones: {} } },
  ] };
  const r = check(input);
  assert.ok(r.ok, r.errors.join('\n'));
  const a = r.fighter.anims.idle;
  assert.equal(a.keys[1].pose.images.hand_front, 'open', 'картинка держится во втором ключе');
  assert.equal(a.keys[1].pose.z.upper_arm_back, 20);
  const mid = E.sampleAnim(a, 15);
  assert.ok(Math.abs(mid.scale.torso[0] - 1.1) < 1e-6 && Math.abs(mid.scale.torso[1] - 0.9) < 1e-6);
  const input2 = raw();
  input2.body.poses.stance.images = { hand_front: 'nope' };
  assert.match(check(input2).errors.join('\n'), /нет картинки «nope»/);
});

test('сетка: одна картинка на цепочку, веса в сумме 1, в позе покоя ложится на свои кости', () => {
  const points = [[50, 0], [50, 100], [50, 200]];
  const m = E.buildMesh(100, 200, points);
  for (const w of m.weights) assert.ok(Math.abs(w.reduce((a, [, x]) => a + x, 0) - 1) < 1e-9);
  // the top far from the elbow follows the first bone only, the bottom the second only
  assert.deepEqual(m.weights[0].map(([i]) => i), [0]);
  assert.deepEqual(m.weights[m.weights.length - 1].map(([i]) => i), [1]);
  // two bones straight down from (0, 100), 50 units each: the picture's joint points land on the joints
  const placed = [{ x: 0, y: 100, angle: -90, length: 50 }, { x: 0, y: 50, angle: -90, length: 50 }];
  const out = E.skinMesh({ vertices: new Float32Array([50, 0, 50, 100, 50, 200]), weights: [[[0, 1]], [[0, 0.5], [1, 0.5]], [[1, 1]]] }, points, placed);
  assert.deepEqual([...out].map((v) => Math.round(v)), [0, 100, 0, 50, 0, 0]);
  // bent at the elbow: the end follows the second bone
  const bent = [{ x: 0, y: 100, angle: -90, length: 50 }, { x: 0, y: 50, angle: 0, length: 50 }];
  const o2 = E.skinMesh({ vertices: new Float32Array([50, 200]), weights: [[[1, 1]]] }, points, bent);
  assert.deepEqual([...o2].map((v) => Math.round(v)), [50, 50]);
});

test('сетка в body.json: цепочка по детям, точки на каждый сустав и конец', () => {
  const input = raw();
  input.body.parts.upper_arm_front = { image: 'parts/a.png', mesh: { bones: ['upper_arm_front', 'forearm_front'], points: [[0, 0], [0, 50], [0, 100]] } };
  input.body.parts.forearm_front = null;
  const r = check(input);
  assert.ok(r.ok, r.errors.join('\n'));
  assert.deepEqual(r.fighter.parts.upper_arm_front.pivot, [0, 0]);
  input.body.parts.upper_arm_front.mesh.bones = ['upper_arm_front', 'shin_front'];
  assert.match(check(input).errors.join('\n'), /цепочка от upper_arm_front вниз по детям/);
});

test('стопы на полу: голень дотягивается коленом, бедро на месте', () => {
  const input = raw();
  input.body.ik = { feet: true };
  const def = check(input).fighter;
  // the pelvis bobs down 10: without IK the ankles sink under the floor
  const pose = { root: [0, -10], bones: {} };
  const fk = E.solvePose(pose);
  assert.ok(fk.shin_front.tipY < E.ANKLE_REST - 5);
  const s = E.solveBody(pose, def);
  assert.ok(Math.abs(s.shin_front.tipY - E.ANKLE_REST) < 0.5);
  assert.ok(Math.abs(s.thigh_front.x - fk.thigh_front.x) < 1e-9 && Math.abs(s.thigh_front.y - fk.thigh_front.y) < 1e-9);
  // the knee bends forward
  assert.ok(s.thigh_front.tipX > s.thigh_front.x);
  // in the air nothing is pulled down
  const air = E.solveBody({ root: [0, 60], bones: {} }, def, { grounded: false });
  assert.ok(air.shin_front.tipY > E.ANKLE_REST + 40);
});
