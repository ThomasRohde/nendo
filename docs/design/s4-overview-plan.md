# Implement S4: the overview page

Status: **carried out 2026-09-15**, the day it was accepted. Every stage below landed; the
measured outcomes are in the S4 entry of ADR-0004, and the rules in the
[semantic surfaces contract](../contracts/semantic-surfaces.md). Three things moved while
building: the entity plans a front-page chart needs travel on the overview plan itself,
because a record type can be read by a tile while owning no surface of its own; a range end
is read through the lexeme rather than printed as one, because the lexeme of a civil date
carries its JSON quotes; and the front page takes its inset from its own surface class as
every other kind does, which the first build omitted. Where this plan and the shipped code
disagree, the contracts are current and this file is kept as the transfer it was.

The 2026-09-14 amendment to
[ADR-0004](../decisions/0004-versioned-semantic-ui-contract.md) admitted an
`overviewSurface` in principle; it did not settle what a root with no record type behind
it does to the rest of the contract, and it said nothing about a range. The owner accepted
both on 2026-09-15 and the ADR carries the S4 entry. The programme this slice belongs to is
the [surfaces and charts plan](surfaces-and-charts-plan.md), where S4 takes rung
**1.23.0**.

Planner: **W-002 — S4: overview page, recent records, and range tile**
(`nd.work.r.s4`), whose acceptance check is **C-033**.

## The S4 amendment, as accepted

Two sentences were the whole of what was new, and each was put to the owner on its own
terms. The first admits a root that is not about a record type, which every root has been
until now. The second widens an exact aggregate to a new scalar, which is Engine work
rather than vocabulary work and is the only part of S4 that reaches the storage boundary.
The owner accepted both on 2026-09-15; the entry ADR-0004 now carries is the authority,
and it is not repeated here.

The owner added one thing while accepting, and it is in the accepted entry: **an overview
carries an optional `description`**, because a file that opens on a front page should say
what it is for. Every running instance of Nendo looks the same today, and the sentence a
person reads on the front page is the sentence an agent should be told first. The wider
idea behind it — an introduction to the whole application, led with by the MCP describe
resource — is deliberately **not** in S4; it is its own work item, because an
application-level purpose is stored data that the overview node cannot supply on behalf of
a file that has no overview.

## 1. Start here

Deliver idea D1 and idea C4 together: a front page for the file, and the tile that makes
it say something a list cannot.

- **D1, the overview.** `overviewSurface` draws sections of tiles, charts and short recent
  lists. Because there is no entity in context, every tile, chart and recent list names its
  own `entityId` — required there, and refused everywhere else, the way `scope: group` is
  accepted only on a direct board child rather than resolved by searching upward for an
  ancestor that might exist.
- **C4, the range.** `rangeTile` states the smallest and the largest value of one field
  over the records its clauses cover: 12 to 480 pages, 3 Jan to 14 Sep.

Read the [semantic surfaces contract](../contracts/semantic-surfaces.md) first — *How many
roots of a kind an entity may own* (§26), *Selecting a surface, not a kind* (§58), *Totals
on a list or board* (§84), *Charts* (§423) and *Bounded query composition* (§475). The
gallery section (§276) is the worked template for how a kind's rules are written down; the
S3 timeline is the worked precedent for the whole checklist, because it was the last slice
to add a root.

Three facts about the code decide the shape, and each was read rather than assumed:

- **Every root carries an entity today.** `NendoSemanticCompiler.ComposableSurfaces.cs:25`
  reads `entityId` off each root and refuses a root without one as `NUI150`; line 31 groups
  the roots by that entity, and line 77 builds one `NendoApplicationPlan` per group.
- **The compiled plan is entity-shaped.** `NendoApplicationPlan` (`SemanticModel.cs:44`)
  carries a non-nullable `NendoEntityPlan Entity` and that entity's records, and the
  renderer resolves everything through `plan.entity.semanticId` — `activePlan()`,
  `selectedSurfaces`, `drills`, `drillTarget(plan)` (`plan-selection.ts:36,58,269`).
