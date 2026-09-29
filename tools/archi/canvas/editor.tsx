// The Archi workbench's diagram editor (W-111): archi-online's own ViewEditor, Palette and context
// menus, running on an archi-online model store the workbench fills from its mirror of the
// file's records. Every gesture is an archi-online transaction on that store; the workbench
// collects them and, on Commit, writes the difference to the file as one revision
// (records.ts). Undo and Redo are archi-online's own, over what has not been committed.

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelState } from '@archi/model/types';
import { ViewEditor } from '@archi/canvas/ViewEditor';
import { Palette } from '@archi/ui/Palette';
import { ContextMenuHost } from '@archi/ui/ContextMenu';
import { ModelStoreProvider } from '@archi/ui/store-hooks';
import { createModelStore, openView, redo, setActiveModelStore, setSelection, undo, type ModelStore } from '@archi/model/store';

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
}

/**
 * The editor in `host`, for the model `base` as last read from the file. `show` opens a view;
 * `reset` starts again from a new base (after a commit, a discard, or a change from elsewhere
 * when nothing is waiting); `model` is the model with every edit not yet committed.
 */
export function createEditor(host: HTMLElement, base: ModelState, options: EditorOptions = {}) {
  host.classList.add('archi-editor');
  const store: ModelStore = createModelStore({ model: structuredClone(base) });
  setActiveModelStore(store);
  let viewId: string | null = null;
  let root: Root | null = createRoot(host);
  let quiet = false;

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

  const draw = () => {
    if (!root) return;
    root.render(createElement(ModelStoreProvider, { store, children: [
      createElement('div', { key: 'palette', className: 'archi-palette' }, createElement(Palette)),
      createElement('div', { key: 'splitter', className: 'archi-palette-splitter', role: 'separator', tabIndex: 0,
        'aria-orientation': 'vertical', 'aria-label': 'Palette width', 'aria-valuemin': PALETTE_MIN, 'aria-valuemax': PALETTE_MAX,
        'aria-valuenow': paletteWidth }),
      createElement('div', { key: 'canvas', className: 'archi-editor-canvas' },
        viewId ? createElement(ViewEditor, { key: viewId, viewId }) : null),
      createElement(ContextMenuHost, { key: 'menus' }),
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
      quiet = true;
      try { setSelection('tree', ids, store); } finally { quiet = false; }
    },
    setReadOnly(readOnly: boolean) { store.setState({ readOnly }); },
    zoomIn: () => zoomButton(2),
    zoomOut: () => zoomButton(0),
    zoomActual: () => zoomButton(1),
    fit: () => zoomButton(3),
    zoom: () => Number(/(\d+)%/.exec(host.querySelector('.zoom-controls .zoom-pct')?.textContent ?? '')?.[1] ?? 100) / 100,
    destroy() {
      unsubscribe();
      host.removeEventListener('pointerdown', onSplitterDown);
      host.removeEventListener('keydown', onSplitterKey);
      root?.unmount();
      root = null;
      host.classList.remove('archi-editor');
    },
  };
}
