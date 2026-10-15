import test from 'node:test';
import assert from 'node:assert/strict';
import { camel, uniqueId, parseDetail, parseOptions, readFieldRows, parseDate, inferKind, coerce, shelfOperations, detailOperations, display, typed, kindOf, nameFieldOf, valueForKind }
  from '../../extensions/clay/shape.mjs';

const today = '2026-10-15';
const people = { entityId: 'clay.people', displayName: 'People', nameFieldId: 'clay.people.name',
  records: [{ recordId: 'p1', name: 'Frank Herbert' }, { recordId: 'p2', name: 'Ursula K. Le Guin' }] };

test('a label becomes a readable identifier part', () => {
  assert.equal(camel('First published'), 'firstPublished');
  assert.equal(camel('Ærø & Søby på Fyn'), 'aeroSobyPaFyn');
  assert.equal(camel('2nd edition'), 'n2ndEdition');
  assert.equal(camel('!!!'), 'detail');
  assert.equal(uniqueId('clay.books', new Set(['clay.books', 'clay.books2'])), 'clay.books3');
});

test('a detail line is a label and a value split at the first colon', () => {
  assert.deepEqual(parseDetail('Year: 1965'), { label: 'Year', raw: '1965' });
  assert.deepEqual(parseDetail('  Read   at :  12:30 '), { label: 'Read at', raw: '12:30' });
  assert.deepEqual(parseDetail('Note:'), { label: 'Note', raw: '' });
  assert.equal(parseDetail('no colon here'), null);
  assert.equal(parseDetail(': value'), null);
});

test('dates are ISO, day first, or today, and impossible days are refused', () => {
  assert.equal(parseDate('2026-10-15'), '2026-10-15');
  assert.equal(parseDate('5/1/2024'), '2024-01-05');
  assert.equal(parseDate('15.10.2026'), '2026-10-15');
  assert.equal(parseDate('today', today), today);
  assert.equal(parseDate('31/02/2026'), null);
});

test('the first value typed decides the kind Clay proposes', () => {
  const guess = raw => inferKind(raw, { shelves: [people], today });
  assert.deepEqual(guess('1965'), { kind: 'integer', value: 1965, says: 'a whole number' });
  assert.deepEqual(guess('12,50').value, { $nendoNumber: '12.50' });
  assert.equal(guess('€9.99').kind, 'decimal');
  assert.equal(guess('yes').value, true);
  assert.equal(guess('★★★★').value, 4);
  assert.equal(guess('3/5').kind, 'rating');
  assert.equal(guess('15/10/2026').value, '2026-10-15');
  assert.deepEqual(guess('Reading | Finished | Wishlist'),
    { kind: 'choice', value: 'Reading', options: ['Reading', 'Finished', 'Wishlist'], says: 'a choice of Reading, Finished or Wishlist' });
  assert.deepEqual(guess('frank herbert'), { kind: 'reference', value: 'p1', target: 'clay.people', says: 'a link to People' });
  assert.equal(guess('https://example.org').kind, 'text');
  assert.equal(guess('x'.repeat(81)).kind, 'longText');
  assert.equal(guess('').value, null);
  // A number beyond what JavaScript holds exactly keeps its digits.
  assert.deepEqual(guess('123456789012345678').value, { $nendoNumber: '123456789012345678' });
});

test('a value for an existing field is read by that field, or refused in words', () => {
  const field = (storageKind, extra = {}) => ({ fieldId: 'f', displayName: 'Year', storageKind, required: false, presentation: null, ...extra });
  assert.deepEqual(coerce('1965', field('integer')), { ok: true, value: 1965 });
  assert.deepEqual(coerce('around 1965', field('integer')), { ok: false, message: 'Year holds a whole number.' });
  assert.deepEqual(coerce('7', field('decimal')), { ok: true, value: { $nendoNumber: '7' } });
  assert.deepEqual(coerce('4', field('integer', { presentation: 'rating' })), { ok: true, value: 4 });
  assert.deepEqual(coerce('', field('integer')), { ok: true, value: null });
  assert.equal(coerce('', field('text', { required: true })).ok, false);
  assert.deepEqual(coerce('1/2/2026', field('dateTime')), { ok: true, value: '2026-02-01T00:00:00Z' });
  const status = field('text', { presentation: 'singleChoice', choices: [{ id: 'Reading', displayName: 'Reading', retired: false }, { id: 'Done', displayName: 'Done', retired: false }] });
  assert.deepEqual(coerce('done', status), { ok: true, value: 'Done' });
  assert.deepEqual(coerce('Lost', status), { ok: false, message: 'Year holds Reading or Done.' });
  const author = field('reference', { reference: { targetEntityId: 'clay.people' } });
  assert.deepEqual(coerce('Ursula K. Le Guin', author, { shelves: [people] }), { ok: true, value: 'p2' });
  assert.equal(coerce('Tolkien', author, { shelves: [people] }).message, 'People has nothing named "Tolkien".');
  assert.equal(coerce('3', field('integer', { calculated: true })).ok, false);
});

test('a new shelf is a record type with a required Name, under an ID the file does not use', () => {
  const made = shelfOperations('Books', new Set(['clay.books']));
  assert.equal(made.entityId, 'clay.books2');
  assert.deepEqual(made.operations.map(o => o.operationType), ['schema.createEntity', 'schema.addField']);
  assert.deepEqual(made.operations[1].payload, { entityId: 'clay.books2', fieldId: 'clay.books2.name', displayName: 'Name', storageKind: 'text', required: true, presentation: 'singleLine', options: [] });
});