- **`min` and `max` are numeric end to end.** The compiler refuses a non-number with
  `NUI294` (`ComposableSurfaces.cs:522`), the store repeats the refusal
  (`SqliteNendoStore.ReadQueries.cs:199`), the coordinator gates on
  `NumericAggregates` and its safe-mode branch folds only `JsonValueKind.Number`
  (`NendoWriteCoordinator.ReadQueries.cs:59-88`), and `ExactAggregate` is `decimal` from
  `Add` to `Value`. A Date range is a new lane in four places, not a reuse of one.

### Non-goals

No second overview. No cross-entity join, no number composed from two record types, no
expression over a result. No stored layout: a section is an ordered container, as it is
everywhere else. No overview in Studio's browsing, which keeps its own state. No date
bucket (that is S5), no matrix or ranking (S6). No drag, no resize, no per-person
arrangement. The Reading Log stays W-006's work, after S4–S6 exist.

## 2. What S4 delivers

| Piece | What a person sees |
| --- | --- |
| Overview | Opening a file with one shows the front page first: a title, a sentence or two saying what this file is for, then sections of tiles, charts and recent lists, each labelled with the record type it counts. The record-type picker is still there, one step away, and a file with no overview opens exactly as it does today |
| Recent list | Up to ten records of one type in a declared order, each row opening its record page, with the same empty and failed states a list has |
| Range tile | "12 to 480" under a title, or "3 Jan 2026 to 14 Sep 2026" for a Date; one end absent when the set is empty, stated rather than drawn as zero |
| Honest tiles | Four reads in flight at a time; each tile carries its own loading, empty and failed state with Retry, so a slow chart never blanks the page. A number is exact or *Unavailable* with its reason |
| Drill-through | A segment on an overview chart opens that record type's first list, narrowed, with the dismissible pill — the same transient renderer state S1 built |
| Authoring | Three vocabulary rows with property notes, a diff sentence for every property, a read-only preview over the validated clone's sample, an example, and a gate that builds the page over MCP alone |

## 3. Stages, in order

### S4-A: the kinds (Engine vocabulary, compiler, diff, capability)

Three rows in `SemanticVocabulary.cs`, and one new idea in the table: a **file-scoped
root**. `NendoNodeKindRule` (line 19) expresses a ceiling only as `MaxRootsPerEntity`, and
`RootCardinalityHint` (line 361) generates the `NUI153` hint from it; both gain their
file-level sibling, generated from the same table so the stated ceiling cannot drift from
the one that refuses.

- `overviewSurface`: `definitionVersion`, `title`, an optional `description`, and **no
  `entityId`**; children `section`, `tabGroup`, `summaryTile`, `breakdownChart`,
  `progressTile`, `rangeTile`, `recentList`; at most one per file. The `description` is
  prose the author writes and the renderer draws under the title — not markup, not a
  template, and never a field reference.
- `recentList`: `entityId`, `title`, `limit`, `orderByFieldId`, `orderDirection`; children
  `fieldBinding` and `filterClause`. `limit` is the vocabulary's first per-node bound, and
  its ceiling of ten is published as a constant beside `MaximumEffectiveFilters` and
  `MaximumAggregateGroups`, so the number that is documented is the number that refuses.
- `rangeTile`: `entityId`, `fieldId`, `title`, `scope`; children `filterClause`.

`NUI150` becomes conditional on the kind being entity-scoped, and an `overviewSurface` that
declares an `entityId` is refused by name rather than ignored. `SurfaceContext` carries "no
entity in context" down the recursion, and a tile or chart under an overview reads its own
`entityId` where it reads the surface's today; the same property on a tile under a list or
a record page is refused, because there it would silently disagree with the surface it sits
on. The compiler's implicit-clause table (`SurfaceContextFor`, line 383) and the published
`EffectiveFilterContexts` (`SemanticVocabulary.cs:287`) gain one row: *an overview tile,
chart or recent list composes its own clauses over the record type it names*, so it carries
the full eight and adds no predicate of its own.

