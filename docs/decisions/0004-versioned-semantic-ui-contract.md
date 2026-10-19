# ADR-0004: Use a strict versioned semantic UI contract

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `ComposableSurfaceTests`, `SemanticCapabilityTests` and the per-kind Engine suites, the Workbench `npm test` suites, and `tools/Gate-AgentAuthoring.mjs`
- **Depends on:** ADR-0002 containing desktop architecture and ADR-0003 relational/metadata boundary

## Context

Nendo needs stored forms, lists, boards, pages and charts that survive renderer
replacement and that can be inspected, diffed and authored through typed operations.
Persisted React, AG Grid, HTML, CSS or other renderer configuration would turn an
implementation choice into the file format and open an authority escape hatch.

The drivers are: renderer-independent durable definitions; stable semantic targets for
authoring, accessibility and automation; deterministic validation, compilation and
diagnostics; operation-level diff, history, proposal and promotion; no arbitrary code,
markup, style or privileged host invocation; and safe failure that keeps Studio reachable.

## Decision

Nendo stores versioned semantic UI definitions and compiles them into an immutable,
host-neutral render plan. The delivered behaviour, every diagnostic and every limit are
in [the semantic surfaces contract](../contracts/semantic-surfaces.md); this ADR states
the rules that bound it.

### The contract and its tree

- **Contract version 3 is the only shape a host compiles.** A stored root that declares
  `definitionVersion` 1 or 2 fails closed with `NUI003`, which names the supported
  version. `Compile` validates the node tree or returns nothing. An entity's surfaces are
  `NendoApplicationPlan.Surfaces`, one ordered tree; there are no fixed form, list, board
  or command slots and no `cardFieldIds` (a board's card fields are its ordered
  `fieldBinding` children). `nendo://application/surfaces` describes each entity through
  `surfaces` alone.
- **Stable identity.** Every definition and node has a stable semantic ID. Parent,
  position, binding and typed properties are explicit.
- **Typed operations.** The canonical UI operations are `ui.addNode`, `ui.setProperty`,
  `ui.moveNode`, `ui.removeNode` and `ui.removeProperty`. Whole-definition convenience
  input validates and expands into them before diff, history, proposal or promotion.
  Agent-authored definition changes use the proposal lane of
  [ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md).
- **A closed vocabulary.** Permitted kinds, properties, children per kind, operators,
  value kinds and aggregates are tables. They are emitted as a machine-readable
  description generated from the same tables the compiler validates against, so a client
  never has to probe. A surface nests at most 24 levels, its root counted (`NUI456`).
- **Fail closed.** Unknown kinds or properties, illegal parenting, orphans, parent cycles,
  duplicate roots, unknown command effects and incompatible versions are diagnostics with
  a code, `semanticId` and `propertyPath`. A core error produces no partial plan, and an
  invalid definition suppresses every custom plan. Studio, the data and recovery are
  never affected. A property a kind does not take is `NUI090`.
- **What a definition never holds:** renderer components or configuration, HTML, CSS,
  XAML, JavaScript, arbitrary controls, SQL, paths or generic host calls. Code a file
  carries runs only as a custom view under
  [ADR-0013](0013-custom-views-with-code-in-the-file.md), whose view kinds join this
  vocabulary.
- **Digest.** The render-plan digest hashes an explicit payload projection, with the
  contract version inside it. It is stable, insensitive to meaningless ordering and
  sensitive to every semantic change, including a move. It is a compile-time identity:
  never persisted, never an authority token, never checked by promotion, which uses the
  canonical operation digest.
- **Renderer state stays out of the file.** Adapters derive accessibility and automation
  targets from semantic IDs. Grid configuration, a Markdown editor's document, selection,
  drills, filter picks, folds and tabs are adapter state. The Workbench's runtime
  dependencies are `ag-grid-community`, Tiptap and `marked`.
