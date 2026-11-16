// Fighter check and compile. Pure: takes parsed JSON (and optionally the list of files in the fighter folder),
// returns understandable errors or a compiled fighter the simulation and the renderer use.
import {
  STAT_KEYS, STAT_MAX, STAT_POINTS, deriveStats, MOVE_BUDGET, MOVES_MAX, BASE_HP, NORMAL_HIT_CAP, SUPER_TOTAL_CAP, ABILITY,
} from './constants.js';
import { BLOCKS, readParams } from './blocks.js';
import { BONES, BONE_NAMES, BASE_ANIMS, EASINGS, emptyPose, solvePose, sampleAnim } from './skeleton.js';
import { assignCommands, parseCommand } from './commands.js';
import { SOUND_NAMES } from './soundnames.js';
import { readExtraBones, readPoseLook, meshChainOk, MESH_BONES_MAX } from './body.js';

const RING_NAMES = new Set(BONE_NAMES);

const SOUND_SET = new Set(SOUND_NAMES);

export const FX_TYPES = {
  sparks: 'искры из точки попадания',
  trail: 'след за костью (обычно кисть или стопа) пока приём активен',
  flash: 'вспышка во весь экран',
  particles: 'частицы, летящие от кости',
  glow: 'свечение вокруг бойца',
  shockwave: 'ударная волна, искажающая картинку',
  afterimage: 'шлейф полупрозрачных копий бойца',
  ring: 'расходящееся кольцо',
};
export const FX_ON = ['start', 'active', 'hit', 'block', 'projectile', 'ability'];
export const LINE_KINDS = ['intro', 'taunt', 'super', 'hit', 'hurt', 'victory', 'defeat', 'other'];
export const REQUIRED_LINE_KINDS = ['intro', 'taunt', 'super', 'hit', 'victory', 'defeat'];
export const CAMERA_ANGLES = ['low', 'high', 'close', 'wide', 'dutch'];
export const MOVE_SLOTS = ['normal', 'special', 'super'];
export const POSTURES = ['stand', 'crouch', 'air'];
const RESERVED_IDS = new Set(['throw', 'jump', 'dash', 'parry', 'guard', 'walk', 'crouch', 'tech']);
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_MOVE_TICKS = 150;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// look: { names, skins } of the body — a fighter's own bones and its parts' alternative pictures (engine/body.js)
function readPose(raw, where, errors, poses, look = null) {
  const names = look?.names || RING_NAMES;
  if (typeof raw === 'string') {
    if (poses && poses[raw]) return poses[raw];
    errors.push(`${where}: нет позы "${raw}" в body.json → poses`);
    return emptyPose();
  }
  if (!isObj(raw)) {
    errors.push(`${where}: поза — имя из poses или объект { root, bones }`);
    return emptyPose();
  }
  const pose = emptyPose();
  if (raw.root !== undefined) {
    if (Array.isArray(raw.root) && raw.root.length === 2 && raw.root.every((n) => Number.isFinite(n) && Math.abs(n) <= 400)) {
      pose.root = [raw.root[0], raw.root[1]];
    } else errors.push(`${where}.root: [dx, dy], числа по модулю до 400`);
  }
  for (const [k, v] of Object.entries(raw.bones || {})) {
    if (!names.has(k)) errors.push(`${where}.bones.${k}: нет такой кости (есть: ${[...names].join(', ')})`);
    else if (!Number.isFinite(v) || Math.abs(v) > 360) errors.push(`${where}.bones.${k}: угол в градусах, по модулю до 360`);
    else pose.bones[k] = v;
  }
  Object.assign(pose, readPoseLook(raw, where, errors, names, look?.skins || null));
  for (const k of Object.keys(raw)) if (!['root', 'bones', 'scale', 'images', 'z'].includes(k)) errors.push(`${where}.${k}: у позы есть root, bones, scale, images, z`);
  return pose;
}

