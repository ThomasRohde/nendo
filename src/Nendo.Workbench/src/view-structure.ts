import { prepareApplication } from './actions';
import { state } from './app-state';
import { client } from './client';
import { choiceDisplay, cssToken, escapeAttribute, escapeHtml, messageFor, presentationLabel, storageLabel, valueDisplay } from './format';
import { type EntitySnapshot, type FieldPlan, type ReadPage, type RecordSnapshot } from './host';
import { currentRecipe, sessionEntity } from './plan-selection';
import { formValue } from './record-form';
import { fieldControlMarkup } from './record-markup';
import { referenceControl, referenceVersions, wireReferenceControls } from './reference-controls';
import { content, requiredElement, rerender, showError } from './shell';
import { fieldProposal, renameSchemaProposal } from './studio';
import { CHOICE_TONES, toneLabel, toneOf } from './tones';
import { renderData } from './view-data';
/**
 * Studio structure: the fields of one record type and every change that can be
 * made to them. Each dialog prepares a proposal rather than writing, so a
 * definition change is reviewed on the proposal screen before it reaches the file.
 */

export function renderStructure(): void {
  const entity = sessionEntity();
  if (entity === null) {
    renderData();
    return;
  }
  const activated = state.compilation?.isValid === true;
  const recipe = currentRecipe();
  content.innerHTML = `<div class="studio-page structure-page">
    <div class="page-toolbar"><label class="select-field">Record type<select id="structure-entity">${state.session.entities.map(candidate => `<option value="${escapeAttribute(candidate.entityId)}" ${candidate.entityId === entity.entityId ? 'selected' : ''}>${escapeHtml(candidate.displayName)}</option>`).join('')}</select></label>${activated ? '<span class="health-chip healthy">Active</span>' : ''}<span class="toolbar-spacer"></span>${activated || recipe === null ? '' : `<button id="prepare-application" class="primary-button" data-action type="button">${escapeHtml(recipe.actionLabel)}</button>`}<button id="rename-entity" class="secondary-button" data-action type="button">Rename record type</button><button id="add-field" class="primary-button" data-action type="button"><span class="button-glyph" aria-hidden="true">+</span>Add field</button></div>
    <div class="message-slot" role="alert" hidden></div>
    <section class="definition-card">
      <div class="definition-title"><div><span class="entity-icon" aria-hidden="true">${escapeHtml(entity.displayName.slice(0, 1).toUpperCase())}</span><div><h2>${escapeHtml(entity.displayName)}</h2><code>${escapeHtml(entity.entityId)}</code></div></div><div class="definition-title-actions"><strong>${entity.fields.length} fields</strong><button id="retire-entity" class="secondary-button" data-action type="button">${entity.retired ? 'Reactivate' : 'Retire'} record type</button></div></div>
      <div class="field-list">
        <div class="field-row field-row-head" aria-hidden="true"><span>Field</span><span>Stores</span><span>Shown as</span><span>Required</span></div>
        ${entity.fields.map((field) => `<article class="field-row${field.retired ? ' is-retired' : ''}">
        <div class="field-identity"><strong>${escapeHtml(field.displayName)}${field.retired ? ' <span class="field-tag">Retired</span>' : ''}</strong><code>${escapeHtml(field.fieldId)}</code><div class="field-actions"><button class="text-button" data-rename-field="${escapeAttribute(field.fieldId)}" data-action type="button" ${entity.retired || field.retired ? 'disabled' : ''} aria-label="Rename ${escapeAttribute(field.displayName)}">Rename</button><button class="text-button" data-retire-field="${escapeAttribute(field.fieldId)}" data-action type="button" ${entity.retired ? 'disabled' : ''}>${field.retired ? 'Reactivate' : 'Retire'}</button>${field.presentation === 'singleChoice' ? `<button class="text-button" data-choice-field="${escapeAttribute(field.fieldId)}" data-action type="button" ${entity.retired || field.retired ? 'disabled' : ''}>Edit choices</button>` : ''}</div></div>
        <span class="field-kind">${escapeHtml(storageLabel(field.storageKind, field.unsupportedStorageKind))}${storageLabel(field.storageKind) === 'Reference' && !field.reference ? `<button class="text-button" data-convert-reference="${escapeAttribute(field.fieldId)}" data-action type="button" ${entity.retired || field.retired ? 'disabled' : ''}>Convert reference</button>` : ''}</span>
        <span class="field-presentation">${escapeHtml(presentationLabel(field.presentation))}${field.scale ? ` ${escapeHtml(`${field.scale.min}–${field.scale.max}`)}` : ''}</span>
        <span class="field-requirement"><span class="requirement-value">${field.required ? 'Required' : 'Optional'}</span><button class="text-button" data-require-field="${escapeAttribute(field.fieldId)}" data-action type="button" ${entity.retired || field.retired ? 'disabled' : ''}>${field.required ? 'Make optional' : 'Make required'}</button></span>
      </article>`).join('')}</div>
    </section>
    ${activated ? '<aside class="context-note"><strong>Stable semantics</strong><p>Use surfaces bind to these IDs, not display labels or physical columns.</p></aside>' : '<aside class="context-note"><strong>No active surfaces</strong><p>Data remains available while a stored surface definition is prepared or repaired.</p></aside>'}
  </div>`;
  requiredElement<HTMLSelectElement>('#structure-entity').addEventListener('change', event => {
    state.selectedEntityId = (event.currentTarget as HTMLSelectElement).value;
    rerender();
  });
  requiredElement<HTMLButtonElement>('#add-field').addEventListener('click', () => renderAddField(entity));
  requiredElement<HTMLButtonElement>('#add-field').disabled = !!entity.retired;
  requiredElement<HTMLButtonElement>('#rename-entity').disabled = !!entity.retired;
  requiredElement('#retire-entity').addEventListener('click', () => prepareRetirement(entity, null, !entity.retired));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-retire-field]'))
    button.addEventListener('click', () => prepareRetirement(entity, button.dataset.retireField!, !entity.fields.find(field => field.fieldId === button.dataset.retireField)!.retired));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-choice-field]'))
    button.addEventListener('click', () => renderChoiceEditor(entity, button.dataset.choiceField!));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-require-field]'))
    button.addEventListener('click', () => void renderFieldRequirement(entity, button.dataset.requireField!));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-convert-reference]'))
    button.addEventListener('click', () => renderReferenceConversion(entity, button.dataset.convertReference!));
  requiredElement<HTMLButtonElement>('#rename-entity').addEventListener('click', () => renderRenameSchema(entity, null));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-rename-field]'))
    button.addEventListener('click', () => renderRenameSchema(entity, button.dataset.renameField!));
  content.querySelector<HTMLButtonElement>('#prepare-application')?.addEventListener('click', () => {
    if (recipe !== null) void prepareApplication(recipe, 'structure');
  });
}

