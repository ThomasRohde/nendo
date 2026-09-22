import { refreshDerived } from './actions';
import {
  calendarModes, calendarMonths, drills, focusedRecords, leaveRecordContext, selectedSurfaces, selectedTabs,
  state, surfaceErrors, surfaceWindows, timelineModes, timelineYears,
} from './app-state';
import { refuseWhileDirty } from './draft-guard';
import { messageFor } from './format';
import { navigationTrail, tabsOf, type Place } from './navigation-trail';
import {
  activePlan, applicationPlans, calendarModeFor, calendarMonthFor, effectiveSurfaceQuery, overviewPlan,
  selectedSurfaceNode, timelineModeFor, timelineYearFor,
} from './plan-selection';
import { loadOpenedRecordPanels } from './related-actions';
import { loadFocusedRecord, loadSurfaceWindow } from './reads';
import { refreshChrome, rerender, setBusy, showError } from './shell';
import { accumulatesPages, surfaceById } from './surface-model';

/**
 * Going back, and coming forward again, from anywhere in the file.
 *
 * The trail itself is in `navigation-trail.ts` and knows nothing about the session. This
 * module is the other half: reading the place somebody is in, and putting one back. It is
 * shaped like `related-actions.ts` and imports the same set, because restoring a place is
 * what W-033 already built for one record, with more fields set.
 */

/** Where the person is now, in enough detail to come back to it. */
export function placeNow(heading: { eyebrow: string; title: string }): Place {
  const plan = activePlan();
  // The record type that is actually on screen, not the one that was picked. Nothing
  // sets `selectedApplicationEntity` until somebody uses the picker, opens a related row
  // or comes through the front page, and `resetFileView` puts it back to null — so on the
  // screen every file opens on it is null while `activePlan` is quietly showing the first
  // compiled type. A place that recorded the null recorded no record type at all: the
  // surface, the drill and the tabs were left out of it, and the record on it could not
  // be read back, because a read needs the type to read from.
  const entityId = plan?.entity.semanticId ?? state.selectedApplicationEntity;
  const surface = plan === null ? null : selectedSurfaceNode(plan);
  const surfaceId = surface?.semanticId ?? null;
  return {
    view: state.view,
    eyebrow: heading.eyebrow,
    title: heading.title,
    applicationEntityId: entityId,
    studioEntityId: state.selectedEntityId,
    showOverview: state.showOverview,
    surfaceId,
    recordId: state.selectedRecordId,
    returnTo: state.returnTo,
    drill: entityId === null ? null : drills.get(entityId) ?? null,
    tabs: tabsOf(entityId),
    calendar: surface !== null && surface.kind === 'calendarSurface' && surfaceId !== null
      ? { surfaceId, month: calendarMonthFor(surfaceId), mode: calendarModeFor(surfaceId) }
      : null,
    timeline: surface !== null && surface.kind === 'timelineSurface' && surfaceId !== null
      ? { surfaceId, year: timelineYearFor(surfaceId), mode: timelineModeFor(surfaceId) }
      : null,
    helpTopicId: state.helpTopicId,
    // Only the screens that are about a proposal. A preview can be loaded while somebody
    // is on a surface, and a place that named it there would be refused the moment the
    // proposal was accepted — for a screen that has nothing to do with it.
    proposalId: state.view === 'proposal' ? state.proposal?.proposalId ?? null : null,
    agentProposalId: state.view === 'agentProposal' ? state.agentProposal?.proposalId ?? null : null,
    proposalReturnView: state.view === 'proposal' ? state.proposalReturnView : null,
  };
}

/** Note where the person is. Called from the one place a view is drawn. */
export function recordPlace(heading: { eyebrow: string; title: string }): void {
  // Before a file is open there is nowhere to go back to, and the empty frame is not a
  // place. Without this the trail would start with it and back would lead to no file.
  if (state.session.fileSessionId === null) return;
  navigationTrail.record(placeNow(heading));
}

/** Whether the way back and the way forward lead anywhere, and to where. */
export function backTarget(): Place | null { return navigationTrail.peekBack(); }
export function forwardTarget(): Place | null { return navigationTrail.peekForward(); }

/** How a place is named on the button that leads to it. */
export function placeName(place: Place): string {
  return place.eyebrow === '' ? place.title : `${place.eyebrow} — ${place.title}`;
}

