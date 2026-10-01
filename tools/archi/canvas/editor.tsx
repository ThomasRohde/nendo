// The Archi workbench's diagram editor (W-111): archi-online's own ViewEditor, Palette and context
// menus, running on an archi-online model store the workbench fills from its mirror of the
// file's records. Every gesture is an archi-online transaction on that store; the workbench
// collects them and, on Commit, writes the difference to the file as one revision
// (records.ts). Undo and Redo are archi-online's own, over what has not been committed.

import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelState } from '@archi/model/types';
import { ViewEditor } from '@archi/canvas/ViewEditor';
import { Palette } from '@archi/ui/Palette';
import { ContextMenuHost } from '@archi/ui/ContextMenu';
import { AppDialogHost } from '@archi/ui/AppDialog';
import { alignmentAnchorMode, hydrateSettingsStore, useSettingsStore } from '@archi/settings/app-settings';
import { alignableNodeIds, alignNodes, distributeNodes, matchSize } from '@archi/model/ops/alignment';
import { reorderViewObjects } from '@archi/model/ops/movement';
import { duplicateViewObjects } from '@archi/model/ops/duplicate';
import { copyNodes, cutNodes, hasClipboard, pasteNodes } from '@archi/canvas/clipboard';
import { sameTypeViewObjectIds } from '@archi/canvas/view-editor/bounds';
import { AppearanceTab } from '@archi/ui/properties/AppearanceTab';
import { LabelTab } from '@archi/ui/properties/LabelTab';
import { resolveTarget } from '@archi/ui/properties/target';
import { useStore } from '@archi/ui/store-hooks';
import { ModelStoreProvider } from '@archi/ui/store-hooks';
import { createModelStore, openView, redo, setActiveModelStore, setSelection, undo, type ModelStore } from '@archi/model/store';

/**
 * The arrange commands (W-113), each archi-online's own operation as its context menu runs it, on
 * the objects of the view among `ids`: one transaction, so one Undo step and one edit waiting to
 * be committed. Answers a sentence when the selection does not suit the command, else null.
 */
export const ARRANGE_COMMANDS = ['align-left', 'align-center', 'align-right', 'align-top', 'align-middle', 'align-bottom',
  'match-width', 'match-height', 'match-size', 'distribute-horizontal', 'distribute-vertical',
  'order-front', 'order-forward', 'order-backward', 'order-back', 'select-same-type', 'duplicate',
  'cut', 'copy', 'paste', 'paste-reference', 'paste-copy'] as const;
export type ArrangeCommand = typeof ARRANGE_COMMANDS[number];

export function arrangeIn(store: ModelStore, viewId: string, wanted: string[], command: ArrangeCommand): string | null {
  const model = store.getState().model;
  if (!model || !model.views[viewId]) return 'Open a view to arrange it.';
  const ids = wanted.filter(id => model.nodes[id]?.viewId === viewId || model.connections[id]?.viewId === viewId);
  const settings = useSettingsStore.getState().settings;
  const anchor = alignmentAnchorMode(settings);
  const boxes = alignableNodeIds(model, ids);
  const atLeast = (count: number, list: string[], what: string) => (list.length >= count ? null : `Select at least ${count} ${what} on the view.`);
  const [verb, mode] = command.split('-') as [string, string];
  switch (verb) {
    case 'align': return atLeast(2, boxes, 'boxes') ?? (alignNodes(boxes, mode as 'left', anchor, store), null);
    case 'match': return atLeast(2, boxes, 'boxes') ?? (matchSize(boxes, mode === 'size' ? 'both' : mode as 'width', anchor, store), null);
    case 'distribute': return atLeast(3, boxes, 'boxes') ?? (distributeNodes(boxes, mode as 'horizontal', store), null);
    case 'order': return atLeast(1, ids, 'objects') ?? (reorderViewObjects(ids, mode as 'front', store), null);
  }
  switch (command) {
    case 'select-same-type': return atLeast(1, ids, 'objects') ?? (setSelection('view', sameTypeViewObjectIds(model, viewId, ids), store), null);
    case 'duplicate': {
      const refusal = atLeast(1, ids, 'objects');
      if (refusal) return refusal;
      setSelection('view', duplicateViewObjects(viewId, ids, settings.pasteOffset, store), store);
      return null;
    }
    case 'cut': return atLeast(1, ids, 'objects') ?? (cutNodes(ids, store), null);
    case 'copy': return atLeast(1, ids, 'objects') ?? (copyNodes(ids, store), null);
    default: {
      if (!hasClipboard()) return 'Nothing has been copied yet.';
      const how = command === 'paste-reference' ? 'reference' : command === 'paste-copy' ? 'duplicate' : 'default';
      setSelection('view', pasteNodes(viewId, undefined, store, undefined, how), store);
      return null;
    }
  }
}

