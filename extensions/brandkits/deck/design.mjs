// A Deck design: everything the Design tab chooses, in one file that Brandkits writes and Deck
// reads. A `.deckdesign` file is a zip of design.json, the logos and the background pictures. Pure:
// no DOM, no window.nendo, so Deck's view, Brandkits' view and node's tests share it.
//
// design.json, version 1. Every field but format, version and name may be left out, and Deck then
// uses the family's own choice:
//   { format: 'nendo.deck-design', version: 1, name, tagline, voice,
//     source: {app, kit, kitVersion, exported},
//     template: {family, mode: light|dark, style: {titleWeight, titleTracking, radius, kicker, bullet}},
//     colors: {primary, secondary, accent, background, surface, ink, muted},   hex
//     chart: [hex…],                                                           series colours, in order
//     fonts: {heading, body, mono},
//     logos: {light, dark, mark: path in the zip, placement},
//     backgrounds: {title|section|closing|content:
//       {kind: 'role', role} | {kind: 'gradient', angle, stops: [colour, colour]} |
//       {kind: 'image', src: path in the zip, tint: colour, tintAlpha, dark}},
//     deck: {footer, slideNumbers} }
// A colour in a background is a role name or a hex, so it follows the kit when the kit changes.

import { zip, unzip } from './zip.mjs';
import { normalHex, BRAND_ROLES, FAMILIES, templateById } from './themes.mjs';
import { F } from './model.mjs';

export const DESIGN_FORMAT = 'nendo.deck-design';
export const DESIGN_VERSION = 1;
export const DESIGN_EXTENSION = '.deckdesign';
/** The slide kinds a design gives its own background. Statement draws as a Section. */
export const SLOTS = ['title', 'section', 'closing', 'content'];
export const PLACEMENTS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'none'];
export const KICKERS = ['caps', 'italic', 'mono', 'pill'];
export const BULLETS = ['•', '–', '—', '■', '▪', '›', '○', '◆'];
const PICTURE = /\.(svg|png|jpe?g|webp|gif)$/i;
const MAX_PICTURE = 8 * 1024 * 1024;

export const slotOf = layout => layout === 'Title' ? 'title' : layout === 'Section' || layout === 'Statement' ? 'section' : layout === 'Closing' ? 'closing' : 'content';

