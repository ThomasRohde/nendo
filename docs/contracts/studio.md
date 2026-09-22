# Studio contract

This contract gives the requirements for the permanent host-owned database editor.

- **Decision:** [ADR-0015](../decisions/0015-host-owned-database-studio-and-ag-grid-community.md)

## 1. Axiom

Every valid `.nendo` file opens with a permanent human workspace that the host supplies. This workspace is **Nendo Studio**.

Studio is available when:

- the database contains no user entities;
- no agent is connected;
- no custom surface exists;
- a custom definition or declarative command is invalid;
- the file opens in a restricted safe mode.

Application content cannot remove, replace or hide the route back to Studio.

## 2. Experience target

The default Data workspace should feel closer to a modern Notion database table than to a raw SQLite browser. This is a target for interaction quality. It is not a target for visual imitation or feature parity.

A user should experience records as typed objects with understandable properties, relations, validation and history. The user should not see anonymous rows and foreign-key values.

The minimum Studio destinations are:

1. **Data**: table, record inspector, search, filters, sorts, import and export;
2. **Structure**: entities, fields, constraints, relationships and physical mapping;
3. **Surfaces**: generated and custom semantic views plus validation/disable/restore;
4. **History**: revisions, attribution, semantic changes and supported compensation;
5. **Health**: compatibility, integrity, drift, backup, recovery and safe mode.

## 3. Empty database experience

A new Nendo file contains only kernel metadata and a genesis revision. Studio opens on Data and offers:

- **Create entity**;
- **Import CSV**;
- **Attach agent** and copy connection guidance;
- **Inspect file** identity, versions and health.

Studio does not add a sample entity, record or custom surface implicitly.

## 4. Automatic experience for every entity

When an entity exists, Studio immediately supplies:

- an `All records` table;
- a generated record inspector/form;
- create, edit and delete paths;
- sorting, filtering and quick search;
- schema and record-history inspection;
- CSV import and export.

These are runtime projections from the semantic schema. A generated default does not have to become stored application content until the user customises or names it.

## 5. Table interaction contract

The first MVP should provide:

- inline editing for scalar fields;
- explicit pending, committed, validation-failed and conflicted states;
- keyboard focus, navigation, edit, commit and cancel behaviour;
- a persistent new-record affordance;
- resizable, movable and hideable columns;
- field-aware sort and filter operations;
- row selection and a small set of atomic bulk operations;
- bounded TSV copy and paste;
- a record inspector for long text, relationships and metadata;
- deterministic row ordering and block loading for large entities;
- light, dark and high-contrast presentation;
- accessible names, roles, errors and focus;
- stable semantic test targets based on entity, field and record IDs.

Saved views are desirable, but they are secondary to correct editing. The MVP may ship one default view plus one saved custom view per entity before it supports a general view-management system.

## 6. Field presentations

The Studio maps semantic storage and constraints to editors:

| Semantic form | Storage/relationship | Table experience |
| --- | --- | --- |
| short text | `text` | inline text editor |
| long text | `text` + presentation hint | clipped cell and record inspector editor |
| integer/decimal | numeric scalar | locale-aware numeric editor |
| checkbox | `boolean` | direct toggle with nullable state where declared |
| date/datetime | canonical date value | date/time editor with explicit timezone semantics |
| single choice | scalar + allowed stable option IDs | searchable choice picker; the cell shows the tone of the option as a dot |
| rating | `integer` + a closed min/max scale of at most ten values | the cell draws dots filled to the value; the user edits it by choosing one of the numbers of the scale; a value outside the scale shows as that number with the issue stated, never as a dot count that nobody chose |
| reference | relationship/foreign key | related-record label and picker |
| UUID | `uuid` | normally read-only abbreviated value |

Multi-choice is not an MVP scalar type. It requires a relationship/join model and is deferred. Binary fields/assets and general JSON editing are also deferred.

Unknown future types stay visible and read-only. They do not disappear.

## 7. Authority boundary

The table component is a renderer and interaction surface. It does not own persistence or the Nendo application model.

It receives no:

- SQLite connection or SQL;
- database or filesystem path;
- shell, process or network authority;
- generic native host object;
- MCP credential or proposal authority.

