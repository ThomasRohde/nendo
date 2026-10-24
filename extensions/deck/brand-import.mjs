// Reads a brand kit that another app exported, Brandkits first: its design tokens (JSON), its
// CSS variables, or its Claude Design bundle (a zip of both plus logos and a README). A view
// cannot read another .nendo file, so this is how a deck takes a kit from Brandkits.

import { unzip } from './zip.mjs';
import { normalHex, BRAND_ROLES } from './themes.mjs';

const ROLE_WORDS = {
  primary: [/primary/, /brand(?!.*(secondary|accent))/, /main/],
  secondary: [/secondary/],
  accent: [/accent/, /highlight/, /tertiary/],
  background: [/background/, /\bbg\b/, /canvas/, /paper/, /^base$/],
  surface: [/surface/, /card/, /panel/],
  ink: [/\bink\b/, /^text$/, /text[-_.]?(primary|default|body)?$/, /foreground/, /\bfg\b/, /on[-_.]?background/],
  muted: [/muted/, /subtle/, /secondary[-_.]?text/, /text[-_.]?secondary/, /caption/],
};
const FONT_WORDS = { heading: /(heading|display|title|headline|h1)/, body: /(body|text|base|paragraph|sans)/, mono: /(mono|code)/ };

/** Which role a token's path names, or null. Text roles win over brand roles: "text-secondary" is muted. */
export function roleOf(path) {
  const p = path.toLowerCase();
  if (/font|type|size|weight|space|radius|shadow|line-height|duration/.test(p)) return null;
  for (const role of ['muted', 'ink', 'background', 'surface', 'accent', 'secondary', 'primary']) if (ROLE_WORDS[role].some(rx => rx.test(p))) return role;
  return null;
}

/** Every {path, value} leaf of a JSON tree, with $value/value unwrapped. */
function leaves(node, path = [], out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') { out.push({ path: path.join('.'), value: node }); return out; }
  if ('$value' in node || ('value' in node && typeof node.value !== 'object')) { out.push({ path: path.join('.'), value: node.$value ?? node.value, type: node.$type ?? node.type }); return out; }
  if (Array.isArray(node)) { node.forEach((v, i) => leaves(v, [...path, String(i)], out)); return out; }
  for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) leaves(v, [...path, k], out);
  return out;
}

