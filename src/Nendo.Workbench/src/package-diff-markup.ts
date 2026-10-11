import { escapeHtml } from './format';
import type { ExtensionFileChange } from './host-types';
import { icon } from './icons';

/**
 * A proposal's changes to custom-view code, as lines (ADR-0013). Code in the file is
 * reviewed like code: each file with the lines it adds and removes and three lines of
 * context, so accepting it is reading it rather than trusting a sentence about it. A
 * binary file is said by its sizes; a change longer than the review shows says so, in its
 * folded summary too, and every file the proposal adds or replaces can be read whole before
 * accepting it (review R-017, `package-file-reader.ts`).
 *
 * Each file is a disclosure that starts folded (W-098): a proposal can change many
 * files, and every file's lines open at once buried the rest of the review. Folded, a
 * file still says its name, what happened to it, its sizes and how many lines it adds
 * and removes, so the list reads as an overview and a file opens where it matters.
 */
export function packageChangesMarkup(changes: readonly ExtensionFileChange[] | undefined): string {
  if (changes === undefined || changes.length === 0) return '';
  return `<section class="package-changes" data-testid="package-changes"><h3>Code</h3>${changes.map(fileMarkup).join('')}</section>`;
}

function fileMarkup(change: ExtensionFileChange): string {
  const sizes = change.change === 'added'
    ? byteSize(change.bytesAfter)
    : change.change === 'removed'
      ? byteSize(change.bytesBefore)
      : `${byteSize(change.bytesBefore)} → ${byteSize(change.bytesAfter)}`;
  const verb = change.change === 'added' ? 'Added' : change.change === 'removed' ? 'Removed' : 'Changed';
  // A hunk's first line is the file's first when it starts at line 1, where a byte-order mark is
  // only encoding. The flag and the note read what the proposal leaves, not lines it removes.
  const startsFile = (hunk: ExtensionFileChange['hunks'][number], index: number) => index === 0 && (hunk.newStart === 1 || hunk.oldStart === 1);
  const hidden = change.textual && change.hunks.some((hunk) => hunk.lines.some((line, index) =>
    line.kind !== 'removed' && hasHiddenCharacters(line.text, startsFile(hunk, index))));
  const body = !change.textual
    ? '<p class="package-change-note">Not shown as lines: it is not text, or it is longer than the review lays out line by line.</p>'
    : (hidden ? hiddenCharactersNote : '') + change.hunks.map((hunk) => `<pre class="package-hunk" aria-label="Lines ${hunk.oldStart} to ${hunk.oldStart + Math.max(hunk.oldLines - 1, 0)} before, ${hunk.newStart} to ${hunk.newStart + Math.max(hunk.newLines - 1, 0)} after">${hunk.lines.map((line, index) =>
      `<span class="diff-line diff-${line.kind}"><span class="diff-mark" aria-hidden="true">${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>${showHiddenCharacters(line.text, startsFile(hunk, index))}</span>`).join('')}</pre>`).join('')
      + (change.truncated ? '<p class="package-change-note">The change continues past what the review shows.</p>' : '');
  const reader = change.change === 'removed' ? ''
    : `<p class="package-read"><button class="text-button" type="button" data-package-read="${escapeHtml(change.path)}" data-package-id="${escapeHtml(change.packageId)}">Read the whole file</button><span data-package-read-note role="status"></span></p>`;
  const lines = change.textual ? lineCounts(change) : '';
  const flag = hidden ? ' · <strong class="hidden-char-flag">hidden characters</strong>' : '';
  return `<details class="package-change" data-package-path="${escapeHtml(change.path)}"><summary><span class="package-change-chevron" aria-hidden="true">${icon('chevron')}</span><strong>${escapeHtml(change.path)}</strong><span>${escapeHtml(verb)} in ${escapeHtml(change.packageId)} · ${escapeHtml(sizes)}${lines}${flag}</span></summary><div class="package-change-body">${body}${reader}</div></details>`;
}

/** How many lines a text file's shown change adds and removes, for the folded summary. */
function lineCounts(change: ExtensionFileChange): string {
  const all = change.hunks.flatMap((hunk) => hunk.lines);
  const added = all.filter((line) => line.kind === 'added').length;
  const removed = all.filter((line) => line.kind === 'removed').length;
  return ` · +${added} −${removed} ${added + removed === 1 ? 'line' : 'lines'}${change.truncated ? ' shown · longer than the review shows' : ''}`;
}

/** A byte count as a person reads it; Studio's package list says sizes the same way. */
export function byteSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2).replace(/\.?0+$/, '')} MB`;
}

/**
 * Characters the review would not otherwise show as they are. Direction controls and invisible
 * format characters (Unicode's Cf, the tag characters among them) reorder or hide code, so a line
 * could read as a closed string and a comment while it runs as one string literal (Trojan Source;
 * WMX-01). The Hangul fillers draw as blank space yet are valid in a name. A soft hyphen is left
 * alone, and so is a byte-order mark at the very start of a file. Paths cannot carry any of them:
 * a package path is ASCII.
 */
const hiddenCharacters = /[\p{Bidi_Control}\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;

function shownHidden(match: RegExpMatchArray, startsFile: boolean): boolean {
  return match[0] !== '\u00AD' && !(startsFile && match.index === 0 && match[0] === '\uFEFF');
}

/** Whether the text holds a character the review draws as its code point. */
export function hasHiddenCharacters(text: string, startsFile = false): boolean {
  for (const match of text.matchAll(hiddenCharacters)) if (shownHidden(match, startsFile)) return true;
  return false;
}

/** The text escaped for markup, each hidden character drawn as its code point instead. */
export function showHiddenCharacters(text: string, startsFile = false): string {
  let shown = '';
  let from = 0;
  for (const match of text.matchAll(hiddenCharacters)) {
    if (!shownHidden(match, startsFile)) continue;
    const code = `U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
    shown += escapeHtml(text.slice(from, match.index)) + `<span class="hidden-char" title="${code}">[${code}]</span>`;
    from = match.index! + match[0].length;
  }
  return shown + escapeHtml(text.slice(from));
}

/** Said above a change whose lines, as the proposal leaves them, hold any. */
export const hiddenCharactersNote = '<p class="package-change-note hidden-char-note" role="note">The lines this change leaves hold invisible or direction-changing characters, shown as [U+…]. Code that holds them can read differently from how it runs.</p>';

/** Said above a whole proposed file that holds any. */
export const hiddenCharactersFileNote = '<p class="package-change-note hidden-char-note" role="note">This file holds invisible or direction-changing characters, shown as [U+…]. Code that holds them can read differently from how it runs.</p>';
