// How a part's picture sits on its bone. A limb drawn with only a thin margin past its joint leaves a notch on the
// outside of every bend (elbow, knee, ankle). The ring sinks such a joint into the picture: it moves the pivot or
// the tip along the part's axis until the picture covers the joint with a round cap about half as deep as the limb
// is thick there. The bone length stays the same, the picture grows a little. Pure function: browser and Node.

// ends that meet a neighbour: pivot — the joint with the parent, tip — the joint with the child
const JOINTS = {
  upper_arm_back: ['pivot', 'tip'], forearm_back: ['pivot', 'tip'], hand_back: ['pivot'],
  upper_arm_front: ['pivot', 'tip'], forearm_front: ['pivot', 'tip'], hand_front: ['pivot'],
  thigh_back: ['tip'], shin_back: ['pivot', 'tip'], foot_back: ['pivot'],
  thigh_front: ['tip'], shin_front: ['pivot', 'tip'], foot_front: ['pivot'],
};
const CAP = 0.38; // wanted depth of the cap past the joint, share of the limb's thickness at that end
// the pivot → tip segment shrinks at most by this share: limbs grow at most ~18 %, hands and feet ~11 %
const MAX_SHRINK = 0.15;
const MAX_SHRINK_END = 0.1;

// img: { width, height, data } (RGBA); part: { pivot, tip }. Returns { pivot, tip, ends: { pivot, tip }, moved }.
// ends.X: { margin, thick } in picture pixels — how far the picture reaches past that joint and how thick it is there.
export function seatPart(img, part, bone) {
  const [px, py] = part.pivot;
  const ax = part.tip[0] - px;
  const ay = part.tip[1] - py;
  const L = Math.hypot(ax, ay);
  if (!img || !L) return { pivot: part.pivot, tip: part.tip, ends: {}, moved: false };
  const ux = ax / L;
  const uy = ay / L;
  const { width: w, height: h, data } = img;
  let lo = 0;
  let hi = L;
  // thickness across the axis in a band around each end
  const band = Math.max(4, L * 0.12);
  const span = { pivot: [Infinity, -Infinity], tip: [Infinity, -Infinity] };
  const step = Math.max(1, Math.round(Math.max(w, h) / 400));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (data[(y * w + x) * 4 + 3] < 100) continue;
    const s = (x - px) * ux + (y - py) * uy;
    const t = -(x - px) * uy + (y - py) * ux;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
    if (Math.abs(s) < band) {
      span.pivot[0] = Math.min(span.pivot[0], t);
      span.pivot[1] = Math.max(span.pivot[1], t);
    }
    if (Math.abs(s - L) < band) {
      span.tip[0] = Math.min(span.tip[0], t);
      span.tip[1] = Math.max(span.tip[1], t);
    }
  }
  const thick = (k) => (span[k][1] > span[k][0] ? span[k][1] - span[k][0] : 0);
  const ends = { pivot: { margin: -lo, thick: thick('pivot') }, tip: { margin: hi - L, thick: thick('tip') } };
  let inPivot = 0;
  let inTip = 0;
  for (const end of JOINTS[bone] || []) {
    const e = ends[end];
    const need = Math.max(0, CAP * e.thick - e.margin);
    if (end === 'pivot') inPivot = need;
    else inTip = need;
  }
  const total = inPivot + inTip;
  const cap = L * (/^(hand|foot)_/.test(bone) ? MAX_SHRINK_END : MAX_SHRINK);
  if (total > cap) {
    inPivot *= cap / total;
    inTip *= cap / total;
  }
  if (inPivot + inTip < 0.5) return { pivot: part.pivot, tip: part.tip, ends, moved: false };
  return {
    pivot: [px + ux * inPivot, py + uy * inPivot],
    tip: [part.tip[0] - ux * inTip, part.tip[1] - uy * inTip],
    ends,
    moved: true,
    sunk: { pivot: inPivot, tip: inTip },
  };
}

export const SEAT_JOINTS = JOINTS;
export const SEAT_CAP = CAP;
