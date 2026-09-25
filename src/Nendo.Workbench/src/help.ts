import { clientHelp } from './client-help';
import { conceptHelp } from './help-concepts';
import { agentHelp } from './help-agents';
export { setupRequest } from './client-help';
export { agentSurface } from './help-agents';
import type { ApplicationPlan, EntitySnapshot } from './host';

export interface HelpTerm { term: string; meaning: string; code?: boolean }
export interface HelpSection { heading: string; paragraphs?: string[]; steps?: string[]; terms?: HelpTerm[] }
export interface HelpTopic { id: string; title: string; category: string; summary: string; sections: HelpSection[]; setupRequest?: string; related?: string[] }
export interface HelpContext { entities: EntitySnapshot[]; applications?: ApplicationPlan[]; fileName: string | null }
export type HelpProvider = (context: HelpContext) => HelpTopic[];

/** Index order. A category a host provider adds without naming it here follows these, in first-seen order. */
export const helpCategoryOrder: readonly string[] = ['Getting started', 'How Nendo works', 'Everyday work', 'Agents', 'About this app'];

export function groupHelpTopics(topics: readonly HelpTopic[]): Array<{ category: string; topics: HelpTopic[] }> {
  const groups = new Map<string, HelpTopic[]>();
  for (const topic of topics) {
    const group = groups.get(topic.category);
    if (group) group.push(topic); else groups.set(topic.category, [topic]);
  }
  const rank = (category: string): number => { const index = helpCategoryOrder.indexOf(category); return index === -1 ? helpCategoryOrder.length : index; };
  return [...groups].map(([category, items]) => ({ category, topics: items })).sort((a, b) => rank(a.category) - rank(b.category));
}

/** Everything a search may match: title, category, summary, headings, paragraphs, steps and terms. */
export function helpSearchText(topic: HelpTopic): string {
  return [topic.title, topic.category, topic.summary, ...topic.sections.flatMap(section => [section.heading,
    ...(section.paragraphs ?? []), ...(section.steps ?? []), ...(section.terms ?? []).flatMap(term => [term.term, term.meaning])])]
    .join(' ').toLocaleLowerCase();
}

function rootTitle(app: ApplicationPlan, kind: string): string | null {
  const root = app.surfaces.find(node => node.kind === kind);
  const title = root?.properties.title ?? root?.properties.label;
  return typeof title === 'string' ? title : null;
}