export function renderAddField(entity: EntitySnapshot): void {
  content.innerHTML = `<div class="dialog-page"><section class="record-form-card"><header><button id="cancel-field" class="text-button" type="button" data-dismiss>Back to Structure</button><h2>Add a field to ${escapeHtml(entity.displayName)}</h2><p>New fields are optional so existing records remain valid. Review the proposal before applying it.</p></header>
    <form id="add-field-form" class="record-form"><label>Field name<input name="fieldName" required maxlength="120" autocomplete="off" /></label>
    <label>Type<select id="field-kind" name="kind"><option value="text">Short text</option><option value="longText">Long text</option><option value="choice">Choice</option><option value="integer">Whole number</option><option value="rating">Rating on a scale</option><option value="decimal">Decimal</option><option value="boolean">Yes / No</option><option value="date">Date</option><option value="dateTime">Date and time with timezone</option><option value="uuid">UUID</option><option value="reference">Reference to another record</option></select></label>
    <label id="field-choices-label" hidden>Choices, one per line<textarea name="choices" rows="4"></textarea></label>
    <div id="field-scale" hidden><div class="scale-bounds"><label>Lowest<input name="scaleMin" type="number" step="1" value="1" /></label><label>Highest<input name="scaleMax" type="number" step="1" value="5" /></label></div><p>A rating is a whole number shown as dots. The scale carries at most ten values and is set once, so choose it with the field. A value outside it stays readable as its number.</p></div>
    <div id="reference-definition" hidden><label>Target record type<select id="reference-target" name="targetEntityId">${state.session.entities.filter(candidate => !candidate.retired && candidate.fields.some(field => !field.retired && storageLabel(field.storageKind) === 'Text')).map(candidate => `<option value="${escapeAttribute(candidate.entityId)}">${escapeHtml(candidate.displayName)}</option>`).join('')}</select></label><label>Show targets using this text field<select id="reference-label" name="labelFieldId"></select></label><p>The relationship stores the target's ID. Changing its label keeps the relationship.</p></div>
    <div class="message-slot" role="alert" hidden></div><div class="form-actions"><button class="primary-button" data-action type="submit">Preview field</button></div></form></section></div>`;
  requiredElement<HTMLButtonElement>('#cancel-field').addEventListener('click', () => rerender());
  requiredElement<HTMLSelectElement>('#field-kind').addEventListener('change', event => {
    requiredElement<HTMLElement>('#field-choices-label').hidden = (event.target as HTMLSelectElement).value !== 'choice';
    requiredElement<HTMLElement>('#reference-definition').hidden = (event.target as HTMLSelectElement).value !== 'reference';
    requiredElement<HTMLElement>('#field-scale').hidden = (event.target as HTMLSelectElement).value !== 'rating';
  });
  const updateReferenceLabels = (): void => {
    const target = state.session.entities.find(candidate => candidate.entityId === requiredElement<HTMLSelectElement>('#reference-target').value);
    requiredElement<HTMLSelectElement>('#reference-label').innerHTML = (target?.fields ?? []).filter(field => !field.retired && storageLabel(field.storageKind) === 'Text')
      .map(field => `<option value="${escapeAttribute(field.fieldId)}">${escapeHtml(field.displayName)}</option>`).join('');
  };
  requiredElement<HTMLSelectElement>('#reference-target').addEventListener('change', updateReferenceLabels);
  updateReferenceLabels();
  requiredElement<HTMLFormElement>('#add-field-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    try {
      const payload = fieldProposal(entity.entityId, String(form.get('fieldName')), String(form.get('kind')), String(form.get('choices')),
        { targetEntityId: String(form.get('targetEntityId') ?? ''), labelFieldId: String(form.get('labelFieldId') ?? ''), expectedDefinitionRevision: state.session.manifest!.definitionRevision },
        { min: String(form.get('scaleMin') ?? ''), max: String(form.get('scaleMax') ?? '') });
      void prepareApplication({ actionLabel: 'Add field', applicationName: entity.displayName, proposalPayload: payload }, 'structure');
    } catch (error) { showError(messageFor(error)); }
  });
  content.querySelector<HTMLInputElement>('input')?.focus();
}

