/**
 * What a new file of the open application keeps (ADR-0022), as Studio and the File menu say
 * it. A record type has a default, kept or left out; a record may say otherwise or follow the
 * type. The File menu names one new file by the application's own label, or "New empty copy".
 */

/** The three things a Studio cell can say a record does: follow its type, or one of the two marks. */
export type KeptChoice = 'Follows type' | 'Kept' | 'Left out';

export const keptChoices: readonly KeptChoice[] = ['Follows type', 'Kept', 'Left out'];

/** The menu entry for a new file of this application, from its label. */
export function newFileMenuLabel(label: string | null | undefined): string {
  return label ? `New ${label}…` : 'New empty copy…';
}

/** A record's own mark as a cell's choice. */
export function keptChoice(own: boolean | null | undefined): KeptChoice {
  return own === true ? 'Kept' : own === false ? 'Left out' : 'Follows type';
}

/** The mark a chosen cell value writes: true, false, or null to follow the type. */
export function keptFromChoice(choice: unknown): boolean | null {
  if (choice === 'Kept') return true;
  if (choice === 'Left out') return false;
  if (choice === 'Follows type') return null;
  throw new Error('Choose Kept, Left out or Follows type.');
}

/** What a cell reads: the record's own mark, or what its type gives it. */
export function keptText(typeKeeps: boolean, own: boolean | null | undefined): string {
  if (own === true) return 'Kept';
  if (own === false) return 'Left out';
  return typeKeeps ? 'Kept (type)' : 'Left out (type)';
}

/** The sentence beside a record type's toggle. */
export function keptDefaultSentence(displayName: string, typeKeeps: boolean): string {
  return typeKeeps
    ? `A new file of this application keeps ${displayName} records, unless a record says otherwise.`
    : `A new file of this application leaves ${displayName} records out, unless a record says otherwise.`;
}

/**
 * Turning a record type's default is a change to what the application ships with, so it
 * arrives as one reviewed operation the person accepts, as every definition change does.
 */
export function keptDefaultProposal(entityId: string, displayName: string, kept: boolean,
  expectedDefinitionRevision: number): Record<string, unknown> {
  const title = kept ? `Keep ${displayName} records in new files` : `Leave ${displayName} records out of new files`;
  const id = crypto.randomUUID().replaceAll('-', '');
  return { proposalId: `proposal-${id}`, title, mutations: [{ idempotencyKey: `kept-${id}`, description: title,
    operations: [{ operationId: `kept-${id}`, operationType: 'schema.setKeptInNewFiles',
      payload: { entityId, kept, expectedDefinitionRevision } }],
  }] };
}
