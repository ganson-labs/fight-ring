// Lab page for `arena preview`: a pose sheet or a deterministic clip, rendered frame by frame on request.
//   lab.html?mode=sheet&a=/f/0/
//   lab.html?mode=move&a=/f/0/&b=/f/1/&move=<id>&w=1280&h=720[&dummy=block][&debug=1]
//   lab.html?mode=replay&a=/f/0/&b=/f/1/&replay=/out/replay.json[&stage=/stage/]
import * as PIXI from 'pixi.js';
import { createFight, stepFight, brainView, REACH, ZONE_Y, HURTBOX, BASE_ANIMS, RING_SEED, fightHash, solvePose, sampleAnim, BONES, ringLine } from '../engine/index.js';
import { Broadcast } from './broadcast.js';
import { loadAds, attachBillboard } from './ads.js';
import { loadFighterAssets, loadStage } from './assets.js';
import { Scene, Rig } from './scene.js';
import { bodyFit, fitWarnings, fighterPoses, ringJointOnPicture, CHILDREN, OPENING_PARTS, OPEN_LIMIT } from './fit.js';
import { stageBeds } from './sound.js';
import { moveDemo, demoGap } from './movedemo.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'sheet';
const W = Number(q.get('w') || 1280);
const H = Number(q.get('h') || 720);
const FPS = Number(q.get('fps') || 30);
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.message || e.reason)));

const lab = { done: false, frames: 0, errors, says: [], sounds: [], info: {}, timing: [] };
const PHASES = ['vs', 'board', 'fight', 'after', 'result', 'replay', 'final', 'card', 'done'];
lab.phases = PHASES;
window.lab = lab;

async function makeApp(w, h) {
  const app = new PIXI.Application();
  await app.init({ width: w, height: h, background: 0x07080c, antialias: true, preference: 'webgl', preserveDrawingBuffer: true, autoStart: false, resolution: 1 });
  document.body.appendChild(app.canvas);
  return app;
}

function expand(runs) {
  const out = [];
  for (const [n, s] of runs) for (let i = 0; i < n; i++) out.push(s);
  return out;
}

async function fonts() {
  try {
    await document.fonts.load('700 italic 40px Oswald');
    await document.fonts.load('500 20px Oswald');
    await document.fonts.ready;
  } catch {}
}

// ---------- pose sheet ----------

