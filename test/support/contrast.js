// The arithmetic the contrast gate rests on: WCAG 2.1 relative luminance, the
// contrast ratio built from it, and alpha compositing done *before* the ratio.
//
// It is a separate module from the gate for one reason: this part is pure, and
// pure things can be checked against published numbers instead of against a
// browser. #767676 on white is 4.54:1 and #777777 on white is 4.48:1 -- the
// canonical AA boundary on either side. A rounding rule that gets the boundary
// wrong still sails through a black-on-white check and then misjudges every
// real piece of text, which is the only place it matters.
//
// No dependencies, matching the rest of this repo.

// Accepts "#rgb", "#rrggbb", "rgb(r, g, b)" and "rgba(r, g, b, a)". Returns
// { rgb: [r, g, b], alpha } with channels 0-255, or null when the value carries
// no colour at all ("transparent", "none", a gradient, the empty string).
export function parseColour(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text === "transparent" || text === "none") return null;

  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const channels = [...hex].map((character) => parseInt(character + character, 16));
      if (channels.some(Number.isNaN)) return null;
      return { rgb: channels.slice(0, 3), alpha: channels.length === 4 ? channels[3] / 255 : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const channels = [];
      for (let index = 0; index < hex.length; index += 2) channels.push(parseInt(hex.slice(index, index + 2), 16));
      if (channels.some(Number.isNaN)) return null;
      return { rgb: channels.slice(0, 3), alpha: channels.length === 4 ? channels[3] / 255 : 1 };
    }
    return null;
  }

  const match = text.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return null;
  const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
  return { rgb: parts.slice(0, 3), alpha };
}

export function toHex(rgb) {
  return `#${rgb.map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// WCAG 2.1 relative luminance. The 0.03928 threshold and the 2.4 exponent are
// the specification's, not an approximation of sRGB.
export function relativeLuminance(colour) {
  const parsed = Array.isArray(colour) ? { rgb: colour } : parseColour(colour);
  if (!parsed) throw new Error(`relativeLuminance: not a colour: ${colour}`);
  const [r, g, b] = parsed.rgb.map((channel) => {
    const c = clamp(channel, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Unrounded on purpose. Callers that want two decimals round at the edge; a
// value rounded here and compared against 4.5 would pass 4.495:1 as AA.
export function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

// Source-over compositing of `foreground` at `alpha` onto an opaque
// `background`. This is the step issue #126 is about: a gate that skips it reads
// the token and reports 21:1 for text the reader sees at 2.85:1.
export function composite(foreground, background, alpha = 1) {
  const top = Array.isArray(foreground) ? { rgb: foreground, alpha: 1 } : parseColour(foreground);
  const bottom = Array.isArray(background) ? { rgb: background, alpha: 1 } : parseColour(background);
  if (!top) throw new Error(`composite: not a colour: ${foreground}`);
  if (!bottom) throw new Error(`composite: not a colour: ${background}`);
  const weight = clamp(alpha * top.alpha, 0, 1);
  return toHex(top.rgb.map((channel, index) => channel * weight + bottom.rgb[index] * (1 - weight)));
}

// Saturation as chroma over the 0-255 range: 0 for any neutral grey, whatever
// the lightness. Used to tell "de-emphasised by removing colour" from
// "de-emphasised by dimming", which contrast alone cannot distinguish.
export function saturation(colour) {
  const parsed = Array.isArray(colour) ? { rgb: colour } : parseColour(colour);
  if (!parsed) return 0;
  return (Math.max(...parsed.rgb) - Math.min(...parsed.rgb)) / 255;
}
