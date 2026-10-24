// Contrast by WCAG 2.2: relative luminance of sRGB colours and the ratio between two of them.
// The view, never the agent, works out every ratio it shows.

/** '#RGB' or '#RRGGBB' (with or without #) as {r, g, b} 0-255, or null. */
export function parseHex(value) {
  const text = String(value ?? '').trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(text) ? [...text].map(c => c + c).join('') : text;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

/** The hex in the shape the file keeps: #RRGGBB, upper case. Null when it is not a colour. */
export function normalHex(value) {
  const rgb = parseHex(value);
  return rgb ? `#${[rgb.r, rgb.g, rgb.b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}` : null;
}

const channel = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** The contrast ratio, 1 to 21, or null when either is not a colour. */
export function ratio(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Ratios are shown cut, not rounded, to two decimals, so 4.499 never reads as a pass. */
export const shown = value => value === null ? '–' : (Math.floor(value * 100) / 100).toFixed(2);

/**
 * The grade of a ratio for text: AAA (7), AA (4.5), Large only (3: AA for large text, and for
 * buttons and graphics) or Fails. target 'AAA' raises the bar a pair must clear to pass.
 */
export function grade(value, target = 'AA') {
  if (value === null) return { label: '–', pass: false, large: false };
  const cut = Math.floor(value * 100) / 100;
  const label = cut >= 7 ? 'AAA' : cut >= 4.5 ? 'AA' : cut >= 3 ? 'Large only' : 'Fails';
  const pass = target === 'AAA' ? cut >= 7 : cut >= 4.5;
  const large = target === 'AAA' ? cut >= 4.5 : cut >= 3;
  return { label, pass, large };
}

/** Black or white, whichever reads better on the colour. */
export function inkOn(hex) {
  return (ratio(hex, '#000000') ?? 0) >= (ratio(hex, '#FFFFFF') ?? 0) ? '#000000' : '#FFFFFF';
}
