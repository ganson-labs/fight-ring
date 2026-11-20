// A move's command in the game's notation ("236P", "[4]6P") as glyphs: arrows as on a numpad, then the button.
const ARROW: Record<string, string> = { 1: '↙', 2: '↓', 3: '↘', 4: '←', 6: '→', 7: '↖', 8: '↑', 9: '↗' };

export interface Glyph { text: string; kind: 'dir' | 'hold' | 'btn' }

export function commandGlyphs(raw: string | null): Glyph[] {
  if (!raw) return [];
  const out: Glyph[] = [];
  let rest = raw;
  const hold = rest.match(/^\[(\d)\]/);
  if (hold?.[1]) {
    out.push({ text: ARROW[hold[1]] ?? hold[1], kind: 'hold' });
    rest = rest.slice(hold[0].length);
  }
  const m = rest.match(/^(\d*)(.*)$/);
  for (const d of m?.[1] ?? '') if (ARROW[d]) out.push({ text: ARROW[d], kind: 'dir' });
  if (m?.[2]) out.push({ text: m[2], kind: 'btn' });
  return out;
}
