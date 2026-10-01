// The Archi workbench's canvas (W-110): archi-online's own static view renderer, figures,
// icons, connection routes and Manhattan router, drawn from the mirror of Archi.nendo's records.
// tools/archi/build-canvas.mjs bundles this with React into extensions/archi/canvas.js.
//
// React draws the content once per model; pan and zoom move one transform, so a large view
// pans without drawing again. Hit-testing uses the same geometry the drawing does.

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { Bounds, ModelState } from '@archi/model/types';
import { StaticViewContent } from '@archi/canvas/export/StaticViewSvg';
import { renderViewSvg } from '@archi/canvas/export/view-image';
import { copyPngBlobToClipboard, rasterizeSvg, supportsPngClipboard } from '@archi/canvas/export/svg-image';
import { computeAbsBounds } from '@archi/canvas/view-editor/bounds';
import { createConnectionRouteResolver, type Point } from '@archi/canvas/geometry';
import { createNestedConnectionVisibilityResolver } from '@archi/model/ops';
import { DEFAULT_SETTINGS } from '@archi/settings/app-settings';
import { buildMirror, type RecordSets } from './mirror';
import { applyWrites, toRecords, writesFor } from './records';
import { createEditor } from './editor';

export { buildMirror, toRecords, writesFor, applyWrites, createEditor };
// Open and save .archimate files (W-120).
export { readArchimate, planImport, importBatches, holdsNoModel, modelForExport, exportArchimate, leftOutSentence,
  parseArchimateText, ArchimateFileError, recordIdOf } from './io';
// archi-online's own rules, for the lane that checks the editor offers nothing else.
export { validRelationshipTypes } from '@archi/model/rules';
export { RELATIONSHIP_TYPES } from '@archi/model/metamodel';
// archi-online's validator, Archi 5.9's eight checks and its integrity pass, run on the mirror (W-117).
export { VALIDATION_RULES, DEFAULT_VALIDATION_CONFIG, validateModel } from '@archi/model/validation';
declare const __ARCHI_ONLINE_COMMIT__: string;
export const archiOnlineCommit = __ARCHI_ONLINE_COMMIT__;

const SVG = 'http://www.w3.org/2000/svg';
const settings = { ...DEFAULT_SETTINGS, legendLabels: {}, legendUserColors: {} };

/** Every diagram object's bounds on the view, absolute, and every connection's route. */
export function geometry(model: ModelState, viewId: string) {
  const bounds = computeAbsBounds(model, viewId);
  const visible = createNestedConnectionVisibilityResolver(model, settings);
  const route = createConnectionRouteResolver(model, bounds, { isVisible: visible, orthogonalAnchors: settings.useOrthogonalConnectionAnchors, prewarmViewId: viewId });
  const routes = new Map<string, Point[]>();
  for (const connection of Object.values(model.connections)) {
    if (connection.viewId !== viewId) continue;
    const points = route(connection.id);
    if (points) routes.set(connection.id, points);
  }
  return { bounds, routes };
}

/**
 * A view as an image (W-123): archi-online's own export, which draws the view offscreen, turns
 * its labels into SVG text and crops to the drawing with Archi's 10-pixel margin. White or
 * transparent behind it; the figures are Archi's in either theme, as the canvas draws them.
 */
export function viewSvg(model: ModelState, viewId: string, background: 'white' | 'transparent' = 'white') {
  return renderViewSvg(model, viewId, { background, renderSettings: settings });
}

/** The largest scale up to `wanted` that one canvas holds for an image of this size. */
export function pngScale(width: number, height: number, wanted: number) {
  return Math.min(wanted, 16384 / Math.max(width, height), Math.sqrt(64e6 / (width * height)));
}