async function sheet() {
  const A = await loadFighterAssets(q.get('a'));
  await fonts();
  const cells = [];
  cells.push({ title: 'скелет', sub: 'покой', pose: { root: [0, 0], bones: {} }, rig: true });
  const seen = new Set();
  for (const name of Object.keys(BASE_ANIMS)) {
    const anim = A.def.anims[name];
    if (!anim || seen.has(anim)) continue;
    seen.add(anim);
    const own = true;
    const ticks = [...new Set(anim.keys.map((k) => k.t))];
    for (const t of ticks.slice(0, 6)) cells.push({ title: name, sub: `t ${t}${own ? '' : ''}`, pose: sampleAnim(anim, t) });
  }
  for (const m of A.def.moves) {
    const ticks = new Set(m.anim.keys.map((k) => k.t));
    for (const s of m.segments) ticks.add(s.activeStart);
    for (const t of [...ticks].sort((x, y) => x - y).slice(0, 10)) {
      const seg = m.segments.find((s) => t >= s.activeStart && t < s.activeEnd && s.type === 'strike');
      cells.push({ title: `${m.id}`, sub: `t ${t}${seg ? ' · удар' : ''}`, pose: sampleAnim(m.anim, t), box: seg ? seg.p : null, posture: m.posture });
    }
  }
  // how children sit on their parents: the parents' pictures large, with anchors and openings (render/fit.js)
  const fit = bodyFit(A.def.parts, A.seat, A.pixels, fighterPoses(A.def));
  const warns = fitWarnings(fit, A.def.parts);
  const closeups = OPENING_PARTS.filter((b) => A.def.parts[b] && A.textures[A.def.parts[b].image]);
  cells.unshift(...closeups.map((b) => ({ title: b, sub: 'якоря и проймы', part: b })));
  const cw = 300;
  const ch = 360;
  const cols = 6;
  const rows = Math.ceil(cells.length / cols);
  const top = 60 + warns.length * 24 + (warns.length ? 8 : 0);
  const app = await makeApp(cw * cols, ch * rows + top);
  const st = app.stage;
  const g = new PIXI.Graphics();
  st.addChild(g);
  const head = new PIXI.Text({ text: `${A.def.card.name} — лист поз (кадры ключей, красное — хитбокс удара, синее — хёртбокс ринга)`, style: { fontFamily: 'Oswald, Arial', fontSize: 26, fill: 0xffffff } });
  head.position.set(16, 14);
  st.addChild(head);
  warns.forEach((w, i) => {
    const t = new PIXI.Text({ text: `! ${w}`, style: { fontFamily: 'Arial', fontSize: 16, fill: 0xffb347 } });
    t.position.set(16, 60 + i * 24);
    if (t.width > cw * cols - 32) t.scale.x = (cw * cols - 32) / t.width;
    st.addChild(t);
  });
  const scale = 0.78;
  cells.forEach((c, i) => {
    const x0 = (i % cols) * cw;
    const y0 = top + Math.floor(i / cols) * ch;
    g.rect(x0 + 4, y0 + 4, cw - 8, ch - 8).fill({ color: 0x15171d }).stroke({ width: 1, color: 0x2c2f3a });
    if (c.part) {
      closeup(st, A, fit, c.part, x0, y0, cw, ch);
      const t = new PIXI.Text({ text: c.title, style: { fontFamily: 'Oswald, Arial', fontSize: 22, fill: 0xffffff } });
      t.position.set(x0 + 14, y0 + ch - 58);
      const s = new PIXI.Text({ text: c.sub, style: { fontFamily: 'Oswald, Arial', fontSize: 18, fill: 0x9aa0b0 } });
      s.position.set(x0 + 14, y0 + ch - 30);
      st.addChild(t, s);
      return;
    }
    const footX = x0 + cw / 2 - 30;
    const footY = y0 + ch - 70;
    g.moveTo(x0 + 10, footY).lineTo(x0 + cw - 10, footY).stroke({ width: 1, color: 0x3a3e4c });
    const hb = c.posture === 'crouch' ? HURTBOX.crouch : c.posture === 'air' ? HURTBOX.air : HURTBOX.stand;
    g.rect(footX + hb[0] * scale, footY - hb[3] * scale, (hb[2] - hb[0]) * scale, (hb[3] - hb[1]) * scale).stroke({ width: 1.5, color: 0x4fc3ff, alpha: 0.7 });
    const rig = new Rig(A);
    const solved = solvePose(c.pose);
    const placed = rig.apply(solved);
    rig.root.position.set(footX, footY);
    rig.root.scale.set(scale);
    if (c.rig) rig.root.alpha = 0.55;
    st.addChild(rig.root);
    if (c.box) {
      const r = REACH[c.box.reach];
      const zy = ZONE_Y[c.box.zone];
      const bx = new PIXI.Graphics();
      bx.rect(footX + 20 * scale, footY - zy[1] * scale, (15 + r) * scale, (zy[1] - zy[0]) * scale).fill({ color: 0xff3b3b, alpha: 0.3 }).stroke({ width: 2, color: 0xff3b3b });
      st.addChild(bx);
    }
    if (c.rig) {
      const bg = new PIXI.Graphics();
      for (const b of BONES) {
        const j = solved[b.name];
        bg.moveTo(footX + j.x * scale, footY - j.y * scale).lineTo(footX + j.tipX * scale, footY - j.tipY * scale).stroke({ width: 3, color: 0x7dff9a });
        bg.circle(footX + j.x * scale, footY - j.y * scale, 4).fill({ color: 0xffe14d });
        // a child moved by its parent's anchor: from the ring's joint to where its picture starts
        const p = placed[b.name];
        if (Math.hypot(...p.shift) > 0.5) {
          bg.moveTo(footX + j.x * scale, footY - j.y * scale).lineTo(footX + p.x * scale, footY - p.y * scale).stroke({ width: 2, color: 0xff6ad5 });
          bg.circle(footX + p.x * scale, footY - p.y * scale, 4).fill({ color: 0xff6ad5 });
        }
      }
      st.addChild(bg);
    }
    const t = new PIXI.Text({ text: c.title, style: { fontFamily: 'Oswald, Arial', fontSize: 22, fill: 0xffffff } });
    t.position.set(x0 + 14, y0 + ch - 58);
    const s = new PIXI.Text({ text: c.sub, style: { fontFamily: 'Oswald, Arial', fontSize: 18, fill: 0x9aa0b0 } });
    s.position.set(x0 + 14, y0 + ch - 30);
    st.addChild(t, s);
  });
  app.render();
  lab.info = { cells: cells.length, width: cw * cols, height: ch * rows + top, warnings: warns };
  lab.frame = () => app.canvas.toDataURL('image/png');
  lab.frames = 1;
}