export function renderRenameSchema(entity: EntitySnapshot, fieldId: string | null): void {
  const name = fieldId ? entity.fields.find(field => field.fieldId === fieldId)!.displayName : entity.displayName;
  const expectedRevision = state.session.manifest!.definitionRevision;
  content.innerHTML = `<div class="dialog-page"><section class="record-form-card"><h2>Rename ${escapeHtml(name)}</h2>
    <p>This changes the display name. Existing record values and IDs stay as they are.</p>
    <div class="message-slot" role="alert" hidden></div><form id="rename-schema-form" class="record-form">
    <label>New name<input id="schema-name" name="displayName" maxlength="120" required value="${escapeAttribute(name)}" /></label>
    <div class="form-actions"><button id="cancel-rename" class="secondary-button" type="button" data-dismiss>Cancel</button><button class="primary-button" data-action type="submit">Preview rename</button></div>
    </form></section></div>`;
  requiredElement<HTMLButtonElement>('#cancel-rename').addEventListener('click', () => rerender());
  requiredElement<HTMLFormElement>('#rename-schema-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const payload = renameSchemaProposal(entity.entityId, fieldId, requiredElement<HTMLInputElement>('#schema-name').value, expectedRevision);
      void prepareApplication({ actionLabel: 'Rename', applicationName: entity.displayName, proposalPayload: payload }, 'structure');
    } catch (error) { showError(messageFor(error)); }
  });
  requiredElement<HTMLInputElement>('#schema-name').focus();
}

