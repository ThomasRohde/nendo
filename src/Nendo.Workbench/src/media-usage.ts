import { icon } from './icons';

/**
 * The pictures a file embeds, on History (ADR-0031 point 8, W-273): how many, what they weigh
 * against the file's budget, and how much of that nothing names any more. A picture stays while a
 * record, a deleted record or a change History keeps names it, so History is where it is let go.
 */

/** What the host answers for `media.usage`. */
export interface MediaUsage {
  count: number;
  bytes: number;
  unusedCount: number;
  unusedBytes: number;
  budgetBytes: number;
}

/** What the host answers for `media.removeUnused`. */
export interface MediaRemovalResult {
  removed: number;
  removedBytes: number;
  fileBytesBefore: number;
  fileBytesAfter: number;
  backupLabel: string;
  spaceReclaimed: boolean;
}

/** The usage History last read, and for which state of which file; cleared by a fold or a removal. */
export const mediaUsageState: { usage: MediaUsage | null; key: string | null } = { usage: null, key: null };

/** A size as a person reads it: bytes, KB, MB or GB, in steps of 1,024. */
export function byteSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit === 0 ? `${bytes.toLocaleString()} bytes` : `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

const pictures = (count: number): string => count === 1 ? '1 picture' : `${count.toLocaleString()} pictures`;

/** The section, or nothing for a file that embeds no picture. */
export function mediaUsageMarkup(usage: MediaUsage | null, canRemove: boolean): string {
  if (usage === null || usage.count === 0) return '';
  const near = usage.bytes / usage.budgetBytes >= 0.8;
  return `<section class="history-fold callout${near ? ' is-tinted' : ''}" data-media-usage aria-label="Pictures in this file">
    <span class="callout-icon">${icon(near ? 'alert' : 'file')}</span>
    <strong>${pictures(usage.count)} in this file: ${byteSize(usage.bytes)} of ${byteSize(usage.budgetBytes)}</strong>
    ${usage.unusedCount === 0
      ? `<p class="quiet" data-media-unused="0">Every picture is named by a record or by a change History keeps. A picture taken out of a record stays while its change can be undone; folding older history lets go of it.</p>`
      : `<p data-media-unused="${usage.unusedCount}">${pictures(usage.unusedCount)}, ${byteSize(usage.unusedBytes)}, ${usage.unusedCount === 1 ? 'is' : 'are'} no longer named by any record or kept change.</p>
         ${canRemove ? '<p><button class="secondary-button" data-remove-unused-media type="button">Remove unused pictures…</button></p>' : ''}`}
  </section>`;
}

/** The question asked before removing, in the words of what it does. */
export function removeUnusedQuestion(usage: MediaUsage): { headingId: string; title: string; bodyHtml: string; confirmLabel: string } {
  return {
    headingId: 'remove-media-heading',
    title: 'Remove unused pictures?',
    bodyHtml: `
      <p>${pictures(usage.unusedCount)}, ${byteSize(usage.unusedBytes)}, that no record and no kept change names will be removed from this file, and the file is then made smaller.</p>
      <p>First Nendo saves a backup beside this file with every picture in it. Removing cannot be undone here; open the backup to get a picture back.</p>`,
    confirmLabel: 'Back up and remove',
  };
}
