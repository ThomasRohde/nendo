import type { DesktopSessionView } from './host-types';

/**
 * Which recovery actions Health, the File menu and the native panel offer for the open file.
 * The native panel holds the same rules in DesktopRecoveryPresentation; the host refuses either
 * action whatever is drawn.
 */

/**
 * Inspect file again: a file is open and is not healthy. A healthy file that only waits for its
 * automatic actions to be approved has editing off too, and offering the action there closed it,
 * ended agent access and reopened it read-only, where the approval could no longer be given (R2SMA-06).
 */
export function offersReinspection(session: Pick<DesktopSessionView, 'fileName' | 'health'>): boolean {
  return session.fileName !== null && session.health !== 'normal';
}

/**
 * Restore and Upgrade: the file can yield a backup, and is not marked read-only in File Explorer.
 * Such a file is inspected, exported and backed up, never replaced (R2SMA-10, owner 2026-10-13).
 */
export function offersReplacement(session: Pick<DesktopSessionView, 'capabilities' | 'findings'>): boolean {
  return session.capabilities.backup && !session.findings.some(finding => finding.code === 'file-read-only');
}