export function renderReferenceConversion(entity: EntitySnapshot, fieldId: string): void {
  const field = entity.fields.find(candidate => candidate.fieldId === fieldId)!;
  const fileSessionId = state.session.fileSessionId;
  const expectedDefinitionRevision = state.session.manifest!.definitionRevision;
  const targets = state.session.entities.filter(candidate => !candidate.retired && candidate.fields.some(label => !label.retired && storageLabel(label.storageKind) === 'Text'));
  const title = `Convert ${field.displayName} reference`;
  content.innerHTML = `<div class="dialog-page"><section class="record-form-card"><h2>${escapeHtml(title)}</h2>
    <p>Choose the target record type and its label, then explicitly map every existing value. Nothing changes until you accept the proposal.</p>
    <div class="message-slot" role="alert" hidden></div><form id="conversion-target-form" class="record-form">
    <label>Target record type<select id="conversion-target" required><option value="">Choose a record type</option>${targets.map(target => `<option value="${escapeAttribute(target.entityId)}">${escapeHtml(target.displayName)}</option>`).join('')}</select></label>
    <label>Target label<select id="conversion-label" required><option value="">Choose a text field</option></select></label>
    <div class="form-actions"><button id="cancel-conversion" class="secondary-button" type="button" data-dismiss>Cancel</button><button class="primary-button" type="submit">Map values</button></div>
    </form></section></div>`;
  requiredElement('#cancel-conversion').addEventListener('click', () => rerender());
  requiredElement<HTMLSelectElement>('#conversion-target').addEventListener('change', event => {
    const target = targets.find(candidate => candidate.entityId === (event.currentTarget as HTMLSelectElement).value);
    requiredElement('#conversion-label').innerHTML = '<option value="">Choose a text field</option>' + (target?.fields ?? [])
      .filter(label => !label.retired && storageLabel(label.storageKind) === 'Text')
      .map(label => `<option value="${escapeAttribute(label.fieldId)}">${escapeHtml(label.displayName)}</option>`).join('');
  });
  const targetForm = requiredElement<HTMLFormElement>('#conversion-target-form');
  targetForm.addEventListener('submit', event => {
    event.preventDefault();
    const reference = { targetEntityId: requiredElement<HTMLSelectElement>('#conversion-target').value,
      labelFieldId: requiredElement<HTMLSelectElement>('#conversion-label').value };
    void (async () => {
      try {
        const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', { entityId: entity.entityId, limit: 100 });
        if (state.session.fileSessionId !== fileSessionId || !targetForm.isConnected) return;
        if (page.nextCursor) throw new Error('Conversion supports at most 100 records in one atomic review. No values have changed.');
        const boundField = { ...field, reference };
        content.innerHTML = `<div class="dialog-page"><section class="record-form-card"><h2>${escapeHtml(title)}</h2>
          <p>Choose a target for each record${field.required ? '.' : ', or use Clear to explicitly leave it unset.'} Original values remain in history; this conversion cannot be undone automatically.</p>
          <div class="message-slot" role="alert" hidden></div>
          ${page.items.map(record => `<form class="record-form conversion-record"><h3>${escapeHtml(record.recordId)}</h3><p>Original value: <code>${escapeHtml(record.values[fieldId] === null ? '(null)' : valueDisplay(record.values[fieldId]))}</code></p>${referenceControl(boundField, '')}</form>`).join('')}
          <div class="form-actions"><button id="cancel-conversion" class="secondary-button" type="button" data-dismiss>Cancel</button><button id="preview-conversion" class="primary-button" data-action type="button">Preview conversion</button></div>
          </section></div>`;
        requiredElement('#cancel-conversion').addEventListener('click', () => rerender());
        const forms = [...content.querySelectorAll<HTMLFormElement>('.conversion-record')];
        for (const form of forms) {
          form.addEventListener('submit', event => event.preventDefault());
          form.addEventListener('change', () => { form.dataset.explicitMapping = 'true'; });
          wireReferenceControls(form, [boundField], payload => client.request<ReadPage<RecordSnapshot>>('data.queryRecords', payload));
        }
        requiredElement('#preview-conversion').addEventListener('click', () => {
          try {
            if (state.session.fileSessionId !== fileSessionId || state.session.manifest?.definitionRevision !== expectedDefinitionRevision)
              throw new Error('The file or definition changed. Return to Structure and review again.');
            const records = forms.map((form, index) => {
              if (form.dataset.explicitMapping !== 'true') throw new Error('Choose a target or explicitly clear every record before previewing.');
              const targetRecordId = String(new FormData(form).get(fieldId) ?? '') || null;
              const expectedTargetRecordVersion = referenceVersions(form, { [fieldId]: targetRecordId })[fieldId] ?? null;
              if ((field.required && targetRecordId === null) || (targetRecordId !== null && expectedTargetRecordVersion === null))
                throw new Error('Select a current target for every required reference.');
              return { recordId: page.items[index].recordId, expectedRecordVersion: page.items[index].recordVersion, targetRecordId, expectedTargetRecordVersion };
            });
            const id = crypto.randomUUID().replaceAll('-', '');
            const common = { entityId: entity.entityId, fieldId, ...reference, expectedDefinitionRevision };
            const mutations: Array<{ idempotencyKey: string; description: string; operations: unknown[] }> = [];
            if (records.length) mutations.push({ idempotencyKey: `convert-${id}`, description: title, operations: [{
              operationId: `convert-${id}`, operationType: 'data.convertLegacyReference', payload: { ...common, records },
            }] });
            mutations.push({ idempotencyKey: `bind-${id}`, description: `Bind ${field.displayName} to the reviewed targets`, operations: [{
              operationId: `bind-${id}`, operationType: 'schema.configureReference', payload: { ...common, ...(records.length ? {
                reviewedRecords: records.map(row => ({ ...row, expectedRecordVersion: row.expectedRecordVersion + 1,
                  expectedTargetRecordVersion: row.expectedTargetRecordVersion !== null && reference.targetEntityId === entity.entityId
                    ? row.expectedTargetRecordVersion + 1 : row.expectedTargetRecordVersion })),
              } : {}) },
            }] });
            void prepareApplication({ actionLabel: title, applicationName: entity.displayName,
              proposalPayload: { proposalId: `proposal-${id}`, title, mutations } }, 'structure');
          } catch (error) { showError(messageFor(error)); }
        });
        content.querySelector<HTMLElement>('.reference-choose, #preview-conversion')?.focus();
      } catch (error) { if (targetForm.isConnected) showError(messageFor(error)); }
    })();
  });
  requiredElement<HTMLSelectElement>('#conversion-target').focus();
}