// A parent's picture large: openings (red — open, green — closed by the parts above), the ring's joints of its
// children (white rings) and their anchors (pink dots, with a line from the ring's joint).
function closeup(st, A, fit, bone, x0, y0, cw, ch) {
  const part = A.def.parts[bone];
  const tex = A.textures[part.image];
  const box = [cw - 30, ch - 90];
  const k = Math.min(box[0] / tex.width, box[1] / tex.height);
  const ox = x0 + (cw - tex.width * k) / 2;
  const oy = y0 + 14 + (box[1] - tex.height * k) / 2;
  const sp = new PIXI.Sprite(tex);
  sp.position.set(ox, oy);
  sp.scale.set(k);
  st.addChild(sp);
  const g = new PIXI.Graphics();
  st.addChild(g);
  const at = (p) => [ox + p[0] * k, oy + p[1] * k];
  for (const o of fit.openings.filter((o) => o.bone === bone)) {
    const open = o.rest < OPEN_LIMIT || o.mean < OPEN_LIMIT;
    const [a, b] = [at(o.op.box.slice(0, 2)), at(o.op.box.slice(2))];
    g.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]).stroke({ width: 2, color: open ? 0xff4d4d : 0x5dff8a });
  }
  for (const c of CHILDREN[bone]) {
    if (!A.def.parts[c]) continue;
    const ring = ringJointOnPicture(A.def.parts, A.seat, c);
    const r = at(ring);
    g.circle(r[0], r[1], 6).stroke({ width: 2, color: 0xffffff });
    const an = part.anchors?.[c];
    let label = r;
    if (an) {
      const p = at(an);
      g.moveTo(r[0], r[1]).lineTo(p[0], p[1]).stroke({ width: 2, color: 0xff6ad5 });
      g.circle(p[0], p[1], 6).fill({ color: 0xff6ad5 });
      label = p;
    }
    const t = new PIXI.Text({ text: c, style: { fontFamily: 'Arial', fontSize: 13, fill: an ? 0xff9be6 : 0xffffff, stroke: { color: 0x000000, width: 3 } } });
    t.position.set(label[0] + 8, label[1] - 8);
    st.addChild(t);
  }
}

// ---------- clips ----------

