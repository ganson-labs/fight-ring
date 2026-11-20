// Where the ring lives and the data of the game. The game does not know its own address: everything is found
// from the place of this file, so the same files work from the judge's server (node serve.mjs), from a folder of
// a static site and under any path of a domain.
//   ROOT           the ring's root, the parent of viewer/
//   at('stages/')  an address under the root; a leading slash is the root too
//   loadGame()     api/game.json: the light list — fighters with their versions, matches, stages; every address in
//                  it made absolute
//   fullFighter(f), fullMatch(m)   what only a fighter's card or a match's page needs (locker-room replies, the
//                  breakdown of changes, numbers, story, protocol) is fetched when that page opens and put into
//                  the same object
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

// text: the answer as it came, for telling whether anything changed since the last read
export async function loadGame() {
  const text = await (await fetch(at('api/game.json'), { cache: 'no-store' })).text();
  return Object.assign(rebase(JSON.parse(text)), { text });
}

async function detail(o, merge) {
  if (!o?.detail || o.full) return o;
  o.loading ||= fetch(at(o.detail), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d) merge(d);
    o.full = true;
  }).catch(() => {}).finally(() => (o.loading = null));
  await o.loading;
  return o;
}

export const fullFighter = (f) => detail(f, (d) => {
  for (const v of d.versions || []) Object.assign(f.versions.find((x) => x.v === v.v) || {}, v);
});
export const fullMatch = (m) => detail(m, (d) => Object.assign(m, d, { id: m.id }));
