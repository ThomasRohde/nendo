// Measures text with the browser's own font engine, so the layout fits text as it will draw.
import { fontStack } from './themes.mjs';

const cache = new Map();
let context = null;
export function canvasMeasure(text, { size, weight = 400, font = '', italic = false }) {
  context ??= (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d');
  const key = `${weight}|${italic}|${font}|${text}`;
  let at100 = cache.get(key);
  if (at100 === undefined) {
    context.font = `${italic ? 'italic ' : ''}${weight} 100px ${fontStack(font)}`;
    at100 = context.measureText(text).width;
    if (cache.size > 20000) cache.clear();
    cache.set(key, at100);
  }
  return at100 * size / 100;
}
/** Forget measurements once a web font arrives, since they were taken with its fallback. */
export function forgetMeasurements() { cache.clear(); }
