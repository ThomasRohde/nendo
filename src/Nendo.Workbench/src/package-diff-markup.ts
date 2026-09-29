import { escapeHtml } from './format';
import type { ExtensionFileChange } from './host-types';
import { icon } from './icons';

/**
 * A proposal's changes to custom-view code, as lines (ADR-0013). Code in the file is
 * reviewed like code: each file with the lines it adds and removes and three lines of
 * context, so accepting it is reading it rather than trusting a sentence about it. A
 * binary file is said by its sizes; a change longer than the review shows says so.
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
  const body = !change.textual
    ? '<p class="package-change-note">Not text, so it is shown by its size.</p>'
    : change.hunks.map((hunk) => `<pre class="package-hunk" aria-label="Lines ${hunk.oldStart} to ${hunk.oldStart + Math.max(hunk.oldLines - 1, 0)} before, ${hunk.newStart} to ${hunk.newStart + Math.max(hunk.newLines - 1, 0)} after">${hunk.lines.map((line) =>
      `<span class="diff-line diff-${line.kind}"><span class="diff-mark" aria-hidden="true">${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>${escapeHtml(line.text)}</span>`).join('')}</pre>`).join('')
      + (change.truncated ? '<p class="package-change-note">The change continues past what the review shows.</p>' : '');
  const lines = change.textual ? lineCounts(change) : '';
  return `<details class="package-change" data-package-path="${escapeHtml(change.path)}"><summary><span class="package-change-chevron" aria-hidden="true">${icon('chevron')}</span><strong>${escapeHtml(change.path)}</strong><span>${escapeHtml(verb)} in ${escapeHtml(change.packageId)} · ${escapeHtml(sizes)}${lines}</span></summary><div class="package-change-body">${body}</div></details>`;
}

/** How many lines a text file's shown change adds and removes, for the folded summary. */
function lineCounts(change: ExtensionFileChange): string {
  const all = change.hunks.flatMap((hunk) => hunk.lines);
  const added = all.filter((line) => line.kind === 'added').length;
  const removed = all.filter((line) => line.kind === 'removed').length;
  return ` · +${added} −${removed} ${added + removed === 1 ? 'line' : 'lines'}${change.truncated ? ' shown' : ''}`;
}

/** A byte count as a person reads it; Studio's package list says sizes the same way. */
export function byteSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2).replace(/\.?0+$/, '')} MB`;
}
