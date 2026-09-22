import type { DesktopSessionView, EntitySnapshot } from './host';

export function selectedEntity(session: DesktopSessionView, entityId: string | null): EntitySnapshot | null {
  return session.entities.find(entity => entity.entityId === entityId) ?? session.entities[0] ?? null;
}

export function renameSchemaProposal(entityId: string, fieldId: string | null, displayName: string, expectedDefinitionRevision: number): Record<string, unknown> {
  displayName = displayName.trim();
  if (!displayName || displayName.length > 120) throw new Error('Enter a display name up to 120 characters.');
  const id = crypto.randomUUID().replaceAll('-', '');
  return { proposalId: `proposal-${id}`, title: `Rename to ${displayName}`, mutations: [{ idempotencyKey: `rename-${id}`,
    description: `Rename to ${displayName}`, operations: [{ operationId: `rename-${id}`,
      operationType: fieldId ? 'schema.renameField' : 'schema.renameEntity',
      payload: { entityId, ...(fieldId ? { fieldId } : {}), displayName, expectedDefinitionRevision },
    }],
  }] };
}

// Renaming a board is Studio's one surface proposal, and it travels the lane every
// agent change travels: one property set on the board root, through
// proposal.prepareChangeSet. It used to send a compatibility method that named the
// starter file's board by constant ID, and the host stopped admitting that method
// at the current protocol on 2026-09-03 while the form went on calling it (F-084).
export function renameBoardProposal(surfaceId: string, nodeId: string, title: string): Record<string, unknown> {
  title = title.trim();
  if (!title || title.length > 120) throw new Error('Enter a board title up to 120 characters.');
  const id = crypto.randomUUID().replaceAll('-', '');
  return { proposalId: `proposal-${id}`, title: `Rename board to ${title}`, mutations: [{ idempotencyKey: `rename-board-${id}`,
    description: `Rename board to ${title}`, operations: [{ operationId: `rename-board-${id}`,
      operationType: 'ui.setProperty', payload: { surfaceId, nodeId, propertyName: 'title', value: title },
    }],
  }] };
}

// Studio starts with one ordinary text field. Richer schema authoring remains
// the same canonical proposal lane; this creates no reference application.
export function recordTypeProposal(name: string, fieldName: string): Record<string, unknown> {
  name = name.trim();
  fieldName = fieldName.trim();
  if (!name || name.length > 120 || !fieldName || fieldName.length > 120) {
    throw new Error('Enter a record type and first field name, each up to 120 characters.');
  }
  const id = crypto.randomUUID().replaceAll('-', '');
  const proposalId = `proposal-${id}`;
  const entityId = `entity.${id}`;
  return { proposalId, title: `Add ${name} records`, mutations: [{
    idempotencyKey: `${proposalId}-definition`, description: `Add ${name} records`, operations: [
      { operationId: `${proposalId}-entity`, operationType: 'schema.createEntity', payload: { entityId, displayName: name } },
      { operationId: `${proposalId}-field`, operationType: 'schema.addField', payload: { entityId,
        fieldId: `field.${id}.name`, displayName: fieldName, storageKind: 'text', required: true,
        presentation: 'singleLine', options: [] } },
    ],
  }] };
}

export function fieldProposal(entityId: string, name: string, kind: string, choices: string,
  reference?: { targetEntityId: string; labelFieldId: string; expectedDefinitionRevision: number },
  scale?: { min: string; max: string }): Record<string, unknown> {
  name = name.trim();
  if (!name || name.length > 120) throw new Error('Enter a field name up to 120 characters.');
  const kinds: Record<string, { storageKind: string; presentation?: string }> = {
    text: { storageKind: 'text', presentation: 'singleLine' },
    longText: { storageKind: 'text', presentation: 'longText' },
    choice: { storageKind: 'text', presentation: 'singleChoice' },
    integer: { storageKind: 'integer' }, decimal: { storageKind: 'decimal' },
    boolean: { storageKind: 'boolean' }, date: { storageKind: 'date', presentation: 'date' },
    rating: { storageKind: 'integer', presentation: 'rating' },
    dateTime: { storageKind: 'dateTime' }, uuid: { storageKind: 'uuid' },
    reference: { storageKind: 'reference' },
  };
  const type = kinds[kind];
  if (!type) throw new Error('Choose a supported field type.');
  if (kind === 'reference' && (!reference?.targetEntityId || !reference.labelFieldId)) throw new Error('Choose a target record type and its text label field.');
  const options = kind === 'choice' ? choices.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
  if (kind === 'choice' && (options.length < 1 || new Set(options).size !== options.length)) throw new Error('Enter distinct choices, one per line.');
  // A rating's bounds are refused here in the same words the host uses, so a mistake is
  // named before it costs a proposal.
  let bounds: { min: number; max: number } | null = null;
  if (kind === 'rating') {
    const min = Number((scale?.min ?? '').trim());
    const max = Number((scale?.max ?? '').trim());
    if (!Number.isInteger(min) || !Number.isInteger(max)) throw new Error('Enter whole numbers for the lowest and highest values.');
    if (max <= min) throw new Error('The highest value must be greater than the lowest.');
    if (max - min > 9) throw new Error(`A rating scale carries at most 10 values, and ${min} to ${max} is ${max - min + 1}.`);
    bounds = { min, max };
  }
  const id = crypto.randomUUID().replaceAll('-', '');
  return { proposalId: `proposal-${id}`, title: `Add ${name} field`, mutations: [{
    idempotencyKey: `field-${id}`, description: `Add ${name} field`, operations: [{
      operationId: `add-${id}`, operationType: 'schema.addField', payload: {
        entityId, fieldId: `field.${id}`, displayName: name, ...type, required: false, options, ...(bounds ?? {}),
      },
    }, ...(kind === 'reference' ? [{ operationId: `reference-${id}`, operationType: 'schema.configureReference',
      payload: { entityId, fieldId: `field.${id}`, ...reference } }] : [])],
  }] };
}