function readAnim(raw, where, errors, poses, { loop = false, maxT = Infinity, look = null } = {}) {
  if (!isObj(raw) || !Array.isArray(raw.keys) || raw.keys.length === 0) {
    errors.push(`${where}: нужен объект { keys: [{ t, pose, ease }] } хотя бы с одним ключом`);
    return { keys: [{ t: 0, pose: emptyPose(), ease: 'linear' }], length: 1, loop };
  }
  const keys = [];
  let prev = -1;
  raw.keys.forEach((k, i) => {
    const w = `${where}.keys[${i}]`;
    if (!isObj(k)) return errors.push(`${w}: ключ — объект { t, pose, ease }`);
    if (!Number.isInteger(k.t) || k.t < 0) return errors.push(`${w}.t: целый тик от 0`);
    if (k.t <= prev) errors.push(`${w}.t: тики ключей должны расти (${k.t} после ${prev})`);
    if (k.t > maxT) errors.push(`${w}.t: ${k.t} — позже конца приёма (${maxT})`);
    prev = k.t;
    const e = k.ease ?? 'linear';
    if (!EASINGS.includes(e)) errors.push(`${w}.ease: одно из ${EASINGS.join(', ')}`);
    keys.push({ t: k.t, pose: readPose(k.pose, `${w}.pose`, errors, poses, look), ease: e });
  });
  // a part's picture and the draw order hold from the key that sets them until a key changes them
  let images = null;
  let z = null;
  for (const k of keys) {
    if (k.pose.images) images = { ...(images || {}), ...k.pose.images };
    if (k.pose.z) z = { ...(z || {}), ...k.pose.z };
    if ((images && k.pose.images !== images) || (z && k.pose.z !== z)) k.pose = { ...k.pose, ...(images ? { images } : {}), ...(z ? { z } : {}) };
  }
  const isLoop = raw.loop ?? loop;
  let length = keys.length ? keys[keys.length - 1].t : 0;
  if (raw.length !== undefined) {
    if (!Number.isInteger(raw.length) || raw.length < length || raw.length < 1) errors.push(`${where}.length: целое, не меньше тика последнего ключа`);
    else length = raw.length;
  }
  if (isLoop && length < 1) errors.push(`${where}: у повторяющейся анимации нужен length больше 0`);
  return { keys, length: Math.max(length, 1), loop: !!isLoop };
}

function readFx(list, where, errors, voiceIds) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    errors.push(`${where}: список эффектов`);
    return [];
  }
  return list.map((fx, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(fx)) {
      errors.push(`${w}: объект { on, type, ... }`);
      return null;
    }
    if (!FX_TYPES[fx.type]) errors.push(`${w}.type: один из ${Object.keys(FX_TYPES).join(', ')}`);
    if (!FX_ON.includes(fx.on)) errors.push(`${w}.on: один из ${FX_ON.join(', ')}`);
    if (fx.bone !== undefined && !BONE_NAMES.includes(fx.bone)) errors.push(`${w}.bone: нет такой кости`);
    for (const c of ['color', 'color2']) if (fx[c] !== undefined && !HEX.test(fx[c])) errors.push(`${w}.${c}: цвет #rrggbb`);
    if (fx.size !== undefined && !(fx.size >= 0.2 && fx.size <= 3)) errors.push(`${w}.size: от 0.2 до 3`);
    if (fx.count !== undefined && !(Number.isInteger(fx.count) && fx.count >= 1 && fx.count <= 200)) errors.push(`${w}.count: целое от 1 до 200`);
    if (fx.duration !== undefined && !(Number.isInteger(fx.duration) && fx.duration >= 1 && fx.duration <= 120)) errors.push(`${w}.duration: тики от 1 до 120`);
    if (fx.image !== undefined && typeof fx.image !== 'string') errors.push(`${w}.image: путь к картинке в папке бойца`);
    const allowed = new Set(['on', 'type', 'bone', 'color', 'color2', 'size', 'count', 'duration', 'image']);
    for (const k of Object.keys(fx)) if (!allowed.has(k)) errors.push(`${w}.${k}: у эффекта нет такого поля`);
    return { ...fx, color: fx.color || '#ffffff', size: fx.size ?? 1 };
  }).filter(Boolean);
}

