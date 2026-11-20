// Text of the ring's screens. A canvas text is cut at its measured box: the slant of italic letters, Й and Ё
// above the caps, tails below the line and thick strokes and shadows stick out of it. ringText gives every text
// room around the glyphs (style.padding by the font size); fitText shrinks a text to a width (long names).
import * as PIXI from 'pixi.js';

// The ring's font is ready before the first text is drawn: every file of it, the Cyrillic ones included. A canvas text
// drawn before its letters arrived keeps the fallback font for good, and document.fonts.load('… Oswald') alone
// fetches only the Latin file (a clip came out with other letters now and then).
export async function ringFonts() {
  try {
    await Promise.all([...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Oswald').map((f) => f.load()));
    await document.fonts.ready;
  } catch {}
}

export function ringText({ text, style = {}, ...rest }) {
  const size = Number(style.fontSize) || 26;
  const stroke = typeof style.stroke === 'object' ? style.stroke?.width || 0 : 0;
  const shadow = style.dropShadow ? (style.dropShadow.blur || 0) + (style.dropShadow.distance || 0) : 0;
  const padding = style.padding ?? Math.ceil(size * 0.3 + stroke + shadow);
  return new PIXI.Text({ text, style: { ...style, padding }, ...rest });
}

// scale a text down (never up) so it is at most maxWidth wide; keeps the requested scale as the base
export function fitText(t, maxWidth, base = 1) {
  t.scale.set(base);
  const w = t.width;
  if (w > maxWidth && w > 0) t.scale.set((base * maxWidth) / w);
  return t;
}
