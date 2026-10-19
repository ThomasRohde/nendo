import { escapeAttribute, escapeHtml } from './format';
import type { ResolvedLook } from './host';

/**
 * A file's look (W-089): the tone and letter of the badge its icon carries on the window, the
 * taskbar, the notification area and notifications. Every file has one by default; the About
 * page is where a person gives it one of its own, through a proposal they review like any
 * other change to the file. A file may also carry its own picture (W-001), drawn instead of the
 * badge: the person drops one on the icon, and the page draws it into a square PNG first.
 */

/** The tones a file may choose, in the order the page offers them: the choice tones. */
export const lookTones = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'grey'] as const;

const toneNames: Record<string, string> = {
  red: 'Red', orange: 'Orange', amber: 'Amber', green: 'Green', teal: 'Teal', blue: 'Blue', violet: 'Violet', grey: 'Grey',
};

/**
 * The mark with the file's badge, as the icon draws it, or the file's own picture when it has
 * one. Decorative: the words beside it say the same.
 */
export function lookIconMarkup(tone: string, letter: string, pictureUrl: string | null = null): string {
  if (pictureUrl !== null) return `<span class="look-icon look-picture" aria-hidden="true"><img src="${escapeAttribute(pictureUrl)}" alt="" /></span>`;
  return `<span class="look-icon" aria-hidden="true"><img src="/nendo-mark.png" alt="" /><span class="look-badge" data-tone="${escapeAttribute(tone)}">${escapeHtml(letter)}</span></span>`;
}

/** Where the page shows a file's own picture: its media: address on the file's media origin. */
export function iconPictureUrl(icon: string | null | undefined, mediaOrigin: string | null | undefined): string | null {
  if (!icon || !mediaOrigin || !/^media:[0-9a-f]{64}$/.test(icon)) return null;
  return `${mediaOrigin}/m/${icon.slice('media:'.length)}`;
}

/** One sentence for the look, which is how a screen reader meets the picture beside it. */
export function lookSentence(tone: string, letter: string, chosen: boolean, picture = false): string {
  if (picture) return 'Its own picture.';
  return `${toneNames[tone] ?? tone} with the letter ${letter}${chosen ? '' : ', by default'}.`;
}

/**
 * The look section of the About page: the icon as it is drawn, and when the file can be
 * changed, a tone and a letter to choose and a proposal to review. Nothing is written here;
 * reviewing the proposal is the only way a look reaches the file.
 */
export function aboutLookMarkup(look: ResolvedLook, canChange: boolean, mediaOrigin: string | null = null): string {
  const chosen = look.toneChosen || look.letterChosen;
  const picture = iconPictureUrl(look.icon, mediaOrigin);
  const summary = `<div class="look-summary"${canChange ? ' data-look-drop' : ''}>${lookIconMarkup(look.tone, look.letter, picture)}<p><strong>Icon</strong><span data-look-sentence>${escapeHtml(lookSentence(look.tone, look.letter, chosen, picture !== null))}</span><small>On the taskbar, in Alt+Tab, in the notification area and on notifications, so this file is told apart from others open beside it.${canChange ? ' Drop a picture here to use it instead.' : ''}</small></p></div>`;
  if (!canChange) return `<section class="about-file-look" aria-label="Icon">${summary}</section>`;
  const swatches = lookTones.map((tone) => `<label class="look-swatch"><input type="radio" name="look-tone" value="${tone}" ${tone === look.tone ? 'checked' : ''} /><span data-tone="${tone}" aria-hidden="true"></span><span class="visually-hidden">${toneNames[tone]}</span></label>`).join('');
  return `<section class="about-file-look" aria-label="Icon">${summary}
    <div class="look-picture-actions"><button type="button" class="secondary-button" data-look-pick>Choose picture…</button><button type="button" class="secondary-button" data-look-clear-picture ${picture === null ? 'disabled' : ''}>Use colour and letter</button><input type="file" accept="${iconPictureAccept}" data-look-file hidden /></div>
    <fieldset class="look-tones"><legend>Colour</legend><div class="look-swatches">${swatches}</div></fieldset>
    <label class="look-letter"><span>Letter</span><input type="text" name="look-letter" maxlength="2" value="${escapeAttribute(look.letter)}" autocomplete="off" spellcheck="false" aria-describedby="look-letter-note" /><small id="look-letter-note">One letter or digit.</small></label>
    <div class="look-actions"><button type="button" class="secondary-button" data-look-defaults ${chosen ? '' : 'disabled'}>Use defaults</button><button type="button" class="secondary-button" data-look-review disabled>Review change</button></div>
  </section>`;
}

