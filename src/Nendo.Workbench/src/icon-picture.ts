import { containRect, iconPictureMaxBase64, iconPictureSides } from './file-look';

/**
 * A file's own picture as the page draws it for an icon (W-001): whatever the person dropped or
 * picked, PNG, JPEG, GIF, WebP, AVIF, SVG or ICO, drawn whole and centred on a transparent square
 * and encoded as PNG, the one kind an icon is. The largest side that fits in one message to the
 * host wins; the Engine checks the result again before it becomes the icon.
 */

/** The most a picture the page draws for an icon may hold before it is read. */
export const iconPictureMaxBytes = 20 * 1024 * 1024;

/** Whether this file looks like a picture the page can draw, by its type or, for ICO and SVG, its name. */
export function looksLikePicture(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(file.name);
}

/** The square PNG for this picture, as base64, or a refusal that says why there is none. */
export async function squareIconPng(file: File): Promise<string> {
  if (!looksLikePicture(file)) throw new Error('Drop a picture: PNG, JPEG, GIF, WebP, AVIF, SVG or ICO.');
  if (file.size > iconPictureMaxBytes) throw new Error(`A picture for an icon is at most ${iconPictureMaxBytes / (1024 * 1024)} MiB.`);
  const image = await loadImage(await readAsDataUrl(file));
  // An SVG with only a viewBox has no size of its own; it is drawn to the square.
  const width = image.naturalWidth || iconPictureSides[0];
  const height = image.naturalHeight || iconPictureSides[0];
  for (const side of iconPictureSides) {
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('This Nendo cannot draw a picture.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const rect = containRect(width, height, side);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    const base64 = canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
    if (base64.length <= iconPictureMaxBase64) return base64;
  }
  throw new Error('That picture is too detailed to make an icon of. Try a simpler one.');
}

/** The file as a data address: the shell's own policy loads data: pictures, and no object address. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('That picture could not be read.'));
    reader.onerror = () => reject(new Error('That picture could not be read.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file is not a picture this Nendo can show.'));
    image.src = source;
  });
}
