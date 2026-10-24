// A kit's slides: the choices the Slides tile makes, and the Deck design a kit exports. Pure: the
// view hands it the kit as plain values, so node's tests run it as the view does.
//
// The choices live on the Kit as JSON in kitSlides, and a picture background in the kit's media
// field for that kind of slide (SLIDE_PICTURE_FIELDS). A choice left out is worked out from the
// kit: the family from its personality, the colours from its roles, the type from its typefaces.

import { contrast, isDark, normalHex, templateById } from './deck/themes.mjs';
import { normalizeDesign, SLOTS, DESIGN_FORMAT, DESIGN_VERSION } from './deck/design.mjs';

export const SLIDE_PICTURE_FIELDS = { title: 'kitSlideTitle', section: 'kitSlideSection', closing: 'kitSlideClosing', content: 'kitSlideContent' };
export const FAMILIES = [['keynote', 'Keynote'], ['editorial', 'Editorial'], ['swiss', 'Swiss'], ['boardroom', 'Boardroom'], ['studio', 'Studio'], ['minimal', 'Minimal']];
export const BACKGROUNDS = [
  ['family', 'The family’s own'], ['role:primary', 'Primary'], ['role:secondary', 'Secondary'], ['role:accent', 'Accent'],
  ['role:background', 'Background'], ['role:ink', 'Text colour'], ['gradient:primary,secondary', 'Primary to secondary'],
  ['gradient:primary,background', 'Primary to background'], ['gradient:secondary,primary', 'Secondary to primary'], ['picture', 'Picture…'],
];
export const PLACEMENTS = [['top-right', 'Top right'], ['top-left', 'Top left'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['none', 'No logo']];
export const KICKERS = [['caps', 'Small capitals'], ['italic', 'Italic'], ['mono', 'Mono'], ['pill', 'Pill']];
export const CORNERS = [[0, 'Square'], [4, 'Slight'], [12, 'Rounded'], [22, 'Soft']];
export const WEIGHTS = [[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Heavy']];

const str = value => String(value ?? '');
const FAMILY_WORDS = [
  ['studio', /bold|joyful|playful|cheeky|vibrant|fun|energetic|generous/i],
  ['swiss', /sharp|fast|direct|precise|modern|efficient/i],
  ['minimal', /calm|exact|quiet|minimal|clean|simple|serene/i],
  ['boardroom', /trust|reassur|reliable|professional|clear|steady/i],
  ['editorial', /craft|warm|earthy|rooted|honest|patient|gentle|unhurried/i],
];
/** The family a kit's personality suggests, Keynote when nothing matches. */
export function familyFor(personality) {
  const words = str(personality);
  return FAMILY_WORDS.find(([, rx]) => rx.test(words))?.[0] ?? 'keynote';
}

/** The kit's choices as kitSlides holds them; what is missing or broken is simply left out. */
export function readChoices(text) {
  try { const value = JSON.parse(str(text) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/**
 * The kit's colours as Deck's seven roles, and its chart colours. kit: {colours: [{role, hex}]},
 * in the kit's order. A role the kit lacks is left out, and Deck works it out from the others.
 */
export function kitRoles(colours) {
  const valid = colours.map(c => ({ ...c, hex: normalHex(c.hex) })).filter(c => c.hex);
  const of = role => valid.filter(c => c.role === role);
  const byLight = [...valid].sort((a, b) => contrast(b.hex, '#000000') - contrast(a.hex, '#000000'));
  const background = of('Background')[0]?.hex ?? byLight[0]?.hex;
  const ink = of('Text')[0]?.hex ?? byLight.at(-1)?.hex;
  const loud = valid.filter(c => !['Background', 'Text', 'Neutral'].includes(c.role));
  const primary = of('Primary')[0]?.hex ?? loud[0]?.hex;
  const secondary = of('Secondary')[0]?.hex ?? of('Primary')[1]?.hex;
  const accent = of('Accent')[0]?.hex;
  const neutrals = of('Neutral').map(c => c.hex).filter(hex => hex !== background && hex !== ink);
  const roles = { primary, secondary, accent, background, ink };
  if (background) {
    // The surface is the neutral nearest the background; muted text the faintest neutral that still reads.
    const near = neutrals.filter(n => contrast(n, background) < 1.6).sort((a, b) => contrast(a, background) - contrast(b, background));
    if (near[0]) roles.surface = near[0];
    const readable = neutrals.filter(n => contrast(n, background) >= 4.5).sort((a, b) => contrast(a, background) - contrast(b, background));
    if (readable[0]) roles.muted = readable[0];
  }
  const chart = [...new Set([primary, accent, secondary, ...loud.map(c => c.hex)].filter(Boolean))]
    .filter(hex => !background || contrast(hex, background) >= 1.5).slice(0, 6);
  return { colors: Object.fromEntries(Object.entries(roles).filter(([, v]) => v)), chart };
}

const background = value => {
  const v = str(value);
  if (v.startsWith('role:')) return { kind: 'role', role: v.slice(5) };
  if (v.startsWith('gradient:')) return { kind: 'gradient', angle: 135, stops: v.slice(9).split(',') };
  return null;
};
const fixSvg = svg => {
  let text = str(svg).trim();
  if (!/^<svg[\s>]/i.test(text.replace(/^<\?xml[^>]*>\s*/i, ''))) return null;
  if (!/xmlns=/.test(text)) text = text.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return text;
};

/**
 * The Deck design a kit exports, and its pictures by path. kit: {recordId, version, name, tagline,
 * voice, personality, colours: [{role, hex}], typefaces: [{role, family}], logos: [{kind, svg}],
 * pictures: {slot: {type}}} with the choices from readChoices. A picture's bytes are the view's to
 * add to the map: its path is returned under `pictureSlots`.
 */
export function kitDesign(kit, choices = {}) {
  const { colors, chart } = kitRoles(kit.colours ?? []);
  const face = (...roles) => roles.map(r => (kit.typefaces ?? []).find(t => t.role === r && str(t.family).trim())).find(Boolean)?.family;
  const family = FAMILIES.some(([id]) => id === choices.family) ? choices.family : familyFor(kit.personality);
  const mode = choices.mode === 'dark' || choices.mode === 'light' ? choices.mode : (colors.background && isDark(colors.background) ? 'dark' : templateById(family).mode);
  const logo = (...kinds) => kinds.map(k => (kit.logos ?? []).find(l => l.kind === k && fixSvg(l.svg))).find(Boolean);
  const pictures = new Map();
  const logos = {};
  for (const [key, kinds, file] of [['light', ['Primary', 'Wordmark', 'Mono'], 'logos/logo.svg'], ['dark', ['Reversed'], 'logos/logo-dark.svg'], ['mark', ['Mark'], 'logos/mark.svg']]) {
    const l = logo(...kinds);
    if (l) { logos[key] = file; pictures.set(file, fixSvg(l.svg)); }
  }
  logos.placement = choices.placement ?? 'top-right';
  const backgrounds = {}, pictureSlots = {};
  for (const slot of SLOTS) {
    const choice = choices.backgrounds?.[slot];
    if (choice === 'picture') {
      const type = kit.pictures?.[slot]?.type;
      if (!type) continue;
      const path = `backgrounds/${slot}.${type === 'image/svg+xml' ? 'svg' : type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`;
      // The tint is a colour, not a role: a dark stage turns a light kit's text colour light, and white
      // titles sit on this tint whatever the stage. At 0.6 the darkest colour keeps a white title at 3:1 even
      // over a white picture.
      const tint = [colors.ink, colors.secondary, colors.primary].filter(Boolean).sort((a, b) => contrast(a, '#FFFFFF') - contrast(b, '#FFFFFF')).at(-1);
      const shade = tint && isDark(tint) ? tint : '#111111';
      backgrounds[slot] = { kind: 'image', src: path, tint: shade, tintAlpha: 0.6, dark: true };
      pictureSlots[slot] = path;
    } else {
      const b = background(choice);
      if (b) backgrounds[slot] = b;
    }
  }
  const style = {};
  if (Number.isFinite(Number(choices.titleWeight)) && choices.titleWeight !== null && choices.titleWeight !== '') style.titleWeight = Number(choices.titleWeight);
  if (Number.isFinite(Number(choices.radius)) && choices.radius !== null && choices.radius !== '') style.radius = Number(choices.radius);
  if (choices.kicker) style.kicker = choices.kicker;
  const design = normalizeDesign({
    format: DESIGN_FORMAT, version: DESIGN_VERSION, name: str(kit.name).trim() || 'Brand', tagline: kit.tagline, voice: kit.voice,
    source: { app: 'Brandkits', kit: kit.recordId, kitVersion: kit.version, exported: kit.exported },
    template: { family, mode, style }, colors, chart, fonts: { heading: face('Heading', 'Display'), body: face('Body', 'Heading'), mono: face('Mono') },
    logos, backgrounds, deck: { footer: choices.footer, slideNumbers: choices.slideNumbers },
  });
  // A picture the design lost in checking is not carried.
  for (const path of [...pictures.keys()]) if (!Object.values(design.logos ?? {}).includes(path)) pictures.delete(path);
  for (const slot of Object.keys(pictureSlots)) if (!design.backgrounds?.[slot]) delete pictureSlots[slot];
  return { design, pictures, pictureSlots };
}
