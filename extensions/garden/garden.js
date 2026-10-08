// The Garden package's places: the Overview, a screen of the file led by the garden's graph; the
// Garden view, the workspace where notes are read and written; the notes' Graph and Tend screens;
// the Agenda, a screen of the tasks; and on a note's record page the Backlinks panel. Each reads
// the file through window.nendo (ADR-0013) and nothing else.
import { startWorkspace } from './workspace.js';
import { startPanel } from './panel.js';
import { startGraphScreen } from './graphscreen.js';
import { startHome } from './home.js';
import { startAgenda } from './agenda.js';
import { startTend } from './tend.js';

export const HOME_VIEW = 'gd.home';
export const AGENDA_SCREEN = 'gd.task.agenda';
export const TEND_SCREEN = 'gd.note.tend';

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
  else if (context.kind === 'extensionGraphSurface') await startGraphScreen(nendo, context, kit);
  else if (context.viewId === HOME_VIEW) await startHome(nendo, context, kit);
  else if (context.viewId === AGENDA_SCREEN) await startAgenda(nendo, context, kit);
  else if (context.viewId === TEND_SCREEN) await startTend(nendo, context, kit);
  else await startWorkspace(nendo, context, kit);
})();