const coreHelp: HelpProvider = () => [
  { id: 'start', title: 'Find your way around', category: 'Getting started', summary: 'Files, Studio and your everyday screens.', related: ['overview', 'records', 'files'], sections: [
    { heading: 'One file holds your app', paragraphs: ['A .nendo file holds your record types, records, screens and change history. Keep it in a local folder. Nendo saves successful edits automatically; there is no separate Save file command.'] },
    { heading: 'Start with your data', steps: ['Choose File → New file when no file is open. Choose a local folder and file name.', 'In Studio → Data, click Create record type. Enter a name such as Entry and a first field such as Title, then review and accept the proposal.', 'Click Add followed by the record type name. Enter the values and click the form’s Add button.', 'Use opens the screens configured for this file. Studio is always available for inspecting the underlying data.'] },
    { heading: 'Where to go', paragraphs: ['Data shows records. Structure shows record types and fields. Surfaces shows how screens are defined. History shows saved changes and available compensation. Health shows file condition and recovery options. Agent controls local agent access.'] },
    { heading: 'Custom views', paragraphs: [
      'A custom view is a screen, or a panel on a record page, drawn by code the file itself carries: a graph of linked records, a Gantt chart, a map. It runs inline, where its screen or record page puts it, as soon as it is shown. There is nothing to install and nothing to allow. Its code came into the file through a proposal whose lines were reviewed, and a copy of the file carries it.',
      'A view reads the file through the same typed services Studio uses, calculated fields and exact numbers included. It can open a record, a screen or Studio and show a short message; in this version it cannot change records. It is a web page in a frame of its own, so it can also reach the network and the clipboard. A view that stops answering says so, with Stop and Reload, and the rest of Nendo keeps working.',
      'Two switches decide whether views run, both kept on this computer: Run custom views, for every file, and one for each file. They are under Studio → Surfaces → Custom views, which File → Custom views opens. Views never run in safe mode, during recovery, while a file needs attention, or after Restart without custom views. The same panel imports a package from a folder, a .zip or a .nendoview file, exports one to a folder, and removes one; importing and removing are proposals you review.',
    ] },
  ] },
  { id: 'csv', title: 'Import and export CSV', category: 'Everyday work', summary: 'Map columns, review new records and preserve exact values.', related: ['data-model', 'files'], sections: [
    { heading: 'Import step by step', steps: ['Choose File → Import CSV, select the destination record type, then choose a .csv file.', 'Choose External CSV for literal text or Nendo CSV for a faithful Nendo export. In External CSV, explicitly choose whether empty cells mean null. Map each required field to its source column.', 'Click Validate first batch. Review every displayed row and typed value: null and quoted empty text are different. Import creates new records; it never merges with existing records.', 'Click Import to commit that whole batch, or Cancel remaining import. Batches contain at most 100 rows. Cancelling leaves earlier accepted batches committed. History records each accepted batch.'] },
    { heading: 'Faithful export', steps: ['Choose File → Export CSV and select the record type.', 'Read the profile explanation, choose a local destination folder and enter a new .csv file name.', 'To import this export, choose the Nendo CSV profile. Null uses \\N; literal leading backslashes are doubled. Text whitespace, quotes, newlines, exact numbers and formula-like text are preserved. Choices and references use stable IDs.'] },
    { heading: 'Limits and interrupted work', paragraphs: ['Import accepts UTF-8 files up to 16 MiB, 10,000 rows, 100 columns and 64 Ki characters per cell. Malformed rows are rejected, never silently skipped. Use Cancel during reading or export to stop.', 'Each accepted batch has a durable receipt. Nendo checks the receipt after an interrupted acknowledgement. If the entire app closes, inspect the CSV History entries before importing those rows again. A CSV export is not a backup and does not restore record IDs or history.'] },
  ] },
  { id: 'files', title: 'Files, copies and recovery', category: 'Everyday work', summary: 'Choose the right kind of copy and recover safely.', related: ['one-file', 'history'], sections: [
    { heading: 'Open and close', paragraphs: ['File → Open file switches to a chosen file. Close file returns to the start screen. New file is available there. If you open File and change your mind, click outside it, press Escape, or tab away.'] },
    { heading: 'Choose a copy', paragraphs: ['Create backup saves a recovery copy. Duplicate creates another instance of the same application, retaining its history. Fork starts a separate application identity from the current content. Each action asks you for a destination.', 'Restore backup replaces the current file with a chosen backup and retains a copy of the previous file. Read its confirmation carefully. Review recovery record handles an interrupted file replacement.'] },
    { heading: 'When something fails', paragraphs: ['Do not assume a failed or timed-out save was not applied. Follow the pending-save notice to check its outcome. Health and the native recovery view remain available if a custom screen or renderer fails. Use Create backup before further recovery work.'] },
  ] },
  { id: 'records', title: 'Edit, move and undo changes', category: 'Everyday work', summary: 'Use a board, list, form or Studio table.', related: ['data-model', 'history', 'lanes'], sections: [
    { heading: 'Edit records', paragraphs: ['In Studio → Data, double-click a cell, edit it and press Enter. In Use, click a record to open its form, edit the fields and click Save changes. Saving an untouched form makes no new change.'] },
    { heading: 'Fold a section away', paragraphs: ['Press a section’s heading on a record page or the front page to fold it away, and again to open it; Enter or Space does the same from the keyboard. A folded section reads nothing until you open it, so a long page costs only what you are looking at. Whether a section starts open or closed is decided by whoever built the screen; what you fold stays as you left it on this computer, also after you close and reopen the file, and is never written to the file.'] },
    { heading: 'Require a value', steps: ['Open Studio → Structure and choose Make required beside the field.', 'If records have no value, enter a value for each listed record. For a reference, click Choose record and select its target. Nothing is filled automatically.', 'Click Preview changes, review the proposal, then accept or reject it. More than 50 missing records are handled in separate reviewed batches; return to Make required to continue.', 'Make optional relaxes the requirement through review. Reactivating a retired required field uses the same missing-value form.'] },
    { heading: 'Retire a field or record type', steps: ['Open Studio → Structure. Choose Retire beside a field, or Retire record type, and review the proposal.', 'Retirement keeps stored data but prevents ordinary edits to the retired definition. In Data, select Show retired data to inspect it.', 'Return to Structure and choose Reactivate to restore availability. If new records lack a retired required field, an explicit reviewed backfill is needed before reactivation.', 'If a surface uses the definition, retirement is rejected. Ask an agent to propose removal or replacement of those bindings in the same change set. Incoming references must also be repaired before retiring their target type.'] },
    { heading: 'Rename or retire a choice', steps: ['Open Studio → Structure and choose the record type.', 'Beside a choice field, click Edit choices. Select an option, change its display label or select Retired, then click Preview choice change.', 'Review and accept the proposal. A renamed choice keeps the same stored ID and board column membership. A retired choice remains visible on existing records but cannot be newly selected or used as a drop target.', 'To make it available again, return to Edit choices, clear Retired and review the new proposal.'] },
    { heading: 'Delete and restore a record', steps: ['In Studio → Data, select the record type and click Open beside the record.', 'Click Delete record… below the fields. Read the confirmation, then choose Delete record. Cancel or Escape leaves the record unchanged.', 'If another record references it, Nendo rejects deletion. Open those records and clear optional references or choose another target first.', 'To restore a deleted record, open History. Find its Delete entry and click Compensate. Nendo restores its saved values only if the current schema and reference targets still permit it; the record receives a new version.'] },
    { heading: 'Move a card', paragraphs: ['Hold the left mouse button on a card, move it over a named column, then release. Nendo saves the grouping field automatically. Escape cancels the gesture. Save or close unfinished form edits before dragging.', 'Ungrouped contains records whose grouping value is missing or outside the board’s named groups. Drag one to a named column to assign it. Page counts describe the current page, not necessarily the entire file.'] },
    { heading: 'Undo where supported', paragraphs: ['Open History, find the change and choose Compensate when available. This creates a new change reversing supported effects if the current state still permits it. Some structure changes are not compensatable. This is not universal undo.'] },
  ] },
];

