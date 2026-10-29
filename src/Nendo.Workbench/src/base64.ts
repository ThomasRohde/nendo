/**
 * Base64 to bytes: the browser's own decoder where it has one, else one pass over `atob`.
 *
 * An exported page carries its file and its runtime as base64, tens of megabytes of it, so this
 * is on the path to the first screen. Mapping `atob`'s string through a function per byte took
 * 2.6 s on a 10 MB file, where this takes well under a tenth of a second.
 */
export function bytesFromBase64(text: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (typeof native === 'function') return native.call(Uint8Array, text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
