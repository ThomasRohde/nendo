/**
 * This device's local storage, or null where there is none to use: outside a browser, or
 * where the page may not reach it. A remembered fold or column width is a convenience, so
 * every caller carries on without one.
 */
export function deviceStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
