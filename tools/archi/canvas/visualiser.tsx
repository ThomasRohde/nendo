// The Archi workbench's Analysis and Visualiser (W-118): archi-online's own model relations, views
// in use and semantic graph (src/model/analysis.ts, analysis-graph.ts), its layout request, laid out
// by ELK in the worker (elk.ts), and its VisualiserCanvas, all run on the mirror of the file's
// records. The controls around the drawing are the workbench's (view.js), as the validator's list
// is: archi-online's VisualiserPanel reads the selection and its preferences from stores of its own
// app, which the workbench does not run.

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelState } from '@archi/model/types';
import { buildAnalysisGraph, type AnalysisGraphOptions, type AnalysisGraphResult } from '@archi/model/analysis-graph';
import { layoutElkGraph, type ElkGraphLayoutResult } from '@archi/model/layout/elk-graph';
import { VisualiserCanvas } from '@archi/ui/visualiser/VisualiserCanvas';
import { buildVisualiserLayoutRequest } from '@archi/ui/visualiser/presentation';
import { renderAnalysisGraphSvg } from '@archi/ui/VisualiserPanel';
import { ContextMenuHost } from '@archi/ui/ContextMenu';
import { copyPngBlobToClipboard, rasterizeSvg } from '@archi/canvas/export/svg-image';

export { modelRelations, viewsUsing, findInView } from '@archi/model/analysis';
export { DEFAULT_ANALYSIS_PREFERENCES, normalizeAnalysisPreferences } from '@archi/settings/analysis-preferences';
export { ELEMENT_TYPES, elementLabel, relationshipLabel } from '@archi/model/metamodel';

/** The graph around the focus, as archi-online's Visualiser and Generate View For build it. */
export function analysisGraph(model: ModelState, options: AnalysisGraphOptions): AnalysisGraphResult {
  return buildAnalysisGraph(model, options);
}

/** The graph laid out by ELK, with archi-online's own sizes, ports and spacing. */
export function analysisLayout(graph: AnalysisGraphResult, showRelationshipNames: boolean): Promise<ElkGraphLayoutResult> {
  const request = buildVisualiserLayoutRequest(graph, showRelationshipNames);
  return layoutElkGraph(request.graph, request.options);
}

/** The laid-out graph as archi-online exports it: an SVG document on white. */
export function analysisSvg(graph: AnalysisGraphResult, layout: ElkGraphLayoutResult, showRelationshipNames: boolean): string {
  return renderAnalysisGraphSvg(graph, layout, { showRelationshipNames });
}

/** The same picture as a PNG, at `scale` times its size. */
export function analysisPng(graph: AnalysisGraphResult, layout: ElkGraphLayoutResult, showRelationshipNames: boolean, scale = 2): Promise<Blob> {
  const svg = analysisSvg(graph, layout, showRelationshipNames);
  const size = /<svg[^>]* width="([\d.]+)" height="([\d.]+)"/.exec(svg);
  if (!size) return Promise.reject(new Error('The picture has no size.'));
  return rasterizeSvg(svg, Number(size[1]), Number(size[2]), scale);
}

/** The PNG at twice its size on the clipboard, as a view is copied (W-123). */
export function copyAnalysisPng(graph: AnalysisGraphResult, layout: ElkGraphLayoutResult, showRelationshipNames: boolean) {
  return copyPngBlobToClipboard(analysisPng(graph, layout, showRelationshipNames, 2));
}

interface VisualiserOptions {
  /** A click on a box: select that concept. */
  onSelect?: (id: string) => void;
  /** A double-click, or Open in its menu: make that concept the focus. */
  onOpen?: (id: string) => void;
}

/**
 * archi-online's VisualiserCanvas in `host`, with its context menu: pan, zoom, fit and the keys
 * it answers. `show` draws a graph as laid out; the canvas fits it whenever the graph changes.
 */
export function createVisualiser(host: HTMLElement, options: VisualiserOptions = {}) {
  let root: Root | null = createRoot(host);
  const empty = (text: string) => createElement('div', { key: 'canvas', className: 'visualiser-canvas visualiser-canvas-empty' },
    createElement('p', { className: 'empty-hint' }, text));
  const draw = (content: unknown) => {
    if (!root) return;
    flushSync(() => root!.render([content, createElement(ContextMenuHost, { key: 'menus' })] as never));
  };
  return {
    show(graph: AnalysisGraphResult, layout: ElkGraphLayoutResult, showRelationshipNames: boolean) {
      draw(createElement(VisualiserCanvas, {
        key: 'canvas', graph, layout, showRelationshipNames,
        onSelectConcept: id => options.onSelect?.(id),
        onOpenConcept: id => options.onOpen?.(id),
      }));
    },
    /** A sentence in place of the drawing: nothing selected, laying out, or why it failed. */
    message(text: string) { draw(empty(text)); },
    destroy() { root?.unmount(); root = null; host.replaceChildren(); },
  };
}
