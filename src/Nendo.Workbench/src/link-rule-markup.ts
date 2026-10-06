import { escapeHtml } from './format';
import type { EntitySnapshot } from './host-types';

/**
 * What Studio's Structure says about a link rule (ADR-0026), on the record types it touches: on
 * the link type, which links it allows; on the table, whose links its records allow. Declaring
 * or removing one is an authored change set, so the note offers no button. Empty for a record
 * type that is neither.
 */
export function linkRuleNote(entity: EntitySnapshot, entities: readonly EntitySnapshot[]): string {
  const named = (entityId: string) => entities.find(candidate => candidate.entityId === entityId);
  const fieldName = (owner: EntitySnapshot | undefined, fieldId: string) =>
    escapeHtml(owner?.fields.find(field => field.fieldId === fieldId)?.displayName ?? fieldId);
  const notes: string[] = [];
  if (entity.linkRule) {
    const rule = entity.linkRule;
    const table = named(rule.tableEntityId);
    const end = (fieldId: string) => {
      const target = entity.fields.find(field => field.fieldId === fieldId)?.reference?.targetEntityId;
      return target ? named(target) : undefined;
    };
    notes.push(`<p class="link-rule-note" data-link-rule="link"><strong>Allowed links</strong> A record from ${fieldName(entity, rule.sourceFieldId)} ` +
      `to ${fieldName(entity, rule.targetFieldId)} is kept only when ${escapeHtml(table?.displayName ?? rule.tableEntityId)} holds the source’s ` +
      `${fieldName(end(rule.sourceFieldId), rule.sourceKindFieldId)}, the target’s ${fieldName(end(rule.targetFieldId), rule.targetKindFieldId)} ` +
      `and its ${fieldName(entity, rule.kindFieldId)}, whoever writes it.</p>`);
  }
  for (const link of entities.filter(candidate => candidate.linkRule?.tableEntityId === entity.entityId))
    notes.push(`<p class="link-rule-note" data-link-rule="table"><strong>Allowed links</strong> Each record allows one kind of ` +
      `${escapeHtml(link.displayName)} link. Changing or deleting one is refused while a link still needs it.</p>`);
  return notes.join('');
}
