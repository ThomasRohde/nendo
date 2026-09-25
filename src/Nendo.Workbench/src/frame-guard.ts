/**
 * Nendo Studio never runs inside a frame (ADR-0013).
 *
 * A custom view is a frame in this page, and a frame can hold frames of its own. Were one of
 * them this document, it would be a second Workbench with the host bridge, under a view's
 * control. The host cancels any frame navigation to the Workbench's origin; this is the
 * second lock. main.ts imports it first, so when it throws nothing else has run: no bridge
 * listener, no client, no page. The root says so, for the guards that look.
 */
export function refuseFraming(target: Window & typeof globalThis): void {
  if (target.top === target) return;
  target.document.documentElement.dataset.framed = 'refused';
  target.document.body?.replaceChildren();
  throw new Error('Nendo Studio does not run inside a frame.');
}

refuseFraming(window);
