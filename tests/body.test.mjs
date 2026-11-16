// The body on the ring skeleton: separate shoulders and hips, far limbs behind the body, joints sunk into thin caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../kit/arena/engine/index.js';
import { DEFAULT_Z } from '../kit/arena/engine/skeleton.js';
import { seatPart } from '../kit/arena/render/seat.js';

test('плечи и бёдра в покое в разных точках: дальние сзади, ближние спереди, дальнее плечо выше', () => {
  const j = E.solvePose({ root: [0, 0], bones: {} });
  assert.ok(j.upper_arm_back.x < j.upper_arm_front.x - 10);
  assert.ok(j.upper_arm_back.y > j.upper_arm_front.y);
  assert.ok(j.thigh_back.x < j.thigh_front.x - 8);
});

test('смещение поперёк родителя поворачивается вместе с торсом', () => {
  const lean = E.solvePose({ root: [0, 0], bones: { torso: -90 } }); // torso lies forward
  // forward across a torso pointing forward is down: the near shoulder sits below the far one
  assert.ok(lean.upper_arm_front.y < lean.upper_arm_back.y - 10);
});

test('по умолчанию дальние рука и нога позади торса, ближние впереди', () => {
  for (const n of ['upper_arm_back', 'forearm_back', 'hand_back', 'thigh_back', 'shin_back', 'foot_back']) assert.ok(DEFAULT_Z[n] < DEFAULT_Z.torso, n);
  for (const n of ['upper_arm_front', 'forearm_front', 'hand_front', 'thigh_front', 'shin_front', 'foot_front']) assert.ok(DEFAULT_Z[n] > DEFAULT_Z.torso, n);
});

// a vertical bar 20 px thick from y = top to y = bottom on a 40×200 picture
function bar(top, bottom) {
  const w = 40;
  const h = 200;
  const data = new Uint8Array(w * h * 4);
  for (let y = top; y <= bottom; y++) for (let x = 10; x < 30; x++) data[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, data };
}

test('сустав без запаса ринг утапливает в картинку, с запасом не трогает', () => {
  const thin = seatPart(bar(20, 180), { pivot: [20, 20], tip: [20, 180] }, 'forearm_front');
  assert.ok(thin.moved);
  assert.ok(thin.pivot[1] > 24 && thin.tip[1] < 176);
  const capped = seatPart(bar(10, 190), { pivot: [20, 20], tip: [20, 180] }, 'forearm_front');
  assert.equal(capped.moved, false);
  const torso = seatPart(bar(20, 180), { pivot: [20, 180], tip: [20, 20] }, 'torso');
  assert.equal(torso.moved, false);
});

test('подгонка не растягивает часть больше предела', () => {
  const s = seatPart(bar(60, 70), { pivot: [20, 60], tip: [20, 70] }, 'hand_front');
  const L = Math.hypot(s.tip[0] - s.pivot[0], s.tip[1] - s.pivot[1]);
  assert.ok(L >= 9 - 1e-9);
});