export async function goBack(): Promise<void> { await travel('back'); }
export async function goForward(): Promise<void> { await travel('forward'); }

/**
 * What is wrong with a place, said in a sentence, or null when it is still there.
 *
 * Everything here is answerable without a read. The record is the one thing that is not,
 * and it is checked separately, before anything moves.
 */
function whyPlaceIsGone(place: Place): string | null {
  const can = state.session.capabilities;
  const permitted =
    place.view === 'use' ? can.customSurfaces
      : place.view === 'data' || place.view === 'structure' ? can.readData
        : place.view === 'surfaces' ? can.customSurfaces
          : place.view === 'history' ? can.readHistory
            : place.view === 'agent' || place.view === 'agentProposal' ? can.agentAccess
              : true;
  if (!permitted) return 'That screen is not available in this file any more.';
  if (place.proposalId !== null && state.proposal?.proposalId !== place.proposalId)
    return 'Those proposed changes are no longer waiting.';
  if (place.agentProposalId !== null && state.agentProposal?.proposalId !== place.agentProposalId)
    return 'Those proposed changes are no longer waiting.';
  // A Studio page is judged on its own record type, not on the one Use happened to be
  // pointing at when the place was noted. Every place carries the Use fields so that
  // going back restores the whole view, but a Structure page refused because a proposal
  // removed a screen somewhere else is a page that is right there on the screen.
  if (place.view === 'data' || place.view === 'structure') {
    // selectedEntity falls back to the first record type, so a retired one would land
    // somebody on another type's page and call it the one they asked for.
    if (place.studioEntityId !== null &&
        !state.session.entities.some((entity) => entity.entityId === place.studioEntityId))
      return 'That record type is no longer in this file.';
    return null;
  }
  if (place.view !== 'use') return null;
  // renderUse falls through to a record type when the front page has gone, which is the
  // same silent substitution.
  if (place.showOverview === true && overviewPlan() === null) return 'This file no longer has a front page.';
  if (place.applicationEntityId === null) return null;
  const plan = applicationPlans().find((candidate) => candidate.entity.semanticId === place.applicationEntityId);
  if (plan === undefined) return 'That record type no longer has a screen.';
  // surfaceById rather than resolveSurface: resolving falls back to the first compiled
  // root, which would quietly land the person on a different screen and call it the one
  // they asked for.
  if (place.surfaceId !== null && surfaceById(plan, place.surfaceId) === null)
    return 'That screen is no longer in this file.';
  return null;
}

async function travel(direction: 'back' | 'forward'): Promise<void> {
  const way = direction === 'back' ? 'the way back' : 'the way forward';
  const target = direction === 'back' ? navigationTrail.peekBack() : navigationTrail.peekForward();
  if (state.actionInFlight || target === null) return;
  // Both directions redraw, and a redraw discards a form's drafts, so both decline while
  // there is unsaved typing — in the words the related row's own back already uses.
  if (refuseWhileDirty(direction === 'back' ? 'going back' : 'going forward')) return;
  const gone = whyPlaceIsGone(target);
  if (gone !== null) { declinePlace(direction, `${gone} ${capitalised(way)} now leads to the place before it.`); return; }

  // Read the record before anything moves, and before the redraw that a move ends with.
  // A place whose record has gone must leave the person exactly where they are, and the
  // redraw is what it cannot survive: a view rebuilds the content pane, and the sentence
  // saying what went was written into it. Declining through the same path a move takes
  // showed the sentence and then destroyed it in the same tick, with nothing on screen to
  // say why nothing had happened.
  state.actionInFlight = true;
  setBusy(true);
  try {
    // A record needs the type to read it from. A place that has a record but no record
    // type is one this build can no longer make, and reading with an empty type would
    // ask the host a question with no answer.
    if (target.recordId !== null && target.applicationEntityId !== null)
      await loadFocusedRecord(target.applicationEntityId, target.recordId);
  } catch (error) {
    state.actionInFlight = false;
    setBusy(false);
    showError(messageFor(error));
    return;
  }
  if (target.recordId !== null && !focusedRecords.has(target.recordId)) {
    state.actionInFlight = false;
    setBusy(false);
    declinePlace(direction, `That record is no longer there. ${capitalised(way)} now leads to the place before it.`);
    return;
  }

  navigationTrail.setRestoring(true);
  if (direction === 'back') navigationTrail.stepBack(); else navigationTrail.stepForward();
  // Held rather than shown, and said after the redraw: a refusal about a move belongs
  // to the screen the move ended on, and the redraw is what draws that screen.
  let failure: string | null = null;
  try {
    await settle(target);
  } catch (error) {
    failure = messageFor(error);
  } finally {
    state.actionInFlight = false;
    setBusy(false);
    rerender();
    // Released after the redraw, so the restore never records the place it just restored
    // and never eats what is ahead of it.
    navigationTrail.setRestoring(false);
  }
  if (failure !== null) showError(failure);
}