function readMove(raw, i, errors, warnings, ctx) {
  const where = `moves.json → moves[${i}]${raw?.id ? ` ("${raw.id}")` : ''}`;
  const err = (m) => errors.push(`${where} → ${m}`);
  if (!isObj(raw)) {
    err('приём — объект');
    return null;
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9_]{1,24}$/.test(raw.id)) err('id: латиница в нижнем регистре, цифры и _, до 24 знаков');
  else if (RESERVED_IDS.has(raw.id)) err(`id "${raw.id}" занят механикой ринга`);
  if (!str(raw.name, 28)) err('name: название приёма до 28 знаков');
  if (!MOVE_SLOTS.includes(raw.slot)) err(`slot: один из ${MOVE_SLOTS.join(', ')}`);
  if (!POSTURES.includes(raw.posture)) err(`posture: один из ${POSTURES.join(', ')}`);
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0) {
    err('blocks: список блоков конструктора, хотя бы один удар, снаряд, телепорт или способность');
    return null;
  }
  const move = { id: raw.id, name: raw.name, slot: raw.slot, posture: raw.posture, blocks: [] };
  if (raw.stance !== undefined && !ctx.stanceIds.has(raw.stance)) err(`stance: нет стойки "${raw.stance}" в fighter.json → stances`);
  const actions = [];
  const mods = {};
  raw.blocks.forEach((b, k) => {
    const w = `blocks[${k}]`;
    const spec = BLOCKS[b?.type];
    if (!spec) return err(`${w}.type: нет блока "${b?.type}". Есть: ${Object.keys(BLOCKS).join(', ')}`);
    const { value, errors: pe } = readParams(spec.params, b);
    pe.forEach((m) => err(`${w} (${b.type}).${m}`));
    if (pe.length) return;
    const block = { type: b.type, ...value };
    move.blocks.push(block);
    if (spec.kind === 'action') actions.push(block);
    else if (mods[b.type]) err(`${w}: блок "${b.type}" в приёме может быть только один`);
    else mods[b.type] = block;
  });
  if (!actions.length) {
    err('нужен хотя бы один удар, снаряд, телепорт или способность');
    return null;
  }
  if (actions.length > 4) err('не больше 4 действий (удар, снаряд, телепорт, способность) в одном приёме');
  if (move.slot === 'normal') {
    if (actions.some((a) => a.type !== 'strike') || Object.keys(mods).length) err('обычный приём (slot "normal") собирается только из ударов (strike); снаряды, телепорт, способность, заряд и броня — в special или super');
    if (actions.length > 2) err('обычный приём — не больше 2 ударов');
  }
  for (const [k, b] of move.blocks.entries()) BLOCKS[b.type].check(b, move).forEach((m) => err(`blocks[${k}] (${b.type}): ${m}`));

  // timeline
  const segments = [];
  let cursor = 0;
  for (const a of actions) {
    const d = BLOCKS[a.type].duration(a);
    const s = { type: a.type, p: a, start: cursor, activeStart: cursor + d.startup, activeEnd: cursor + d.startup + d.active, end: 0 };
    s.end = s.activeEnd + d.recovery;
    cursor = s.end;
    segments.push(s);
  }
  const duration = cursor;
  if (duration > MAX_MOVE_TICKS) err(`приём длится ${duration} тиков, предел ${MAX_MOVE_TICKS}`);
  const charge = mods.charge
    ? { ...mods.charge, seg: segments.findIndex((s) => s.type === 'strike' || s.type === 'projectile') }
    : null;
  const chargeMul = charge ? 1 + charge.bonus : 1;

  // damage limits
  let totalDamage = 0;
  for (const s of segments) if (s.type === 'strike' || s.type === 'projectile') totalDamage += s.p.damage * (s.p.hits ?? 1) * (charge && segments[charge.seg] === s ? chargeMul : 1);
  const derivedPower = ctx.damageMul;
  if (move.slot === 'super') {
    if (totalDamage > BASE_HP * SUPER_TOTAL_CAP) err(`суперприём наносит ${Math.round(totalDamage)} за все попадания (с зарядом), предел ${BASE_HP * SUPER_TOTAL_CAP} (25 % здоровья)`);
  } else {
    for (const s of segments) {
      if (s.type !== 'strike' && s.type !== 'projectile') continue;
      const hit = s.p.damage * (charge && segments[charge.seg] === s ? chargeMul : 1) * derivedPower;
      if (hit > BASE_HP * NORMAL_HIT_CAP + 1e-9) warnings.push(`${where}: попадание ${Math.round(hit)} с учётом силы и заряда — ринг срежет его до 8 % здоровья соперника`);
    }
  }

  let cost = 0;
  const costMods = { chargeMul };
  for (const b of move.blocks) cost += BLOCKS[b.type].cost(b, move.slot, costMods);

  const anim = readAnim(raw.anim, `${where} → anim`, errors, ctx.poses, { maxT: duration, look: ctx.look });
  const fx = readFx(raw.fx, `${where} → fx`, errors);
  if (raw.line !== undefined && !ctx.lineIds.has(raw.line)) err(`line: нет реплики "${raw.line}" в voice.json`);
  let director = null;
  if (raw.director !== undefined) {
    if (move.slot !== 'super') err('director бывает только у суперприёма');
    else director = readDirector(raw.director, `${where} → director`, errors, ctx.lineIds);
  }
  const abilityBlock = move.blocks.find((b) => b.type === 'ability');
  if (abilityBlock && ctx.files && !ctx.files.has(abilityBlock.script)) err(`blocks (ability).script: нет файла ${abilityBlock.script} в папке бойца`);
  const known = new Set(['id', 'name', 'slot', 'posture', 'stance', 'blocks', 'anim', 'fx', 'line', 'director', 'command', 'sounds']);
  if (raw.command !== undefined && parseCommand(raw.command).error) err(`command: ${parseCommand(raw.command).error}`);
  const sounds = readSounds(raw.sounds, err, ctx);
  for (const k of Object.keys(raw)) if (!known.has(k)) err(`${k}: у приёма нет такого поля`);
  return {
    ...move,
    segments,
    duration,
    charge,
    armor: mods.armor ? mods.armor.hits : 0,
    armorUntil: segments[0].activeStart,
    firstActive: segments.find((s) => s.type !== 'teleport')?.activeStart ?? segments[0].activeStart,
    totalDamage,
    hasProjectile: segments.some((s) => s.type === 'projectile'),
    stance: raw.stance ?? null,
    // filled by prepareAbilities (engine/measure.js) after the ring measured the ability
    ability: abilityBlock ? { script: abilityBlock.script, seg: segments.findIndex((s) => s.type === 'ability'), measured: null, power: null, cooldown: null, cost: BLOCKS.ability.cost(abilityBlock) } : null,
    cost,
    anim,
    fx,
    line: raw.line ?? null,
    director,
    command: typeof raw.command === 'string' ? raw.command : null,
    sounds,
  };
}