- **Commands** invoke only a closed effect set through typed application services: a
  command owns ordered `commandStep` children, applied as one atomic mutation against one
  expected record version. No cross-entity writes.

### Admitting a kind or property

A kind or property is admitted only with an owner-facing semantic diff that says what it
does to records, and an explicit path in both Use and the read-only proposal preview.
Geometry alone is not application meaning. Every visible node is reachable; an unknown
node never falls through to another presentation or disappears. Filters and command steps
contribute to their parent's meaning and need no standalone control. A kind accepted
where nothing draws it is refused rather than compiled and silently missing.

Each addition arrives with its compiler, diff, Use and preview support, its capability
rung, an authoring example, a step in the agent-authoring gate and a phase in the
blackbox prompt. The preview uses the validated clone, labels bounded samples, never
reads active-file totals and never acquires write handlers.

### Node kinds

| Kind | Where | Rules |
| --- | --- | --- |
| `recordForm` | root, one per entity | Create/edit form. A `detailSurface` takes precedence for the record page. |
| `detailSurface` | root, one per entity | The record page. Optional header `titleFieldId`, `subtitleFieldId`, `accentFieldId`. |
| `recordList`, `boardSurface`, `calendarSurface`, `timelineSurface`, `gallerySurface`, `matrixSurface`, `outlineSurface`, `recordCommand` | roots, eight of each kind per entity | Each owns its own query and window. |
| `overviewSurface` | root, one per file | The front page; no `entityId`. |
| `section` | non-root | Titled group; takes `title`, `visibleWhen`, `opens`; may hold sections. |
| `tabGroup` | under `detailSurface`, `recordForm`, `section`, `overviewSurface` | Only titled `section` children; one level of tabs, nesting through sections included. |
| `fieldBinding` | non-root | One field; optional `visibleWhen`. |
| `relatedList` | record page | Records of `targetEntityId` that point back through `viaFieldId` (`NUI260`–`NUI266`). Takes `fieldBinding`, `filterClause`, `summaryTile`; no chart. |
| `summaryTile`, `breakdownChart`, `progressTile`, `rangeTile`, `trendChart`, `activityGrid` | tiles | Accepted on lists, boards, galleries, matrices, record pages, sections and the overview. |
| `recentList`, `rankedList` | overview and its sections only | `NUI395`, `NUI422` elsewhere. |
| `filterClause`, `commandStep` | non-root | Declared filter; command effect. |

`entityId` on a tile, chart or list is required under an overview and refused anywhere
else, where it could only disagree with its surface. Use selects a surface by its stable
ID, in compiled root order, defaulting to the first eligible root. A missing remembered
root falls back without erasing the choice. Selection is file-session renderer state.
Studio keeps its own browsing state.

### Clearing a property

`ui.removeProperty {surfaceId, nodeId, propertyName}` is on the definition lane and
`ReversibleWithRetainedState`. It deletes the property's row, so the node behaves as if it
never had it, and retains the removed value as evidence. A property the node does not
carry is refused (`ui-property-absent`). It is the inverse of a `ui.setProperty` that gave
a property its first value, so History offers Undo on every `ui.setProperty`; its own
inverse is `ui.setProperty` with the retained value. Both are refused once the definition
has moved on, and the compile check that guards every definition undo still applies. A
JSON null remains a present property whose value is null, and validators refuse it. A
file that has cleared a property, including by such an Undo, needs host 1.48.0.

### Filters, values and the query budget

