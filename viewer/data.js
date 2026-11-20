// Where the ring lives and the data of the game. The game does not know its own address: everything is found
// from the place of this file, so the same files work from the judge's server (node serve.mjs), from a folder of
// a static site and under any path of a domain.
//   ROOT           the ring's root, the parent of viewer/
//   at('stages/')  an address under the root; a leading slash is the root too
//   loadGame()     api/game.json: fighters with their versions, matches, stages; every address in it made absolute
export const ROOT = new URL('../', import.meta.url);
export const at = (u) => (u ? new URL(String(u).replace(/^\/+/, ''), ROOT).href : u);

function rebase(d) {
  for (const f of d.fighters || []) for (const v of f.versions || []) v.url = at(v.url);
  for (const m of d.matches || []) {
    m.reel = at(m.reel);
    for (const r of m.rounds || []) {
      r.replay = at(r.replay);
      r.video = at(r.video);
      r.timing = at(r.timing);
      r.dirs = (r.dirs || []).map(at);
    }
  }
  for (const s of d.stages || []) {
    s.dir = at(s.dir);
    s.thumb = at(s.thumb);
  }
  return d;
}

export async function loadGame() {
  return rebase(await (await fetch(at('api/game.json'), { cache: 'no-store' })).json());
}