export function renderChoiceEditor(entity: EntitySnapshot, fieldId: string): void {
  const field = entity.fields.find(field => field.fieldId === fieldId)!;
  const expectedDefinitionRevision = state.session.manifest!.definitionRevision;
  content.innerHTML = `<div class="dialog-page"><section class="record-form-card"><h2>Edit ${escapeHtml(field.displayName)} choices</h2>
    <p>Change a display label, retire a choice or give it a colour. Existing records keep their stored choice ID. Retired choices remain readable but cannot be newly assigned. A colour shows on the board column, on chips and on any record page coloured by this field.</p>
    <div class="message-slot" role="alert" hidden></div><form id="choice-form" class="record-form">
      <label>Choice<select id="choice-id">${field.options.map(id => `<option value="${escapeAttribute(id)}">${escapeHtml(choiceDisplay(field, id))}</option>`).join('')}</select></label>
      <label>Display label<input id="choice-label" maxlength="200" required /></label>
      <label class="checkbox-field"><input id="choice-retired" type="checkbox" />Retired</label>
      <fieldset class="tone-field"><legend>Colour</legend><div class="tone-picker" id="choice-tone">${[null, ...CHOICE_TONES].map((tone) => `<label><input type="radio" name="choice-tone" value="${tone ?? ''}" /><span class="choice-tone-swatch" style="${tone === null ? '' : `--status-color: var(--tone-${tone})`}" aria-hidden="true"></span>${escapeHtml(toneLabel(tone))}</label>`).join('')}</div></fieldset>
      <div class="form-actions"><button id="cancel-choice" class="secondary-button" type="button" data-dismiss>Cancel</button><button class="primary-button" data-action type="submit">Preview choice change</button></div>
    </form></section></div>`;
  const select = requiredElement<HTMLSelectElement>('#choice-id');
  const load = (): void => {
    const choice = field.choices?.find(choice => choice.id === select.value);
    requiredElement<HTMLInputElement>('#choice-label').value = choice?.displayName ?? select.value;
    requiredElement<HTMLInputElement>('#choice-retired').checked = choice?.retired ?? false;
    const tone = toneOf(field, select.value) ?? '';
    const radio = content.querySelector<HTMLInputElement>(`#choice-tone input[value="${tone}"]`);
    if (radio) radio.checked = true;
  };
  select.addEventListener('change', load); load();
  requiredElement('#cancel-choice').addEventListener('click', () => rerender());
  requiredElement<HTMLFormElement>('#choice-form').addEventListener('submit', event => {
    event.preventDefault();
    const id = crypto.randomUUID().replaceAll('-', '');
    const payload = { entityId: entity.entityId, fieldId, choiceId: select.value,
      displayName: requiredElement<HTMLInputElement>('#choice-label').value,
      retired: requiredElement<HTMLInputElement>('#choice-retired').checked,
      tone: content.querySelector<HTMLInputElement>('#choice-tone input:checked')?.value || null, expectedDefinitionRevision };
    void prepareApplication({ actionLabel: 'Change choice', applicationName: entity.displayName,
      proposalPayload: { proposalId: `proposal-${id}`, title: `Change ${field.displayName} choice`, mutations: [{
        idempotencyKey: `choice-${id}`, description: `Change ${field.displayName} choice`, operations: [{
          operationId: `choice-${id}`, operationType: 'schema.setChoiceMetadata', payload,
        }],
      }] } }, 'structure');
  });
  select.focus();
}

