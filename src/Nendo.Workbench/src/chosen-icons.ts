import { iconGroups, iconSet, type SetIcon } from './icon-set';

/**
 * The icons a record type or a screen can carry (ADR-0038): the curated set the file names an icon
 * from. A name this Nendo does not know is treated as no choice, so a file written by a newer Nendo
 * shows its guessed icons here.
 */

const byName = new Map(iconSet.map(item => [item.name, item]));

export { iconGroups, iconSet, type SetIcon };

/** The name if it is one of the set's, else null. */
export function knownIcon(name: unknown): string | null {
  return typeof name === 'string' && byName.has(name) ? name : null;
}

/** One icon of the set, drawn as Nendo's outline icons are. */
export function setIconMarkup(name: string): string {
  const found = byName.get(name);
  return `<svg class="outline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${found?.drawing ?? ''}</svg>`;
}

/** The icons that answer a search, by name or search word, in one group or all of them. */
export function findIcons(query: string, group: string | null): SetIcon[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(word => word !== '');
  return iconSet.filter(item => (group === null || item.group === group)
    && words.every(word => item.name.includes(word) || item.words.split(' ').some(term => term.startsWith(word))));
}