async function clip() {
  const vertical = H > W;
  const [A, B] = await Promise.all([loadFighterAssets(q.get('a')), loadFighterAssets(q.get('b'))]);
  const stage = q.get('stage') ? await loadStage(q.get('stage')) : null;
  await fonts();
  const app = await makeApp(W, H);
  const names = [q.get('na') || '', q.get('nb') || ''];
  const show = q.get('show') === '1';
  const ads = q.get('ads') ? await loadAds(q.get('ads'), { force: q.get('adsForce') === '1' }) : null;
  const scene = new Scene(app, { width: W, height: H, vertical, debug: q.get('debug') === '1', names });
  scene.setStage(stage);
  if (ads) attachBillboard(scene, ads);
  scene.setFighters([A, B]);
  const rep = mode === 'replay' ? await (await fetch(q.get('replay'), { cache: 'no-store' })).json() : null;
  const seed = rep?.seed ?? (Number(q.get('seed')) || RING_SEED);
  const fight = createFight({ fighters: [A.def, B.def], seed });
  const wins = (q.get('wins') || '0-0').split('-').map(Number);
  const round = Number(q.get('round') || 1);
  const firstTo = Number(q.get('firstTo') || 2);
  let source;
  let steps = [];
  if (mode === 'replay') {
    steps = expand(rep.steps);
    source = (f, i) => (i < steps.length ? steps[i] : undefined);
    lab.info.result = rep.result;
  } else {
    const m = A.def.movesById[q.get('move')];
    if (!m) throw new Error(`нет приёма ${q.get('move')}`);
    const dummyMod = await import(`${q.get('b')}brain.js`);
    const dummy = dummyMod.default;
    source = moveDemo(fight, m, { gap: Number(q.get('gap')) || demoGap(m), dummy: (f) => dummy.tick(brainView(f, 1)) });
    dummy.init?.({ side: 1, options: { dummy: q.get('dummy') || 'stand' }, view: brainView(fight, 1) });
    lab.info.move = { id: m.id, duration: m.duration };
  }
  const ring = q.get('ring') === '1';
  // the stage's music and ambience go under the whole clip (the judge mixes them in Node)
  lab.info.beds = stage ? stageBeds(stage) : null;
  scene.reset(fight);
  const bc = new Broadcast({
    app, scene, assets: [A, B], fight, source, steps, names, width: W, height: H, vertical,
    show, intro: q.get('intro') === '1', final: q.get('final') === '1', round, rerun: q.get('rerun') === '1', wins, firstTo, ads,
    banner: mode === 'replay', announcer: ring, totalTicks: lab.info.result?.ticks || 1, seed,
    // the judge's record (Node) replayed here must end in the same state, abilities included
    onRecordEnd: (f) => {
      if (!rep?.hash) return;
      lab.info.replayHash = fightHash(f);
      if (lab.info.replayHash !== rep.hash) errors.push(`повтор записи разошёлся с боем судьи: ${lab.info.replayHash} против ${rep.hash}`);
    },
    onSound: (name, gain, variant, delay = 0) => lab.sounds.push({ frame: lab.frames + Math.round(delay * FPS), name, gain, variant }),
    onSay: (side, line) => lab.says.push({ frame: lab.frames, side, line }),
  });
  const step = (draw) => {
    bc.frame(1 / FPS);
    if (draw) {
      lab.beforeRender?.();
      app.render();
    }
    lab.frames++;
    lab.phase = bc.phase?.kind || 'done';
    // the fight tick and the phase of every frame: the judge maps moments of the fight to seconds of the clip
    lab.timing.push([bc.replayPlayer ? -1 : fight.tick, PHASES.indexOf(lab.phase)]);
    lab.done = bc.done && bc.tail > (mode === 'replay' ? 20 : 10);
  };
  lab.frame = () => {
    step(true);
    return app.canvas.toDataURL('image/jpeg', 0.92);
  };
  // n frames played without a picture: the judge films one clip in several pages at once, each plays the whole
  // show and takes its own pieces (the scene is a function of the fight and the time, so the pieces join seamlessly).
  // The answer: the clip has ended.
  lab.skip = (n) => {
    for (let i = 0; i < n && !lab.done; i++) step(false);
    return lab.done;
  };
  const player = bc.player;
  lab.player = player;
  // from/to: only this stretch of the recording (ticks of the fight); the camera has followed it from the start
  const from = Number(q.get('from') || 0);
  const to = Number(q.get('to') || 0);
  // ghost: another version of one fighter over the recording, translucent and cold (the judge's match ghost):
  // ghost.json { side, frames: [{ tick, x, y, facing, pose }] }, its pictures in g=/g/
  let ghost = null;
  if (q.get('ghost')) {
    const data = await (await fetch(q.get('ghost'), { cache: 'no-store' })).json();
    const G = await loadFighterAssets(q.get('g'));
    const rig = new Rig(G, { tint: 0x9fd8ff });
    // cold and see-through: no colour of its own, blue light, a soft blue edge
    const cm = new PIXI.ColorMatrixFilter();
    cm.desaturate();
    cm.brightness(1.25, true);
    const blue = new PIXI.ColorMatrixFilter();
    blue.matrix = [0.62, 0, 0, 0, 0, 0, 0.86, 0, 0, 0.02, 0, 0, 1.18, 0, 0.08, 0, 0, 0, 1, 0];
    rig.root.filters = [cm, blue];
    ghost = { data, rig, i: 0 };
  }
  const placeGhost = () => {
    if (!ghost) return;
    const { data, rig } = ghost;
    if (rig.root.parent !== scene.fighterLayer) scene.fighterLayer.addChild(rig.root);
    while (ghost.i + 1 < data.frames.length && data.frames[ghost.i + 1].tick <= fight.tick) ghost.i++;
    const g = data.frames[ghost.i];
    if (!g || g.tick > fight.tick) {
      rig.root.visible = false;
      return;
    }
    rig.root.visible = true;
    rig.grounded = g.y <= 0.5;
    rig.apply(solvePose(g.pose));
    rig.root.position.set(g.x, -g.y);
    rig.root.scale.set(g.facing, 1);
    rig.root.alpha = 0.55;
  };
  lab.beforeRender = placeGhost;
  if (from || to || ghost) {
    const base = lab.frame;
    let started = false;
    lab.frame = () => {
      if (!started) {
        started = true;
        for (let i = 0; i < 60 * 600 && fight.tick < from && !bc.done; i++) bc.frame(1 / FPS);
      }
      const url = base();
      if (to && fight.tick >= to) lab.done = true;
      return url;
    };
  }
}

