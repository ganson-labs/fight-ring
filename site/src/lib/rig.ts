// What a live figure on a page is drawn from (ui/live.js): the fighter's folder and lighter copies of its pictures.
// A fighter's parts are PNG of 100–300 KB each, up to 4 MB a fighter; the page gets the same pictures as WebP of the
// same size in pixels, so the figure looks the same and costs a tenth of that.
import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RING } from '../data/ring';
import type { Fighter } from '../data/ring';

const files = import.meta.glob<{ default: ImageMetadata }>(['../../../seasons/*/fighters/*/v*/{parts,art}/*.{png,jpg,jpeg,webp}', '../../../roster/*/fighter/{parts,art}/*.{png,jpg,jpeg,webp}']);
const stages = import.meta.glob<{ default: ImageMetadata }>('../../../stages/*/far.hd.webp');

/** The folder a fighter is drawn from, relative to the site root, with a trailing slash: the latest version of a
 *  season's fighter, the one folder of a roster's fighter. */
export const rigDir = (f: Fighter): string | null => (f.origin === 'roster' ? `roster/${f.id}/fighter/` : f.versions.at(-1)?.dir ?? null);

function pictures(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (/^[\w./-]+\.(png|jpe?g|webp)$/i.test(value)) out.add(value);
  } else if (Array.isArray(value)) for (const v of value) pictures(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) pictures(v, out);
}

/** picture as the fighter names it ("parts/head.png") → its lighter copy, relative to the site root */
export async function rigImages(dir: string): Promise<Record<string, string>> {
  const abs = join(RING, dir);
  const names = new Set<string>();
  for (const f of ['fighter', 'body', 'moves']) {
    const file = join(abs, `${f}.json`);
    if (existsSync(file)) pictures(JSON.parse(readFileSync(file, 'utf8')), names);
  }
  // pictures an ability draws are named in its code, not in the JSON: they lie with the parts
  if (existsSync(join(abs, 'parts'))) for (const n of readdirSync(join(abs, 'parts'))) names.add(`parts/${n}`);
  const out: Record<string, string> = {};
  for (const name of names) {
    if (/portrait/.test(name)) continue;
    const load = files[`../../../${dir}${name}`];
    if (!load) continue;
    const meta = (await load()).default;
    const img = await getImage({ src: meta, width: meta.width, format: 'webp', quality: 86 });
    out[name] = img.src.replace(/^\/+/, '');
  }
  return out;
}

/** The far layer of a stage as a backdrop of a page, relative to the site root (the original is about 1 MB). */
export async function stageBackdrop(stage: string | undefined, width = 1280): Promise<string | null> {
  const load = stage ? stages[`../../../stages/${stage}/far.hd.webp`] : undefined;
  if (!load) return null;
  const meta = (await load()).default;
  const img = await getImage({ src: meta, width: Math.min(width, meta.width), format: 'webp', quality: 55 });
  return img.src.replace(/^\/+/, '');
}