// "sounds": { "start": "whoosh-heavy", "hit": "punch-heavy" } — sounds of the ring's catalogue by name (arena sounds)
function readSounds(v, err, ctx) {
  if (v === undefined) return {};
  if (!isObj(v)) {
    err('sounds: объект { когда: "имя звука" }, когда — одно из ' + FX_ON.join(', '));
    return {};
  }
  const out = {};
  for (const [k, name] of Object.entries(v)) {
    if (!FX_ON.includes(k)) err(`sounds.${k}: когда — одно из ${FX_ON.join(', ')}`);
    else if (typeof name !== 'string' || !SOUND_SET.has(name)) err(`sounds.${k}: "${name}" — нет такого звука в каталоге ринга (node arena/cli.mjs sounds)`);
    else out[k] = name;
  }
  return out;
}

// which limb a normal strikes with: the hand or the foot that reaches furthest forward at the first active tick
function strikeLimb(move) {
  try {
    const at = solvePose(sampleAnim(move.anim, move.firstActive));
    const reach = (b) => at[b].tipX - at.pelvis.x;
    const hand = Math.max(reach('hand_front'), reach('hand_back'));
    const foot = Math.max(reach('foot_front'), reach('foot_back'));
    return foot > hand ? 'K' : 'P';
  } catch {
    return 'P';
  }
}

function readDirector(d, where, errors, lineIds) {
  if (!isObj(d)) {
    errors.push(`${where}: объект`);
    return null;
  }
  const out = {
    title: d.title ?? '',
    titleColor: d.titleColor ?? '#ffffff',
    line: d.line ?? null,
    zoom: d.zoom ?? 1.6,
    angle: d.angle ?? 'close',
    flash: d.flash ?? '#ffffff',
    background: d.background ?? 'darken',
    backgroundColor: d.backgroundColor ?? '#000000',
    slowmo: d.slowmo ?? 0.5,
  };
  if (typeof out.title !== 'string' || out.title.length > 28) errors.push(`${where}.title: название во весь экран, до 28 знаков`);
  for (const c of ['titleColor', 'flash', 'backgroundColor']) if (!HEX.test(out[c])) errors.push(`${where}.${c}: цвет #rrggbb`);
  if (out.line !== null && !lineIds.has(out.line)) errors.push(`${where}.line: нет реплики "${out.line}" в voice.json`);
  if (!(out.zoom >= 1 && out.zoom <= 2.5)) errors.push(`${where}.zoom: от 1 до 2.5`);
  if (!CAMERA_ANGLES.includes(out.angle)) errors.push(`${where}.angle: один из ${CAMERA_ANGLES.join(', ')}`);
  if (!['darken', 'color', 'none'].includes(out.background)) errors.push(`${where}.background: darken, color или none`);
  if (!(out.slowmo >= 0.2 && out.slowmo <= 1)) errors.push(`${where}.slowmo: от 0.2 до 1`);
  const known = new Set(Object.keys(out));
  for (const k of Object.keys(d)) if (!known.has(k)) errors.push(`${where}.${k}: у режиссуры нет такого поля`);
  return out;
}

