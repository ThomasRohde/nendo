import { refreshDerived } from './actions';
import { leaveRecordContext, state } from './app-state';
import { refuseWhileDirty } from './draft-guard';
import { fileViews, showsFileView } from './file-view-model';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import { icon } from './icons';
import { typeGlyph } from './type-icons';
import { overviewTitle } from './overview-model';
import { activePlan, applicationPlans, overviewPlan } from './plan-selection';
import { requiredElement, rerender, showError } from './shell';
import { viewTitle } from './view-frame-markup';
import { showsOverview } from './view-overview';

/**
 * The file's own places under Use in the navigation (G, trial): its front page, its views and its
 * record types, as the breadcrumb's first picker offers them. Choosing one opens Use on it from
 * anywhere in the window, which is what a NavigationView item does.
 */

const list = requiredElement<HTMLElement>('#nav-places');

interface RailPlace { value: string; label: string; glyph: string }

function railPlaces(): RailPlace[] {
  if (!state.session.capabilities.customSurfaces || state.compilation?.isValid !== true) return [];
  const overview = overviewPlan();
  return [
    ...(overview === null ? [] : [{ value: 'overview', label: overviewTitle(overview), glyph: icon('home') }]),
    ...fileViews().map((view) => ({ value: `view:${view.semanticId}`, label: viewTitle(view), glyph: icon('surfaces') })),
    ...applicationPlans().map((plan) => ({ value: `type:${plan.entity.semanticId}`, label: plan.entity.displayName, glyph: typeGlyph(plan.entity.displayName) })),
  ];
}

function currentValue(): string | null {
  if (state.view !== 'use') return null;
  if (showsFileView()) return `view:${state.fileView}`;
  if (showsOverview()) return 'overview';
  const plan = activePlan();
  return plan === null ? null : `type:${plan.entity.semanticId}`;
}

let drawn = '';

export function drawRailPlaces(): void {
  const places = railPlaces();
  const current = currentValue();
  const markup = places.map((place) => {
    const selected = place.value === current;
    return `<button class="nav-place${selected ? ' is-selected' : ''}" type="button" data-rail-place="${escapeAttribute(place.value)}"${selected ? ' aria-current="page"' : ''} title="${escapeAttribute(place.label)}"><span class="nav-symbol" aria-hidden="true">${place.glyph}</span><span>${escapeHtml(place.label)}</span></button>`;
  }).join('');
  // Redrawn only when it changed, so a press is never lost to a chrome refresh under the pointer.
  if (markup === drawn) return;
  drawn = markup;
  list.innerHTML = markup;
  list.hidden = places.length === 0;
}

async function openPlace(value: string): Promise<void> {
  if (state.actionInFlight || refuseWhileDirty('showing another screen')) return;
  state.view = 'use';
  state.creatingRecord = false;
  leaveRecordContext();
  if (value.startsWith('view:')) {
    state.fileView = value.slice('view:'.length);
    state.showOverview = false;
    rerender();
    return;
  }
  state.fileView = null;
  if (value === 'overview') { state.showOverview = true; rerender(); return; }
  state.showOverview = false;
  state.selectedApplicationEntity = value.slice('type:'.length);
  try {
    await refreshDerived();
  } catch (error) {
    showError(messageFor(error));
  }
  rerender();
}

list.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-rail-place]') : null;
  if (button === null || button.disabled) return;
  void openPlace(button.dataset.railPlace!);
});