- `filterClause` children are ANDed. Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`,
  `isNull`, `isNotNull`. Ordering is `orderByFieldId` with `orderDirection`. There is no
  expression language and no free-text operator.
- Value kinds, shared with `commandStep`: `literal` (typed to the field's storage kind,
  with the `$nendoNumber` envelope for numbers), `today`, `now`, `null`, `thisWeek` and
  `thisMonth`. A mismatched value is a diagnostic, never a host fault.
- **Periods.** `thisWeek` and `thisMonth` are spans of days on a Date or DateTime field,
  the week starting Monday, resolved by the reader in the person's own calendar as `today`
  is. A period is compared by an edge, so a clause stays one filter: `lt` before it, `gte`
  from its first day, `lte` to its last day, `gt` after it. Any other operator is
  `NUI460`, the wrong field `NUI457`, and a command step assigning a period `NUI287`.
  Custom views follow the same rules. Formulas still have no clock. Host 1.53.0.
- **Budget.** One query carries at most eight effective filters (`MaximumEffectiveFilters`),
  counting inherited root and tile clauses and the predicates the host adds: one for a
  board column or a related-list reference, two date bounds for a calendar month, a
  timeline year or a trend, one `isNotNull` for a ranking. The over-time and ranking
  refusals name the clauses the host adds. An over-budget definition is refused before
  acceptance (`NUI300`). The host never drops a predicate or widens a query.
- Pagination keeps the original query snapshot; query or revision changes invalidate
  cursors; a stale response never replaces current state; a failed read shows a retry
  state, never an unfiltered fallback.

### Totals

- `summaryTile` aggregates are `count`, `sum`, `min` and `max`. `count` takes no field;
  the others take one Integer or Decimal `fieldId`. The host folds stored lexemes itself,
  one streamed row at a time, accumulating a sum as a scaled integer, so every result is
  exact in constant memory. SQLite never aggregates a Decimal column.
- **`avg` is refused by name, with its reason** (`NUI292`): the mean of exact decimals is
  not generally exact. An average needs its own decision declaring a scale and rounding.
  Diagnostics: `NUI291` unknown aggregate, `NUI293` numeric aggregate with no field,
  `NUI294` unknown, retired or non-numeric field, `NUI295` `fieldId` beside `count`.
- A REAL value in a Decimal column refuses the aggregate (`aggregate-not-exact`). The
  result carries `valueLexeme` beside the JSON number, and the Workbench draws the lexeme.
  An empty set returns null and the tile says so; zero is a real sum. An aggregate that
  cannot be represented reads *Unavailable*. The safe-mode fold gives the same answers as
  SQLite.
- `scope` is `surface` (default) or `group`; `group` is legal only on a direct board child
  and adds the column's choice ID, or `isNull` for the ungrouped column. Invalid non-null
  choice data is never counted as null. Surface totals cover the whole matching set,
  independent of the loaded page.
- **Calculated totals.** A `summaryTile`, `breakdownChart` and `rankedList` may name a
  calculated Integer or Decimal. The host folds each record's result over the bounded read
  a calculated filter uses: an empty result adds nothing, a result in error refuses the
  whole total (`calculated-total-incomplete`), and past 10,000 records the read is refused
  (`calculated-query-too-wide`). A calculated Text, Boolean or Date is not a number. A
  calculated grouping, matrix axis, trend, range or date stays refused (`NUI214`). Host
  1.54.0, read from the node tree.

### Colour and charts

- **Tone.** A choice option may carry a `tone` from the closed set red, orange, amber,
  green, teal, blue, violet, grey, set through the choice-metadata operation and stored in
  `__nendo_choice_tone`. It is a semantic token; the renderer owns the Light and Dark
  colours, and a file never stores a hex value. A value nobody toned takes a hue derived
  from the stored value, stable and shared by every surface.
- **A chart** is an exact aggregate over one grouping, drawn as proportion. It shows its
  numbers, a table of them is one toggle away, it never draws a page of records as the
  whole set and never shows a proportion without both numbers. The grouping is a
  single-choice field or a Boolean (unset group last, a value outside the options counted
  separately), civil-date buckets, or, for a `breakdownChart` only, a bound Reference: an
  open grouping of the target records, labelled by the target's label field, ordered by
  label then ID, unset last. One grouped read answers at most 366 groups including the
  unset group (`MaximumAggregateGroups`); a reference grouping past that is refused whole
  (`aggregate-too-many-groups`), never drawn in part. A reference without target and label
  is `NUI350`.
- `breakdownChart` breaks down one aggregate by its grouping; at group scope it may not
  break down its own board's grouping (`NUI352`). `progressTile` is a ring of two counts:
  its own clauses over its scope, and the scope alone.
- `rangeTile` is not a chart: `min` and `max` of one field drawn as a strip with both ends
  labelled. It is the one tile that reads a Date; `sum` over a Date stays refused.
- **Over time.** `trendChart` states one exact number per `month` or `week`;
  `activityGrid` one count per day, and takes no aggregate or field. `range` is a closed
  word resolved to civil-date bounds at read time, so a stored definition never carries a
  date: `last12Months`, `last6Months`, `last90Days`, `last30Days` for a trend, `thisYear`
  and `lastTwelveMonths` for a grid. The host generates every bucket from the bounds, so
  an empty month is a column at zero and an empty day the lightest square. `dateFieldId`
  is a stored Date; a DateTime is refused by name, because truncating it is a time-zone
  decision not yet made.
- **Drill-through.** A segment, ring, bucket or cell opens the record type's first list
  with that group's predicates as a transient filter, with a pill to clear it. It is
  file-session renderer state, never written to the file. While a drill or Filter pick
  stands, a screen's own tiles and charts step aside.

### Grids and rankings

- **`matrixSurface`** crosses two different stored axes (`rowByFieldId`,
  `columnByFieldId`; `NUI410`–`NUI413`), each an active single choice or a Boolean. It is
  one grouped read over the cross product of both option sets plus unset lanes, so every
  cell number is exact over the whole surface scope and an empty cell is a cell. It counts
  only. Cells hold the surface's one bounded window as cards and state *showing n of m*
  where the window is partial. An `eq` on an axis leaves one option and each `ne` removes
  one; no other operator narrows an axis. Every reachable option is drawn; an unset row or
  column only when its number is not zero. A value outside the options is a data issue
  counted separately. The cross product must fit 366: over it at authoring time the
  definition is refused naming both fields and counts; grown over it later, the surface
  states it cannot draw rather than draw part. A cell drills with two predicates (`isNull`
  for an unset lane). A cell nobody answered reads as absent, never zero. Cards do not
  move between cells. No matrix on the front page.
- **`rankedList`** ranks records by an active Integer or Decimal `rankByFieldId`, stored
  or calculated (`NUI420`); a Date is refused. `limit` is 1 to 50, refused above, not
  clamped. Bars are against one exact `max` over the same scope; when the maximum is not
  above zero, no bars are drawn. Equal numbers share a numeral and the next skips; the
  limit cuts a tie that crosses it.
- **`recentList`** is a list's ordered window, at most ten rows, refused above.

### Calendar, timeline, gallery, outline and boards

- **`calendarSurface`**: required `dateFieldId`, an active Date (a DateTime is refused).
  A Monday-first month view of civil dates without UTC conversion, previous/next and
  Today, and a bounded undated view. Month queries use an inclusive start and exclusive
  next-month bound. Default order is date ascending with the record-ID tie-break; the
  declared order governs entries per day. Pages accumulate with an explicit
  partial/complete state and Load more, so a first page never looks like a complete month.
  DateTime, recurrence, durations and drag-to-date are out of scope.
- **`timelineSurface`**: records on a spine by a Date field, one civil year at a time with
  a heading per month. Optional `endDateFieldId` draws an inclusive span, cut at 31
  December and stated; an end before its start is a data issue. Placement is by the start
  date only, stated on the surface. `titleFieldId` and `accentFieldId` follow the record
  page's rules. Refusals `NUI370`–`NUI374`.
- **`gallerySurface`**: one card per record over exactly a list's bounded window and
  pager, with the same tiles. `titleFieldId` and `accentFieldId` are optional (`NUI380`,
  `NUI381`); without a title a card leads with its first bound field. Optional
  `coverFieldId` names an active media field of the type whose picture tops each card,
  square and edge to edge (`NUI459` otherwise); it is not repeated among the values. A
  gallery with a cover needs host 1.52.0.
- **Rating.** `presentation: rating` applies to an Integer field with a closed `min` and
  `max` of at most ten values, stored in `__nendo_field_scale` and reached through the
  field operation's evidence. The scale bounds the drawing, not the column: a value outside
  it is written and read exactly and reported as `NDATA012`.
- **`outlineSurface`**: a declared hierarchy ([ADR-0019](0019-hierarchies-in-the-schema.md))
  as an outline. Properties `title`, `titleFieldId`, `accentFieldId`, `expandDepth`,
  `reorder`; only `fieldBinding` children, drawn as columns. No ordering and no
  `filterClause`: the tree reads in sibling order and a find box opens a match's path. The
  type must declare a hierarchy (`NUI430`); the title is a stored Text that is not a
  choice (`NUI431`), defaulting to the parent reference's label field; the accent is a
  single choice (`NUI432`); `expandDepth` is 1 to 4, default 2 (`NUI433`); `reorder` is a
  Boolean (`NUI434`). While an outline shows a hierarchy, `schema.removeHierarchy` is
  refused (`hierarchy-field-in-use`). Open rows are kept for the device under
  `nendo.outlineRows.<applicationId>`. With `reorder`, records move through the Engine's
  typed move by keyboard (Alt, Shift and an arrow) and by pointer capture, not native drag
  and drop.
- **Board grouped by a reference.** `boardSurface.groupByFieldId` may be a bound Reference
  (an unbound one is refused at authoring). Every active record of the target type is a
  column, in ascending label order; `orderDirection` orders cards, never lanes; Ungrouped
  stays first. Past 24 columns (`MaximumReferenceBoardColumns`) the board draws none and
  states the target type, its record count and the bound; this is checked at read time
  only. A drag between columns writes the reference with the column's version; a changed
  target is refused (`target-version-conflict`) and the board reloads its columns. The
  capability ladder reads the field's storage kind for this, not only the node tree.

### Record pages

- **Header.** `detailSurface` takes optional `titleFieldId`, `subtitleFieldId` and
  `accentFieldId`.
- **Tabs.** A tab change keeps the record draft. Validation activates and focuses a
  hidden invalid field. A save is one typed mutation against its expected version. Tab
  selection is transient, keyboard-accessible, file-scoped state.
- **Conditional visibility.** `visibleWhen` on a `fieldBinding` or `section` names a
  Boolean calculated field of the record type. It decides what is on screen only; the
  field stays in the form and is saved.
- **Folding.** Every section folds, except a tab's body. An author says only how it
  starts: `opens` is `open` (default) or `closed`; another word is `NUI312`, on a tab's
  body `NUI313`, on another kind `NUI090`. What a person folds or opens is kept for the
  device under `nendo.sectionFolds.<applicationId>`, a map from node ID to `open` or
  `closed`, read before the first draw; untouched sections start as `opens` says, a
  section opened to reveal a required field is not remembered, and unavailable storage
  leaves `opens` in charge. A closed section reads nothing: its tiles, charts and lists
  read when opened, and a value read stays until the file changes. Fields of a closed
  section stay in the form, so a save carries the same values, and an empty required
  field reveals its section. The heading is the control, exposed as expanded or collapsed
  and operable by keyboard. Diff: *Add the section "Lately", starting closed.*, *Start
  the section closed.*, *Start the section open.*

### The overview page and the file's purpose

- **`overviewSurface`** is one per file, carries `title` and an optional `description`,
  and holds sections, tab groups, tiles, charts and recent and ranked lists. Use opens it
  first when one exists. It composes nothing across record types: each child is a bounded
  read over the one type it names, spending its own budget. No join, no expression over a
  result, no stored layout.
- **Purpose.** A file may carry one purpose: prose of at most 4,000 characters, refused
  above, set or cleared by `application.setPurpose` on the definition lane. It is not a
  node. It is stored in `__nendo_application_purpose`; a clear deletes the row, and
  nothing is derived from the file name. `nendo://application/describe` leads with it and
  the `manifest` read carries it; a person reads it on **About this file**. The review
  names it as `purposeBefore`/`purposeAfter`. Host 1.24.0, declared by the operation's
  evidence.

