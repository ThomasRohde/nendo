// The Capability Atlas model: what the view that shows the Atlas binds, the hierarchy built from
// the tree the Engine keeps, and the record types related to it. The Atlas takes its record type
// and which field plays which part from that view (nendo.context) and from the file's schema
// (nendo.schema.describe), so any file whose record type is declared a tree can show it.
// Nothing here touches the page or Nendo, so view.js and the node tests
// (tools/bcm-atlas/model.test.mjs) share it.

/**
 * The parts a field can play, which the view's configuration names as
 * { "fields": { part: fieldId } }. Every part is optional: one the view does not give hides what
 * it drives. `name` is how the Atlas labels the part, and `kind` what its field must hold.
 */
export const ROLES = {
  code: { name: 'Reference', kind: 'text' },
  description: { name: 'Definition', kind: 'text' },
  owner: { name: 'Accountable owner', kind: 'text' },
  maturity: { name: 'Maturity', kind: 'integer' },
  target: { name: 'Target maturity', kind: 'integer' },
  importance: { name: 'Strategic importance', kind: 'choice' },
  investment: { name: 'Investment direction', kind: 'choice' },
  lifecycle: { name: 'Lifecycle', kind: 'choice' },
  reviewed: { name: 'Review date', kind: 'date' },
  evidence: { name: 'Assessment evidence', kind: 'text' },
};

/** What each kind of part accepts, and how a sentence names it. */
const KINDS = {
  text: { fits: field => field.storageKind === 'text' && field.choices.length === 0, words: 'a text field' },
  integer: { fits: field => field.storageKind === 'integer' && field.choices.length === 0, words: 'a whole-number field' },
  choice: { fits: field => field.choices.length > 0, words: 'a choice field' },
  date: { fits: field => field.storageKind === 'date', words: 'a date field' },
};

/** Maturity labels by level. Level 0 stands for no assessment; 1 to 5 are the scale. */
export const maturityLabels = ['Unassessed', 'Initial', 'Repeatable', 'Defined', 'Managed', 'Optimising'];

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => typeof value === 'string' && value.trim() !== '' ? value : null;

/** The line above the map that says whose model this is: { title, note }, from the configuration. */
function bannerOf(value) {
  const banner = plainObject(value);
  return text(banner.title) === null ? null : { title: banner.title, note: text(banner.note) };
}

/**
 * A field's value as a person reads it: a choice by its name, a reference by the label of the
 * record it points at, a number by its exact digits. Null when the record holds nothing there.
 */
export function display(record, fieldId, fields) {
  const value = record?.values?.[fieldId];
  if (value === null || value === undefined || value === '') return null;
  const field = fields.find(candidate => candidate.fieldId === fieldId);
  if (field?.reference) return record.labels?.[fieldId] ?? String(value);
  if (field?.choices?.length) return field.choices.find(choice => choice.id === value)?.displayName ?? String(value);
  return record.exact?.[fieldId] ?? String(value);
}

/** The field a record type is known by: the one references to it show, else its first text field. */
function labelFieldOf(entity, entities) {
  for (const other of entities) {
    for (const field of other.fields) {
      if (field.reference?.targetEntityId === entity.entityId && field.reference.labelFieldId) return field.reference.labelFieldId;
    }
  }
  return entity.fields.find(field => !field.calculated && KINDS.text.fits(field))?.fieldId ?? null;
}

/**
 * The record types that refer to the Atlas's own, found in the schema. A type with exactly two
 * references, one to the Atlas's type, is a link to what the other points at (an application
 * that supports a capability); any other type that refers to it is a list of related records (the
 * initiatives that change it). One section per reference to the Atlas's type. The view's
 * configuration may give a section its title, its row as a template of {fieldId} placeholders,
 * and what it says when it is empty; the schema decides which sections there are. Sections come
 * in the order the configuration lists them, then links before lists: the host lists record
 * types by ID, which says nothing about how the inspector should read.
 */