It calls named, validated operations such as:

```text
queryRows
createRecord
editField
removeRecords
applyBoundedPaste
saveTableView
```

Every mutation includes an active application/session identifier, stable semantic IDs, optimistic version preconditions and an idempotency key. A value is authoritative only after the host commits it and returns the resulting version.

Schema actions that start from a column menu are application-lane operations. The table never executes DDL.

## 8. Component and containing architecture status

ADR-0002 selected a single local web workbench in a thin WinUI host. DS1 then
compared AG Grid Community and Tabulator through that containing boundary. It
recommended AG Grid Community for DS2. DS2 qualified the Windows provider,
automation, high-contrast, focus, packaging and lifecycle paths. ADR-0015 then
accepted AG Grid Community behind an adapter that Nendo owns. The real 200%
Windows scale has no recorded pass. It is an explicit hardening obligation after
selection and before release.

The acceptance of ADR-0015 resolved the component decision. Before acceptance,
the decision had to price the full system, and not only the grid. The ADR records
these costs:

- duplicate typed editors;
- theming and high contrast;
- accessibility rigs;
- UI automation rigs;
- focus and clipboard seams;
- virtualisation and paging;
- JavaScript/NuGet supply chains;
- packaging and crash isolation;
- long-term replacement cost.

The semantic renderer, containing-architecture and functional-grid experiments
are complete. Their prototypes stay disposable evidence. They are not production
scaffolding. Acceptance of the direction does not select the production source
structure, and it does not waive the host/service boundary.

## 9. Prototype gates

ADR-0015 was accepted after the following evidence and the explicit owner risk
disposition were recorded under `docs/experiments/results/` and in the ADR. The
gates below are the record of what the acceptance required. They are not open
work. The one obligation that remains is the real 200% Windows scale in DS2, as
section 8 states.

### DS1 — functional grid spike — complete

The DS1 result
records a pass for both candidates and recommends AG Grid Community for DS2.

Prove against the chosen containing architecture:

- empty and populated database states;
- 100, 10,000 and 100,000-row fixtures through one bounded query contract;
- text, numeric, boolean, date, choice and reference editors;
- inline edit, row creation, deletion, selected-row bulk action and bounded TSV paste;
- optimistic conflicts and idempotent retry;
- database session survival after renderer reload/crash;
- all application assets local and offline;
- no commercial/Enterprise module dependency when evaluating AG Grid Community.

### DS2 — accessibility, automation and lifecycle

Prove:

- keyboard-only use;
- Narrator or equivalent Windows accessibility evidence;
- visible focus across shell/component boundaries;
- 200% text/display scaling and high contrast;
- stable semantic automation targets;
- light/dark theme propagation;
- packaged offline launch;
- dependency inventory and update policy;
- measured implementation duplication for the chosen architecture.

### Exit rule

Vendor documentation and a mock-up that looks convincing are not sufficient. The experiment result must record commands, versions, measurements, observations, failures and unresolved limitations.

## 10. Safe-mode fallback

If the primary table renderer cannot initialise, Studio must keep a bounded fallback that can:

- list entities;
- inspect one record at a time;
- export data;
- inspect file health;
- reach backup and recovery actions.

A renderer crash must not close the database, replay an unconfirmed mutation or corrupt the application session.

## 11. MVP acceptance criteria

- [ ] Empty `.nendo` files open into a useful Studio without an agent.
- [ ] Every entity receives a usable table and record editor automatically.
- [ ] Users can create and edit records without SQL or a custom surface.
- [ ] Basic entity/field creation stays available through host-owned tooling.
- [ ] A large flat table is block-loaded. It is not copied whole into the UI process.
- [ ] Edits are atomic, attributed, idempotent and version checked.
- [ ] Invalid or conflicting edits are never presented as committed.
- [ ] Custom surfaces can fail while Studio stays usable.
- [ ] Keyboard, accessibility, scaling, high-contrast and automation gates pass.
- [ ] The packaged experience works offline.
- [ ] CI enforces the selected grid/component licence and dependency boundary.
- [ ] Ordinary SQLite inspection still exposes understandable user data.
