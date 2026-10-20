import { optionsMarkup } from './agent-chat-model';
import type { AgentOption } from './host-types';

/**
 * The launched agent's own options (model, effort, mode and whatever else it offers), as the
 * Agent page draws and sets them (ADR-0030, ADR-0033). They are set there and nowhere else: the
 * conversation tab and custom views have none.
 *
 * A box carries `data-agent-options`. Its markup is written only when it changed and nothing in
 * it is in use, because the page redraws as the agent works and an open list or More panel
 * would close under the person.
 */

/** Write the options into `box`, unless they are as drawn or the person is using them. */
export function patchAgentOptions(box: HTMLElement, options: readonly AgentOption[], ended: boolean): void {
  const html = ended ? '' : optionsMarkup([...options]);
  const inUse = box.contains(document.activeElement) || box.querySelector('details[open]') !== null;
  if (html === box.dataset.drawn || inUse) return;
  box.innerHTML = html;
  box.dataset.drawn = html;
}

/**
 * Set an option as the person picks it. Chromium on Windows changes a closed select on each
 * arrow key and fires change at once, so the first arrow chose the agent's option (Allow All
 * among them), closed More and dropped focus. A change made with the keys waits for Enter, or for
 * focus to leave. `commit` answers false when the agent refused, and the agent's own value is
 * drawn again.
 */
export function wireAgentOptions(
  box: HTMLElement,
  options: () => readonly AgentOption[],
  commit: (option: AgentOption, value: string, label: string) => Promise<boolean>,
): void {
  const choose = (select: HTMLSelectElement, keyed: boolean): void => {
    const option = options().find((candidate) => candidate.id === select.dataset.configId);
    if (option === undefined || select.value === option.currentValue) return;
    // A pick from the open list in More is the person done with it; a key keeps them in it.
    const more = select.closest<HTMLDetailsElement>('details.chat-more');
    if (more !== null && !keyed) more.open = false;
    void commit(option, select.value, select.selectedOptions[0]?.text ?? select.value).then((done) => {
      if (done) return;
      delete box.dataset.drawn;
      patchAgentOptions(box, options(), false);
    });
  };
  box.addEventListener('keydown', (event) => {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (select === null || select.dataset.configId === undefined) return;
    if (event.key === 'Enter') { event.preventDefault(); select.dataset.keyed = ''; choose(select, true); return; }
    if (event.key === 'Escape') { revertLooked(select, options()); return; }
    // Space opens the list, whose own keys never reach the select; a pick there is a pick.
    if (!event.altKey && (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || event.key.startsWith('Page') || (event.key.length === 1 && event.key !== ' '))) select.dataset.keyed = 'yes';
  });
  box.addEventListener('pointerdown', (event) => {
    if (event.target instanceof HTMLSelectElement) event.target.dataset.keyed = '';
  });
  box.addEventListener('focusout', (event) => {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (select === null || select.dataset.configId === undefined || select.dataset.keyed !== 'yes') return;
    select.dataset.keyed = '';
    choose(select, true);
  });
  box.addEventListener('change', (event) => {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (select === null || select.dataset.configId === undefined || select.dataset.keyed === 'yes') return;
    choose(select, false);
  });
}

/** A select's value only looked at with the arrow keys, put back to the agent's own. */
function revertLooked(select: HTMLSelectElement, options: readonly AgentOption[]): void {
  if (select.dataset.keyed !== 'yes') return;
  select.dataset.keyed = '';
  const option = options.find((candidate) => candidate.id === select.dataset.configId);
  if (option !== undefined) select.value = option.currentValue;
}

/**
 * The More panel closes when the person is done with it: a press anywhere else, Escape, or a
 * choice in it. Escape closes the panel and does nothing else; a value only looked at with the
 * arrow keys goes back to the agent's own, so leaving does not pick it. Installed once.
 */
export function installAgentOptionKeys(options: () => readonly AgentOption[]): void {
  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Node ? event.target : null;
    for (const more of document.querySelectorAll<HTMLDetailsElement>('[data-agent-options] details.chat-more[open]')) {
      if (target === null || !more.contains(target)) more.open = false;
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const more = document.querySelector<HTMLDetailsElement>('[data-agent-options] details.chat-more[open]');
    if (more === null) return;
    const looked = document.activeElement;
    if (looked instanceof HTMLSelectElement && more.contains(looked)) revertLooked(looked, options());
    event.preventDefault();
    event.stopImmediatePropagation();
    more.open = false;
    more.querySelector('summary')?.focus();
  }, true);
}
