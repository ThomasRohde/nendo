import { DesktopWorkbenchClient, UnavailableWorkbenchClient } from './host-desktop';
import { PreviewWorkbenchClient } from './host-preview';
import type { WorkbenchClient } from './host-types';

/**
 * Which host the Workbench is talking to, and which protocol it speaks.
 *
 * The version below is the single declaration of it: tools/Test-ApplicationNeutrality.ps1
 * reads this exact line to check that the shipped Workbench is pinned to the
 * generic protocol, so it stays here rather than moving to host-types.ts with
 * the shapes it versions.
 */

export const protocolVersion = 7;

export * from './host-types';

export function createWorkbenchClient(): WorkbenchClient {
  const bridge = window.chrome?.webview;
  if (bridge !== undefined) {
    return new DesktopWorkbenchClient(bridge);
  }
  if (new URLSearchParams(window.location.search).has('preview')) {
    return new PreviewWorkbenchClient();
  }
  return new UnavailableWorkbenchClient();
}
