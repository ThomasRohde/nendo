/**
 * Choice tones, ADR-0004 2026-09-14 amendment. An option's colour is a closed named
 * hue stored in the file; the colours behind each name live in the theme tokens
 * (`--tone-<name>`), so Light and Dark own their own values and a file never carries
 * a hex value. Where an option has no tone the renderer keeps its previous habit: a
 * hue derived from the stored ID, stable per value and shared by every surface.
 */
export const CHOICE_TONES = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'grey'] as const;
export type ChoiceTone = (typeof CHOICE_TONES)[number];

export interface TonedChoice { id: string; displayName: string; retired: boolean; tone?: string | null }
export interface TonedField { choices?: TonedChoice[] }

export function isChoiceTone(value: unknown): value is ChoiceTone {
  return typeof value === 'string' && (CHOICE_TONES as readonly string[]).includes(value);
}

/** The tone of one option, or null when it has none or the value is not an option. */
export function toneOf(field: TonedField | undefined, value: unknown): ChoiceTone | null {
  if (typeof value !== 'string') return null;
  const tone = field?.choices?.find((choice) => choice.id === value)?.tone;
  return isChoiceTone(tone) ? tone : null;
}

/** How much of a derived hue a chip's text keeps, the rest being the theme's ink, per theme. */
export const derivedChipShare = { light: 48, dark: 48 } as const;

/** A hue derived from the stored value, for an option that has no tone. */
export function derivedHue(value: string): number {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * The inline style that sets `--status-color` for a choice value: its tone's token,
 * else the derived hue. An unset value sets nothing, so the muted default shows.
 */
export function choiceStyle(field: TonedField | undefined, value: unknown): string {
  const tone = toneOf(field, value);
  if (tone !== null) return `--status-color: var(--tone-${tone})`;
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // A derived hue can be any colour, a pale yellow among them, so its chip text leans further to
  // the ink than a named tone's to reach 4.5:1 in both themes (UIS-06).
  return text === '' ? '' : `--status-color: hsl(${derivedHue(text)} 58% 49%); --chip-share: ${derivedChipShare.light}%; --chip-share-dark: ${derivedChipShare.dark}%`;
}

/** The label a picker shows for a tone, or for none. */
export function toneLabel(tone: ChoiceTone | null): string {
  return tone === null ? 'No colour' : tone[0].toUpperCase() + tone.slice(1);
}