const presentationLabels: Record<string, string> = { singleLine: 'short text', longText: 'long text', singleChoice: 'choose one option', date: 'date', rating: 'rating on a scale' };

// Providers are host-owned code. Application content is always plain text, never executable help.
const applicationHelp: HelpProvider = ({ entities, applications, fileName }) => entities.map(entity => ({
  id: `entity:${entity.entityId}`, title: entity.displayName, category: 'About this app',
  summary: `Records and fields in ${fileName ?? 'this file'}.`, sections: [
    { heading: 'Work with these records', paragraphs: [entity.retired ? `This record type is retired. Open Studio → Data and select Show retired data to inspect ${entity.displayName}. Reactivate it in Structure before editing.` : `Open Studio → Data and select ${entity.displayName}. Click Add ${entity.displayName} to create a record. This reference is generated from the current file, including record types and fields added by you or an agent.`] },
    { heading: 'Fields', paragraphs: [
      ...entity.fields.map(field => {
        const target = field.reference ? entities.find(candidate => candidate.entityId === field.reference?.targetEntityId) : undefined;
        return `${field.displayName}: ${field.retired ? 'retired, ' : ''}${field.required ? 'required' : 'optional'}`
          + (field.presentation ? `, ${presentationLabels[field.presentation] ?? 'value'}` : '')
          + (field.reference ? `, reference to ${target?.displayName ?? field.reference.targetEntityId}` : '')
          + (field.options.length ? `. Choices: ${field.options.map(id => { const choice = field.choices?.find(choice => choice.id === id); return `${choice?.displayName ?? id}${choice?.retired ? ' (retired)' : ''}`; }).join(', ')}` : '')
          + '.';
      }),
      ...(entity.derivedFields ?? []).map(field => `${field.displayName}: calculated, shown but never typed in.`),
    ] },
    ...(applications ?? []).filter(app => app.entity.semanticId === entity.entityId).map(app => ({ heading: 'Screens and actions', paragraphs: [
      `Open Use and select ${entity.displayName} in Record type. ${[rootTitle(app, 'recordForm'), rootTitle(app, 'recordList'), rootTitle(app, 'boardSurface')].filter(Boolean).map(title => `“${title}”`).join(', ') || 'Select a record to use its configured action.'}`,
      rootTitle(app, 'recordCommand') ? `Open a record to use “${rootTitle(app, 'recordCommand')}”. Changes are saved in History.` : 'This record type has no configured action.',
      app.surfaces.some(node => node.kind === 'recordForm' || node.kind === 'detailSurface') ? 'Record details use the configured form.' : 'Record details use the Studio editor because this type has no custom form.',
    ] })),
  ],
}));

export const helpProviders: readonly HelpProvider[] = [coreHelp, conceptHelp, clientHelp, agentHelp, applicationHelp];
export function helpTopics(context: HelpContext, providers: readonly HelpProvider[] = helpProviders): HelpTopic[] {
  const topics = providers.flatMap(provider => provider(context));
  if (new Set(topics.map(topic=>topic.id)).size !== topics.length) throw new Error('Help topic IDs must be unique.');
  return topics;
}