const str = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const num = (value, min, max) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.min(max, Math.max(min, Number(value))) : undefined;
const font = value => str(value, 80).split(',')[0].replace(/["']/g, '').trim() || undefined;
/** A role name or a hex; anything else is no colour. */
const colour = value => BRAND_ROLES.includes(value) ? value : normalHex(value) ?? undefined;
const path = value => {
  const p = str(value, 200).replace(/\\/g, '/').replace(/^\.?\//, '');
  return p && !p.split('/').includes('..') && PICTURE.test(p) ? p : undefined;
};
const prune = object => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined && v !== '' && !(typeof v === 'object' && v && !Array.isArray(v) && !Object.keys(v).length)));

/** The design in design.json, checked and cut down to what Deck knows. Throws a sentence saying why not. */
export function normalizeDesign(data) {
  if (!data || typeof data !== 'object' || data.format !== DESIGN_FORMAT) throw new Error('This is not a Deck design: its design.json does not say "nendo.deck-design".');
  const version = Number(data.version);
  if (!Number.isInteger(version) || version < 1) throw new Error('This Deck design has no version Deck can read.');
  if (version > DESIGN_VERSION) throw new Error(`This Deck design is version ${version}, made by a newer Brandkits. Update Deck to read it.`);
  const name = str(data.name, 120);
  if (!name) throw new Error('This Deck design has no name.');
  const t = data.template ?? {};
  const family = FAMILIES.includes(String(t.family ?? '').toLowerCase()) ? String(t.family).toLowerCase() : 'keynote';
  const s = t.style ?? {};
  const style = prune({
    titleWeight: num(s.titleWeight, 100, 900) === undefined ? undefined : Math.round(num(s.titleWeight, 100, 900) / 100) * 100,
    titleTracking: num(s.titleTracking, -0.08, 0.08), radius: num(s.radius, 0, 40),
    kicker: KICKERS.includes(s.kicker) ? s.kicker : undefined, bullet: BULLETS.includes(s.bullet) ? s.bullet : undefined,
  });
  const colors = {};
  for (const role of BRAND_ROLES) { const hex = normalHex(data.colors?.[role]); if (hex) colors[role] = hex; }
  const chart = (Array.isArray(data.chart) ? data.chart : []).map(c => normalHex(c)).filter(Boolean).slice(0, 8);
  const fonts = prune({ heading: font(data.fonts?.heading), body: font(data.fonts?.body), mono: font(data.fonts?.mono) });
  const l = data.logos ?? {};
  const logos = prune({ light: path(l.light), dark: path(l.dark), mark: path(l.mark), placement: PLACEMENTS.includes(l.placement) ? l.placement : undefined });
  const backgrounds = {};
  for (const slot of SLOTS) { const b = background(data.backgrounds?.[slot]); if (b) backgrounds[slot] = b; }
  const deck = prune({ footer: str(data.deck?.footer, 200) || undefined, slideNumbers: typeof data.deck?.slideNumbers === 'boolean' ? data.deck.slideNumbers : undefined });
  const source = prune({ app: str(data.source?.app, 60) || undefined, kit: str(data.source?.kit, 120) || undefined,
    kitVersion: Number.isInteger(data.source?.kitVersion) ? data.source.kitVersion : undefined, exported: str(data.source?.exported, 40) || undefined });
  return prune({
    format: DESIGN_FORMAT, version: DESIGN_VERSION, name, tagline: str(data.tagline, 200) || undefined, voice: str(data.voice, 4000) || undefined, source,
    template: prune({ family, mode: t.mode === 'dark' || t.mode === 'light' ? t.mode : templateById(family).mode, style }),
    colors, chart: chart.length ? chart : undefined, fonts, logos, backgrounds, deck,
  });
}
function background(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.kind === 'role') { const role = colour(b.role); return role ? { kind: 'role', role } : null; }
  if (b.kind === 'gradient') {
    const stops = (Array.isArray(b.stops) ? b.stops : []).map(colour).filter(Boolean).slice(0, 3);
    return stops.length >= 2 ? { kind: 'gradient', angle: num(b.angle, 0, 360) ?? 135, stops } : null;
  }
  if (b.kind === 'image') {
    const src = path(b.src);
    return src ? prune({ kind: 'image', src, tint: colour(b.tint), tintAlpha: num(b.tintAlpha, 0, 1), dark: typeof b.dark === 'boolean' ? b.dark : undefined }) : null;
  }
  return null;
}

/** Every picture a design names, by its path in the package. */
export function picturesOf(design) {
  const out = new Set();
  for (const key of ['light', 'dark', 'mark']) if (design.logos?.[key]) out.add(design.logos[key]);
  for (const slot of SLOTS) if (design.backgrounds?.[slot]?.src) out.add(design.backgrounds[slot].src);
  return [...out];
}
export const typeOf = name => /\.svg$/i.test(name) ? 'image/svg+xml' : /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg';

/** A .deckdesign file's bytes → {design, pictures: Map(path → {name, bytes, type})}. Throws a sentence. */
export async function readDesignPackage(bytes, fileName = 'design') {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new Error(`${fileName} is not a Deck design file. In Brandkits, choose Export, then Deck design.`);
  const entries = unzip(bytes).filter(e => !e.name.endsWith('/'));
  const entry = entries.find(e => e.name.replace(/^[^/]+\//, '') === 'design.json' || e.name === 'design.json');
  if (!entry) throw new Error(`${fileName} holds no design.json, so it is not a Deck design.`);
  const root = entry.name.slice(0, entry.name.length - 'design.json'.length);
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await entry.bytes())); } catch { throw new Error(`The design.json in ${fileName} is not valid JSON.`); }
  const design = normalizeDesign(data);
  const pictures = new Map();
  for (const p of picturesOf(design)) {
    const e = entries.find(x => x.name === root + p);
    if (!e) continue;
    const data = await e.bytes();
    if (data.length > MAX_PICTURE) continue;
    pictures.set(p, { name: p.split('/').pop(), bytes: data, type: typeOf(p) });
  }
  // A picture the package names but does not hold is left out, rather than drawn as a hole.
  for (const key of ['light', 'dark', 'mark']) if (design.logos?.[key] && !pictures.has(design.logos[key])) delete design.logos[key];
  for (const slot of SLOTS) if (design.backgrounds?.[slot]?.src && !pictures.has(design.backgrounds[slot].src)) delete design.backgrounds[slot];
  return { design, pictures };
}