### Related lists and narrowing in Use

- **A related list is a way in.** It offers **Add**, the related type's own record page as
  a create form with the reference back filled in by label and carrying the parent's
  version (`target-version-required` otherwise), still editable; and **open**, the related
  record as its own page with one step back, replaced rather than stacked, never in the
  file. Neither is authored or stored, so nothing raises a rung. A type with no compiled
  surface offers neither and says so. A page with unsaved edits declines both in the board
  drag's words. No bulk add, no delete and no related list in a create form.
- **Links.** A related list whose type has a required reference back and at least one
  other required reference is a link list, read from the schema. Beside Add it offers
  **Link ‹other type›** per other required reference (the create form with the other
  end's picker open) and **Remove link** per row, which asks, then deletes the link record
  at its version as an ordinary, restorable delete. The ends are never touched. Custom
  views do the same through `records.create` and `records.delete`.
- **Filter pick.** A `recordList`, `boardSurface` or `matrixSurface` in Use offers
  **Filter** over every active single-choice or bound reference field of its type. A
  person picks one value (an option, a target record by label, or *Not set*), adding one
  `eq` or `isNull` clause to the screen's own. A screen whose clauses already spend the
  budget offers no Filter. A reference offers at most 100 targets by label. A board's
  columns and drag are unchanged.
- **Place state.** A Filter pick and Studio's sort and filter belong to the place, as a
  drill does: the trail copies them by value, Back, Forward and switching tabs restore
  them before reading, and a change amends the current place rather than adding a step.
  They are renderer state for the file session, never in the file, and are not remembered
  across a reopen.

### A file's look and icon

- **Look.** Every file has a tone and one letter or digit, drawn as a badge on the Nendo
  mark. Defaults: the tone from FNV-1a over the application ID's UTF-8 into orange, amber,
  green, teal, blue or violet, and the first letter or digit of the file name.
  `application.setLook` (`tone`, `letter`, null for a part's default) is on the definition
  lane; only chosen parts are stored, in `__nendo_application_look` (layout rung
  `-look-`), and returning both to default deletes the row. The manifest carries the
  look, resolved with defaults by `NendoLook.Resolve`; the review names
  `lookBefore`/`lookAfter`. Host 1.38.0.
- **Icon.** `application.setIcon { icon, expectedDefinitionRevision }`, definition lane,
  `ReversibleWithRetainedState`, sets a `media:` address already embedded in the file
  (`media-missing` otherwise), or null to remove it. The picture is a square PNG, 16 to
  1,024 pixels a side, at most 1 MiB (`icon-invalid` names which). It replaces the whole
  drawn icon, mark and badge; tone and letter return when it is removed. It is stored in
  `__nendo_application_icon` (`singleton_id`, `sha256` referencing `__nendo_media`) as
  the layout rung `-icon-`; removing it deletes the row and keeps the rung. An icon row
  naming missing or non-PNG content makes the file unreadable rather than misdrawn. The
  picture counts as in use for *Remove unused media*, and a new file of the application
  ([ADR-0022](0022-new-file-keeping-the-records-an-application-ships-with.md)) keeps it with the look.
  The manifest's `look` carries `icon`. The Workbench turns a dropped PNG, JPEG, GIF,
  WebP, AVIF, SVG or ICO into a 256-pixel PNG centred on transparency. Host 1.55.0.
- **Where the look shows**: window and taskbar icon, Alt+Tab, the notification-area icon,
  notification pictures and the status bar. The Jump List shows each file's icon as this
  device last drew it, and the shipped document icon for a file it never opened. A row the
  person pinned keeps the icon it had when pinned. Tabs carry no look. A person chooses
  the look and icon on **About this file**, through the ordinary proposal review.

### Capability versions

The version-3 tree is preserved, so new capabilities are gated by an increasing minimum
host version. One Engine calculation over the resulting definition covers additions,
property changes and moves at the completed mutation boundary, and feeds canonical
evidence, promotion and inspection. It reads the node tree and, where the tree cannot
show a capability, the entity fields (a reference board); a value with no node (purpose,
look, icon) is declared by its operation's evidence. Removing a capability never lowers a
file's minimum. Open never rewrites a file. Preview names a minimum-host raise as
irreversible. Intermediate hosts do not advertise later features. Product release version
and contract version are separate. The ladder may change as the product needs: its one
job is to say truthfully what a file needs.

| Host | Capability |
| --- | --- |
| 1.11.0 | Contract version 3 |
| 1.12.0 | List and board tiles and `scope` |
| 1.13.0 | Several command roots |
| 1.14.0 | Several list and board roots |
| 1.15.0 | Named tabs |
| 1.16.0 | Date calendar |
| 1.18.0 | `visibleWhen` |
| 1.19.0 | Choice tone and record-page header |
| 1.20.0 | `breakdownChart`, `progressTile` |
| 1.21.0 | Timeline |
| 1.22.0 | Gallery and rating scale |
| 1.23.0 | Overview, `recentList`, `rangeTile` |
| 1.24.0 | File purpose |
| 1.25.0 | `trendChart`, `activityGrid` |
| 1.26.0 | `matrixSurface`, `rankedList` |
| 1.27.0 | Board grouped by a reference |
| 1.28.0 | `section.opens` |
| 1.36.0 | `outlineSurface` |
| 1.38.0 | File look |
| 1.48.0 | `ui.removeProperty` |
| 1.52.0 | Gallery cover (the media rung) |
| 1.53.0 | `thisWeek`, `thisMonth` |
| 1.54.0 | Calculated totals, reference breakdown |
| 1.55.0 | File icon |

Other rungs belong to other ADRs; `NendoFormat.cs` holds the full ladder.

## Consequences

- Durable definitions survive UI-library changes, and one operation stream drives
  authoring, diff, history and promotion.
- Invalid or future definitions fail without making data inaccessible.
- The bounded vocabulary cannot express arbitrary applications; a new capability needs
  contract work, a rung and adapter support. Renderer-specific features cannot be
  serialised into the file.
- Accessibility and visual behaviour remain obligations of the adapter; a valid plan is
  not by itself a usable UI.

## Rejected alternatives

- Persisted renderer configuration (React, AG Grid or another toolkit): couples the file
  to a replaceable adapter.
- Arbitrary markup, scripts or a free-form definition document: reintroduces the general
  extension problem and destroys operation-level diff and promotion.
- Fixed plan slots with one field per new kind: makes every addition a structural change.
- An expression language for filters and derived values: that is ADR-0008's scope.
- `avg` without a declared scale and rounding: puts one rounded number on a page of exact
  ones.
- Client-side sample totals presented as exact; inferred tile scope; unbounded roots;
  recursive tab groups.
- A matrix as one tile per cell: twenty reads for a five-by-four grid.
- An authored property to enable related-list actions, folding or a Filter control: every
  existing screen would lack them until edited, and the schema already says enough.
- "Empty means delete" for a null property value: gives one operation two meanings.
- A picture field in the look table, or any icon format beyond PNG: breaks the look
  table's layout or needs a second renderer.
- Remembering a Filter pick on the device: a narrowed board reopened later reads as
  missing work.

## Revisit triggers

- A required surface cannot be expressed without renderer state; the custom-view model
  (ADR-0013) is then the answer, not the vocabulary.
- Filtering needs exceed the closed operator set.
- A grouping needs a cross-entity join, or a DateTime needs a declared time zone.