test('a new detail carries what its kind needs, and nothing a kind does not take', () => {
  const taken = new Set();
  const rating = detailOperations({ entityId: 'clay.books', label: 'Stars', kind: 'rating' }, taken);
  assert.deepEqual(rating.operations[0].payload, { entityId: 'clay.books', fieldId: 'clay.books.stars', displayName: 'Stars', required: false, options: [], storageKind: 'integer', presentation: 'rating', min: 1, max: 5 });
  const choice = detailOperations({ entityId: 'clay.books', label: 'Status', kind: 'choice', options: ['Reading', 'Done'] }, taken);
  assert.deepEqual(choice.operations.map(o => o.operationType), ['schema.addField', 'schema.setChoiceMetadata', 'schema.setChoiceMetadata']);
  assert.deepEqual(choice.operations[0].payload.options, ['Reading', 'Done']);
  assert.equal(choice.operations[2].payload.tone, 'blue');
  const plainChoice = detailOperations({ entityId: 'clay.books', label: 'Mood', kind: 'choice', options: ['Calm', 'Wild'], colours: false }, taken);
  assert.deepEqual(plainChoice.operations.map(o => o.operationType), ['schema.addField']);
  const link = detailOperations({ entityId: 'clay.books', label: 'Author', kind: 'reference', target: 'clay.people', targetNameFieldId: 'clay.people.name' }, taken);
  assert.deepEqual(link.operations[1], { operationType: 'schema.configureReference', payload: { entityId: 'clay.books', fieldId: 'clay.books.author', targetEntityId: 'clay.people', labelFieldId: 'clay.people.name' } });
  assert.equal('min' in detailOperations({ entityId: 'clay.books', label: 'Year', kind: 'integer' }, taken).operations[0].payload, false);
  assert.throws(() => detailOperations({ entityId: 'clay.books', label: 'Status', kind: 'choice', options: ['One'] }, taken), /two options/);
});

test('the field form reads label and type rows, and refuses what cannot be made', () => {
  assert.deepEqual(parseOptions(' Reading, Finished | Wishlist ,Reading'), ['Reading', 'Finished', 'Wishlist']);
  assert.deepEqual(readFieldRows([{ label: ' Year ', kind: 'integer' }, { label: '', kind: 'text' }, { label: 'Author', kind: 'ref:clay.people' },
    { label: 'Status', kind: 'choice', options: 'Reading, Done' }]), { ok: true, fields: [
    { label: 'Year', kind: 'integer', options: [], target: null },
    { label: 'Author', kind: 'reference', options: [], target: 'clay.people' },
    { label: 'Status', kind: 'choice', options: ['Reading', 'Done'], target: null }] });
  assert.equal(readFieldRows([{ label: 'Name', kind: 'text' }], ['Name']).message, 'There is already a field called Name.');
  assert.equal(readFieldRows([{ label: 'Year', kind: 'text' }, { label: 'year', kind: 'integer' }]).ok, false);
  assert.match(readFieldRows([{ label: 'Status', kind: 'choice', options: 'Only' }]).message, /at least two options/);
});

test('a person can overrule the guess, and the value is read again as the kind they picked', () => {
  assert.deepEqual(valueForKind('1965', 'text'), { ok: true, value: '1965' });
  assert.deepEqual(valueForKind('1965', 'decimal'), { ok: true, value: { $nendoNumber: '1965' } });
  assert.equal(valueForKind('soon', 'date').ok, false);
  assert.deepEqual(valueForKind('A | B', 'choice'), { ok: true, value: 'A' });
});

test('stored values read on a card as a person wrote them', () => {
  const record = { values: { r: 3, b: false, c: 'Done', a: 'p1', d: 12.5 }, labels: { a: 'Frank Herbert' }, exact: { d: '12.50' } };
  assert.equal(display({ fieldId: 'r', storageKind: 'integer', presentation: 'rating' }, record), '★★★☆☆');
  assert.equal(typed({ fieldId: 'r', storageKind: 'integer', presentation: 'rating' }, record), '★★★');
  assert.equal(display({ fieldId: 'b', storageKind: 'boolean' }, record), 'No');
  assert.equal(display({ fieldId: 'c', storageKind: 'text', presentation: 'singleChoice', choices: [{ id: 'Done', displayName: 'Finished' }] }, record), 'Finished');
  assert.equal(display({ fieldId: 'a', storageKind: 'reference' }, record), 'Frank Herbert');
  assert.equal(display({ fieldId: 'd', storageKind: 'decimal' }, record), '12.50');
  assert.equal(display({ fieldId: 'missing', storageKind: 'text' }, record), null);
});

test('a shelf made outside Clay is named by its first required text field', () => {
  const entity = { entityId: 'task', fields: [
    { fieldId: 'taskDue', storageKind: 'date' }, { fieldId: 'taskNotes', storageKind: 'text', presentation: 'longText' },
    { fieldId: 'taskTitle', storageKind: 'text', required: true }] };
  assert.equal(nameFieldOf(entity).fieldId, 'taskTitle');
  assert.equal(kindOf({ storageKind: 'Integer', presentation: 'rating' }), 'rating');
});
