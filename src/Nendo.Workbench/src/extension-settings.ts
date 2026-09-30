import { refreshDerived } from './actions';
import { state } from './app-state';
import { client } from './client';
import { holdingThePage } from './draft-guard';
import type { DesktopSessionView } from './host';
import { content, refreshChrome, rerender } from './shell';
import { parkViewFrames, releaseViewFrames, wireViewFrames } from './view-frames';

let generation = 0;

/** A device switch changes no data revision, so it needs its own refresh boundary. */
export async function refreshExtensionSettings(): Promise<void> {
  const ownGeneration = ++generation;
  const fileSessionId = state.session.fileSessionId;
  const refreshed = await client.request<DesktopSessionView>('session.getSnapshot');
  if (ownGeneration !== generation || fileSessionId !== state.session.fileSessionId || refreshed.fileSessionId !== fileSessionId) return;
  state.session = refreshed;
  if (!holdingThePage()) await refreshDerived();
  if (ownGeneration !== generation || state.session.fileSessionId !== fileSessionId) return;
  if (holdingThePage()) {
    // Stop/disconnect frames promptly while leaving the record form and its values
    // in place. The ordinary render uses this same park/adopt/release lifecycle.
    parkViewFrames();
    wireViewFrames(content);
    releaseViewFrames();
    refreshChrome();
  } else rerender();
}
