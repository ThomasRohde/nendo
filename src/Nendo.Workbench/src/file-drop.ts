/**
 * A Nendo file dragged onto the window.
 *
 * Two separate answers, because the browser gives two different amounts of
 * information at two moments and it is easy to promise more than is known.
 *
 * While a drag is over the window, a page may count the items and see that they are
 * files. It may not see their names — that is a browser rule, and the right one — so
 * the hint on screen cannot say whether the thing being dragged is a Nendo file. It
 * says what it does know and nothing more.
 *
 * On the drop the names arrive, and that is the moment a refusal can name a reason.
 */

/** The Nendo file extension, as it appears on disk. */
const extension = '.nendo';

export interface DragHint {
  /** What the person sees while the pointer is over the window. */
  message: string;
  /** Whether this is an offer or a refusal, which is what the hint is styled by. */
  possible: boolean;
}

/**
 * What to say while something is being dragged over the window.
 *
 * @param fileCount how many file items the drag carries.
 */
export function describeDrag(fileCount: number): DragHint | null {
  if (fileCount <= 0) return null;
  if (fileCount > 1) return { message: 'Nendo opens one file at a time', possible: false };
  return { message: 'Drop to open this file', possible: true };
}

export interface DropVerdict {
  /** The index of the file to hand the host, or null when nothing will be opened. */
  accept: number | null;
  /** Why nothing will be opened, or null when something will be. */
  refusal: string | null;
}

/**
 * What to do with what was dropped.
 *
 * A refusal names the file where there is one to name. "That is not a Nendo file"
 * with the name in it is the difference between a person checking what they dragged
 * and a person wondering whether the window is broken.
 */
export function judgeDrop(names: readonly string[]): DropVerdict {
  if (names.length === 0) return { accept: null, refusal: null };
  if (names.length > 1) {
    return { accept: null, refusal: `Nendo opens one file at a time. ${names.length} files were dropped.` };
  }
  const name = names[0];
  if (!name.toLowerCase().endsWith(extension) || name.length === extension.length) {
    return { accept: null, refusal: `${name} is not a Nendo file. Nendo opens ${extension} files.` };
  }
  return { accept: 0, refusal: null };
}
