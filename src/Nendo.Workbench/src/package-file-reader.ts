import { escapeHtml } from './format';
import type { ProposalFileWindow } from './host-types';
import { byteSize } from './package-diff-markup';

/**
 * The whole of a file a proposal adds or replaces, read before accepting it (review R-017).
 *
 * The review's diff stops at a bound and a binary file is said by its size, so without this a
 * person could accept bytes they had no way to read. The host answers from the proposal's own
 * validated copy, never the active file, and only for the digest under review: a proposal
 * amended since is refused rather than shown. The windows are put together here, checked
 * against the whole file's SHA-256, and shown as text in Nendo's own dialog, with Copy.
 */

/** The largest file the dialog puts together: a package file's own bound. */
const largestFile = 4 * 1024 * 1024;
/** One read's size, the host's bound for a window. */
const windowBytes = 256 * 1024;

export interface ProposedFile { mediaType: string; sha256: string; bytes: Uint8Array; text: string | null }

export type Request = <T>(method: string, payload: Record<string, unknown>) => Promise<T>;

/** Read every window of one proposed file and check it. Throws when it cannot be read whole. */
export async function readProposedFile(
  target: { proposalId: string; reviewedDigest: string; packageId: string; path: string },
  request: Request,
): Promise<ProposedFile> {
  const parts: Uint8Array[] = [];
  let read = 0, total = Infinity, first: ProposalFileWindow | null = null;
  while (read < total) {
    const window = await request<ProposalFileWindow>('proposal.readPackageFile', { ...target, offset: read, length: windowBytes });
    if (first === null) { first = window; total = window.totalBytes; }
    if (window.totalBytes > largestFile) throw new Error(`${target.path} is larger than a package file may be.`);
    if (window.sha256 !== first.sha256 || window.offset !== read) throw new Error(`${target.path} changed while it was read. Open the proposal again.`);
    const bytes = decodeBase64(window.content);
    if (bytes.length === 0) break;
    parts.push(bytes);
    read += bytes.length;
  }
  const bytes = new Uint8Array(read);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  if (first === null || read !== total) throw new Error(`${target.path} could not be read to its end.`);
  const digest = await sha256Hex(bytes);
  if (digest !== first.sha256.toLowerCase().replace(/^sha256:/, '')) throw new Error(`${target.path} did not read back as the proposal holds it.`);
  let text: string | null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = null; }
  return { mediaType: first.mediaType, sha256: digest, bytes, text };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The dialog: the file as text with Copy, or its size and digest when it is not text. */
export function proposedFileMarkup(path: string, file: ProposedFile): string {
  const facts = `${escapeHtml(file.mediaType)} · ${escapeHtml(byteSize(file.bytes.length))} · SHA-256 <code>${escapeHtml(file.sha256)}</code>`;
  const body = file.text === null
    ? '<p>Not text, so it cannot be shown as lines. Its size and digest are those of the bytes the proposal adds.</p>'
    : `<pre class="package-file-text" tabindex="0">${escapeHtml(file.text)}</pre>`;
  return `<h2 id="package-file-heading">${escapeHtml(path)}, as the proposal leaves it</h2><p class="package-file-facts">${facts}</p>${body}
    <div class="form-actions">${file.text === null ? '' : '<button class="secondary-button" data-copy type="button">Copy</button>'}<button class="primary-button" data-close type="button" autofocus>Close</button></div>`;
}