// ---------- one figure on a transparent background (the judge's match pack) ----------

// lab.html?mode=figure&a=/f/0/&anim=intro&t=end[&k=3]: the fighter in a pose of one animation (t — its tick, «end» —
// the last key), drawn in the resolution of its own pictures (the densest picture 1:1, k overrides), no stage, no
// light, alpha kept.
async function figure() {
  const A = await loadFighterAssets(q.get('a'));
  const name = q.get('anim') || 'idle';
  // a move's animation by its id (move=…), or a state's (anim=…)
  const anim = q.get('move') ? A.def.movesById[q.get('move')]?.anim : A.def.anims[name];
  if (!anim) throw new Error(`у бойца нет анимации ${q.get('move') || name}`);
  const last = Math.max(...anim.keys.map((k) => k.t));
  // «peak»: the key most unlike the idle stance (an entrance often ends back in the stance)
  const peak = () => {
    const rest = sampleAnim(A.def.anims.idle, 0);
    const diff = (p) => Object.keys({ ...p.bones, ...rest.bones }).reduce((a, b) => a + Math.abs((p.bones[b] || 0) - (rest.bones[b] || 0)), 0) + Math.hypot((p.root?.[0] || 0) - (rest.root?.[0] || 0), (p.root?.[1] || 0) - (rest.root?.[1] || 0)) / 10;
    return anim.keys.map((k) => k.t).reduce((best, t) => (diff(sampleAnim(anim, t)) > diff(sampleAnim(anim, best)) ? t : best), anim.keys[0].t);
  };
  const tq = q.get('t');
  const t = !tq || tq === 'end' ? last : tq === 'peak' ? peak() : Math.min(last, Number(tq));
  const rig = new Rig(A);
  // springs settle over the frames before t, as they would in the fight
  if (A.def.bones?.some((b) => b.spring)) for (let i = Math.max(0, t - 40); i < t; i++) rig.apply(solvePose(sampleAnim(anim, i)));
  rig.apply(solvePose(sampleAnim(anim, t)));
  // the densest picture 1:1: a single picture by its bone, a mesh by the span of its first segment
  const dense = Math.max(...Object.values(rig.bones).map((b) => {
    if (b.holder) return 1 / (b.holder.__scale || 1);
    const [p0, p1] = b.part.mesh.points;
    return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / (BONES.find((x) => x.name === b.part.mesh.bones[0])?.length || A.def.bones.find((x) => x.name === b.part.mesh.bones[0])?.length || 1);
  }));
  const k = Number(q.get('k')) || Math.min(8, Math.max(1, dense));
  rig.root.scale.set(k);
  const holder = new PIXI.Container();
  holder.addChild(rig.root);
  // box=W,H: a fixed frame in fighter units with the floor at its bottom (frames of a movement line up)
  const fixed = q.get('box') ? q.get('box').split(',').map(Number) : null;
  const b = holder.getBounds();
  const pad = Math.round(12 * k);
  const w = fixed ? Math.round(fixed[0] * k) : Math.ceil(b.width) + pad * 2;
  const h = fixed ? Math.round(fixed[1] * k) : Math.ceil(b.height) + pad * 2;
  const app = new PIXI.Application();
  await app.init({ width: w, height: h, backgroundAlpha: 0, antialias: true, preference: 'webgl', preserveDrawingBuffer: true, autoStart: false, resolution: 1 });
  document.body.appendChild(app.canvas);
  if (fixed) rig.root.position.set(w / 2, h - 16 * k);
  else rig.root.position.set(pad - b.x, pad - b.y);
  app.stage.addChild(holder);
  app.render();
  lab.info = { anim: name, t, k: +k.toFixed(3), width: w, height: h };
  lab.frame = () => app.canvas.toDataURL('image/png');
  lab.frames = 1;
}

lab.ready = (mode === 'sheet' ? sheet() : mode === 'figure' ? figure() : clip()).then(() => true).catch((err) => {
  errors.push(String(err?.stack || err));
  return false;
});