export function prepareRetirement(entity: EntitySnapshot, fieldId: string | null, retired: boolean): void {
  if (!retired && fieldId && entity.fields.find(field => field.fieldId === fieldId)?.required) {
    void renderFieldRequirement(entity, fieldId, true);
    return;
  }
  const id = crypto.randomUUID().replaceAll('-', '');
  const title = `${retired ? 'Retire' : 'Reactivate'} ${fieldId ? entity.fields.find(field => field.fieldId === fieldId)!.displayName : entity.displayName}`;
  void prepareApplication({ actionLabel: title, applicationName: entity.displayName, proposalPayload: {
    proposalId: `proposal-${id}`, title, mutations: [{ idempotencyKey: `retirement-${id}`, description: title, operations: [{
      operationId: `retirement-${id}`, operationType: 'schema.setRetired', payload: { entityId: entity.entityId, fieldId, retired,
        expectedDefinitionRevision: state.session.manifest!.definitionRevision },
    }] }],
  } }, 'structure');
}

export async function renderFieldRequirement(entity: EntitySnapshot, fieldId: string, reactivate = false): Promise<void> {
  const field = entity.fields.find(field => field.fieldId === fieldId)!;
  const required = reactivate || !field.required;
  const fileSessionId = state.session.fileSessionId;
  const expectedDefinitionRevision = state.session.manifest!.definitionRevision;
  const title = reactivate ? `Reactivate ${field.displayName}` : `Make ${field.displayName} ${required ? 'required' : 'optional'}`;
  try {
    const page = required ? await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', {
      entityId: entity.entityId, limit: 50, filters: [{ fieldId, operator: 'isNull' }],
    }) : { items: [], nextCursor: null };
    if (state.session.fileSessionId !== fileSessionId) return;
    const plan: FieldPlan = { semanticId: fieldId, automationTarget: `field-${cssToken(fieldId)}`, displayName: field.displayName,
      storageKind: field.storageKind, required: true, presentation: field.presentation, options: field.options, choices: field.choices };
    const labelField = entity.fields.find(candidate => candidate.fieldId !== fieldId && storageLabel(candidate.storageKind) === 'Text');
    content.innerHTML = `<div class="dialog-page"><section class="record-form-card"><h2>${escapeHtml(title)}</h2>
      <p>${page.items.length ? 'Enter an explicit value for each record below. Review every change before applying it.' : 'No missing values need filling. Review the definition change before applying it.'}</p>
      ${page.nextCursor ? '<p>More than 50 records need values. This proposal fills this batch only. Return here after accepting it to continue; the field changes only after all missing values are filled.</p>' : ''}
      <div class="message-slot" role="alert" hidden></div>
      ${page.items.map((record, index) => `<form class="record-form backfill-record" data-row="${index}"><h3>${escapeHtml(labelField ? valueDisplay(record.values[labelField.fieldId]) || record.recordId : record.recordId)}</h3><code>${escapeHtml(record.recordId)}</code>${fieldControlMarkup(plan, null)}</form>`).join('')}
      <div class="form-actions"><button id="cancel-requirement" class="secondary-button" type="button" data-dismiss>Cancel</button><button id="preview-requirement" class="primary-button" data-action type="button">Preview changes</button></div>
      </section></div>`;
    requiredElement('#cancel-requirement').addEventListener('click', () => rerender());
    const forms = [...content.querySelectorAll<HTMLFormElement>('.backfill-record')];
    for (const form of forms) {
      form.addEventListener('submit', event => event.preventDefault());
      wireReferenceControls(form, [field], payload => client.request<ReadPage<RecordSnapshot>>('data.queryRecords', payload));
    }
    requiredElement('#preview-requirement').addEventListener('click', () => {
      try {
        if (state.session.fileSessionId !== fileSessionId) throw new Error('The open file changed. Return to Structure and review again.');
        const id = crypto.randomUUID().replaceAll('-', '');
        const operations = forms.map((form, index) => {
          if (!form.reportValidity()) throw new Error('Fill every missing value before previewing.');
          const value = formValue(plan, new FormData(form));
          if (value === null || value === undefined) throw new Error('Choose a value for every record.');
          return { operationId: `fill-${id}-${index}`, operationType: field.retired ? 'data.backfillRetiredField' : 'data.setField',
            payload: { entityId: entity.entityId, fieldId, recordId: page.items[index].recordId,
              expectedRecordVersion: page.items[index].recordVersion, value,
              expectedTargetRecordVersion: referenceVersions(form, { [fieldId]: value })[fieldId] ?? null } };
        });
        const mutations: Array<{ idempotencyKey: string; description: string; operations: unknown[] }> = [];
        if (operations.length) mutations.push({ idempotencyKey: `fill-${id}`, description: `Fill missing ${field.displayName} values`, operations });
        if (!page.nextCursor) mutations.push({ idempotencyKey: `require-${id}`, description: title, operations: [{
          operationId: `require-${id}`, operationType: reactivate ? 'schema.setRetired' : 'schema.setFieldRequired',
          payload: { entityId: entity.entityId, fieldId, expectedDefinitionRevision, ...(reactivate ? { retired: false } : { required }) },
        }] });
        void prepareApplication({ actionLabel: title, applicationName: entity.displayName,
          proposalPayload: { proposalId: `proposal-${id}`, title, mutations } }, 'structure');
      } catch (error) { showError(messageFor(error)); }
    });
    content.querySelector<HTMLElement>('input, select, #preview-requirement')?.focus();
  } catch (error) { showError(messageFor(error)); }
}

