/**
 * One bar above a Use screen, rather than two. The address row holds Back and Forward, the
 * breadcrumb with its pickers and the command box; on a Use screen the toolbar (a view's
 * controls, Filter, the pager, Add) joins it, rather than taking a row of its own below while
 * the breadcrumb's box stretches across the empty middle.
 *
 * Where the window has room, the breadcrumb's box now hugs what it says and the Use toolbar is
 * laid over the free middle of the address row, between that box and the command box: one bar.
 * The toolbar stays where it is in the page, so every control keeps its listeners and every
 * lookup that finds it inside the Use page still does; only its box moves, by CSS
 * (styles/21-native.css, `.workspace-layer[data-one-bar]`). Where the middle cannot hold the whole
 * toolbar, every control of a view's included, the toolbar keeps its own row, as before.
 */

/** Below this width the address row's free middle cannot hold a Use toolbar, and it keeps its row. */
export const minimumWidth = 360;

/**
 * Where the toolbar goes in the address row, from the boxes on either side of it, or null when
 * the middle is narrower than the toolbar needs (`need`, at least `minimumWidth`).
 */
export function oneBarPlace(layer: DOMRect, identity: DOMRect, controls: DOMRect, need = 0, gap = 8): { left: number; right: number } | null {
  const left = Math.round(identity.right - layer.left + gap);
  const right = Math.round(layer.right - controls.left + gap);
  return layer.width - left - right >= Math.max(minimumWidth, need) ? { left, right } : null;
}

/**
 * The width a Use toolbar needs: every group whole, a view's controls included, and the gaps.
 * Joining the address row never puts a control into More that its own row would show,
 * so a view's strip counts at its full width, as if More held nothing.
 */
export function toolbarNeed(toolbar: HTMLElement): number {
  const children = [...toolbar.children] as HTMLElement[];
  const gap = parseFloat(getComputedStyle(toolbar).columnGap) || 0;
  return children.reduce((sum, child) => sum + (child.matches('[data-view-toolbar-slot]') ? stripWidth(child) : child.scrollWidth), 0)
    + gap * Math.max(0, children.length - 1);
}

/** A view's controls laid out whole: each control's width and the strip's gaps, with More hidden. */
function stripWidth(slot: HTMLElement): number {
  const strip = slot.querySelector<HTMLElement>('[data-view-toolbar]');
  if (!strip) return 0;
  const parked = [...strip.querySelectorAll<HTMLElement>(':scope > [data-view-overflow]')];
  const more = strip.querySelector<HTMLElement>(':scope > [data-view-more]');
  const moreHidden = more?.hidden ?? true;
  // Read synchronously and put back before the frame, so the row's own fit sees no change.
  for (const item of parked) item.removeAttribute('data-view-overflow');
  if (more) more.hidden = true;
  const items = [...strip.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.getClientRects().length > 0);
  const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
  const width = items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0) + gap * Math.max(0, items.length - 1);
  for (const item of parked) item.setAttribute('data-view-overflow', '');
  if (more) more.hidden = moreHidden;
  return Math.ceil(width);
}

export function startOneBar(): void {
  const layer = document.querySelector<HTMLElement>('.workspace-layer');
  const header = layer?.querySelector<HTMLElement>(':scope > .workspace-header');
  const identity = header?.querySelector<HTMLElement>('.workspace-identity');
  const controls = header?.querySelector<HTMLElement>('.header-controls');
  const studio = document.getElementById('studio-content');
  if (!layer || !header || !identity || !controls || !studio) return;

  let queued = false;
  const place = (): void => {
    queued = false;
    const toolbar = studio.querySelector<HTMLElement>('.use-page > .use-toolbar');
    if (!toolbar || header.hidden) { clear(); return; }
    // Measure with the breadcrumb's box hugging its content, as it is drawn in one bar.
    layer.dataset.oneBarMeasure = '';
    const spot = oneBarPlace(layer.getBoundingClientRect(), identity.getBoundingClientRect(), controls.getBoundingClientRect(), toolbarNeed(toolbar));
    delete layer.dataset.oneBarMeasure;
    if (!spot) { clear(); return; }
    layer.style.setProperty('--one-bar-left', `${spot.left}px`);
    layer.style.setProperty('--one-bar-right', `${spot.right}px`);
    layer.style.setProperty('--one-bar-top', `${Math.round(identity.getBoundingClientRect().top - layer.getBoundingClientRect().top)}px`);
    layer.dataset.oneBar = '';
  };
  const clear = (): void => {
    delete layer.dataset.oneBar;
    layer.style.removeProperty('--one-bar-left');
    layer.style.removeProperty('--one-bar-right');
    layer.style.removeProperty('--one-bar-top');
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(place);
  };
  new ResizeObserver(schedule).observe(layer);
  new ResizeObserver(schedule).observe(identity);
  // A screen drawn, a picker changed or a toolbar declared changes what stands in the row.
  new MutationObserver(schedule).observe(studio, { childList: true, subtree: true });
  new MutationObserver(schedule).observe(header, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  schedule();
}
