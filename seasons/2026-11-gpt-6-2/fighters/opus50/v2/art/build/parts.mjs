// Part placement for «Метроном». Imported by build.mjs.
const limb = (img, pivot, tip, extra = {}) => ({ image: `parts/${img}.png`, pivot, tip, seat: false, ...extra });
export const parts = {
  pelvis: { image: 'parts/pelvis.png', pivot: [168, 150], tip: [168, 38], width: 0.8,
    anchors: { thigh_front: [205, 150], thigh_back: [131, 150] } },
  torso: { image: 'parts/torso.png', pivot: [150, 355], tip: [150, 39], width: 1.0,
    anchors: { head: [146, 40], upper_arm_front: [70, 103], upper_arm_back: [205, 88] } },
  head: { image: "parts/head.png", pivot: [148, 322], tip: [148, 133] },
  upper_arm_back: limb('upper_arm_back', [49, 75], [252, 72], { width: 0.85 }),
  forearm_back: limb('forearm_back', [48, 72], [254, 72], { width: 0.9 }),
  hand_back: limb('hand_back', [40, 105], [160, 100]),
  thigh_back: limb('thigh_back', [57, 91], [306, 92], { width: 0.72 }),
  shin_back: limb('shin_back', [51, 90], [260, 87], { width: 0.72 }),
  foot_back: limb('foot_back', [105, 142], [245, 142]),
  thigh_front: limb('thigh_front', [57, 91], [306, 92], { width: 0.72 }),
  shin_front: limb('shin_front', [51, 90], [260, 87], { width: 0.72 }),
  foot_front: limb('foot_front', [105, 142], [245, 142]),
  upper_arm_front: limb('upper_arm_front', [49, 75], [252, 72], { width: 0.85 }),
  forearm_front: limb('forearm_front', [48, 72], [254, 72], { width: 0.9 }),
  hand_front: limb('hand_front', [40, 105], [160, 100]),
};
