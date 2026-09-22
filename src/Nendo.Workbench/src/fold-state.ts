import { sectionFolds } from './app-state';
import type { SurfaceNodePlan } from './host';

/**
 * Whether a section is open on the page in front of the person (ADR-0004, 2026-09-20
 * amendment).
 *
 * Two things answer it, one stored and one not. An author says how a section starts
 * with `opens`, and that is in the file. What the person has done since -- folded this
 * one, opened that one -- is their own view of the page: file-scoped renderer state
 * like a selected tab, cleared when the file is, never durable. A closed section reads
 * nothing: the walkers that decide what a page is still waiting for stop at it.
 */
export function sectionIsOpen(node: SurfaceNodePlan): boolean {
  const folded = sectionFolds.get(node.semanticId);
  if (folded !== undefined) return folded === 'open';
  return node.properties.opens !== 'closed';
}

/** Remember what the person did with a section, for this file and this session only. */
export function foldSection(sectionId: string, open: boolean): void {
  sectionFolds.set(sectionId, open ? 'open' : 'closed');
}