function relatedTypes(entityId, entities, presentation, typeName, problems) {
  const related = [];
  for (const other of entities) {
    if (other.entityId === entityId) continue;
    const references = other.fields.filter(field => !field.calculated && field.reference && field.reference.targetEntityId !== other.entityId);
    const toThis = references.filter(field => field.reference.targetEntityId === entityId);
    if (toThis.length === 0) continue;
    const shown = plainObject(presentation[other.entityId]);
    const link = references.length === 2;
    for (const via of toThis) {
      const far = link ? references.find(field => field !== via) : null;
      const farType = far ? entities.find(candidate => candidate.entityId === far.reference.targetEntityId) : null;
      related.push({
        entityId: other.entityId,
        viaFieldId: via.fieldId,
        farFieldId: far?.fieldId ?? null,
        farName: far ? farType?.displayName ?? far.reference.targetEntityId : null,
        labelFieldId: link ? null : labelFieldOf(other, entities),
        title: text(shown.title) ?? (toThis.length > 1 ? `${other.displayName} · ${via.displayName}` : other.displayName),
        row: text(shown.row),
        empty: text(shown.empty) ?? 'None yet.',
        fields: other.fields,
      });
    }
  }
  const listed = Object.keys(presentation);
  const rank = entry => {
    const place = listed.indexOf(entry.entityId);
    return place !== -1 ? place : listed.length + (entry.farFieldId === null ? 1 : 0);
  };
  related.sort((a, b) => rank(a) - rank(b));
  for (const described of listed) {
    if (!related.some(entry => entry.entityId === described)) {
      problems.push(`The configuration describes ${described}, which does not refer to ${typeName}.`);
    }
  }
  return related;
}

/**
 * Dated assessments (W-080): a record type that holds one scored judgement of one capability on
 * one dimension at one date, named by the view's configuration as
 *
 *   { "assessments": { "entityId", "capability", "dimension", "score", "date",
 *                      "dimensions": { "maturity", "health", "value" } } }
 *
 * where each of the first five is a field of that type and `dimensions` maps the Atlas's three
 * dimensions to the dimension field's choice IDs. Every assessment is a record, so history keeps
 * each one; the capability shows the latest per dimension. Null when the configuration names
 * none; a named one that does not fit says why in `problems`.
 */
export function bindAssessments(value, entities, atlasEntityId, problems) {
  const configured = plainObject(value);
  if (Object.keys(configured).length === 0) return null;
  const entity = entities.find(candidate => candidate.entityId === configured.entityId);
  if (entity === undefined) {
    problems.push(`The configuration names ${configured.entityId ?? 'no record type'} for assessments, which is not a record type of this file.`);
    return null;
  }
  const field = id => entity.fields.find(candidate => candidate.fieldId === id && !candidate.calculated);
  const capability = field(configured.capability), dimension = field(configured.dimension);
  const score = field(configured.score), date = field(configured.date);
  const wrong = [
    capability?.reference?.targetEntityId === atlasEntityId ? null : 'capability, a reference to the capabilities',
    dimension !== undefined && dimension.choices.length > 0 ? null : 'dimension, a choice field',
    score !== undefined && KINDS.integer.fits(score) ? null : 'score, a whole-number field',
    date !== undefined && KINDS.date.fits(date) ? null : 'date, a date field',
  ].filter(Boolean);
  if (wrong.length) {
    problems.push(`Assessments in ${entity.displayName} need ${wrong.join('; ')}.`);
    return null;
  }
  const named = plainObject(configured.dimensions);
  const dimensions = {};
  for (const key of ['maturity', 'health', 'value']) {
    const id = text(named[key]);
    if (id !== null && dimension.choices.some(choice => choice.id === id)) dimensions[key] = id;
  }
  return {
    entityId: entity.entityId,
    capabilityFieldId: capability.fieldId,
    dimensionFieldId: dimension.fieldId,
    scoreFieldId: score.fieldId,
    dateFieldId: date.fieldId,
    dimensions,
    scale: score.scale ?? { min: 1, max: 5 },
    dimensionName: key => dimension.choices.find(choice => choice.id === dimensions[key])?.displayName ?? key,
  };
}

/**
 * Every assessment by capability and dimension, oldest first, so the latest and the one in
 * force at a date are both one lookup. An assessment with no score or no date says nothing and
 * is left out; two on the same date keep the order they were read in, the later one winning.
 */