/** A design and its pictures (Map path → bytes or text) → the .deckdesign file's bytes. */
export function writeDesignPackage(design, pictures = new Map(), date) {
  const clean = normalizeDesign(design);
  const files = [{ name: 'design.json', data: JSON.stringify(clean, null, 2) + '\n' }];
  for (const p of picturesOf(clean)) if (pictures.has(p)) files.push({ name: p, data: pictures.get(p) });
  return zip(files, date);
}
export const designFileName = design => `${String(design.name ?? 'Design').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Design'}${DESIGN_EXTENSION}`;

/**
 * The template and brand specs resolveTheme takes, from a design. urlOf turns a picture's path into
 * what the renderer draws: a media address in Deck, an object URL in Brandkits' preview.
 */
export function designSpecs(design, urlOf = p => p) {
  const c = design.colors ?? {};
  const backgrounds = {};
  for (const slot of SLOTS) {
    const b = design.backgrounds?.[slot];
    if (b) backgrounds[slot] = b.kind === 'image' ? { ...b, src: urlOf(b.src) } : b;
  }
  const template = {
    id: `design:${design.name}`, family: design.template?.family ?? 'keynote', name: design.name, mode: design.template?.mode,
    colors: { bg: c.background, surface: c.surface, ink: c.ink, muted: c.muted, primary: c.primary, secondary: c.secondary, accent: c.accent },
    fonts: { ...(design.fonts ?? {}) }, style: { ...(design.template?.style ?? {}) }, backgrounds, chart: design.chart ?? null,
    logoPlacement: design.logos?.placement ?? null,
  };
  const logo = key => design.logos?.[key] ? urlOf(design.logos[key]) : null;
  const brand = { name: design.name, colors: { ...c }, fonts: { ...(design.fonts ?? {}) }, logo: logo('light'), logoDark: logo('dark'), mark: logo('mark') };
  return { template, brand, deck: { footer: design.deck?.footer ?? '', slideNumbers: design.deck?.slideNumbers !== false } };
}

// ---- A design as Deck's records ---------------------------------------------------------------

