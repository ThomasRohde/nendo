// The Garden view: on a screen of the file it is the workspace; on a note's record page it is the
// Backlinks panel. Both read the file through window.nendo (ADR-0013) and nothing else.
import { startWorkspace } from './workspace.js';
import { startPanel } from './panel.js';

(async () => {
  const nendo = window.nendo;
  const notFramed = document.getElementById('not-framed');
  if (nendo === undefined) { notFramed.hidden = false; return; }
  let context;
  try {
    context = await nendo.ready;
  } catch (error) {
    notFramed.textContent = error.message;
    notFramed.hidden = false;
    return;
  }
  document.documentElement.lang = context.locale ?? 'en';
  const kit = await import('./kit/nendo-view-kit.js');
  kit.installFocusRing(document);
  if (context.placement === 'recordPage') await startPanel(nendo, context, kit);
  else await startWorkspace(nendo, context, kit);
})();