The Date range: `ValidateAggregateReading` (line 471) admits a Date for `min` and `max`
only, refusing `sum` on one by name; the store and the coordinator gain the same lane; and
`ExactAggregate` grows a comparison fold beside its decimal fold, because a civil date is
stored as ISO text and ordered by `RecordQuerySemantics.Compare` rather than by arithmetic.
**The safe-mode branch folds only numbers today, and must answer a Date too** — an
aggregate that is exact in SQLite and *Unavailable* in safe mode would be two answers to
one question.

`NendoCompileResult` gains the overview beside `Applications`, as its own plan with no
entity, rather than an `ApplicationPlan` with an invented one. The diff gains its nouns and
sentences (`SemanticDiff.cs:224,256,299`), including a tile-flavoured reading of `entityId`,
which today says *Bind the surface to …* (line 372), and a sentence for `limit`.
`NendoFormat` gains `OverviewMinimumHostVersion = "1.23.0"` with `CurrentHostVersion` moved
to it, and `SemanticCapability.Features` (line 96) gains the row; `MostRootsOfKindPerEntity`
(line 72) groups by `entityId ?? ""` and must not count a file-scoped root in the empty
bucket.

Diagnostics take the next free block, **NUI390 onward**. Tests are `OverviewSurfaceTests`
in the shape of `TimelineSurfaceTests`: compile, every refusal by code and property path,
the one-per-file ceiling, a tile's entity required here and refused there, the filter
budget, the rung raised irreversibly, the vocabulary row and its notes. `ExactAggregateTests`
gains the Date lane, and rows go into `SemanticCapabilityTests`, `SemanticDiffSummaryTests`,
`BehaviourSurfaceTests`, `MalleabilityTests` and `IdentityCopyTests`.

### S4-B: the front page (Workbench model, Use, preview, styles, help)

A pure `overview-model.ts` beside `timeline-model.ts`, with its own `node --test` suite
added by name to `package.json`'s explicit list: each tile's query composition from its own
entity and clauses, the recent window key and its limit, and the range read as two
aggregates with one end possibly absent.

The Use route is the one real change. `surface-model.ts:12` lists the five kinds the
surface picker offers, all of them per record type; the overview is not one of them. It
becomes the first entry of the Use toolbar's record-type control — one place where a person
chooses what they are looking at — and `main.ts`'s `validUse`, which today requires a
non-null `activePlan()`, must admit a file whose only compiled root is an overview.
Selection stays file-session-local renderer state, cleared on a file switch.

Everything below the route is reuse. `panels.ts` already bounds tile reads to four with its
generation guard and its per-key loading, ready and failed states; it takes the surface's
entity as an argument today and takes the node's own instead. `chart-kit.ts` gains a `strip`
beside `proportionBar` and `ring`; `charts.ts` registers `rangeTile` in `chartKinds` and
`isChartKind`; `record-markup.ts:163` gains its third branch. Drill-through needs no new
state — `drills` is already keyed by record type — only a way to resolve the target plan
from the tile's entity rather than from the surface's. `surface-preview.ts` gains an
overview arm in `treeMarkup` and a fixture in `preview-fixtures.ts`, drawing the same page
over the clone's bounded sample with the note that already says so. Four label switches
gain a case (`surface-model.ts`, `view-surfaces.ts`, `surface-preview.ts`, `format.ts`),
`styles/09-surfaces.css` and `styles/14-refinements-controls.css` gain the overview grid and
the strip, and `help-concepts.ts` gains an Overview section beside Galleries and Timelines.

### S4-C: agents, gates and the second application

- **Authoring example.** An overview over a neutral pair of record types, registered
  eleventh in `NendoAuthoringExamples.Description()`; the examples test replays it against
  the real boundary, and the row in `mcp-interface.md` that names all ten names eleven.
- **Agent-authoring gate.** The Axiom Register gains an overview, authored **as its own
  proposal** — a change set holds at most 128 operations and the register's screens already
  fill one, which is why the timeline and the gallery each took their own, and which also
  puts the minimum-host raise on a review of its own. The kind joins the list
  `authorAsAgent` asserts the vocabulary publishes; `assertSurfacesDescribeTheRegister`
  gains its row; and `assertTheWidenedSurfacesRun` gains a block that opens the overview,
  reads the tiles' numbers back against a count it makes itself, drives a drill from an
  overview chart into the narrowed list, and screenshots Light and Dark.
