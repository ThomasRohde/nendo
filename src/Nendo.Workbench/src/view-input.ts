/**
 * Whether a key or a menu a view hands back to the Workbench may act now (WXS-08).
 *
 * A key a person presses inside a view's frame, or a right-click there, leaves the frame
 * element as the Workbench's focused element, since the frame's own document is another
 * origin. A key a view posts while the person types in a Nendo field was never pressed in the
 * view: run as Nendo's own, Ctrl+W closed the tab and Alt+ArrowLeft went back with no key
 * pressed there. So a handed-back key runs only while the frame has focus.
 *
 * A menu may also answer a command Nendo just sent the view from Ctrl K, a key the view
 * declared or Nendo's Add, when the Workbench rather than the frame has focus; otherwise a menu that takes
 * focus could catch the person's next Space and pick an item they never chose.
 */
export const menuAfterCommandMs = 2000;

export function viewKeyMayRun(active: Element | null, frame: Element | null): boolean {
  return frame !== null && active === frame;
}

export function viewMenuMayShow(active: Element | null, frame: Element | null, commandAt: number | null, now: number): boolean {
  if (viewKeyMayRun(active, frame)) return true;
  return frame !== null && commandAt !== null && now - commandAt >= 0 && now - commandAt <= menuAfterCommandMs;
}