export const MODES = ['Light', 'Dark'];
export const PLACEMENT_LABELS = { 'top-right': 'Top right', 'top-left': 'Top left', 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', none: 'None' };
const placementOf = label => Object.keys(PLACEMENT_LABELS).find(k => PLACEMENT_LABELS[k] === label) ?? null;
export const IMAGE_FIELDS = { title: F.template.titleImage, section: F.template.sectionImage, closing: F.template.closingImage, content: F.template.contentImage };
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

/** The key a design is found by on a second import: its Brandkits kit, else its name. */
export const sourceKey = design => design.source?.kit ? `${design.source.app ?? 'Brandkits'}:${design.source.kit}` : `name:${design.name.toLowerCase()}`;

/**
 * A design's values for its Brand kit and its Template record, by field ID. Every field is named,
 * null where the design has nothing, so a second import leaves nothing of the first behind.
 * Pictures are not here: they are put as media after the records are written.
 */
export function designValues(design) {
  const c = design.colors ?? {}, f = design.fonts ?? {};
  const brand = {
    [F.brand.name]: design.name, [F.brand.source]: 'Brandkits', [F.brand.voice]: design.voice ?? null, [F.brand.tagline]: design.tagline ?? null,
    [F.brand.headingFont]: f.heading ?? null, [F.brand.bodyFont]: f.body ?? null, [F.brand.monoFont]: f.mono ?? null,
    [F.brand.tokens]: JSON.stringify(design, null, 2).slice(0, 60000),
  };
  for (const role of BRAND_ROLES) brand[F.brand[role]] = c[role] ?? null;
  const backgrounds = {};
  for (const slot of SLOTS) {
    const b = design.backgrounds?.[slot];
    if (b) backgrounds[slot] = b.kind === 'image' ? { ...b, src: slot } : b;
  }
  const template = {
    [F.template.name]: design.name, [F.template.family]: capital(design.template?.family ?? 'keynote'),
    [F.template.description]: design.tagline ? `${design.tagline} Designed in Brandkits.` : 'Designed in Brandkits.',
    [F.template.headingFont]: f.heading ?? null, [F.template.bodyFont]: f.body ?? null,
    [F.template.background]: c.background ?? null, [F.template.surface]: c.surface ?? null, [F.template.ink]: c.ink ?? null, [F.template.muted]: c.muted ?? null,
    [F.template.primary]: c.primary ?? null, [F.template.secondary]: c.secondary ?? null, [F.template.accent]: c.accent ?? null,
    [F.template.mode]: design.template?.mode === 'dark' ? 'Dark' : 'Light',
    [F.template.style]: Object.keys(design.template?.style ?? {}).length ? JSON.stringify(design.template.style) : null,
    [F.template.backgrounds]: Object.keys(backgrounds).length ? JSON.stringify(backgrounds) : null,
    [F.template.chart]: design.chart?.length ? design.chart.join(', ') : null,
    [F.template.logoPlacement]: PLACEMENT_LABELS[design.logos?.placement ?? 'top-right'],
    [F.template.source]: sourceKey(design),
  };
  return { brand, template };
}

const json = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch { return null; } };

/** A Template record's values → the template spec resolveTheme takes; pictures by their media address. */
export function templateSpecFrom(values, recordId = null) {
  const v = field => values?.[field] ?? null;
  const hex = field => normalHex(v(field));
  const family = String(v(F.template.family) ?? 'Keynote').toLowerCase();
  const backgrounds = {};
  for (const [slot, b] of Object.entries(json(v(F.template.backgrounds)) ?? {})) {
    if (!SLOTS.includes(slot) || !b) continue;
    if (b.kind === 'image') { const address = v(IMAGE_FIELDS[slot]); if (address) backgrounds[slot] = { ...b, src: address }; }
    else backgrounds[slot] = b;
  }
  const mode = v(F.template.mode);
  return {
    id: recordId, family, name: v(F.template.name) ?? 'Template', mode: mode === 'Dark' ? 'dark' : mode === 'Light' ? 'light' : undefined,
    colors: { bg: hex(F.template.background), surface: hex(F.template.surface), ink: hex(F.template.ink), muted: hex(F.template.muted),
      primary: hex(F.template.primary), secondary: hex(F.template.secondary), accent: hex(F.template.accent) },
    fonts: { heading: v(F.template.headingFont), body: v(F.template.bodyFont) },
    style: json(v(F.template.style)) ?? {}, backgrounds,
    chart: String(v(F.template.chart) ?? '').split(/[\s,;]+/).map(c => normalHex(c)).filter(Boolean),
    logoPlacement: placementOf(v(F.template.logoPlacement)),
  };
}
/** A Brand kit record's values → the brand spec resolveTheme takes. */
export function brandSpecFrom(values) {
  const v = field => values?.[field] ?? null;
  const colors = {};
  for (const role of BRAND_ROLES) { const hex = normalHex(v(F.brand[role])); if (hex) colors[role] = hex; }
  return {
    name: v(F.brand.name) ?? 'Brand', colors,
    fonts: { heading: v(F.brand.headingFont), body: v(F.brand.bodyFont), mono: v(F.brand.monoFont) },
    logo: v(F.brand.logo), logoDark: v(F.brand.logoDark), mark: v(F.brand.mark),
  };
}