- **Decision Log.** The neutrality fixture gains an overview through both loaders
  (`SemanticApplicationFixture.cs`, `SemanticProtocolFixture.cs`), the expected shape and
  the runtime lane's role table, so the kind is proved on a second application without a
  branch named for it.
- **Blackbox prompt.** Phase 3 asks for an overview with a recent list and a range, and for
  reading its numbers back against a count; *Focus for this round* moves onto S4 and is
  re-dated. `docs/reviews/README.md`'s coverage rows are what the repository gate checks.

### S4-D: contracts, architecture and the record

`semantic-surfaces.md` gains *The overview page* — its one-per-file cardinality, the rule
that each child names its own record type, the range tile's two aggregates and its Date
lane, the budget row and the ladder row for 1.23. *Selecting a surface, not a kind* gains
the sentence that the overview is chosen beside the record types rather than among a type's
surfaces. `architecture.md`'s kind roll-call and its aggregate paragraph, which says an
aggregate reads an Integer or Decimal field, are corrected in the same change;
`mcp-interface.md`, `roadmap.md`, the glossary and the programme plan follow; and ADR-0004
gains the S4 entry with its measured outcomes.

Planner: the exact outcomes go on **C-033** by method — Automated for the suites and the
gate, Agent-observed for what was read off the running window — new observations become
Findings, and W-002 goes to Review before Done. A passed check does not complete the work.

## 4. Decisions taken by default

Stated so they are choices rather than accidents; each is a bounded initial value.

- **One overview per file.** Several would need a file-level selector that nothing else
  needs yet, and the programme plan already took this default.
- **The overview is chosen beside the record types, not among a type's surfaces.** The
  alternative — a sixth entry in the per-type surface picker — would need an entity it does
  not have.
- **Use opens it first when one exists.** A file without one opens as it does today, which
  is what keeps the empty-but-valid file honest: this changes what a file with an overview
  shows, not what an empty file is.
- **Every tile names its own record type; nothing is inherited and nothing is defaulted.**
  An omitted `entityId` under an overview is refused rather than guessed at, and the same
  property under a list is refused rather than allowed to disagree with the surface.
- **`limit` is declared and refused above ten, not clamped.** A silently clamped limit
  would make the definition and the screen say different things.
- **A range is two aggregates, not a chart.** It has no grouping, so it is not drawn as
  proportion and has no drill-through; both ends are labelled and either may be absent.
- **A Date range orders by comparison.** Min and max of a civil date need no arithmetic,
  which is why the widening stops there: `sum` over a Date stays refused by name.
- **An empty set has no range.** The tile says so rather than drawing zero to zero.
- **The description is the overview's, not the file's.** One optional prose property on the
  root, drawn under its title. A file-level purpose that MCP leads with, and that a file
  without an overview would also have, is a different thing with its own stored data and
  its own work item; putting it on this node now would make the node the only place a file
  can say what it is, which is exactly the shape that later has to be undone.

## 5. Checkpoints

Commit and push after S4-A (Engine green), S4-B (Workbench check, tests and build green),
S4-C and S4-D (the production gate, the installer lanes, the authoring gate and the
neutrality lane green, the documents and the ADR entry in place). Each checkpoint records
changed paths, the exact commands and their literal outcomes, and the next unfinished
acceptance item. Validation is the S2 and S3 sequence:

```text
pwsh ./tools/Test-Production.ps1
pwsh ./tools/Publish-NendoPayload.ps1
pwsh ./tools/Build-NendoInstaller.ps1
pwsh ./tools/Test-NendoSetupIsolated.ps1
pwsh ./tools/Test-AgentAuthoringGate.ps1 -Executable artifacts/build/publish/payload/Nendo.Desktop.exe
pwsh ./tools/Review-NeutralityRuntime.ps1
```
