import { escapeAttribute, escapeHtml } from './format';
import { icon } from './icons';

/**
 * Pictures in a message to the launched agent: which ones the composer takes, how they are named
 * on their chips, and how one is cut into chunks for the host. The host's bounds
 * (AgentConversation.Images.cs) are eight pictures, 5 MiB each and 20 MiB together, of PNG,
 * JPEG, GIF or WebP; it reads the type from the bytes again, and refuses all of them for an agent
 * that did not say it reads images.
 */

export const maximumPictures = 8;
export const maximumPictureBytes = 5 * 1024 * 1024;
export const maximumPicturesBytes = 20 * 1024 * 1024;
export const pictureTypes: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** The picker's filter: the same types. */
export const pictureAccept = pictureTypes.join(',');
/** Bytes per staged chunk: 200,000 base64 characters, well inside one bridge message. */
export const pictureChunkBytes = 150_000;

export interface PictureCandidate { name: string; type: string; size: number }
export interface HeldPicture extends PictureCandidate { key: string }

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Which of `candidates` join the pictures already `held`, in order, and the one line that says
 * why any did not. An agent that does not read pictures takes none of them.
 */
export function takePictures(held: readonly PictureCandidate[], candidates: readonly PictureCandidate[], takesImages: boolean, agent: string):
  { accepted: number[]; note: string | null } {
  if (candidates.length === 0) return { accepted: [], note: null };
  if (!takesImages) return { accepted: [], note: `${agent} does not read pictures, so none go with the message.` };
  const accepted: number[] = [];
  const refused: string[] = [];
  let count = held.length;
  let total = held.reduce((sum, picture) => sum + picture.size, 0);
  candidates.forEach((candidate, index) => {
    const name = candidate.name === '' ? 'A picture' : candidate.name;
    if (!pictureTypes.includes(candidate.type)) refused.push(`${name} is not a PNG, JPEG, GIF or WebP picture.`);
    else if (candidate.size === 0) refused.push(`${name} is empty.`);
    else if (candidate.size > maximumPictureBytes) refused.push(`${name} is ${sizeLabel(candidate.size)}; a picture is 5 MB at most.`);
    else if (count >= maximumPictures) refused.push(`A message carries ${maximumPictures} pictures at most; ${name} was not added.`);
    else if (total + candidate.size > maximumPicturesBytes) refused.push(`A message carries 20 MB of pictures at most; ${name} was not added.`);
    else {
      accepted.push(index);
      count += 1;
      total += candidate.size;
    }
  });
  return { accepted, note: refused.length === 0 ? null : refused.join(' ') };
}

/** A pasted picture has no name of its own (the clipboard calls each one image.png), so it is numbered. */
export function pastedName(type: string, number: number): string {
  const extension = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length);
  return `Pasted picture ${number}.${extension}`;
}

/** The chips over the message box, one per picture, each with its own remove button. */
export function picturesMarkup(held: readonly HeldPicture[]): string {
  return held.map((picture) => `<span class="chat-attachment" data-picture="${escapeAttribute(picture.key)}" title="${escapeAttribute(`${picture.name}, ${sizeLabel(picture.size)}`)}">${icon('image')}<span>${escapeHtml(picture.name)}</span><button type="button" data-remove-picture="${escapeAttribute(picture.key)}" aria-label="Take out ${escapeAttribute(picture.name)}">${icon('close')}</button></span>`).join('');
}

/** A picture's bytes as base64 chunks of at most `pictureChunkBytes`, each with its offset. */
export function pictureChunks(bytes: Uint8Array): Array<{ offset: number; base64: string }> {
  const chunks: Array<{ offset: number; base64: string }> = [];
  for (let offset = 0; offset < bytes.length; offset += pictureChunkBytes) {
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + pictureChunkBytes));
    let binary = '';
    for (let at = 0; at < part.length; at += 0x8000) binary += String.fromCharCode(...part.subarray(at, at + 0x8000));
    chunks.push({ offset, base64: btoa(binary) });
  }
  return chunks;
}
