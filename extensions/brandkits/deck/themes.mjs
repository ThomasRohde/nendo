// Templates and brand kits: what a deck looks like. A template is a family of decorations, two
// fonts and a palette of roles; a brand kit replaces the roles, the fonts and adds a logo. The
// result is one resolved theme that the layout engine reads and nothing else does.

/** Colour helpers: hex in, hex out. Every function accepts #rgb and #rrggbb and ignores case. */
export function parseHex(value) {
  const text = String(value ?? '').trim().replace(/^#/, '');
  const full = text.length === 3 ? text.split('').map(c => c + c).join('') : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
}
export const isHex = value => parseHex(value) !== null;
export function toHex([r, g, b]) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function normalHex(value, fallback = null) {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : fallback;
}
/** WCAG 2.2 relative luminance. */
export function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
export function mix(a, b, amount) {
  const x = parseHex(a) ?? [0, 0, 0], y = parseHex(b) ?? [0, 0, 0];
  return toHex(x.map((v, i) => v + (y[i] - v) * amount));
}
export const isDark = hex => luminance(hex) < 0.2;
/** The colour of the two that reads best on the fill, the first when both pass AA. */
export function readableOn(fill, ...candidates) {
  const list = candidates.filter(isHex);
  for (const c of list) if (contrast(c, fill) >= 4.5) return normalHex(c);
  const black = '#111111', white = '#FFFFFF';
  return contrast(black, fill) >= contrast(white, fill) ? black : white;
}
/** A colour that holds at least `ratio` against the fill: the colour itself, else a mix towards ink. */
export function holdContrast(color, fill, ratio = 3) {
  if (contrast(color, fill) >= ratio) return normalHex(color);
  const towards = isDark(fill) ? '#FFFFFF' : '#000000';
  for (let step = 0.1; step <= 1; step += 0.1) {
    const next = mix(color, towards, step);
    if (contrast(next, fill) >= ratio) return next;
  }
  return towards === '#FFFFFF' ? '#FFFFFF' : '#000000';
}

/** Font stacks: the first name is what PowerPoint is told; the rest is the browser's fallback. */
const STACKS = {
  sans: "'Segoe UI', 'Helvetica Neue', Arial, system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "Consolas, 'Cascadia Mono', 'SFMono-Regular', Menlo, monospace",
};
const SERIF = /georgia|times|garamond|serif|cambria|playfair|merriweather|lora|baskerville|caslon|didot|bodoni|fraunces|tiempos|spectral|crimson|source serif|libre/i;
const MONO = /mono|consol|courier|code|menlo/i;
export function fontStack(name) {
  const clean = String(name ?? '').replace(/["']/g, '').trim();
  if (!clean) return STACKS.sans;
  const tail = MONO.test(clean) ? STACKS.mono : SERIF.test(clean) && !/sans/i.test(clean) ? STACKS.serif : STACKS.sans;
  return `'${clean}', ${tail}`;
}
/** Fonts every Windows machine with Office has; anything else may be fetched from Google Fonts. */
export const LOCAL_FONTS = new Set(['segoe ui', 'segoe ui light', 'segoe ui semibold', 'segoe ui black', 'arial', 'arial black', 'georgia', 'calibri', 'cambria',
  'consolas', 'bahnschrift', 'trebuchet ms', 'verdana', 'tahoma', 'times new roman', 'aptos', 'aptos display', 'franklin gothic medium', 'candara', 'corbel',
  'constantia', 'sitka', 'gill sans mt', 'century gothic', 'palatino linotype', 'book antiqua', 'helvetica', 'helvetica neue', 'courier new', 'impact', 'system-ui']);
export function webFonts(theme) {
  const names = [...new Set([theme.fonts.heading, theme.fonts.body, theme.fonts.mono])].filter(n => n && !LOCAL_FONTS.has(n.toLowerCase()));
  if (!names.length) return null;
  return 'https://fonts.googleapis.com/css2?' + names.map(n => `family=${encodeURIComponent(n).replace(/%20/g, '+')}:ital,wght@0,300;0,400;0,600;0,700;1,400`).join('&') + '&display=swap';
}

/**
 * The built-in templates. `family` picks the decorations in layout.mjs; `mode` says whether the
 * content slides are dark, which decides how a brand kit's roles are laid on them.
 */
export const TEMPLATES = [
  { id: 'keynote', name: 'Keynote', mode: 'dark', description: 'Dark stage, one bright accent, big type. For talks and launches.',
    fonts: { heading: 'Segoe UI', body: 'Segoe UI', mono: 'Consolas' },
    colors: { bg: '#0E1116', surface: '#1A1F29', ink: '#F4F6FA', muted: '#9AA3B2', primary: '#4C8DFF', secondary: '#2A3242', accent: '#FFB547' },
    style: { titleWeight: 700, titleTracking: -0.02, radius: 14, kicker: 'caps', bullet: '•', titleCase: 'none' } },
  { id: 'editorial', name: 'Editorial', mode: 'light', description: 'Warm paper, serif headlines and rules, like a long read.',
    fonts: { heading: 'Georgia', body: 'Segoe UI', mono: 'Consolas' },
    colors: { bg: '#F6F1E7', surface: '#EDE5D5', ink: '#1E1B16', muted: '#6B6255', primary: '#B4532A', secondary: '#2F4A3A', accent: '#C9962B' },
    style: { titleWeight: 400, titleTracking: -0.01, radius: 2, kicker: 'italic', bullet: '—', titleCase: 'none' } },
  { id: 'swiss', name: 'Swiss', mode: 'light', description: 'White grid, heavy grotesque type and one red. Clear and direct.',
    fonts: { heading: 'Arial', body: 'Arial', mono: 'Consolas' },
    colors: { bg: '#FFFFFF', surface: '#F2F2F2', ink: '#111111', muted: '#666666', primary: '#E2231A', secondary: '#111111', accent: '#E2231A' },
    style: { titleWeight: 700, titleTracking: -0.03, radius: 0, kicker: 'caps', bullet: '■', titleCase: 'none' } },
  { id: 'boardroom', name: 'Boardroom', mode: 'light', description: 'Navy and white with a quiet band. For reviews and board papers.',
    fonts: { heading: 'Segoe UI Semibold', body: 'Segoe UI', mono: 'Consolas' },
    colors: { bg: '#FFFFFF', surface: '#F1F4F8', ink: '#16263A', muted: '#5D6B7E', primary: '#1F3A5F', secondary: '#3E7CB1', accent: '#00A6A6' },
    style: { titleWeight: 600, titleTracking: -0.01, radius: 6, kicker: 'caps', bullet: '•', titleCase: 'none' } },
  { id: 'studio', name: 'Studio', mode: 'light', description: 'Soft gradients and rounded cards. For product and design stories.',
    fonts: { heading: 'Bahnschrift', body: 'Segoe UI', mono: 'Consolas' },
    colors: { bg: '#FBF9FF', surface: '#FFFFFF', ink: '#1C1640', muted: '#6E6890', primary: '#6D4AFF', secondary: '#FF5C8A', accent: '#18C6A6' },
    style: { titleWeight: 600, titleTracking: -0.015, radius: 22, kicker: 'pill', bullet: '•', titleCase: 'none' } },
  { id: 'minimal', name: 'Minimal', mode: 'light', description: 'Hairlines, light type and room to breathe. Lets the words work.',
    fonts: { heading: 'Segoe UI Light', body: 'Segoe UI', mono: 'Consolas' },
    colors: { bg: '#FAFAF7', surface: '#F0F0EB', ink: '#141414', muted: '#77776F', primary: '#141414', secondary: '#2B6F6A', accent: '#2B6F6A' },
    style: { titleWeight: 300, titleTracking: -0.01, radius: 0, kicker: 'mono', bullet: '–', titleCase: 'none' } },
];
export const FAMILIES = TEMPLATES.map(t => t.id);
export const templateById = id => TEMPLATES.find(t => t.id === id) ?? null;

/** The roles a brand kit carries, in the order the Design tab lists them. */
export const BRAND_ROLES = ['primary', 'secondary', 'accent', 'background', 'surface', 'ink', 'muted'];

/** Where a brand's logo sits on content slides; Title and Closing slides place it themselves. */
export const LOGO_PLACEMENTS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'none'];

/**
 * Resolves the theme a deck draws with.
 * template: a built-in template, or a Template record's fields as {family, name, mode, fonts, colors,
 *   style, backgrounds, chart, logoPlacement}; design.mjs says what a background is.
 * brand: null, or {name, colors: {role: hex}, fonts: {heading, body, mono}, logo, logoDark, mark}.
 */
/**
 * The theme's colours read on another ground: a design's own background for one kind of slide. Every
 * role worked out against the stage is worked out again against `bg`, with `ink` the text colour
 * already chosen for it.
 */
export function colorsOn(colors, bg, ink = readableOn(bg, colors.ink, colors.bg)) {
  if (bg === colors.bg) return colors;
  const dark = isDark(bg);
  const surface = dark === isDark(colors.bg) ? colors.surface : mix(bg, ink, 0.08);
  return {
    ...colors, bg, ink, surface,
    muted: holdContrast(colors.muted, bg, 4.5),
    accentText: holdContrast(colors.accent, bg, 3),
    primaryText: holdContrast(colors.primary, bg, 3),
    line: mix(bg, ink, dark ? 0.22 : 0.16),
    onSurface: readableOn(surface, ink),
  };
}

export function resolveTheme(template, brand = null, deck = {}) {
  const base = templateById(template?.family ?? template?.id) ?? TEMPLATES[0];
  const own = template ?? {};
  const colors = { ...base.colors, ...clean(own.colors) };
  const fonts = { ...base.fonts, ...clean(own.fonts) };
  const mode = own.mode ?? base.mode;
  if (brand) {
    const b = clean(brand.colors ?? {});
    const background = b.background ?? (mode === 'dark' ? null : colors.bg);
    const ink = b.ink ?? null;
    if (mode === 'dark' && background && isDark(background)) {
      // A dark brand on a dark template: its own background is the stage.
      colors.bg = background;
      colors.surface = b.surface ?? mix(colors.bg, '#FFFFFF', 0.08);
      if (ink) colors.ink = ink;
    } else if (mode === 'dark') {
      // A dark template keeps its stage dark: the brand's ink (or its primary, darkened) is the stage.
      colors.bg = ink && isDark(ink) ? ink : mix(b.primary ?? colors.bg, '#000000', 0.82);
      colors.surface = mix(colors.bg, '#FFFFFF', 0.08);
      colors.ink = background && !isDark(background) ? background : '#F4F6FA';
    } else if (background && isDark(background)) {
      // A light template keeps its stage light: the brand's ink (or its primary, lightened) is the stage.
      colors.bg = ink && !isDark(ink) ? ink : mix(b.primary ?? colors.primary, '#FFFFFF', 0.94);
      colors.surface = mix(colors.bg, b.primary ?? colors.primary, 0.06);
      colors.ink = background;
    } else {
      colors.bg = background ?? colors.bg;
      colors.surface = b.surface ?? mix(colors.bg, b.primary ?? colors.primary, 0.06);
      if (ink) colors.ink = ink;
    }
    for (const role of ['primary', 'secondary', 'accent']) if (b[role]) colors[role] = b[role];
    if (b.muted) colors.muted = b.muted;
    const f = clean(brand.fonts ?? {});
    Object.assign(fonts, f);
  }
  // Every role is read on the slide's background; keep each legible there.
  colors.ink = readableOn(colors.bg, colors.ink);
  colors.muted = holdContrast(colors.muted, colors.bg, 4.5);
  colors.onPrimary = readableOn(colors.primary, '#FFFFFF', colors.bg, colors.ink);
  colors.onSecondary = readableOn(colors.secondary, '#FFFFFF', colors.bg, colors.ink);
  colors.accentText = holdContrast(colors.accent, colors.bg, 3);
  colors.primaryText = holdContrast(colors.primary, colors.bg, 3);
  colors.line = mix(colors.bg, colors.ink, isDark(colors.bg) ? 0.22 : 0.16);
  colors.onSurface = readableOn(colors.surface, colors.ink);
  return {
    id: own.id ?? base.id, name: own.name ?? base.name, family: base.id, mode,
    fonts, colors, style: { ...base.style, ...clean(own.style) },
    backgrounds: resolveBackgrounds(own.backgrounds, colors),
    chart: (own.chart ?? []).map(c => normalHex(c)).filter(Boolean).slice(0, 8),
    logoPlacement: LOGO_PLACEMENTS.includes(own.logoPlacement) ? own.logoPlacement : 'top-right',
    brand: brand ? { name: brand.name ?? '', logo: brand.logo ?? null, logoDark: brand.logoDark ?? null, mark: brand.mark ?? null } : null,
    footer: String(deck.footer ?? '').trim(), slideNumbers: deck.slideNumbers !== false,
    aspect: deck.aspect === '4:3' ? '4:3' : '16:9',
  };
}
/** A colour a background names: a role of the resolved theme, or a hex. */
function roleColour(value, colors) {
  if (value === 'background') return colors.bg;
  if (['primary', 'secondary', 'accent', 'surface', 'ink', 'muted'].includes(value)) return colors[value];
  return normalHex(value);
}
/**
 * A design's backgrounds, per slide kind, as {fill, image, dark}: a fill is a colour or a linear
 * gradient; a picture is drawn under its tint. A kind the design leaves out keeps the family's own.
 */
function resolveBackgrounds(backgrounds, colors) {
  const out = {};
  for (const [slot, b] of Object.entries(backgrounds ?? {})) {
    if (!b || typeof b !== 'object') continue;
    if (b.kind === 'role') {
      const fill = roleColour(b.role, colors);
      if (fill) out[slot] = { fill, dark: isDark(fill) };
    } else if (b.kind === 'gradient') {
      const stops = (b.stops ?? []).map(s => roleColour(s, colors)).filter(Boolean);
      if (stops.length >= 2) out[slot] = { fill: { type: 'linear', angle: Number(b.angle) || 135, stops: stops.map((color, i) => ({ at: i / (stops.length - 1), color })) },
        dark: isDark(mix(stops[0], stops.at(-1), 0.5)) };
    } else if (b.kind === 'image' && b.src) {
      const tint = roleColour(b.tint, colors) ?? '#000000';
      const tintAlpha = Number.isFinite(Number(b.tintAlpha)) ? Math.min(1, Math.max(0, Number(b.tintAlpha))) : 0.35;
      out[slot] = { fill: tint, image: b.src, tintAlpha, dark: typeof b.dark === 'boolean' ? b.dark : isDark(tint) };
    }
  }
  return out;
}
function clean(map) {
  const out = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'string' && /^#?[0-9a-f]{3,6}$/i.test(v.trim()) ? normalHex(v) ?? v : v;
  }
  return out;
}

/** The slide size in CSS pixels. Both sizes are 720 high, so type sizes mean the same on each. */
export const sizeOf = aspect => aspect === '4:3' ? { W: 960, H: 720 } : { W: 1280, H: 720 };