// input: { fighter, body, moves, voice } — parsed JSON of fighter/*.json.
// opts.files: Set of relative paths inside fighter/ (with forward slashes) to check that pictures and sounds exist.
export function checkFighter(input, opts = {}) {
  const errors = [];
  const warnings = [];
  const files = opts.files || null;
  const has = (p) => !files || files.has(String(p).replace(/^\.\//, ''));
  const { fighter: f, body, moves: mv, voice } = input || {};

  // ---- card and stats ----
  if (!isObj(f)) errors.push('fighter.json: нет файла или это не объект');
  const card = isObj(f) ? f : {};
  if (!str(card.name, 20)) errors.push('fighter.json → name: имя бойца, до 20 знаков');
  if (!str(card.motto, 60)) errors.push('fighter.json → motto: девиз, до 60 знаков');
  if (!str(card.story, 600)) errors.push('fighter.json → story: предыстория, до 600 знаков');
  const colors = isObj(card.colors) ? card.colors : {};
  for (const c of ['primary', 'secondary', 'accent']) if (!HEX.test(colors[c] || '')) errors.push(`fighter.json → colors.${c}: цвет #rrggbb`);
  if (card.portrait !== undefined && (typeof card.portrait !== 'string' || !has(card.portrait))) errors.push(`fighter.json → portrait: нет файла ${card.portrait}`);
  const stats = isObj(card.stats) ? card.stats : {};
  let statTotal = 0;
  for (const k of STAT_KEYS) {
    const v = stats[k];
    if (!Number.isInteger(v) || v < 0 || v > STAT_MAX) errors.push(`fighter.json → stats.${k}: целое от 0 до ${STAT_MAX}`);
    else statTotal += v;
  }
  if (statTotal > STAT_POINTS) errors.push(`fighter.json → stats: сумма ${statTotal}, можно не больше ${STAT_POINTS}`);
  for (const k of Object.keys(stats)) if (!STAT_KEYS.includes(k)) errors.push(`fighter.json → stats.${k}: нет такой характеристики (есть ${STAT_KEYS.join(', ')})`);
  const stances = [];
  if (card.stances !== undefined) {
    if (!Array.isArray(card.stances) || card.stances.length > ABILITY.stancesMax) errors.push(`fighter.json → stances: список до ${ABILITY.stancesMax} стоек { id, name }`);
    else card.stances.forEach((st, i) => {
      const w = `fighter.json → stances[${i}]`;
      if (!isObj(st) || typeof st.id !== 'string' || !/^[a-z0-9_]{1,16}$/.test(st.id)) return errors.push(`${w}.id: латиница в нижнем регистре, цифры и _, до 16 знаков`);
      if (!str(st.name, 16)) errors.push(`${w}.name: название стойки до 16 знаков`);
      if (stances.some((x) => x.id === st.id)) errors.push(`${w}.id: "${st.id}" повторяется`);
      for (const k of Object.keys(st)) if (!['id', 'name'].includes(k)) errors.push(`${w}.${k}: у стойки есть только id и name`);
      stances.push({ id: st.id, name: st.name });
    });
  }
  const resources = [];
  if (card.resources !== undefined) {
    if (!Array.isArray(card.resources) || card.resources.length > ABILITY.resourcesMax) errors.push(`fighter.json → resources: список до ${ABILITY.resourcesMax} ресурсов { id, name, max, start, color }`);
    else card.resources.forEach((r, i) => {
      const w = `fighter.json → resources[${i}]`;
      if (!isObj(r) || typeof r.id !== 'string' || !/^[a-z0-9_]{1,16}$/.test(r.id)) return errors.push(`${w}.id: латиница в нижнем регистре, цифры и _, до 16 знаков`);
      if (!str(r.name, 16)) errors.push(`${w}.name: название шкалы до 16 знаков`);
      if (!Number.isInteger(r.max) || r.max < 1 || r.max > ABILITY.resourceMax) errors.push(`${w}.max: целое от 1 до ${ABILITY.resourceMax}`);
      const start = r.start ?? 0;
      if (!Number.isInteger(start) || start < 0 || !(start <= r.max)) errors.push(`${w}.start: целое от 0 до max`);
      if (r.color !== undefined && !HEX.test(r.color)) errors.push(`${w}.color: цвет #rrggbb`);
      if (resources.some((x) => x.id === r.id)) errors.push(`${w}.id: "${r.id}" повторяется`);
      for (const k of Object.keys(r)) if (!['id', 'name', 'max', 'start', 'color'].includes(k)) errors.push(`${w}.${k}: у ресурса есть только id, name, max, start, color`);
      resources.push({ id: r.id, name: r.name, max: r.max, start, color: r.color ?? null });
    });
  }
  const goodStats = STAT_KEYS.every((k) => Number.isInteger(stats[k]) && stats[k] >= 0 && stats[k] <= STAT_MAX) && statTotal <= STAT_POINTS;
  const derived = deriveStats(goodStats ? stats : { health: 3, power: 3, speed: 3, defense: 3 });

  // ---- voice ----
  const lineIds = new Set();
  const lines = [];
  if (!isObj(voice)) errors.push('voice.json: нет файла или это не объект');
  else {
    if (!str(voice.description, 1000)) errors.push('voice.json → description: описание голоса для генерации, до 1000 знаков');
    if (!Array.isArray(voice.lines)) errors.push('voice.json → lines: список реплик');
    else {
      voice.lines.forEach((l, i) => {
        const w = `voice.json → lines[${i}]`;
        if (!isObj(l)) return errors.push(`${w}: объект { id, kind, text }`);
        if (typeof l.id !== 'string' || !/^[a-z0-9_]{1,32}$/.test(l.id)) errors.push(`${w}.id: латиница, цифры и _`);
        else if (lineIds.has(l.id)) errors.push(`${w}.id: "${l.id}" повторяется`);
        if (!LINE_KINDS.includes(l.kind)) errors.push(`${w}.kind: один из ${LINE_KINDS.join(', ')}`);
        if (!str(l.text, 200)) errors.push(`${w}.text: текст реплики до 200 знаков`);
        lineIds.add(l.id);
        lines.push({ id: l.id, kind: l.kind, text: l.text, file: `voice/${l.id}.mp3` });
      });
      for (const k of REQUIRED_LINE_KINDS) if (!lines.some((l) => l.kind === k)) errors.push(`voice.json → lines: нужна хотя бы одна реплика kind "${k}"`);
      if (lines.length > 40) errors.push('voice.json → lines: не больше 40 реплик');
      const missing = lines.filter((l) => files && !has(l.file)).map((l) => l.id);
      if (files && missing.length) (opts.strict ? errors : warnings).push(`голос не записан для ${missing.length} из ${lines.length} реплик (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}): node arena/cli.mjs voice`);
    }
  }

  // ---- body ----
  const parts = {};
  let extraBones = [];
  let ik = null;
  let bodyLook = null;
  let poses = {};
  const anims = {};
  if (!isObj(body)) errors.push('body.json: нет файла или это не объект');
  else {
    const rawParts = isObj(body.parts) ? body.parts : {};
    if (!isObj(body.parts)) errors.push('body.json → parts: объект { кость: { image, pivot, tip } }');
    extraBones = readExtraBones(body.bones, errors);
    const names = new Set([...BONE_NAMES, ...extraBones.map((b) => b.name)]);
    if (body.ik !== undefined) {
      if (!isObj(body.ik) || Object.keys(body.ik).some((k) => k !== 'feet') || (body.ik.feet !== undefined && typeof body.ik.feet !== 'boolean')) errors.push('body.json → ik: { "feet": true } — стопы стоят на полу');
      else ik = { feet: !!body.ik.feet };
    }
    const meshOwned = new Set();
    for (const bone of [...BONE_NAMES, ...extraBones.map((b) => b.name)]) {
      const p = rawParts[bone];
      const w = `body.json → parts.${bone}`;
      if (p === undefined) {
        if (BONE_NAMES.includes(bone)) errors.push(`${w}: нет записи (если кость не рисуется, поставь null)`);
        else parts[bone] = null;
        continue;
      }
      if (p === null) {
        parts[bone] = null;
        continue;
      }
      if (!isObj(p)) {
        errors.push(`${w}: объект { image, pivot: [x, y], tip: [x, y] } или null`);
        continue;
      }
      const okPt = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
      // a mesh: one picture over a chain of bones, bent at the joints; pivot and tip come from its first points
      let mesh;
      if (p.mesh !== undefined) {
        const m = p.mesh;
        if (!isObj(m) || !Array.isArray(m.bones) || !Array.isArray(m.points)) errors.push(`${w}.mesh: { bones: [кость, ребёнок, …], points: [[x, y] сустава каждой кости и конца цепочки] }`);
        else if (m.bones[0] !== bone || m.bones.length < 2 || m.bones.length > MESH_BONES_MAX || !meshChainOk(m.bones, extraBones)) errors.push(`${w}.mesh.bones: цепочка от ${bone} вниз по детям, от 2 до ${MESH_BONES_MAX} костей`);
        else if (m.points.length !== m.bones.length + 1 || !m.points.every(okPt)) errors.push(`${w}.mesh.points: ${m.bones.length + 1} точек [x, y] — сустав каждой кости цепочки и её конец`);
        else if (m.blend !== undefined && !(m.blend >= 0 && m.blend <= 0.5)) errors.push(`${w}.mesh.blend: от 0 до 0.5 — зона изгиба у сустава, доля отрезка`);
        else {
          mesh = { bones: [...m.bones], points: m.points.map((x) => [...x]), blend: m.blend ?? 0.25 };
          for (const b of m.bones.slice(1)) meshOwned.add(b);
          if (p.pivot === undefined) p.pivot = m.points[0];
          if (p.tip === undefined) p.tip = m.points[1];
        }
      }
      if (typeof p.image !== 'string') errors.push(`${w}.image: путь к PNG в папке fighter/`);
      else if (!/\.(png|webp)$/i.test(p.image)) errors.push(`${w}.image: PNG или WebP`);
      else if (!has(p.image)) errors.push(`${w}.image: нет файла ${p.image}`);
      if (!okPt(p.pivot)) errors.push(`${w}.pivot: [x, y] — пиксель картинки, который садится на сустав`);
      if (!okPt(p.tip)) errors.push(`${w}.tip: [x, y] — пиксель картинки, который садится на конец кости`);
      if (okPt(p.pivot) && okPt(p.tip) && p.pivot[0] === p.tip[0] && p.pivot[1] === p.tip[1]) errors.push(`${w}: pivot и tip совпадают`);
      if (p.z !== undefined && !Number.isFinite(p.z)) errors.push(`${w}.z: число, порядок отрисовки`);
      if (p.width !== undefined && !(p.width >= 0.3 && p.width <= 3)) errors.push(`${w}.width: от 0.3 до 3 — толщина поперёк кости`);
      const size = opts.imageSizes?.[p.image];
      if (size && okPt(p.pivot) && okPt(p.tip)) {
        for (const [nm, pt] of [['pivot', p.pivot], ['tip', p.tip]]) {
          if (pt[0] < -size[0] || pt[1] < -size[1] || pt[0] > 2 * size[0] || pt[1] > 2 * size[1]) warnings.push(`${w}.${nm} [${pt}] далеко за картинкой ${size[0]}×${size[1]}`);
        }
      }
      let anchors;
      if (p.anchors !== undefined) {
        const kids = BONES.filter((c) => c.parent === bone).map((c) => c.name);
        if (!isObj(p.anchors)) errors.push(`${w}.anchors: объект { кость-ребёнок: [x, y] } — пиксели этой картинки, куда садится pivot ребёнка`);
        else if (!kids.length) errors.push(`${w}.anchors: у ${bone} нет детей на скелете`);
        else {
          anchors = {};
          for (const [c, pt] of Object.entries(p.anchors)) {
            if (!kids.includes(c)) errors.push(`${w}.anchors.${c}: не ребёнок ${bone} (дети: ${kids.join(', ')})`);
            else if (!okPt(pt)) errors.push(`${w}.anchors.${c}: [x, y] — пиксель картинки ${bone}`);
            else anchors[c] = pt;
          }
        }
      }
      if (p.flip !== undefined && typeof p.flip !== 'boolean') errors.push(`${w}.flip: true — картинка отражается поперёк кости (нарисована зеркально)`);
      if (p.seat !== undefined && typeof p.seat !== 'boolean') errors.push(`${w}.seat: true или false — сдвигать ли ринг сустав внутрь тонкого конца картинки`);
      if (p.shade !== undefined && !(p.shade >= 0 && p.shade <= 1)) errors.push(`${w}.shade: от 0 до 1 — насколько темнее рисуется часть (по умолчанию у _back 0.2, у остальных 0)`);
      // other pictures of this part, switched in animation keys (pose.images)
      let skins;
      if (p.skins !== undefined) {
        if (!isObj(p.skins)) errors.push(`${w}.skins: объект { имя: { image, pivot, tip, width } }`);
        else {
          skins = {};
          for (const [nm, k] of Object.entries(p.skins)) {
            const ws = `${w}.skins.${nm}`;
            if (!isObj(k) || typeof k.image !== 'string' || !/\.(png|webp)$/i.test(k.image)) errors.push(`${ws}: { image: PNG или WebP, pivot, tip }`);
            else if (!has(k.image)) errors.push(`${ws}.image: нет файла ${k.image}`);
            else if (!okPt(k.pivot ?? p.pivot) || !okPt(k.tip ?? p.tip)) errors.push(`${ws}: pivot и tip — [x, y]`);
            else if (k.width !== undefined && !(k.width >= 0.3 && k.width <= 3)) errors.push(`${ws}.width: от 0.3 до 3`);
            else skins[nm] = { image: k.image, pivot: k.pivot ?? p.pivot, tip: k.tip ?? p.tip, width: k.width ?? p.width ?? 1, flip: k.flip ?? !!p.flip };
          }
        }
      }
      parts[bone] = { image: p.image, pivot: p.pivot, tip: p.tip, z: p.z, width: p.width ?? 1, ...(anchors ? { anchors } : {}), ...(mesh ? { mesh } : {}), ...(skins ? { skins } : {}), ...(p.shade !== undefined ? { shade: p.shade } : {}), ...(p.seat === false ? { seat: false } : {}), ...(p.flip ? { flip: true } : {}) };
    }
    for (const b of meshOwned) if (parts[b]) warnings.push(`body.json → parts.${b}: эта кость уже в сетке другой части и рисуется ещё и своей картинкой`);
    for (const k of Object.keys(rawParts)) if (!names.has(k)) errors.push(`body.json → parts.${k}: нет такой кости`);
    bodyLook = { names, skins: Object.fromEntries(Object.entries(parts).filter(([, x]) => x?.skins).map(([k, x]) => [k, x.skins])) };
    if (!Object.values(parts).some(Boolean)) errors.push('body.json → parts: ни одна кость не нарисована');

    if (body.poses !== undefined && !isObj(body.poses)) errors.push('body.json → poses: объект { имя: { root, bones } }');
    poses = {};
    for (const [name, raw] of Object.entries(isObj(body.poses) ? body.poses : {})) poses[name] = readPose(raw, `body.json → poses.${name}`, errors, null, bodyLook);

    const rawAnims = isObj(body.anims) ? body.anims : {};
    for (const [name, spec] of Object.entries(BASE_ANIMS)) {
      if (rawAnims[name] !== undefined) anims[name] = readAnim(rawAnims[name], `body.json → anims.${name}`, errors, poses, { loop: !!spec.loop, look: bodyLook });
      else if (spec.required) errors.push(`body.json → anims.${name}: обязательная анимация`);
    }
    for (const [name, spec] of Object.entries(BASE_ANIMS)) {
      if (!anims[name] && spec.fallback) anims[name] = anims[spec.fallback] || anims.idle;
    }
    for (const k of Object.keys(rawAnims)) if (!BASE_ANIMS[k]) errors.push(`body.json → anims.${k}: нет такого состояния (анимации приёмов живут в moves.json)`);
  }

  // ---- moves ----
  const moves = [];
  if (!isObj(mv) || !Array.isArray(mv.moves)) errors.push('moves.json: нужен объект { moves: [...] }');
  else {
    if (mv.moves.length > MOVES_MAX) errors.push(`moves.json: приёмов ${mv.moves.length}, можно не больше ${MOVES_MAX}`);
    const ctx = { poses, look: bodyLook, lineIds, damageMul: derived.damageMul, stanceIds: new Set(stances.map((x) => x.id)), files };
    const ids = new Set();
    mv.moves.forEach((raw, i) => {
      const m = readMove(raw, i, errors, warnings, ctx);
      if (!m) return;
      if (ids.has(m.id)) errors.push(`moves.json → moves[${i}]: id "${m.id}" повторяется`);
      ids.add(m.id);
      for (const fx of m.fx) if (fx.image && !has(fx.image)) errors.push(`moves.json → ${m.id} → fx: нет файла ${fx.image}`);
      moves.push(m);
    });
    for (const m of moves) m.limb = strikeLimb(m);
    const cmd = assignCommands(moves);
    for (const e of cmd.errors) errors.push(`moves.json → ${e}`);
    for (const m of moves) {
      m.ownCommand = m.command != null;
      m.command = cmd.byId[m.id]?.raw ?? null;
    }
    const supers = moves.filter((m) => m.slot === 'super');
    if (supers.length !== 1) errors.push(`moves.json: суперприём (slot "super") должен быть ровно один, сейчас ${supers.length}`);
    if (!moves.some((m) => m.slot === 'normal')) errors.push('moves.json: нужен хотя бы один обычный приём (slot "normal")');
  }
  const budgetUsed = moves.reduce((s, m) => s + m.cost, 0);
  if (budgetUsed > MOVE_BUDGET) errors.push(`moves.json: приёмы стоят ${budgetUsed} очков, бюджет ${MOVE_BUDGET}`);

  const compiled = errors.length
    ? null
    : {
        card: { name: card.name, motto: card.motto, story: card.story, colors: { ...colors }, portrait: card.portrait ?? null },
        stances,
        resources,
        // ability scripts the loader must import and hand to prepareAbilities (engine/measure.js)
        abilityScripts: [...new Set(moves.filter((m) => m.ability).map((m) => m.ability.script))],
        abilities: null,
        stats: { ...stats },
        derived,
        parts,
        bones: extraBones,
        ik,
        poses,
        anims,
        moves,
        movesById: Object.fromEntries(moves.map((m) => [m.id, m])),
        voice: { description: voice.description, lines, byId: Object.fromEntries(lines.map((l) => [l.id, l])) },
      };
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fighter: compiled,
    budget: { used: budgetUsed, max: MOVE_BUDGET, moves: moves.map((m) => ({ id: m.id, slot: m.slot, cost: m.cost, duration: m.duration })) },
  };
}