/** A view as a PNG at a scale, or the largest one a canvas holds, and the size it came out. */
export async function viewPng(model: ModelState, viewId: string, wanted: number, background: 'white' | 'transparent' = 'white') {
  const { svg, width, height } = viewSvg(model, viewId, background);
  const scale = pngScale(width, height, wanted);
  return { blob: await rasterizeSvg(svg, width, height, scale), width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

/** Copies a view to the clipboard as a PNG at a scale, the image handed over as it is drawn. */
export function copyViewPng(model: ModelState, viewId: string, background: 'white' | 'transparent' = 'white', scale = 2) {
  return copyPngBlobToClipboard(viewPng(model, viewId, scale, background).then(png => png.blob));
}
export { supportsPngClipboard };

export function geometryOf(sets: RecordSets, viewId: string) {
  const { bounds, routes } = geometry(buildMirror(sets), viewId);
  return { bounds: Object.fromEntries(bounds), routes: Object.fromEntries(routes) };
}

interface CanvasOptions {
  onSelect?: (id: string | null) => void;
  onOpen?: (id: string) => void;
  onZoom?: (scale: number) => void;
}

const node = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string> = {}) => {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
};

const distanceToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/**
 * A view drawn in `host`, with pan (drag the paper, or the wheel), zoom (Ctrl and the wheel, or
 * the controller), fit, a navigator in the corner and the selection outlined. `show` draws a
 * view of a model; `select` outlines what is selected; a click on the paper selects what is
 * under the pointer, the deepest object first, a connection within a few pixels of its line.
 */
export function createCanvas(host: HTMLElement, options: CanvasOptions = {}) {
  host.classList.add('archi-canvas');
  const stage = node('svg', { class: 'stage', role: 'img' });
  const viewport = node('g', { class: 'viewport' });
  const paper = node('rect', { class: 'paper' });
  const contentId = `archi-content-${Math.random().toString(36).slice(2)}`;
  const content = node('g', { class: 'content', id: contentId });
  const overlay = node('g', { class: 'selection' });
  viewport.append(paper, content, overlay);
  stage.append(viewport);
  const navigator = node('svg', { class: 'navigator', 'aria-hidden': 'true' });
  const navigatorPaper = node('rect', { class: 'navigator-paper' });
  const navigatorUse = node('use', { href: `#${contentId}` });
  const navigatorFrame = node('rect', { class: 'navigator-frame' });
  navigator.append(navigatorPaper, navigatorUse, navigatorFrame);
  host.append(stage, navigator);
  let root: Root | null = createRoot(content);

  let model: ModelState | null = null, viewId: string | null = null;
  let shape = { bounds: new Map<string, Bounds>(), routes: new Map<string, Point[]>() };
  let extent = { x: 0, y: 0, width: 1, height: 1 };
  let scale = 1, tx = 0, ty = 0;
  // Until the person moves the camera, the view stays fitted, whatever size the pane settles at.
  let fitted = true;
  let selected: string[] = [];

  // A pan moves one transform and nothing else. The navigator draws a copy of the whole view,
  // so its frame follows once the camera rests, and the zoom is reported only when it changes.
  let size = { width: 1, height: 1 };
  let reported = NaN;
  let navigatorTimer: ReturnType<typeof setTimeout> | null = null;
  const frameNavigator = () => {
    navigatorTimer = null;
    navigatorFrame.setAttribute('x', String(-tx / scale));
    navigatorFrame.setAttribute('y', String(-ty / scale));
    navigatorFrame.setAttribute('width', String(size.width / scale));
    navigatorFrame.setAttribute('height', String(size.height / scale));
  };
  const apply = () => {
    viewport.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
    if (navigatorTimer === null) navigatorTimer = setTimeout(frameNavigator, 120);
    if (scale !== reported) { reported = scale; options.onZoom?.(scale); }
  };

  const measure = () => {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const b of shape.bounds.values()) { x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height); }
    for (const points of shape.routes.values()) for (const p of points) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); }
    if (!Number.isFinite(x1)) { x1 = 0; y1 = 0; x2 = 400; y2 = 300; }
    extent = { x: x1 - 20, y: y1 - 20, width: x2 - x1 + 40, height: y2 - y1 + 40 };
    for (const rect of [paper, navigatorPaper]) {
      rect.setAttribute('x', String(extent.x)); rect.setAttribute('y', String(extent.y));
      rect.setAttribute('width', String(extent.width)); rect.setAttribute('height', String(extent.height));
    }
    navigator.setAttribute('viewBox', `${extent.x} ${extent.y} ${extent.width} ${extent.height}`);
  };

  const outline = () => {
    overlay.replaceChildren();
    for (const id of selected) {
      const b = shape.bounds.get(id);
      if (b) { overlay.append(node('rect', { x: String(b.x - 2), y: String(b.y - 2), width: String(b.width + 4), height: String(b.height + 4), class: 'selected-box' })); continue; }
      const points = shape.routes.get(id);
      if (points) overlay.append(node('polyline', { points: points.map(p => `${p.x},${p.y}`).join(' '), class: 'selected-line' }));
    }
  };

  const toModel = (clientX: number, clientY: number): Point => {
    const box = stage.getBoundingClientRect();
    return { x: (clientX - box.left - tx) / scale, y: (clientY - box.top - ty) / scale };
  };

  const hit = (p: Point): string | null => {
    let best: string | null = null, bestDistance = 6 / scale;
    for (const [id, points] of shape.routes) {
      for (let i = 1; i < points.length; i++) {
        const d = distanceToSegment(p, points[i - 1], points[i]);
        if (d < bestDistance) { bestDistance = d; best = id; }
      }
    }
    if (best) return best;
    // The deepest object under the point: a nested one is drawn after, and inside, its parent.
    let depthBest = -1;
    for (const [id, b] of shape.bounds) {
      if (p.x < b.x || p.y < b.y || p.x > b.x + b.width || p.y > b.y + b.height) continue;
      let depth = 0;
      for (let at = model?.nodes[id]; at && at.parentId !== at.viewId; at = model?.nodes[at.parentId]) depth++;
      if (depth >= depthBest) { depthBest = depth; best = id; }
    }
    return best;
  };

  const controller = {
    show(nextModel: ModelState, nextViewId: string, { keepCamera = false } = {}) {
      model = nextModel;
      const changedView = viewId !== nextViewId;
      viewId = nextViewId;
      shape = geometry(model, viewId);
      flushSync(() => root!.render(createElement(StaticViewContent, { model: model!, viewId: viewId!, renderSettings: settings })));
      measure();
      selected = selected.filter(id => shape.bounds.has(id) || shape.routes.has(id));
      outline();
      if (changedView || !keepCamera) controller.fit(); else apply();
    },
    select(ids: string[]) { selected = ids; outline(); },
    selected: () => [...selected],
    fit() {
      const box = size;
      // The whole view in the pane, as large as it goes: a small view is enlarged to fill it.
      scale = Math.max(0.1, Math.min(4, box.width / extent.width, box.height / extent.height));
      fitted = true;
      tx = (box.width - extent.width * scale) / 2 - extent.x * scale;
      ty = (box.height - extent.height * scale) / 2 - extent.y * scale;
      apply();
    },
    zoom(factor: number, at?: { x: number; y: number }) {
      const box = size;
      const cx = at?.x ?? box.width / 2, cy = at?.y ?? box.height / 2;
      const next = Math.max(0.1, Math.min(4, scale * factor));
      fitted = false;
      tx = cx - (cx - tx) * (next / scale);
      ty = cy - (cy - ty) * (next / scale);
      scale = next;
      apply();
    },
    pan(dx: number, dy: number) { tx += dx; ty += dy; fitted = false; apply(); },
    reveal(id: string) {
      const b = shape.bounds.get(id);
      if (!b) return;
      const box = size;
      const left = b.x * scale + tx, top = b.y * scale + ty;
      if (left < 0 || top < 0 || left + b.width * scale > box.width || top + b.height * scale > box.height) {
        tx = box.width / 2 - (b.x + b.width / 2) * scale;
        ty = box.height / 2 - (b.y + b.height / 2) * scale;
        apply();
      }
    },
    camera: () => ({ scale, tx, ty }),
    geometry: () => ({ bounds: Object.fromEntries(shape.bounds), routes: Object.fromEntries(shape.routes) }),
    viewId: () => viewId,
    destroy() { root?.unmount(); root = null; host.replaceChildren(); },
  };

  // Pan by dragging the paper: a drag that moves less than four pixels is a click.
  let drag: { x: number; y: number; moved: boolean; pointer: number } | null = null;
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return;
    drag = { x: event.clientX, y: event.clientY, moved: false, pointer: event.pointerId };
  });
  stage.addEventListener('pointermove', event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { drag.moved = true; stage.setPointerCapture(event.pointerId); stage.classList.add('panning'); }
    drag.x = event.clientX; drag.y = event.clientY;
    controller.pan(dx, dy);
  });
  const end = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const clicked = !drag.moved;
    drag = null;
    stage.classList.remove('panning');
    if (clicked && event.type === 'pointerup') options.onSelect?.(hit(toModel(event.clientX, event.clientY)));
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('dblclick', event => {
    const id = hit(toModel(event.clientX, event.clientY));
    if (id) options.onOpen?.(id);
  });
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    if (event.ctrlKey) {
      const box = stage.getBoundingClientRect();
      controller.zoom(Math.exp(-event.deltaY / 400), { x: event.clientX - box.left, y: event.clientY - box.top });
    } else controller.pan(-(event.shiftKey ? event.deltaY : event.deltaX), event.shiftKey ? 0 : -event.deltaY);
  }, { passive: false });
  navigator.addEventListener('pointerdown', event => {
    const box = navigator.getBoundingClientRect();
    const k = Math.max(extent.width / box.width, extent.height / box.height);
    const mx = extent.x + (event.clientX - box.left - (box.width - extent.width / k) / 2) * k;
    const my = extent.y + (event.clientY - box.top - (box.height - extent.height / k) / 2) * k;
    const host = stage.getBoundingClientRect();
    tx = host.width / 2 - mx * scale; ty = host.height / 2 - my * scale;
    apply();
  });
  const resize = () => {
    const box = host.getBoundingClientRect();
    size = { width: Math.max(1, box.width), height: Math.max(1, box.height) };
    if (fitted && model) controller.fit(); else apply();
  };
  resize();
  new ResizeObserver(resize).observe(host);
  return controller;
}
