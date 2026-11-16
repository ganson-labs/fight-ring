// Text of the ring's screens. A canvas text is cut at its measured box: the slant of italic letters, Й and Ё
// above the caps, tails below the line and thick strokes and shadows stick out of it. ringText gives every text
// room around the glyphs (style.padding by the font size); fitText shrinks a text to a width (long names).
import * as PIXI from 'pixi.js';

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
