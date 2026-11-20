// Browser side: load a fighter folder over HTTP and check it with the same engine code as the sandbox.
import * as PIXI from 'pixi.js';
import { checkFighter, prepareAbilities } from '../engine/index.js';
import { abilityLoader } from '../engine/instrument.js';
import { seatPart } from './seat.js';

// smooth when a part is drawn smaller than its picture: mipmaps, linear filtering, a little anisotropy
const SMOOTH = { autoGenerateMipmaps: true, scaleMode: 'linear', maxAnisotropy: 4 };

function pixels(tex) {
  const res = tex?.source?.resource;
  if (!res) return null;
  const w = res.width || res.naturalWidth;
  const h = res.height || res.naturalHeight;
  if (!w || !h) return null;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(res, 0, 0);
  return g.getImageData(0, 0, w, h);
}

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// how many loaded fighters draw a picture: two fighters may share a file (a site gives equal pictures one address),
// so a picture is let go only with the last fighter that holds it
const held = new Map();

// base: URL of the fighter folder, ending with "/".
// src(image) → the address of one picture, for a page that serves lighter copies of the same pictures (the site's
// WebP); portrait: false leaves the card's portrait out (up to 2.7 MB that a figure never draws); pixels: false does
// not keep the pictures' pixels (only the pose sheet of the lab reads them: 300 fighters held 1.6 GB of them).
export async function loadFighterAssets(base, { src = (img) => `${base}${img}`, portrait: withPortrait = true, pixels: keepPixels = true } = {}) {
  const input = {};
  for (const f of ['fighter', 'body', 'moves', 'voice']) input[f] = await getJSON(`${base}${f}.json`);
  const res = checkFighter(input);
  if (!res.ok) throw new Error(`${base}: боец не прошёл проверку:\n${res.errors.slice(0, 8).join('\n')}`);
  const def = res.fighter;
  // abilities: the fighter's own modules, measured here exactly as the judge measures them in Node
  let abilities = [];
  if (def.abilityScripts.length) {
    const modules = {};
    const load = abilityLoader({
      base: new URL(base, location.href).href,
      read: async (u) => {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) throw new Error(`${u}: ${r.status}`);
        return r.text();
      },
      toUrl: (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' })),
    });
    for (const s of def.abilityScripts) modules[s] = await load(s);
    const prep = prepareAbilities(def, modules);
    if (!prep.ok) throw new Error(`${base}: способности не прошли проверку:\n${prep.errors.slice(0, 8).join('\n')}`);
    abilities = prep.report;
  } else def.abilities = {};
  const textures = {};
  const images = new Set(Object.values(def.parts).filter(Boolean).map((p) => p.image));
  // other pictures of a part, switched in animation keys
  for (const p of Object.values(def.parts)) for (const sk of Object.values(p?.skins || {})) images.add(sk.image);
  for (const m of def.moves) for (const fx of m.fx) if (fx.image) images.add(fx.image);
  for (const img of def.abilityImages || []) images.add(img);
  await Promise.all([...images].map(async (img) => {
    try {
      held.set(src(img), (held.get(src(img)) || 0) + 1);
      textures[img] = await PIXI.Assets.load({ src: src(img), loadParser: 'loadTextures', data: SMOOTH });
    } catch (err) {
      console.warn('картинка не загрузилась', base + img, err);
    }
  }));
  // where each picture really sits on its bone (render/seat.js)
  const seat = {};
  const pictures = {}; // bone → picture pixels: the pose sheet checks how children sit on their parents (render/fit.js)
  const px = new Map();
  for (const [bone, p] of Object.entries(def.parts)) {
    if (!p || !textures[p.image] || p.mesh) continue; // a mesh bends by its own points
    if (!px.has(p.image)) {
      try {
        px.set(p.image, pixels(textures[p.image]));
      } catch {
        px.set(p.image, null);
      }
    }
    // a part with "seat": false sits exactly on its pivot and tip, as drawn
    seat[bone] = p.seat === false ? { pivot: p.pivot, tip: p.tip, ends: {}, moved: false } : seatPart(px.get(p.image), p, bone);
    if (keepPixels && px.get(p.image)) pictures[bone] = px.get(p.image);
  }
  let portrait = null;
  if (withPortrait && def.card.portrait) {
    try {
      portrait = await PIXI.Assets.load({ src: src(def.card.portrait), loadParser: 'loadTextures' });
    } catch {}
  }
  return { base, def, textures, seat, pixels: pictures, portrait, warnings: res.warnings, abilities, sources: [...images].map(src) };
}

// hd: the layer's larger picture ("hd" in stage.json, twice the size) when there is one; it keeps the layer's name
export async function loadStage(base, { hd = true } = {}) {
  if (!base) return null;
  const def = await getJSON(`${base}stage.json`);
  const textures = {};
  await Promise.all((def.layers || []).map(async (l) => {
    if (!l.image || textures[l.image]) return;
    const file = hd && l.hd ? l.hd : l.image;
    textures[l.image] = await PIXI.Assets.load({ src: `${base}${file}`, loadParser: 'loadTextures', data: SMOOTH });
  }));
  return { base, def, textures };
}

// Lets a fighter's pictures go (the video card's memory): for a fighter that was loaded only to draw one still.
export async function unloadFighterAssets(assets) {
  for (const u of assets?.sources || []) {
    const n = (held.get(u) || 1) - 1;
    if (n > 0) held.set(u, n);
    else {
      held.delete(u);
      await PIXI.Assets.unload(u).catch(() => {});
    }
  }
}