/** The model after one arrange command, as archi-online's own operation leaves it: the reference the lane compares a commit with. */
export function arrangeModel(model: ModelState, viewId: string, ids: string[], command: ArrangeCommand) {
  const store = createModelStore({ model: structuredClone(model) });
  const refusal = arrangeIn(store, viewId, ids, command);
  return { refusal, model: store.getState().model! };
}

/** The editor's grid, snapping and guides, as its own empty-canvas menu sets them. */
export function editorSettings() {
  const { gridVisible, snapToGrid, snapToAlignmentGuides } = useSettingsStore.getState().settings;
  return { grid: gridVisible, snap: snapToGrid, guides: snapToAlignmentGuides };
}
export function setEditorSetting(name: 'grid' | 'snap' | 'guides', on: boolean) {
  const key = name === 'grid' ? 'gridVisible' : name === 'snap' ? 'snapToGrid' : 'snapToAlignmentGuides';
  useSettingsStore.getState().setSetting(key, on);
}

/**
 * How the selected box or line looks (W-114): archi-online's own Appearance and Label tabs, for
 * one object selected on the view. Each change is an edit waiting to be committed, as a move is.
 */
// A view's frame is never allowed the computer's font list (Nendo's frame delegates no
// local-fonts), and asking for it only reports a violation each time the Appearance tab draws.
// Without the method, archi-online's tab offers its own common fonts.
if (typeof window !== 'undefined' && 'queryLocalFonts' in window) {
  try { Object.defineProperty(window, 'queryLocalFonts', { value: undefined, configurable: true }); } catch { /* left as it is */ }
}

function StylePanel() {
  const model = useStore(state => state.model);
  const selection = useStore(state => state.selection);
  const readOnly = useStore(state => state.readOnly);
  const [tab, setTab] = useState<'appearance' | 'label'>('appearance');
  const ids = selection.source === 'view' ? selection.ids : [];
  const target = model && ids.length === 1 ? resolveTarget(model, 'view', ids) : null;
  const object = target?.node ?? target?.connection ?? null;
  const panel = (children: unknown[]) => createElement('div', { className: 'properties-panel archi-style-panel', 'aria-label': 'Appearance' }, ...children as []);
  if (!model || !target || !object) {
    return panel([createElement('p', { key: 'hint', className: 'empty-hint' },
      ids.length > 1 ? 'Select one box or line to change how it looks.' : 'Select a box or a line on the view to change how it looks.')]);
  }
  const tabs = [['appearance', 'Appearance'], ['label', 'Label']] as const;
  return panel([
    createElement('div', { key: 'tabs', className: 'prop-tabs', role: 'tablist' }, ...tabs.map(([id, label]) => createElement('button', {
      key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, className: `prop-tab${tab === id ? ' active' : ''}`, 'data-style-tab': id,
      onClick: () => setTab(id),
    }, label))),
    createElement('div', { key: 'content', className: 'prop-content' }, tab === 'appearance'
      ? createElement(AppearanceTab, { target, readOnly })
      : createElement(LabelTab, { key: object.id, model, objectId: object.id, readOnly })),
  ]);
}

const PALETTE_KEY = 'archi-palette-width';
const PALETTE_MIN = 40, PALETTE_MAX = 360, PALETTE_DEFAULT = 112;
const clampPalette = (width: number) => Math.round(Math.min(PALETTE_MAX, Math.max(PALETTE_MIN, width)));

