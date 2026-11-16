// A caption over the match reel (viewer/card.html?kind=caption): one short line on a slanted plate. The round
// result, the locker room and the match's numbers live in viewer/game/screens.js.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A caption over the reel: one short line on a slanted plate, a gold kicker above it, the side's colour on its edge;
// a name in quotes never breaks across lines.
// The page is transparent: the judge lays the screenshot over the clip.
export function captionCard({ text, kicker, color }, aspect) {
  return `<div class="cap ${aspect === '9:16' ? 'v' : 'h'}" style="--side:${esc(color || '#ffc94a')}">
    ${kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''}
    <div class="cap-plate"><span class="slab fit">${esc(text).replace(/«[^»]*»/g, (q) => q.replace(/ /g, '\u00a0'))}</span></div>
  </div>`;
}
