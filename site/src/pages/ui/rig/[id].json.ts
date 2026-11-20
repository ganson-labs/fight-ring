// ui/rig/<fighter>.json: where the lighter copies of one fighter's pictures lie (src/lib/rig.ts), by the folder the
// fighter is drawn from. ui/live.js asks for a fighter's file when its figure comes into the window: one file for
// every fighter of the site weighed half a megabyte at three hundred fighters.
import type { APIRoute } from 'astro';
import { allFighters } from '../../../data/ring';
import { rigDir, rigImages } from '../../../lib/rig';

export async function getStaticPaths() {
  return (await allFighters()).map((f) => ({ params: { id: f.id }, props: { dir: rigDir(f) } }));
}

export const GET: APIRoute = async ({ props }) => {
  const dir = props.dir as string | null;
  return new Response(JSON.stringify(dir ? { [dir]: await rigImages(dir) } : {}), { headers: { 'Content-Type': 'application/json' } });
};
