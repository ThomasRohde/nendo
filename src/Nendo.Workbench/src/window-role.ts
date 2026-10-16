/**
 * Which window of the file this page is in (W-277, ADR-0002 2026-10-16): the main window the
 * process started with, or a window a tab was moved to. A tab window shows the same file and
 * offers everything but the file actions that open, close or replace it, which are the main
 * window's. Told once at start by `window.takeTab`; a browser preview is always the main window.
 */
export type WindowRole = 'main' | 'tab';

let role: WindowRole = 'main';

export function windowRole(): WindowRole {
  return role;
}

export function setWindowRole(next: WindowRole): void {
  role = next;
  document.documentElement.dataset.window = next;
}

/**
 * The file actions only the main window offers. The host refuses the same set from a tab window
 * (DesktopTabWindowRules.MainWindowOnly), and scripts/tab-window.test.mjs holds the two to each other.
 */
export const mainWindowOnly: ReadonlySet<string> = new Set([
  'session.createFile', 'session.openFile', 'file.openRecent', 'file.openDropped', 'file.close',
  'file.newFile', 'file.duplicate', 'file.fork', 'file.restore', 'file.upgrade', 'file.resolveRecovery',
]);
