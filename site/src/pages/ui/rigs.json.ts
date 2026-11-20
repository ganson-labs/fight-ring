// ui/rigs.json: for every fighter of the site, where the lighter copies of its pictures lie (src/lib/rig.ts).
// ui/live.js reads it once, when the first live figure comes into the window.
import type { APIRoute } from 'astro';
import { allFighters } from '../../data/ring';
import { rigDir, rigImages } from '../../lib/rig';

export const GET: APIRoute = async () => {
  const out: Record<string, Record<string, string>> = {};
  for (const f of await allFighters()) {
    const dir = rigDir(f);
    if (dir) out[dir] = await rigImages(dir);
  }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
};
