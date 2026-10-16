import { deviceStorage } from './device-storage';

/**
 * Media addresses as the Workbench reads them (ADR-0031 point 3). The Engine's grammar is the
 * authority and refuses anything else on write; this copy only decides how to show a value, so a
 * value it cannot read is shown as text.
 */
export type MediaSource = 'embedded' | 'web' | 'localAbsolute' | 'localRelative';

export interface MediaAddress {
  source: MediaSource;
  value: string;
  /** For an embedded picture, the SHA-256 that names it. */
  sha256?: string;
}

const embedded = /^media:([0-9a-f]{64})$/;
const absolute = /^[A-Za-z]:[\\/]/;
const relative = /^\.\.?[\\/]/;
const badSegment = /[<>:"|?*]/;

function localSegmentsValid(path: string): boolean {
  const segments = path.split(/[\\/]/);
  return segments.every((segment, index) =>
    segment === '.' || segment === '..'
      ? index < segments.length - 1
      : segment.length > 0 && !segment.endsWith(' ') && !segment.endsWith('.') && !badSegment.test(segment));
}

export function parseMediaAddress(value: unknown): MediaAddress | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  const sha = embedded.exec(value);
  if (sha) return { source: 'embedded', value, sha256: sha[1] };
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !/\s/.test(value) ? { source: 'web', value } : null;
    } catch {
      return null;
    }
  }
  if (absolute.test(value) && value.length >= 4) return localSegmentsValid(value.slice(3)) ? { source: 'localAbsolute', value } : null;
  if (relative.test(value)) return localSegmentsValid(value) ? { source: 'localRelative', value } : null;
  return null;
}

/** What a person reads for where a picture comes from. */
export function mediaSourceLabel(source: MediaSource): string {
  return source === 'embedded' ? 'In file' : source === 'web' ? 'Web' : 'Linked file';
}

const webKey = 'nendo.media.webPictures';

/** Whether this device loads pictures from the internet (ADR-0031 point 11). On unless turned off here. */
export function loadsWebPictures(): boolean {
  try {
    return deviceStorage()?.getItem(webKey) !== 'off';
  } catch {
    return true;
  }
}

export function setLoadsWebPictures(on: boolean): void {
  try {
    deviceStorage()?.setItem(webKey, on ? 'on' : 'off');
  } catch {
    // A device that keeps nothing loads web pictures, the default.
  }
}

/**
 * The page's address for a picture, or null when it is not shown: a web picture while this device
 * does not load them, or a file with no media origin (none open). Embedded and local pictures come
 * from the file's media origin; a web picture is loaded as it is.
 */
export function mediaUrl(address: MediaAddress, mediaOrigin: string | null | undefined, loadWeb = loadsWebPictures()): string | null {
  if (address.source === 'web') return loadWeb ? address.value : null;
  if (!mediaOrigin) return null;
  return address.source === 'embedded'
    ? `${mediaOrigin}/m/${address.sha256}`
    : `${mediaOrigin}/f/?a=${encodeURIComponent(address.value)}`;
}
