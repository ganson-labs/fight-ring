// Portraits of fighters, resized for the page. The originals are the fighters' own files in ../seasons (up to
// 2.7 MB each); the page gets WebP of the width it shows. The kit names the file art/portrait.png.
import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';
import { relative } from 'node:path';
import { RING } from '../data/ring';

const files = import.meta.glob<{ default: ImageMetadata }>('../../../seasons/*/fighters/*/v*/art/portrait.{png,jpg,jpeg,webp}');

export interface Portrait { src: string; set: { url: string; descriptor: string }[]; width: number; height: number }

/** `file` — the portrait on disk; the result's addresses are relative to the site root (no leading slash). */
export async function portrait(file: string | null, width: number): Promise<Portrait | null> {
  if (!file) return null;
  const key = `../../../${relative(RING, file).split('\\').join('/')}`;
  const load = files[key];
  // a portrait under another name goes out as it is: seasons/ lies in the site root
  if (!load) {
    const src = relative(RING, file).split('\\').join('/');
    return { src, set: [{ url: src, descriptor: `${width}w` }], width, height: width };
  }
  const meta = (await load()).default;
  const w = Math.min(width, meta.width);
  const img = await getImage({ src: meta, width: w, widths: [...new Set([w, Math.min(w * 2, meta.width)])], format: 'webp', quality: 82 });
  const strip = (u: string) => u.replace(/^\/+/, '');
  return {
    src: strip(img.src),
    set: img.srcSet.values.map((v) => ({ url: strip(v.url), descriptor: v.descriptor ?? "" })),
    width: w,
    height: Math.round((w * meta.height) / meta.width),
  };
}
