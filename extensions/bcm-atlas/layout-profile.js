// Exact defaultOptions from the owner's BCM layout lab, core.mjs (2026-09-26).
// Search limits and synthetic-root geometry intentionally use the reference defaults.
export const labOptions = Object.freeze({
  mode: 'compact',
  objective: 'frame',
  aspectRatio: 16 / 9,
  leafWidth: 160,
  leafHeight: 56,
  padding: 8,
  headerHeight: 24,
  gap: 8,
  gridSize: 8,
});

export function layoutCapabilities(engine, tree, mode = labOptions.mode) {
  return engine.layoutBcm(tree, { ...labOptions, mode });
}

// Camera only: do not change the lab's coordinates or reserve space for its
// invisible synthetic root. Fit the visible rectangles to a 12px canvas inset.
export function fitViewport(layout, viewport) {
  const nodes = layout.nodes.filter(node => !node.synthetic);
  if (!nodes.length || viewport.width <= 24 || viewport.height <= 24) return null;
  const left = Math.min(...nodes.map(node => node.x));
  const top = Math.min(...nodes.map(node => node.y));
  const right = Math.max(...nodes.map(node => node.x + node.width));
  const bottom = Math.max(...nodes.map(node => node.y + node.height));
  const width = right - left, height = bottom - top;
  const zoom = Math.min((viewport.width - 24) / width, (viewport.height - 24) / height);
  return {
    zoom,
    pan: {
      x: (viewport.width - width * zoom) / 2 - left * zoom,
      y: (viewport.height - height * zoom) / 2 - top * zoom,
    },
  };
}