function capitalised(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1); }

/** Forget a place that is no longer there, and stay put. */
function declinePlace(direction: 'back' | 'forward', message: string): void {
  if (direction === 'back') navigationTrail.dropBack(); else navigationTrail.dropForward();
  showError(message);
  refreshChrome();
}

/** Put the view back the way the place found it. */
async function settle(place: Place): Promise<void> {
  state.view = place.view;
  state.selectedEntityId = place.studioEntityId;
  state.selectedApplicationEntity = place.applicationEntityId;
  state.showOverview = place.showOverview;
  state.helpTopicId = place.helpTopicId;
  // Only where the place is a review. Everywhere else it is left alone, because it is
  // the property of whichever review is open rather than of the screen.
  if (place.proposalReturnView !== null) state.proposalReturnView = place.proposalReturnView;
  leaveRecordContext();
  const entityId = place.applicationEntityId;
  if (entityId !== null) {
    if (place.surfaceId !== null) selectedSurfaces.set(entityId, place.surfaceId);
    // A place with no drill is a place where the list was whole, so the drill is taken
    // off rather than left standing.
    if (place.drill === null) drills.delete(entityId); else drills.set(entityId, place.drill);
  }
  // Every tab of this record type, not only the ones the place carries: a tab opened
  // since must close again, or going back to a page shows a section the page did not
  // have open when it was left.
  for (const [key] of tabsOf(entityId)) selectedTabs.delete(key);
  for (const [key, sectionId] of place.tabs) selectedTabs.set(key, sectionId);
  if (place.calendar !== null) {
    calendarMonths.set(place.calendar.surfaceId, place.calendar.month);
    calendarModes.set(place.calendar.surfaceId, place.calendar.mode);
  }
  if (place.timeline !== null) {
    timelineYears.set(place.timeline.surfaceId, place.timeline.year);
    timelineModes.set(place.timeline.surfaceId, place.timeline.mode);
  }
  // Before the refresh, as returnFromRelatedRecord sets it: the refresh re-reads the
  // record in view under the new change sequence, and a selection made after it has
  // missed that read.
  state.selectedRecordId = place.recordId;
  state.returnTo = place.returnTo;
  await refreshDerived();

  const plan = activePlan();
  if (plan !== null && entityId !== null && place.surfaceId !== null) {
    const node = surfaceById(plan, place.surfaceId);
    // A calendar and a timeline read their own pages as they draw, keyed by the range
    // this place has just put back.
    if (node !== null && !accumulatesPages(node.kind)) {
      // The window has to match the query this place asks for, not just the revision.
      // refreshDerived has just reloaded the selected surface under its DECLARED query,
      // so a window at the current change sequence is sitting there holding the whole
      // list — and a freshness test that asked only about the revision skipped the one
      // read that applies the drill. Coming back to a drilled list drew every row under
      // a pill that said it was narrowed.
      const held = surfaceWindows.get(node.semanticId);
      const wanted = effectiveSurfaceQuery(entityId, node);
      const fresh = held !== undefined && held.page.changeSequence === state.session.manifest?.changeSequence &&
        JSON.stringify(held.query) === JSON.stringify(wanted);
      if (!fresh) {
        surfaceErrors.delete(node.semanticId);
        surfaceWindows.delete(node.semanticId);
        try {
          await loadSurfaceWindow(entityId, node);
        } catch (error) {
          // A surface whose own read refused says so in place, rather than showing the
          // records of whichever surface was loaded before.
          surfaceErrors.set(node.semanticId, messageFor(error));
        }
      }
    }
  }
  if (place.recordId === null) return;
  await loadOpenedRecordPanels(place.recordId);
}