/** The pictures About this file takes for an icon: whatever the page can draw. */
export const iconPictureAccept = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico,.svg';

/** The sides the page tries, largest first, until the PNG fits in one message to the host. */
export const iconPictureSides = [256, 192, 128] as const;

/** The most base64 one icon may take: inside the host's 262,144-character message, with room for the rest of it. */
export const iconPictureMaxBase64 = 240_000;

/**
 * Where a picture of this size sits on a square of this side: scaled down to fit, never up past
 * the square, kept in proportion and centred, so nothing of it is cropped.
 */
export function containRect(width: number, height: number, side: number): { x: number; y: number; width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error('That picture has no size.');
  const scale = side / Math.max(width, height);
  const drawnWidth = Math.max(1, Math.round(width * scale));
  const drawnHeight = Math.max(1, Math.round(height * scale));
  return { x: Math.floor((side - drawnWidth) / 2), y: Math.floor((side - drawnHeight) / 2), width: drawnWidth, height: drawnHeight };
}

/** One letter or digit, upper case where the script has one, or null for anything else. */
export function normaliseLetter(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length !== 1) return null;
  const upper = trimmed.toUpperCase();
  return upper.length === 1 && /^[\p{L}\p{N}]$/u.test(upper) ? upper : null;
}

/**
 * What the file would choose, given what the page shows: a part left as the file already has
 * it stays as it is, chosen or not, so opening the page and saving changes nothing.
 */
export function chosenLook(current: ResolvedLook, tone: string, letter: string): { tone: string | null; letter: string | null } {
  return {
    tone: tone === current.tone ? (current.toneChosen ? tone : null) : tone,
    letter: letter === current.letter ? (current.letterChosen ? letter : null) : letter,
  };
}

/**
 * The change set that gives the file this look: nulls return a part to its default, and an icon
 * of null takes the file's picture away; an icon left undefined is not changed. Null when it
 * would change nothing, which is when the page offers nothing to review.
 */
export function lookProposal(current: ResolvedLook, next: { tone: string | null; letter: string | null; icon?: string | null }, expectedDefinitionRevision: number): Record<string, unknown> | null {
  const before = { tone: current.toneChosen ? current.tone : null, letter: current.letterChosen ? current.letter : null };
  const lookChanges = before.tone !== next.tone || before.letter !== next.letter;
  const iconChanges = next.icon !== undefined && next.icon !== (current.icon ?? null);
  if (!lookChanges && !iconChanges) return null;
  if (next.tone !== null && !(lookTones as readonly string[]).includes(next.tone)) throw new Error('Choose one of the offered colours.');
  if (next.letter !== null && normaliseLetter(next.letter) !== next.letter) throw new Error('Enter one letter or digit.');
  if (iconChanges && next.icon !== null && !/^media:[0-9a-f]{64}$/.test(next.icon ?? '')) throw new Error('Drop a picture to use as the icon.');
  const title = iconChanges && !lookChanges
    ? (next.icon === null ? 'Take this file’s picture away' : 'Give this file its own picture')
    : next.tone === null && next.letter === null && !(iconChanges && next.icon !== null) ? 'Give this file back its default icon' : 'Give this file its own icon';
  const id = crypto.randomUUID().replaceAll('-', '');
  // One mutation each, so each revision can be undone on its own: an undo covers one operation
  // of the file's own, and the colour and the picture are separate choices.
  const mutations: Record<string, unknown>[] = [];
  if (lookChanges) mutations.push({ idempotencyKey: `look-${id}`, description: title,
    operations: [{ operationId: `look-${id}`, operationType: 'application.setLook',
      payload: { tone: next.tone, letter: next.letter, expectedDefinitionRevision } }] });
  if (iconChanges) mutations.push({ idempotencyKey: `icon-${id}`, description: title,
    operations: [{ operationId: `icon-${id}`, operationType: 'application.setIcon',
      payload: { icon: next.icon, expectedDefinitionRevision: lookChanges ? expectedDefinitionRevision + 1 : expectedDefinitionRevision } }] });
  return { proposalId: `proposal-${id}`, title, mutations };
}

/**
 * Whether Review change can be pressed: something differs, and the letter box holds a letter. A
 * refused letter followed by a colour enabled it again with the last good letter, while the box
 * still showed the refused text (WSP-25).
 */
export function lookReviewable(current: ResolvedLook, next: { tone: string | null; letter: string | null; icon?: string | null }, typedLetter: string): boolean {
  return normaliseLetter(typedLetter) !== null && lookProposal(current, next, 0) !== null;
}
