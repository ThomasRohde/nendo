import { escapeAttribute, escapeHtml } from './format';
import type { ResolvedLook } from './host';

/**
 * A file's look (W-089): the tone and letter of the badge its icon carries on the window, the
 * taskbar, the notification area and notifications. Every file has one by default; the About
 * page is where a person gives it one of its own, through a proposal they review like any
 * other change to the file.
 */

/** The tones a file may choose, in the order the page offers them: the choice tones. */
export const lookTones = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'grey'] as const;

const toneNames: Record<string, string> = {
  red: 'Red', orange: 'Orange', amber: 'Amber', green: 'Green', teal: 'Teal', blue: 'Blue', violet: 'Violet', grey: 'Grey',
};

/** The mark with the file's badge, as the icon draws it. Decorative: the words beside it say the same. */
export function lookIconMarkup(tone: string, letter: string): string {
  return `<span class="look-icon" aria-hidden="true"><img src="/nendo-mark.png" alt="" /><span class="look-badge" data-tone="${escapeAttribute(tone)}">${escapeHtml(letter)}</span></span>`;
}

/** One sentence for the look, which is how a screen reader meets the picture beside it. */
export function lookSentence(tone: string, letter: string, chosen: boolean): string {
  return `${toneNames[tone] ?? tone} with the letter ${letter}${chosen ? '' : ', by default'}.`;
}

/**
 * The look section of the About page: the icon as it is drawn, and when the file can be
 * changed, a tone and a letter to choose and a proposal to review. Nothing is written here;
 * reviewing the proposal is the only way a look reaches the file.
 */
export function aboutLookMarkup(look: ResolvedLook, canChange: boolean): string {
  const chosen = look.toneChosen || look.letterChosen;
  const summary = `<div class="look-summary">${lookIconMarkup(look.tone, look.letter)}<p><strong>Icon</strong><span data-look-sentence>${escapeHtml(lookSentence(look.tone, look.letter, chosen))}</span><small>On the taskbar, in Alt+Tab, in the notification area and on notifications, so this file is told apart from others open beside it.</small></p></div>`;
  if (!canChange) return `<section class="about-file-look" aria-label="Icon">${summary}</section>`;
  const swatches = lookTones.map((tone) => `<label class="look-swatch"><input type="radio" name="look-tone" value="${tone}" ${tone === look.tone ? 'checked' : ''} /><span data-tone="${tone}" aria-hidden="true"></span><span class="visually-hidden">${toneNames[tone]}</span></label>`).join('');
  return `<section class="about-file-look" aria-label="Icon">${summary}
    <fieldset class="look-tones"><legend>Colour</legend><div class="look-swatches">${swatches}</div></fieldset>
    <label class="look-letter"><span>Letter</span><input type="text" name="look-letter" maxlength="2" value="${escapeAttribute(look.letter)}" autocomplete="off" spellcheck="false" aria-describedby="look-letter-note" /><small id="look-letter-note">One letter or digit.</small></label>
    <div class="look-actions"><button type="button" class="secondary-button" data-look-defaults ${chosen ? '' : 'disabled'}>Use defaults</button><button type="button" class="secondary-button" data-look-review disabled>Review change</button></div>
  </section>`;
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
 * The change set that gives the file this look: nulls return a part to its default. Null when
 * it would change nothing, which is when the page offers nothing to review.
 */
export function lookProposal(current: ResolvedLook, next: { tone: string | null; letter: string | null }, expectedDefinitionRevision: number): Record<string, unknown> | null {
  const before = { tone: current.toneChosen ? current.tone : null, letter: current.letterChosen ? current.letter : null };
  if (before.tone === next.tone && before.letter === next.letter) return null;
  if (next.tone !== null && !(lookTones as readonly string[]).includes(next.tone)) throw new Error('Choose one of the offered colours.');
  if (next.letter !== null && normaliseLetter(next.letter) !== next.letter) throw new Error('Enter one letter or digit.');
  const title = next.tone === null && next.letter === null ? 'Give this file back its default icon' : 'Give this file its own icon';
  const id = crypto.randomUUID().replaceAll('-', '');
  return { proposalId: `proposal-${id}`, title, mutations: [{ idempotencyKey: `look-${id}`, description: title,
    operations: [{ operationId: `look-${id}`, operationType: 'application.setLook',
      payload: { tone: next.tone, letter: next.letter, expectedDefinitionRevision } }],
  }] };
}
