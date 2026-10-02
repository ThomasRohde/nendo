import { focusWithoutInteraction, requiredElement } from './shell';

/**
 * The breadcrumb as the place to choose where you are (ADR-0013, 2026-09-28; W-092).
 *
 * On a Use screen the top bar's breadcrumb already named the record type and the view, and the
 * Use toolbar below named them again as Showing and View. Now the two names in the breadcrumb
 * are the pickers, and the Use toolbar keeps only what acts on the screen: a custom view's
 * controls and Add share its one row.
 *
 * The Use page and the front page draw the pickers on every redraw, as they drew them in their
 * toolbar before. A redraw that draws none, anywhere else in Nendo, leaves the plain breadcrumb:
 * render() calls beginPlacePickers before the page and endPlacePickers after it. The header's
 * elements are looked up when first needed, so a suite can load this module without a page.
 *
 * Choosing where you are is not editing, so the read-only sweep, which covers the page, leaves
 * the pickers alone: a file that cannot be edited can still be read screen by screen. The busy
 * sweep holds the record-type picker while an action runs, as it did in the Use toolbar.
 */

let drawn = false;

function header(): { slot: HTMLElement; eyebrow: HTMLElement; title: HTMLElement } {
  return {
    slot: requiredElement<HTMLElement>('#place-pickers'),
    eyebrow: requiredElement<HTMLElement>('#session-context'),
    title: requiredElement<HTMLElement>('#workspace-title'),
  };
}

export function beginPlacePickers(): void {
  drawn = false;
}

/**
 * Put the pickers in the breadcrumb, in place of its two names. The heading stays for a screen
 * reader, which hears the page's name as before. The control that had focus keeps it.
 */
export function drawPlacePickers(markup: string): HTMLElement {
  const { slot, eyebrow, title } = header();
  const active = document.activeElement;
  const hadEntity = active instanceof HTMLElement && slot.contains(active) && active.id === 'use-entity';
  const hadView = active instanceof HTMLElement && slot.contains(active) && active.matches('.surface-picker summary');
  slot.innerHTML = markup;
  slot.hidden = false;
  eyebrow.hidden = true;
  title.classList.add('visually-hidden');
  drawn = true;
  if (hadEntity) focusWithoutInteraction(slot.querySelector<HTMLElement>('#use-entity'));
  else if (hadView) focusWithoutInteraction(slot.querySelector<HTMLElement>('.surface-picker summary'));
  return slot;
}

/** After the page is drawn: a page that drew no pickers gets the plain breadcrumb back. */
export function endPlacePickers(): void {
  if (drawn) return;
  const { slot, eyebrow, title } = header();
  if (slot.firstChild !== null) slot.replaceChildren();
  slot.hidden = true;
  eyebrow.hidden = eyebrow.textContent === '';
  title.classList.remove('visually-hidden');
}

/** Whether the page last drawn put its pickers in the breadcrumb, so the header leaves them alone between draws. */
export function placePickersDrawn(): boolean {
  return drawn;
}