function fromPairs(pairs, kit) {
  const colors = {}, fonts = {}, loose = [];
  for (const { path, value, type } of pairs) {
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text !== 'string') continue;
    const hex = normalHex(text.trim());
    const lower = path.toLowerCase();
    if (hex) {
      const role = roleOf(lower);
      if (role && !colors[role]) colors[role] = hex; else loose.push(hex);
      continue;
    }
    if (type === 'fontFamily' || /font|family|typeface/.test(lower)) {
      const family = text.split(',')[0].replace(/["']/g, '').trim();
      if (!family) continue;
      for (const [slot, rx] of Object.entries(FONT_WORDS)) if (rx.test(lower) && !fonts[slot]) { fonts[slot] = family; break; }
    }
  }
  // A kit that names no roles: its first colours are its primary, secondary and accent.
  if (!Object.keys(colors).length) for (const role of ['primary', 'secondary', 'accent']) if (loose.length) colors[role] = loose.shift();
  Object.assign(kit.colors, Object.fromEntries(Object.entries(colors).filter(([r]) => !kit.colors[r])));
  for (const [slot, family] of Object.entries(fonts)) kit.fonts[slot] ??= family;
}

export function parseTokensJson(text, kit = emptyKit()) {
  const data = JSON.parse(text);
  kit.name ||= String(data.name ?? data.brand?.name ?? data.title ?? data.$name ?? data.kit?.name ?? '').trim();
  kit.voice ||= flatten(data.voice ?? data.brand?.voice ?? '');
  kit.tagline ||= String(data.tagline ?? data.brand?.tagline ?? '').trim();
  fromPairs(leaves(data), kit);
  kit.tokens ||= text.slice(0, 60000);
  return kit;
}
const flatten = v => typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.map(flatten).filter(Boolean).join('\n') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${flatten(x)}`).join('\n') : '';

export function parseCss(text, kit = emptyKit()) {
  const pairs = [];
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) pairs.push({ path: m[1], value: m[2].trim() });
  fromPairs(pairs, kit);
  kit.tokens ||= text.slice(0, 60000);
  return kit;
}

export const emptyKit = () => ({ name: '', colors: {}, fonts: {}, voice: '', tagline: '', logos: {}, tokens: '' });

/**
 * A kit's values by Brand kit field name (model.mjs F.brand). Only what the file holds is named, so
 * importing a file again updates those fields and leaves the rest of the kit as the person had it;
 * a new kit is given null for the rest.
 */
export function kitValues(kit) {
  const values = { source: 'Brandkits' };
  if (kit.name) values.name = kit.name;
  for (const key of ['voice', 'tagline', 'tokens']) if (kit[key]) values[key] = kit[key];
  for (const [role, key] of [['heading', 'headingFont'], ['body', 'bodyFont'], ['mono', 'monoFont']]) if (kit.fonts?.[role]) values[key] = kit.fonts[role];
  for (const [role, value] of Object.entries(kit.colors ?? {})) if (value) values[role] = value;
  return values;
}

const DARK_LOGO = /(dark|reverse|reversed|inverse|inverted|white|knockout|on[-_]?dark|negative)/i;

/** A file the person picked or dropped: answers a kit, or throws a sentence saying why not. */
export async function importBrandFile(file) {
  const name = file.name ?? 'kit';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kit = emptyKit();
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const entries = unzip(bytes).filter(e => !e.name.endsWith('/') && !/__MACOSX|\/\./.test(e.name));
    const text = async e => new TextDecoder().decode(await e.bytes());
    const json = entries.filter(e => /\.json$/i.test(e.name)).sort((a, b) => score(b.name) - score(a.name));
    for (const e of json) { try { parseTokensJson(await text(e), kit); break; } catch { /* the next one */ } }
    const css = entries.find(e => /\.css$/i.test(e.name) && /token|brand|variables/i.test(e.name)) ?? entries.find(e => /\.css$/i.test(e.name));
    if (css) parseCss(await text(css), kit);
    const readme = entries.find(e => /readme\.md$/i.test(e.name));
    if (readme) readReadme(await text(readme), kit);
    const pictures = entries.filter(e => /\.(svg|png|jpe?g|webp)$/i.test(e.name) && /logo|mark|wordmark|lockup/i.test(e.name));
    const light = pictures.find(e => !DARK_LOGO.test(e.name) && /primary|full|main|logo/i.test(e.name)) ?? pictures.find(e => !DARK_LOGO.test(e.name));
    const dark = pictures.find(e => DARK_LOGO.test(e.name));
    if (light) kit.logos.light = { name: light.name.split('/').pop(), bytes: await light.bytes(), type: typeOf(light.name) };
    if (dark) kit.logos.dark = { name: dark.name.split('/').pop(), bytes: await dark.bytes(), type: typeOf(dark.name) };
    kit.name ||= name.replace(/\.zip$/i, '').replace(/[-_]+/g, ' ');
  } else if (lower.endsWith('.json')) {
    parseTokensJson(new TextDecoder().decode(bytes), kit);
  } else if (lower.endsWith('.css')) {
    parseCss(new TextDecoder().decode(bytes), kit);
  } else if (/\.(svg|png|jpe?g|webp)$/.test(lower)) {
    kit.logos[DARK_LOGO.test(lower) ? 'dark' : 'light'] = { name, bytes, type: typeOf(lower) };
    return kit;
  } else {
    throw new Error(`${name} is not a brand kit Deck can read. Pick the tokens (.json), the CSS (.css) or the Claude Design bundle (.zip) that Brandkits exports.`);
  }
  kit.name ||= name.replace(/\.(json|css)$/i, '').replace(/[-_]+/g, ' ');
  if (!BRAND_ROLES.some(r => kit.colors[r])) throw new Error(`${name} names no colours Deck recognises, so nothing was imported.`);
  return kit;
}
const score = path => (/tokens?\.json$/i.test(path) ? 4 : 0) + (/brand/i.test(path) ? 2 : 0) - path.split('/').length * 0.1;
const typeOf = path => /\.svg$/i.test(path) ? 'image/svg+xml' : /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg';

/** The README of a Claude Design bundle: its title is the kit's name; a Voice section is its voice. */
export function readReadme(text, kit) {
  const title = /^#\s+(.+)$/m.exec(text);
  if (title && !kit.name) kit.name = title[1].replace(/\s*(brand kit|design system)$/i, '').trim();
  const voice = /^#{2,3}\s+(voice|tone|voice and tone|tone of voice)\s*$([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im.exec(text);
  if (voice && !kit.voice) kit.voice = voice[2].trim().slice(0, 4000);
  const tagline = /^(?:\*\*)?tagline(?:\*\*)?\s*[:\-–]\s*(.+)$/im.exec(text);
  if (tagline && !kit.tagline) kit.tagline = tagline[1].replace(/\*\*/g, '').trim();
  return kit;
}