interface EditorOptions {
  /** The store's model changed: an edit, an undo or a redo. `pending` is whether it now differs from the base. */
  onChange?: (model: ModelState, label: string | null) => void;
  /** The editor's selection, as the ids of what is selected on the view. */
  onSelect?: (ids: string[]) => void;
  /** The editor opened another view: a double-click on a view reference. */
  onOpenView?: (viewId: string) => void;
  /** The pointer was let go in the editor: a change held back while it was pressed may land now. */
  onIdle?: () => void;
  /** Whether the Appearance panel is shown from the start: archi-online fits a view to the canvas
   *  it first measures, so the panel must not narrow it afterwards (the owner, W-114). */
  styleShown?: boolean;
}

/**
 * The editor in `host`, for the model `base` as last read from the file. `show` opens a view;
 * `reset` starts again from a new base (after a commit, a discard, or a change from elsewhere
 * when nothing is waiting); `model` is the model with every edit not yet committed.
 */
export function createEditor(host: HTMLElement, base: ModelState, options: EditorOptions = {}) {
  host.classList.add('archi-editor');
  const store: ModelStore = createModelStore({ model: structuredClone(base) });
  // The editor's settings as last chosen in this view's origin: the grid, snapping and guides
  // (W-113). archi-online's app shell reads them at start; without it they reset every visit.
  hydrateSettingsStore().catch(() => { /* the defaults */ });
  setActiveModelStore(store);
  let viewId: string | null = null;
  let root: Root | null = createRoot(host);
  let quiet = false;
  let styleShown = options.styleShown === true;

  // The palette's width: dragged or stepped with the arrow keys on its splitter, and kept on this
  // device. The buttons wrap, so a wider palette is more columns rather than wider buttons.
  let paletteWidth = PALETTE_DEFAULT;
  try { paletteWidth = clampPalette(Number(localStorage.getItem(PALETTE_KEY)) || PALETTE_DEFAULT); } catch { /* the default */ }
  const setPaletteWidth = (width: number, keep: boolean) => {
    paletteWidth = clampPalette(width);
    host.style.setProperty('--palette-width', `${paletteWidth}px`);
    host.querySelector('.archi-palette-splitter')?.setAttribute('aria-valuenow', String(paletteWidth));
    if (keep) { try { localStorage.setItem(PALETTE_KEY, String(paletteWidth)); } catch { /* this visit only */ } }
  };
  setPaletteWidth(paletteWidth, false);
  const onSplitterDown = (event: PointerEvent) => {
    const splitter = (event.target as Element | null)?.closest('.archi-palette-splitter') as HTMLElement | null;
    if (!splitter || event.button !== 0) return;
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    const startX = event.clientX, startWidth = paletteWidth;
    const move = (next: PointerEvent) => setPaletteWidth(startWidth + next.clientX - startX, false);
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      setPaletteWidth(paletteWidth, true);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  };
  const onSplitterKey = (event: KeyboardEvent) => {
    if (!(event.target as Element | null)?.closest('.archi-palette-splitter')) return;
    const step = event.key === 'ArrowRight' ? 28 : event.key === 'ArrowLeft' ? -28 : 0;
    if (step === 0) return;
    event.preventDefault();
    setPaletteWidth(paletteWidth + step, true);
  };
  host.addEventListener('pointerdown', onSplitterDown);
  host.addEventListener('keydown', onSplitterKey);

  // Whether a gesture is under way. archi-online cancels a drag whose model is replaced while
  // it runs, so the workbench holds a change from the file back until the pointer is let go.
  let pressed = false;
  const onPress = () => { pressed = true; };
  const onRelease = () => {
    if (!pressed) return;
    pressed = false;
    options.onIdle?.();
  };
  host.addEventListener('pointerdown', onPress, true);
  window.addEventListener('pointerup', onRelease, true);
  window.addEventListener('pointercancel', onRelease, true);

  const draw = () => {
    if (!root) return;
    root.render(createElement(ModelStoreProvider, { store, children: [
      createElement('div', { key: 'palette', className: 'archi-palette' }, createElement(Palette)),
      createElement('div', { key: 'splitter', className: 'archi-palette-splitter', role: 'separator', tabIndex: 0,
        'aria-orientation': 'vertical', 'aria-label': 'Palette width', 'aria-valuemin': PALETTE_MIN, 'aria-valuemax': PALETTE_MAX,
        'aria-valuenow': paletteWidth }),
      createElement('div', { key: 'canvas', className: 'archi-editor-canvas' },
        viewId ? createElement(ViewEditor, { key: viewId, viewId }) : null),
      createElement('div', { key: 'style', className: 'archi-style', hidden: !styleShown }, createElement(StylePanel)),
      createElement(ContextMenuHost, { key: 'menus' }),
      // archi-online asks through its own dialogs, which its app shell hosts: which relationship a
      // box dropped into an element box stands for (W-113). Without the host the question waited
      // forever and the move never landed.
      createElement(AppDialogHost, { key: 'dialogs' }),
    ] }));
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (quiet) return;
    if (state.model !== previous.model && state.model) {
      const label = state.undoStack.at(-1)?.label ?? null;
      options.onChange?.(state.model, state.historyRevision > previous.historyRevision ? label : null);
    }
    if (state.selection !== previous.selection && state.selection.source === 'view') options.onSelect?.(state.selection.ids);
    if (state.activeViewId !== previous.activeViewId && state.activeViewId && state.activeViewId !== viewId) options.onOpenView?.(state.activeViewId);
  });

  const zoomButton = (index: number) => host.querySelectorAll<HTMLButtonElement>('.zoom-controls .zoom-btn')[index]?.click();

  return {
    show(id: string) {
      viewId = id;
      quiet = true;
      try { openView(id, store); } finally { quiet = false; }
      draw();
    },
    viewId: () => viewId,
    /** Start again from a model read from the file: nothing waits to be committed afterwards. */
    reset(next: ModelState) {
      quiet = true;
      try {
        store.setState({ model: structuredClone(next), undoStack: [], redoStack: [], historyRevision: 0, savedRevision: 0, dirty: false });
      } finally { quiet = false; }
      draw();
    },
    model: () => store.getState().model!,
    canUndo: () => store.getState().undoStack.length > 0,
    canRedo: () => store.getState().redoStack.length > 0,
    undo: () => undo(store),
    redo: () => redo(store),
    /** Select objects on the view, as a selection made in the tree. */
    select(ids: string[]) {
      // The editor's own selection is the view's, with its handles; handing it back as the tree's
      // would take them away between a click and the drag that follows it.
      const current = store.getState().selection.ids;
      if (current.length === ids.length && current.every((id, index) => id === ids[index])) return;
      quiet = true;
      try { setSelection('tree', ids, store); } finally { quiet = false; }
    },
    setReadOnly(readOnly: boolean) { store.setState({ readOnly }); },
    /** An arrange command on what is selected on the view (W-113); a sentence when it does not suit. */
    arrange(command: ArrangeCommand) {
      if (!viewId) return 'Open a view to arrange it.';
      const refusal = arrangeIn(store, viewId, store.getState().selection.ids, command);
      if (refusal === null) host.querySelector<SVGElement>('.view-svg')?.focus();
      return refusal;
    },
    /** The ids selected on the view. */
    selected: () => [...store.getState().selection.ids],
    /** The Appearance panel beside the view, shown or not (W-114). */
    showStyle(on: boolean) { styleShown = on; draw(); },
    styleShown: () => styleShown,
    zoomIn: () => zoomButton(2),
    zoomOut: () => zoomButton(0),
    zoomActual: () => zoomButton(1),
    fit: () => zoomButton(3),
    zoom: () => Number(/(\d+)%/.exec(host.querySelector('.zoom-controls .zoom-pct')?.textContent ?? '')?.[1] ?? 100) / 100,
    busy: () => pressed,
    destroy() {
      unsubscribe();
      host.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('pointercancel', onRelease, true);
      host.removeEventListener('pointerdown', onSplitterDown);
      host.removeEventListener('keydown', onSplitterKey);
      root?.unmount();
      root = null;
      host.classList.remove('archi-editor');
    },
  };
}