export function assessmentIndex(assessments, records) {
  const byCapability = new Map();
  const dates = new Set();
  for (const record of records ?? []) {
    const capability = record.values?.[assessments.capabilityFieldId];
    const dimension = record.values?.[assessments.dimensionFieldId];
    const scored = record.values?.[assessments.scoreFieldId];
    const date = record.values?.[assessments.dateFieldId];
    if (!capability || !dimension || scored == null || !date) continue;
    const dimensions = byCapability.get(capability) ?? new Map();
    const list = dimensions.get(dimension) ?? [];
    list.push({ score: Number(scored), date: String(date), recordId: record.recordId });
    dimensions.set(dimension, list);
    byCapability.set(capability, dimensions);
    dates.add(String(date));
  }
  for (const dimensions of byCapability.values()) {
    for (const list of dimensions.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  const history = (capabilityId, key) => byCapability.get(capabilityId)?.get(assessments.dimensions[key]) ?? [];
  return {
    /** The latest assessment of a capability on a dimension, or null. */
    latest: (capabilityId, key) => history(capabilityId, key).at(-1) ?? null,
    /** The assessment in force on a date: the latest on or before it, or null. */
    asOf: (capabilityId, key, date) => history(capabilityId, key).filter(entry => entry.date <= date).at(-1) ?? null,
    /** How many assessments a capability has on a dimension. */
    count: (capabilityId, key) => history(capabilityId, key).length,
    /** Every date anything was assessed, oldest first: the dates "change since" can be measured from. */
    dates: [...dates].sort(),
  };
}

/**
 * Application coverage (W-081): the link record type that says which application supports which
 * capability, named by the view's configuration as
 *
 *   { "coverage": { "entityId", "capability", "application", "role", "fit" } }
 *
 * where `capability` and `application` are its two references and `role` and `fit` are optional
 * choice fields the matrix shows. Null when the configuration names none.
 */
export function bindCoverage(value, entities, atlasEntityId, problems) {
  const configured = plainObject(value);
  if (Object.keys(configured).length === 0) return null;
  const entity = entities.find(candidate => candidate.entityId === configured.entityId);
  const field = id => entity?.fields.find(candidate => candidate.fieldId === id && !candidate.calculated);
  const capability = field(configured.capability), application = field(configured.application);
  if (entity === undefined || capability?.reference?.targetEntityId !== atlasEntityId || !application?.reference) {
    problems.push(`Coverage needs ${configured.entityId ?? 'a record type'} with a reference to the capabilities and one to the applications.`);
    return null;
  }
  const choice = id => { const found = field(id); return found !== undefined && found.choices.length > 0 ? found : null; };
  const role = choice(configured.role), fit = choice(configured.fit);
  const applications = entities.find(candidate => candidate.entityId === application.reference.targetEntityId);
  return {
    entityId: entity.entityId,
    capabilityFieldId: capability.fieldId,
    applicationFieldId: application.fieldId,
    applicationName: applications?.displayName ?? application.displayName,
    roleFieldId: role?.fieldId ?? null,
    fitFieldId: fit?.fieldId ?? null,
    choiceName: (fieldId, id) => [role, fit].find(candidate => candidate?.fieldId === fieldId)?.choices.find(c => c.id === id)?.displayName ?? (id ?? null),
    tone: id => fit?.choices.find(c => c.id === id)?.tone ?? null,
  };
}

/**
 * How many distinct applications support each capability, counting everything below a group
 * as the group's own (W-081): a group with no application of its own is still covered when its
 * children are, and two children on one application count it once.
 */
export function coverageCounts(model, coverage, links) {
  const direct = new Map();
  for (const link of links ?? []) {
    const capability = link.values?.[coverage.capabilityFieldId], application = link.values?.[coverage.applicationFieldId];
    if (!capability || !application) continue;
    (direct.get(capability) ?? direct.set(capability, new Set()).get(capability)).add(application);
  }
  const counts = new Map();
  const visit = record => {
    const apps = new Set(direct.get(record.recordId) ?? []);
    for (const child of model.children.get(record.recordId) ?? []) for (const app of visit(child)) apps.add(app);
    counts.set(record.recordId, apps.size);
    return apps;
  };
  model.roots.forEach(visit);
  return counts;
}

/**
 * Capabilities against applications (W-081): a row for each capability given that has an
 * application of its own, a column for each application that supports one of them, and in each
 * cell the links between the two, by role and fit. Rows keep the order given; columns go by name.
 */
export function coverageMatrix(capabilities, coverage, links) {
  const byCapability = new Map();
  for (const link of links ?? []) {
    const capability = link.values?.[coverage.capabilityFieldId];
    if (capability) (byCapability.get(capability) ?? byCapability.set(capability, []).get(capability)).push(link);
  }
  const rows = capabilities.filter(record => byCapability.has(record.recordId)).map(record => ({ record, links: byCapability.get(record.recordId) }));
  const applications = new Map();
  for (const { links: own } of rows) for (const link of own) {
    const id = link.values[coverage.applicationFieldId];
    if (id && !applications.has(id)) applications.set(id, link.labels?.[coverage.applicationFieldId] ?? id);
  }
  const columns = [...applications].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { columns, rows: rows.map(({ record, links: own }) => ({
    record,
    cells: new Map(columns.map(({ id }) => [id, own.filter(link => link.values[coverage.applicationFieldId] === id)])),
  })) };
}

/**
 * The Atlas's bindings for the view that shows it, from the view's context (its record type,
 * label, status, bound fields and configuration) and the file's schema.
 *
 * Required: the record type declares a hierarchy (ADR-0019), whose parent field the editor
 * writes, and the view names a label field, which Nendo requires of every view. Each part in
 * ROLES is optional. A part counts only when its field belongs to the record type, is one the
 * view binds, and holds the right kind of value; otherwise `problems` says what to bind.
 *
 * Returns:
 *   entityId, typeName      the record type and its name
 *   labelFieldId            the field each capability is named by
 *   parentFieldId, orderFieldId   the declared tree; null when the record type declares none
 *   fields                  part -> field ID, or null when the view gives that part nothing
 *   choices                 part -> [{ id, displayName, tone }] for a bound choice part
 *   scale                   { min, max } of the maturity field
 *   related                 the related sections (relatedTypes above)
 *   problems                sentences naming what to bind
 *   banner                  { title, note } for the line above the map, or null
 *   selfReferences          the names of the record type's references to itself
 *   has(part), value(record, part), title(record), gap(record), choiceName(part, id), tone(part, id)
 */
export function bindAtlas(context, schema) {
  const entityId = context?.entityId ?? null;
  const bindings = plainObject(context?.bindings);
  const configuration = plainObject(context?.configuration);
  const entities = Array.isArray(schema?.entities) ? schema.entities : [];
  const entity = entities.find(candidate => candidate.entityId === entityId) ?? null;
  const own = new Map((entity?.fields ?? []).map(field => [field.fieldId, field]));
  const typeName = entity?.displayName ?? entityId ?? 'this record type';
  const problems = [];

  // What the view's definition binds on its own record type: its label, its status and its fields.
  const bound = new Set([bindings.labelFieldId, bindings.statusFieldId,
    ...(Array.isArray(bindings.fields) ? bindings.fields : []).filter(binding => binding.entityId === entityId).map(binding => binding.fieldId)]
    .filter(fieldId => typeof fieldId === 'string'));

  // The tree the record type declares. A host whose schema.describe does not name it yet leaves
  // `hierarchy` out; the record type's one reference to itself is then the parent.
  const selfReferences = [...own.values()].filter(field => !field.calculated && field.reference?.targetEntityId === entityId);
  const tree = entity !== null && 'hierarchy' in entity ? entity.hierarchy
    : selfReferences.length === 1 ? { parentFieldId: selfReferences[0].fieldId, orderFieldId: null } : null;

  const configured = plainObject(configuration.fields);
  for (const part of Object.keys(configured)) {
    if (!Object.hasOwn(ROLES, part)) {
      problems.push(`The configuration gives a field to "${part}", which is not a part of the Atlas. Its parts are ${Object.keys(ROLES).join(', ')}.`);
    }
  }
  const fields = {}, choices = {};
  for (const [part, role] of Object.entries(ROLES)) {
    fields[part] = null;
    const named = text(configured[part]);
    // The view's status field is the lifecycle unless the configuration says otherwise.
    const fieldId = named ?? (part === 'lifecycle' ? text(bindings.statusFieldId) : null);
    if (fieldId === null) continue;
    const field = own.get(fieldId);
    const problem = field === undefined ? `${role.name} is set to ${fieldId}, which is not a field of ${typeName}.`
      : !bound.has(fieldId) ? `${role.name} is set to ${field.displayName}, which this view does not bind. Bind ${field.displayName} to the view, or take ${part} out of its configuration.`
      : field.calculated || !KINDS[role.kind].fits(field) ? `${role.name} needs ${KINDS[role.kind].words}, and ${field.displayName} is not one.`
      : null;
    if (problem !== null) {
      // A status field that is not a choice is simply not a lifecycle; only a named part is a mistake.
      if (named !== null) problems.push(problem);
      continue;
    }
    fields[part] = fieldId;
    if (role.kind === 'choice') {
      choices[part] = field.choices.filter(choice => !choice.retired).map(({ id, displayName, tone }) => ({ id, displayName, tone: tone ?? null }));
    }
  }
  const related = relatedTypes(entityId, entities, plainObject(configuration.related), typeName, problems);
  const assessments = bindAssessments(configuration.assessments, entities, entityId, problems);
  const coverage = bindCoverage(configuration.coverage, entities, entityId, problems);
  // With dated assessments, maturity is the latest Maturity assessment; the stored field, where
  // there is one, is what a capability shows until it is first assessed.
  const assessedMaturity = assessments?.dimensions.maturity !== undefined;
  const scale = (fields.maturity !== null ? own.get(fields.maturity).scale : null) ?? (assessedMaturity ? assessments.scale : null) ?? { min: 1, max: 5 };
  let index = null;

  const labelFieldId = text(bindings.labelFieldId);
  const stored = (record, part) => fields[part] === null ? null : record?.values?.[fields[part]] ?? null;
  const value = (record, part) => {
    if (part === 'maturity' && index !== null && assessedMaturity) {
      const latest = index.latest(record?.recordId, 'maturity');
      if (latest !== null) return latest.score;
    }
    return stored(record, part);
  };
  const has = part => {
    if (part === 'maturity') return fields.maturity !== null || assessedMaturity;
    // The editor writes the stored maturity only where assessments do not keep it.
    if (part === 'maturity-stored') return fields.maturity !== null && !assessedMaturity;
    if (part === 'assessments') return assessments !== null;
    if (part === 'health') return assessments?.dimensions.health !== undefined;
    if (part === 'coverage') return coverage !== null;
    return fields[part] !== null;
  };
  return {
    entityId,
    typeName,
    labelFieldId,
    parentFieldId: tree?.parentFieldId ?? null,
    orderFieldId: tree?.orderFieldId ?? null,
    fields,
    choices,
    scale,
    related,
    problems,
    banner: bannerOf(configuration.banner),
    selfReferences: selfReferences.map(field => field.displayName),
    has,
    value,
    assessments,
    coverage,
    /** Hand the assessment records to the binding; the latest per dimension is read from them. */
    useAssessments(records) {
      index = assessments === null ? null : assessmentIndex(assessments, records);
    },
    /** The latest assessment of a record on a dimension ('maturity', 'health', 'value'), or null. */
    assessed: (record, key) => index?.latest(record?.recordId, key) ?? null,
    /** How many assessments a record has on a dimension. */
    assessedCount: (record, key) => index?.count(record?.recordId, key) ?? 0,
    /** Every date anything was assessed, oldest first. */
    assessmentDates: () => index?.dates ?? [],
    /**
     * Latest maturity minus the maturity in force on `since`, or null when either is missing: a
     * change is only stated between two judgements that were actually made.
     */
    change(record, since) {
      if (index === null || since == null) return null;
      const now = index.latest(record?.recordId, 'maturity'), then = index.asOf(record?.recordId, 'maturity', since);
      return now === null || then === null ? null : now.score - then.score;
    },
    title: record => String((labelFieldId === null ? null : record?.values?.[labelFieldId]) || '(Unnamed capability)'),
    /**
     * Target minus current maturity, or null when either is missing. A group's assessment is
     * its own judgement: nothing here averages or infers it from the children.
     */
    gap(record) {
      const current = value(record, 'maturity'), target = value(record, 'target');
      return current == null || target == null ? null : Number(target) - Number(current);
    },
    choiceName: (part, id) => (choices[part] ?? []).find(choice => choice.id === id)?.displayName ?? (id == null ? null : String(id)),
    tone: (part, id) => (choices[part] ?? []).find(choice => choice.id === id)?.tone ?? null,
  };
}

/** A related record's line under its name: the section's template, or its choices by name. */
export function relatedRow(entry, record) {
  if (entry.row !== null) return entry.row.replace(/\{([^{}]+)\}/g, (_, fieldId) => display(record, fieldId, entry.fields) ?? '—');
  return entry.fields.filter(field => !field.calculated && field.choices.length > 0)
    .map(field => display(record, field.fieldId, entry.fields)).filter(Boolean).join(' · ');
}

/** A related record's name: what a link points at, or the record's own label. */
export function relatedName(entry, record) {
  if (entry.farFieldId !== null) return record.labels?.[entry.farFieldId] ?? `Missing ${String(entry.farName).toLowerCase()}`;
  return (entry.labelFieldId === null ? null : display(record, entry.labelFieldId, entry.fields)) ?? record.recordId;
}

/**
 * The capability hierarchy as the Engine keeps it (ADR-0019): the nodes of one records.treeAll
 * read, depth first, each with its parent. The file declares the parent a hierarchy, so every
 * write that would close a loop or go deeper than 32 levels is refused before it lands, and
 * siblings arrive in the Engine's order -- the order field, then record ID. Nothing here repairs a
 * link or sorts a level. `title` names a record for the layout engine.
 *
 * Returns:
 *   records      every capability, in the Engine's depth-first order
 *   byId         record ID -> record
 *   parents      record ID -> parent record ID, or null at the top level
 *   children     record ID -> child records, in sibling order
 *   roots        top-level records, in sibling order
 *   descendants  (id) -> every record under id, depth first
 *   tree         (record) -> { id, name, children } for the layout engine
 *   title        the title function it was built with
 */
export function hierarchy(nodes, title = record => String(record.recordId)) {
  const records = nodes.map(node => node.record);
  const byId = new Map(records.map(record => [record.recordId, record]));
  const parents = new Map(nodes.map(node => [node.record.recordId, node.parentRecordId ?? null]));
  const children = new Map(records.map(record => [record.recordId, []]));
  const roots = [];
  for (const node of nodes) (node.parentRecordId ? children.get(node.parentRecordId) : roots).push(node.record);

  function descendants(id) {
    const found = [];
    const visit = parentId => {
      for (const child of children.get(parentId) || []) {
        found.push(child);
        visit(child.recordId);
      }
    };
    visit(id);
    return found;
  }

  const tree = record => ({
    id: record.recordId,
    name: title(record),
    children: (children.get(record.recordId) || []).map(tree),
  });

  return { records, byId, parents, children, roots, descendants, tree, title };
}

/**
 * What the map and the tables show for a scope and a level choice.
 *
 * At the enterprise the top-level capabilities are level 1. A focused group is context at
 * level 0, so one level below it still shows its immediate children. A group whose children lie
 * beyond the chosen level is drawn collapsed; hiddenCounts says how many capabilities it holds.
 *
 * Returns:
 *   tree          [{ id, name, children }] cut at the chosen level, for the layout engine
 *   rows          [{ record, depth }] in hierarchy order, depth 0 at the top of the scope
 *   hiddenCounts  record ID -> number of capabilities under it, whether shown or not
 *   maxDepth      the deepest level in the scope, whatever the choice
 */
export function projectHierarchy(model, scope, levels = Infinity) {
  const focused = scope && model.byId.has(scope);
  const roots = focused ? [model.byId.get(scope)] : model.roots;
  const topLevel = focused ? 0 : 1;
  const rows = [], hiddenCounts = new Map();
  let maxDepth = 0;

  function measure(record, depth) {
    maxDepth = Math.max(maxDepth, depth);
    let count = 0;
    for (const child of model.children.get(record.recordId) || []) count += 1 + measure(child, depth + 1);
    hiddenCounts.set(record.recordId, count);
    return count;
  }
  roots.forEach(record => measure(record, topLevel));

  function visit(record, depth) {
    rows.push({ record, depth: depth - topLevel });
    return {
      id: record.recordId,
      name: model.title(record),
      children: depth < levels ? (model.children.get(record.recordId) || []).map(child => visit(child, depth + 1)) : [],
    };
  }
  const tree = roots.map(record => visit(record, topLevel));

  return { tree, rows, hiddenCounts, maxDepth };
}

/** The IDs of the records under parentId in sibling order; null is the top level. */
function siblingIds(model, parentId) {
  return (parentId === null ? model.roots : model.children.get(parentId) ?? []).map(record => record.recordId);
}

/** { parentId, beforeId } is where the record already stands. */
function standsAt(model, recordId, parentId, beforeId, ordered) {
  if ((model.parents.get(recordId) ?? null) !== parentId) return false;
  if (!ordered) return true;
  const siblings = siblingIds(model, parentId);
  return (siblings[siblings.indexOf(recordId) + 1] ?? null) === beforeId;
}

/**
 * Where a drop puts a capability, as records.move takes it (W-079): { parentId, beforeId }, a
 * parent of null being the top level and a beforeId of null the end. A drop is
 * { kind: 'into' | 'before' | 'after', targetId }: into makes it the target's last child;
 * before and after make it the target's sibling on that side. The answer is { refused } when
 * the drop would put the capability inside itself, and { unchanged } when it is already
 * there, so neither is sent. ordered is false when the tree declares no order field: a record
 * then joins its new parent's children without a place among them.
 */
export function dropTarget(model, recordId, drop, ordered = true) {
  const inside = new Set([recordId, ...model.descendants(recordId).map(record => record.recordId)]);
  if (drop.kind === 'into' && inside.has(drop.targetId) || drop.kind !== 'into' && drop.targetId !== recordId && inside.has(drop.targetId)) {
    return { refused: true };
  }
  let parentId, beforeId = null;
  if (drop.kind === 'into') parentId = drop.targetId;
  else {
    if (drop.targetId === recordId) return { unchanged: true };
    parentId = model.parents.get(drop.targetId) ?? null;
    if (ordered) {
      const siblings = siblingIds(model, parentId).filter(id => id !== recordId);
      const at = siblings.indexOf(drop.targetId);
      beforeId = drop.kind === 'before' ? drop.targetId : siblings[at + 1] ?? null;
    }
  }
  return standsAt(model, recordId, parentId, beforeId, ordered) ? { unchanged: true } : { parentId, beforeId };
}

/**
 * The keyboard's moves, as the outline makes them (ADR-0019): up and down swap with the
 * sibling on that side, in makes it the last child of the sibling above, out places it after
 * its parent. null when there is nowhere to go that way.
 */
export function stepTarget(model, recordId, step, ordered = true) {
  const parentId = model.parents.get(recordId) ?? null;
  const siblings = siblingIds(model, parentId);
  const at = siblings.indexOf(recordId);
  if (at < 0) return null;
  switch (step) {
    case 'up':
      return ordered && at > 0 ? { parentId, beforeId: siblings[at - 1] } : null;
    case 'down':
      return ordered && at < siblings.length - 1 ? { parentId, beforeId: siblings[at + 2] ?? null } : null;
    case 'in':
      return at > 0 ? { parentId: siblings[at - 1], beforeId: null } : null;
    case 'out': {
      if (parentId === null) return null;
      const grandparent = model.parents.get(parentId) ?? null;
      const uncles = siblingIds(model, grandparent);
      return { parentId: grandparent, beforeId: ordered ? uncles[uncles.indexOf(parentId) + 1] ?? null : null };
    }
    default:
      return null;
  }
}
