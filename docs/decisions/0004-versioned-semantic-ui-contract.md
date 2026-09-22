# ADR-0004: Use a strict versioned semantic UI contract

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0001 result, EX-0002 result, EX-0003 result and EX-0005 result
- **Depends on:** ADR-0002 containing desktop architecture and ADR-0003 relational/metadata boundary
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

### Accepted amendment — 2026-09-20 (a section can be folded away)

The owner accepted this amendment on 2026-09-20, the day it was proposed for W-040.

**What it authorises.** A section on a front page or a record page can be folded away and
opened again by the person reading it, and an author can say how it starts. The owner
asked for this on the planner's own front page: *Recently delivered* and *Latest
observations* should fold, so a long page shortens to the parts somebody is reading. A
section takes `title` and `visibleWhen` today and nothing else; no kind has a fold.

**Two things, one stored and one not — and that is the decision.** How a section *starts*
is application meaning: an author saying "this part of the page is closed until wanted" is
saying something about the application, as `visibleWhen` says something about a record.
It is stored, as one property on `section`: `opens`, taking the closed words `open` and
`closed`, `open` when absent. What a person has done since — folded this one, opened that
one — is their own view of the page. It is renderer state in exactly the sense a selected
tab is (F-027): file-scoped, cleared when the file is, never durable and never in the
file. Persisting it was considered and rejected twice over: this ADR's decision keeps
renderer state out of definitions, and a fold that followed a person across a reopen
would be the one piece of renderer state that did. Storing only the default was also
considered and rejected, because then a person could not fold anything an author had
not thought to make foldable; and storing nothing was rejected because then an author
could not say "starts closed", which is most of what was asked for.

**Every section folds, and nothing has to be authored for that.** The reasoning of the
2026-09-18 entry applies unchanged: there is nothing left for an author to say about
whether a titled part of a page may be closed, the fold grants no authority, and a
property would leave every existing screen — this planner's included — without the
fold until somebody edited it. Two exceptions, both diagnostics rather than rules of
thumb: a section that is a tab's body neither folds nor accepts `opens`, because a
folded tab body is a strange object and the tab strip already answers the question the
fold would; and `opens` is refused on any kind but `section`. `visibleWhen` and `opens`
compose rather than compete: the first decides whether the section is on the page, the
second how it starts when it is.

**A closed section reads nothing.** Its tiles, charts, ranges, recent and ranked lists
and related lists are not read while it is closed, or folding would save the person
nothing and cost the file the same reads. The chases that fill a page treat a closed
section's descendants as not pending; opening it makes them pending, and they read
then, showing the state a tile shows before its first read. A value once read stays
until the file changes, so closing and reopening a section reads nothing new. On a
record page a closed section's fields stay in the form hidden rather than removed,
exactly as `visibleWhen` keeps them, so a save carries what it would have carried and a
required field left empty reveals its section the way it already reveals its tab.

**The fold is a disclosure.** The section's heading is the control, marked as expanded
or collapsed for assistive technology, and it opens and closes from the keyboard as it
does from a pointer. It is drawn in Light and Dark and carries an automation target
derived from the node's ID, as every node does.

**Rung.** `opens` is a property, and a host that does not know it refuses the surface,
so a file carrying it needs a host that does: a `section` with `opens` is minimum host
1.28. A file without the property needs what it needed, because every section folding
is renderer behaviour and puts nothing in the file.

**Review.** A section added with `opens` reads *Add the section "Lately", starting
closed.*; the property changed on a section the file already has reads *Start the
section closed.* or *Start the section open.* The read-only preview draws a section as it
starts.

**Delivery obligations.** The F4 checklist applies in full, because this is a property:
the vocabulary row and its note, the compiler's two refusals, the capability rung with its
constant and the contract's ladder row, the diff sentences and their tests, the Workbench
front page and record page, the file-scoped fold state, the chase exclusions, the
preview, Help, a step in `Gate-AgentAuthoring.mjs`, a line in the blackbox prompt, and
the contract and architecture text in the same change. The gate proves it on the Axiom
Register: through the host, add a section starting closed that holds a count tile and a
relation on the Remit page, and one on the front page holding a tile. Then measure —
not look: the section is drawn closed; nothing for its tiles crossed the bridge while it
was closed, counted on the bridge as the outcome lane counts; a real pointer press on the
heading opens it, the reads land and the numbers appear; folding it again stops the
reads on the next chase interval; and reopening the file puts it back to its stored
default. Light and Dark. Two falsifications are owed and must each be seen to fail: a
closed section that still reads, caught by the bridge count, and a stored default
ignored, caught by the initial state.

**Not in this amendment.** Remembering a person's folds across a reopen (F-027 stands);
folding a tab, a related list or a whole surface; animation; a fold on the proposal
review itself.

### Accepted amendment — 2026-09-18 (a related list is a way in)

The owner accepted this amendment on 2026-09-18. It is the first entry under this ADR
that adds nothing to the vocabulary at all: no kind, no property, no diagnostic, no
diff sentence and no rung. It changes what a `relatedList` *does*, not what it is.

**What it authorises.** A related list offers two actions it has never offered. **Add**
opens a new record of the related type with the reference back to the record in view
already filled in. **Open** opens a related row as its own record page, with one step
back to where it was opened from. A related list has been display-only since contract
version 3 shipped it, and recording a linked record meant leaving the page that already
knew which record you meant, finding it again in a picker, and navigating back (F-031,
and C-044 where the workaround was accepted so W-001 could close).

**Neither is authored, and that is the decision.** The alternative was a property — a
related list that offers Add only where somebody asked for one. It was rejected for
three reasons, and the third decides it. The node already carries both halves of the
relation, and the compiler already proves them: `targetEntityId` names an active record
type and `viaFieldId` an active Reference field on it aimed at this record type, or the
surface does not compile (`NUI260`–`NUI266`). So there is nothing left for an author to
say. The action grants no authority: Use's own toolbar already adds a record of any type
it shows, and the related list adds the same record with one field filled in. And a
stored property would mean every screen built before today stays as it was until somebody
edits it — including the file this product is planned in, which would need a reviewed
proposal to get a button that needs nothing from the file.

**So nothing is stored, and there is no rung.** Every slice under the 2026-09-14
amendment added one, because each put a shape in the file that an older host would refuse.
This one puts nothing in the file. A rung's one job is to say what a file needs, and a
file that is byte-for-byte what it was needs what it needed. A host without this reads the
same definition and draws the same list without the buttons, which is the correct outcome
and not a failure to protect against.

**The form is the record type's own page.** Add renders the target type's `detailSurface`
as a create form — its sections, its tabs, its required fields, its reference controls —
in the place the record page being looked at was. A type with no page falls back to its
field list, exactly as a create form already does today. So the question *where does the
form come from* has no new answer: it is the answer Use already gives when you press Add
in the toolbar, and a field a type requires stays required here.

**The filled-in reference carries the parent's version, because a reference write is
refused without it** (`target-version-required`). The record the relation is shown for is
on screen, so its version is in hand and nothing has to be read to learn it. The value is
shown by its label, as the picker shows it, rather than as the stable ID nobody recognises.
It stays editable: repointing it is exactly what the picker already permits, and inventing
a rule to forbid it would make this one reference behave unlike every other one.

**A record page with unsaved edits declines both actions**, in the words the board's drag
already uses for the same reason. Both actions redraw the page, and a redraw discards what
is typed into a form. This is the existing habit rather than a new rule — the board refuses
to move a card while the inspector beside it is dirty — and the alternative, saving the
record on the person's behalf so that their next click can proceed, is a write nobody asked
for. Switching tabs still preserves a draft; that path does not redraw and is untouched.

**Back is one step and not a history.** A related record opened from a page offers a return
to that page, and opening a third record replaces the first answer rather than stacking
behind it. It is transient renderer state in the sense a drill-through or a selected surface
is: it never reaches the file and it is cleared when the file is. A stack would be state that
accumulates and a trail nobody asked to keep.

**Where the related type has no screen, the list offers neither action** and says so. Use
shows the record types that have a compiled surface, so a record created into a type without
one would have nowhere to go afterwards and no page to be opened on. Offering a button that
strands somebody is worse than not offering it, and this is the same boundary Use already
draws in its record-type picker rather than a new one.

**What this does not do.** It does not allocate the reference codes a file's own convention
may require: this product requires a Reference field to be non-empty and does not fill it in,
enforce uniqueness or stop it being changed, so a file whose records are named `C-044` still
has a person deciding which number is next. That is an application convention and a separate
piece of work, and this entry is recorded as not having removed it. There is no bulk add, no
delete from a related list, and no related list inside a create form — a record that does not
exist has nothing pointing at it, so the question does not arise.

**Delivery obligations.** The F4 checklist is a checklist for a new kind and most of it does
not apply: there is no vocabulary row, no diagnostic, no diff sentence, no rung and no
authoring example, because there is nothing to author. What is owed is the Use path, the
read-only preview saying what a reviewer is accepting, Workbench tests, a step in
`Gate-AgentAuthoring.mjs`, a phase in the blackbox prompt, the contract and architecture text
in the same change, and Light and Dark, keyboard and screen-reader checks recorded. The gate
proves it on the Axiom Register, whose Remit page already carries an Axioms relation with a
count tile: add an axiom from the Remit, see it in the list and the count move, open it, and
come back. The gate drives it with a real pointer, for the reason S7 records. F-031 is the
report this answers, so a guard is owed that is seen to fail against the restored defect.

**Delivered 2026-09-18.** Recorded outcomes, and only the outcomes that were measured:
`Test-Production.ps1` passed, covering the repository gate, the production boundaries, the
Workbench check, build and twenty-eight unit suites (236 cases), and 1,122 .NET tests
(Engine 795 with one skipped, Desktop 225, LocalMcp 102); the payload and installer were
rebuilt and `Test-NendoSetupIsolated.ps1` passed, with `Test-NendoInstaller.ps1` declining
by interlock because an owner installation is present; `Test-AgentAuthoringGate.ps1` passed
both phases, and its new step added an axiom from the Data remit's relation over a register
an agent had built without ever hearing of these actions — reading off the running app the
reference filled in by the remit's name and carrying its version although no picker was
opened, the relation going to four rows and its count tile to 4 without leaving the page,
the new axiom opening on its own headed page although the surface behind it is filtered to
exclude it, and the way back naming the Data remit and being gone once taken. Captured in
Light and Dark. Keyboard and screen-reader checks were not instrumented in this change; they
remain owner-reported.

The falsification is the Workbench guard, seen failing against the related list with its
actions stripped back out: *The input did not match the regular expression
/data-related-add="rel\.checks"/. Input: actual:
`'<header class="related-head"><h3>Acceptance checks</h3></header>'`* and *The input did not
match the regular expression /data-related-open="c044"/. Input: actual:
`'<li><strong>C-044</strong><span>Accepted exception</span></li>'`* — which is precisely the
display-only relation this entry is about. The gate step was not separately run against that
restored defect; it was, however, seen failing twice against two real defects in this change,
which is how both were found. `refreshDerived` dropped a selection it could not find in the
surface's loaded window, which is every record opened from a relation, so the page navigated
and then showed nothing (*Timed out waiting for the new axiom's own page*); a focused record
is now re-read there like every other window. And the way back named the record **type**
rather than the record, because the Remit page declares no `titleFieldId`; it now falls back
to the first field the page binds, as a card and a recent list already do.

### Accepted amendment — 2026-09-14 (colour, charts and the overview page)

The owner accepted this amendment on 2026-09-14, the day the [vision](../vision.md)
admitted charts and dashboards into scope. It authorises the bounded additions
below within contract version 3. The ideas it sequences, and the order to build
them in, are in [the surfaces and charts plan](../design/surfaces-and-charts-plan.md);
each slice of that plan is recorded under this heading as it lands, with its rules
in [the semantic surfaces contract](../contracts/semantic-surfaces.md).

**What it authorises.**

- A choice option may carry a `tone` from a closed set of named hues, set
  through the existing choice-metadata operation. It is a semantic token in the
  sense a field presentation is, never a hex value, and the renderer owns the
  Light and Dark colours behind it.
- A chart is an exact aggregate over one closed grouping — a single-choice
  field's options, a Boolean, or a Date field's months, weeks or days between two
  bounds — drawn as proportion, with its numbers shown and a table of them one
  toggle away. A chart never draws a page of records as the whole set and never
  shows a proportion without both of its numbers.
- An `overviewSurface` is one file-level root of sections, tiles, charts and
  short recent lists, each naming its own entity.
- Drill-through from a chart into a filtered list is transient renderer state,
  like surface selection.

**What it does not.** None of this stores layout, an expression, a sample or
renderer configuration. There is still no grouping query language, no
cross-entity join and no expression over a result; `avg` stays refused by name,
a calculated field still cannot be grouped or totalled, and an unrepresentable
aggregate still reads *Unavailable*. The sentence in the 2026-09-12 amendment
that refused dashboards is superseded by this one and says so.

**Delivery obligations.** Each kind arrives with its compiler, diff, Use and
preview support, its own rung on the capability ladder, an authoring example, a
step in the agent-authoring gate and a phase in the blackbox prompt — the
checklist the plan states once. Every slice is recorded below as it lands.

- **S0, colour and the record-page header — delivered 2026-09-14.** `tone` on a
  choice option, stored in its own protected table at the end of the layout
  ladder; `titleFieldId`, `subtitleFieldId` and `accentFieldId` on
  `detailSurface`; minimum host 1.19.0 for a file that uses either. Recorded
  outcomes, and only the outcomes that were measured: `Test-Production.ps1`
  passed, covering the repository gate, the production boundaries, the Workbench
  check, build and twelve unit suites, and 856 .NET tests (Engine 603, Desktop
  157, LocalMcp 96); the payload and installer were rebuilt and
  `Test-NendoSetupIsolated.ps1` passed; `Test-AgentAuthoringGate.ps1` passed both
  phases, authoring three toned statuses and a headed page over MCP alone and
  reading the tones off the running board and the record page. The gate's
  surface-picker assertion was repaired in the same change: it read a button's
  whole text after the picker began appending each surface's kind, so it had
  failed since the 2026-09-12 polish without being run.
- **S1, the first charts — delivered 2026-09-14.** One exact grouped aggregate in
  the Engine over a closed grouping (a single-choice field's options, or a
  Boolean), answered in one read with the unset group last and a value outside
  the options counted apart; `breakdownChart` and `progressTile` accepted where a
  `summaryTile` is (not yet inside a `relatedList`, refused rather than drawn
  empty), validated with the tile's own rules shared, at minimum host 1.20.0; a
  pure SVG chart kit in the Workbench; and drill-through from a segment or a ring
  into the record type's first list as renderer state. Recorded outcomes, and only
  the outcomes that were measured: `Test-Production.ps1` passed, covering the
  repository gate, the production boundaries, the Workbench check, build and
  fourteen unit suites, and 874 .NET tests (Engine 621, Desktop 157, LocalMcp 96,
  the worked example included); the payload and installer were rebuilt and
  `Test-NendoSetupIsolated.ps1` passed; `Test-AgentAuthoringGate.ps1` passed both
  phases, authoring a breakdown by status on the board and a ring on the open
  list over MCP alone and reading off the running app the legend's exact counts,
  the segments' tones, the table of the same numbers, a drill that opened the
  first list narrowed to one group with exactly one record read and a pill, the
  list restored on dismissal, and the ring reading 1 of 2.
- **S3, the timeline — delivered 2026-09-14.** `timelineSurface`, a root that
  places records on a spine by a Date field, one civil year at a time under a
  heading for every month, with an optional `endDateFieldId` drawn as a span from
  its start (inclusive days, cut at 31 December and saying so; an end before its
  start stated on the entry as a data issue), `titleFieldId` and `accentFieldId`
  under the record page's rules, and the calendar's undated view. Placement is by
  the start date only, and the year header states the scale and that rule on the
  surface. Refusals `NUI370`–`NUI374`; a year reserves two implicit predicates as
  a month does; minimum host 1.21.0. S2 had not been built when S3 was asked for,
  so S3 took the next rung and S2 takes 1.22.0. The calendar's page accumulator
  and loader now serve both surfaces under one map, and three focus and today
  rings that read an undeclared `--accent` token now read `--cobalt`. Recorded
  outcomes, and only the outcomes that were measured: `Test-Production.ps1`
  passed on its third run, covering the repository gate, the production
  boundaries, the Workbench check, build and nineteen unit suites (156 cases),
  and 900 .NET tests (Engine 647, Desktop 157, LocalMcp 96); the first run failed
  on two `IdentityCopyTests` rows whose expectation hard-coded the Decision Log's
  old minimum host, now stated per application, and on one
  `InstanceOwnershipTests` row with a file lock that did not reproduce in three
  isolated runs or in the two gate runs after it; the payload and installer were
  rebuilt and `Test-NendoSetupIsolated.ps1` passed; `Test-AgentAuthoringGate.ps1`
  passed both phases, authoring the timeline as its own proposal over MCP alone —
  the register's surfaces proposal already held 128 operations, the ceiling —
  with the minimum-host raise as its own diff line, and reading off the running
  app one record read per selection, this year's twelve month headings, the
  accepted axiom as a span in the green tone cut at the year end and saying so,
  the state line and the scale note, the undated view with two records, an entry
  opening the headed record page, and the spine captured in Light and Dark;
  `Review-NeutralityRuntime.ps1` passed all six phases with the Decision Log
  carrying a timeline from decided date to review date. Keyboard and
  screen-reader checks were not instrumented in this change; they remain
  owner-reported.

- **S2, the gallery and the rating scale — delivered 2026-09-14.** `gallerySurface`, a
  root that draws one card per record over exactly a `recordList`'s bounded window, with
  the same pager and the same tile and chart children; its `titleFieldId` and
  `accentFieldId` are the record page's rules with card wording, refused as `NUI380` and
  `NUI381`, and both optional, because a card with no declared title leads with its first
  bound field as a timeline entry does. It adds no implicit predicate, so it joins the
  list and the board in the compiler's clause table and carries the full eight; left out
  of that table it would have been scoped as a page, and its own clauses would not have
  counted against a tile's budget while the renderer composed them. And `presentation:
  rating` on an Integer field with a closed `min` and `max` of at most ten values, stored
  in `__nendo_field_scale` as the layout ladder's new last rung for the reason the tone
  table gives, reached through the field operation's own evidence as a tone is. The scale
  bounds the drawing, not the column: a value outside it is written, read back exactly,
  and reported as `NDATA012` beside the warning a value outside a field's choices already
  makes, because a scale may be declared over values that already exist. Minimum host
  1.22.0 for either. S3 was built before S2, so S2 took the later rung; rungs follow
  delivery order because the ladder is monotone. Recorded outcomes, and only the outcomes
  that were measured: `Test-Production.ps1` passed, covering the repository gate, the
  production boundaries, the Workbench check, build and nineteen unit suites (167 cases),
  and 938 .NET tests (Engine 683, Desktop 157, LocalMcp 98); the payload and installer
  were rebuilt and `Test-NendoSetupIsolated.ps1` passed; `Test-AgentAuthoringGate.ps1`
  passed both phases, authoring a rated field and a gallery over MCP alone and reading off
  the running app three toned cards in one record read, a rating drawn as four filled dots
  of five and named "4 of 5", the surface total covering every matching record, the list's
  pager, a card opening the record page with the rating's stored value chosen in its
  radios, and the grid in Light and Dark; two of its assertions were corrected in the same
  change, because the rating moved the minimum-host raise from the timeline proposal to the
  structure proposal that now carries the scale, and because the record page had never
  bound the rated field; `Review-NeutralityRuntime.ps1` passed all six phases with the
  Decision Log carrying a gallery of decision cards. Keyboard and screen-reader checks were
  not instrumented in this change; they remain owner-reported. **The first build laid the
  gallery out wrongly and the gate passed anyway**, which the owner caught in the
  screenshot: the totals row sat indented past the cards it describes, because the
  gallery's margin override was written before the rule it overrides and lost on order at
  equal specificity; and cards took their content's height, so one whose value was drawn as
  dots stood shorter than its neighbours. Both are fixed, cards now stretch to their row
  and their version footers share a baseline, and the gate measures those three geometries
  rather than only capturing them — a guard falsified by reintroducing the defect, which
  failed it with "Cards in one row have different heights: 158, 158, 150". The owner then
  caught a third: opening a card reflowed the grid, because the inspector takes its space
  from the surface. The gallery now retains its width and the surface scrolls, which is
  the calendar's rule for its day tracks, and the gate measures a card and the grid across
  the click; without the rule it fails with "card 248 to 427, grid 767 to 427", so the
  reflow was a collapse from three columns to one rather than the slight slide it looked
  like. A fourth followed, in the rating's own control: the radio and a dot drawn beside it
  gave every value two circles of the same shape, and the base rule that sizes every input
  for typing drew the mark as a 21 by 39 oval. The radio is the dot now, sized by the
  rating's own rule, and the gate reads the count, the browser's own drawing and the
  measured box — falsified at "The rating radio is drawn by the browser as well as by the
  stylesheet" and "The rating dot is drawn 21 by 39, not as a dot". The owner reported in
  the same breath that the form's text could be selected; a drag from a field name sweeps a
  selection across the whole form, so names, legends and the pills now start none while the
  values stay copyable. That drag was reproduced and fixed in a browser, not in the gate:
  WebView2 does not drive a selection from CDP's synthetic mouse events, so the gate reads
  the rule off the five elements it has to reach and falsifies at "A drag over the form's
  chrome can still sweep it". Two of this session's falsification runs proved nothing until
  that was noticed — a CSS comment placed before a selector does not disable the rule.

- **What the file is for — accepted 2026-09-15, delivered the same day.** The owner
  approved this amendment in advance, on the observation that opened it: every running
  instance of Nendo looks the same, and nothing in a file says what it is for. S4 delivered
  the narrow half — an `overviewSurface` carries a `description` drawn under its title —
  and deliberately stopped there, because a node cannot speak for a file that has no
  overview. This is the other half. A file carries **one purpose of its own**: prose the
  author writes, at most 4,000 characters, refused above that rather than cut, and set or
  cleared by one canonical operation, `application.setPurpose`, on the definition lane. It
  is not a node and not a property of one. `nendo://application/describe` **leads** with it,
  before the manifest, because an agent meeting a file it has never seen should be told what
  the file is for before it is handed revisions and a schema to infer purpose from; the
  narrow `manifest` read carries it too, and a person reads it from **About this file** in
  the File menu, which is reachable whether or not the file has a front page. It was drawn
  in the menu itself for half a day: prose long enough to be worth writing pushed the
  actions underneath it off the bottom of a menu somebody had opened to reach them, so it
  moved to a page of its own. A file whose
  author has said nothing carries nothing: clearing deletes the row rather than storing a
  blank, so absence is absence in the storage as well as in the read, and nothing is ever
  derived from the file name. Stored in its own protected table as the layout ladder's new
  last rung — never a column on the manifest, whose protected layout is a fingerprint of
  verbatim DDL that an `ALTER TABLE` cannot reproduce byte for byte. Minimum host **1.24.0**,
  declared by the operation's own evidence rather than by the capability ladder, which walks
  UI nodes and would never see a value that has none; saying nothing takes no rung and
  raises nothing. The review names it as its own `purposeBefore`/`purposeAfter` pair rather
  than leaving it to be found among the record types and screens, which is where the front
  page was invisible until commit `7d86566`, and the panel no longer tells a person that a
  purpose-only proposal "changes structure and data only".
  Recorded outcomes, and only the outcomes that were measured: `Test-Production.ps1`
  passed, covering the repository gate, the production boundaries, the Workbench check,
  build and unit suites, and 1,046 .NET tests (Engine 729, Desktop 219, LocalMcp 98).
  `Test-AgentAuthoringGate.ps1` passed both phases, authoring the purpose over MCP on a file
  that had no front page yet, accepting it in the running app, and reading it back from the
  top of `describe` and out of the rendered file menu. Three guards were falsified and seen
  to fail: creating the table on a clear made the file unreadable
  (`Expected:<production-semantic-v1>. Actual:<>`), moving the member off first position
  broke the payload order (`Expected string length 7 but was 8`), and dropping the pair from
  the proposal summary failed the gate with `The proposal summary does not carry the purpose
  it sets: null`. A fourth restored the pre-existing bug beside it: a cleared front-page
  description used to read "Say what this file is for: a description", the diff's own
  fallback printed as though the author had typed it, and that line is fixed here with its
  own test. The installer lanes and the neutrality lane are recorded separately below.

- **S4, the overview page — accepted and delivered 2026-09-15.** The owner accepted
  both halves of this slice on 2026-09-15, after the plan in
  [the S4 transfer](../design/s4-overview-plan.md) stated what each would cost. An
  `overviewSurface` is a root that belongs to the file rather than to a record type: one per
  file, with no `entityId` of its own, holding sections, tab groups, tiles, charts and short
  recent lists, each of which names the record type it reads. It carries an optional
  `description`, because a file that opens on a front page should say what it is for — every
  running instance otherwise looks the same, and the sentence a person reads on the front
  page is the sentence an agent should be told first. Use opens the overview first when one
  exists, and a file without one is unchanged: the empty-but-valid file and the permanent
  host-owned Studio route are untouched either way. It composes nothing across record types.
  An overview is several bounded reads side by side, each spending its own filter budget over
  the one record type it names, and there is still no join, no expression over a result and no
  stored layout. A `recentList` is a list's ordered window bounded to at most ten records,
  declared on the node and refused above that rather than clamped. A `rangeTile` is **not** a
  chart in the sense this amendment defines one: it has no grouping at all, but is the two
  exact aggregates `min` and `max` of one field drawn as a strip with both ends labelled, and
  it widens those two aggregates from Integer and Decimal to a Date, which orders by
  comparison rather than by arithmetic — `sum` over a Date stays refused by name, and the
  safe-mode fold answers a Date too, because an aggregate that is exact in SQLite and
  *Unavailable* in safe mode would be two answers to one question. Every number stays exact or
  absent, and `avg`, calculated-field grouping and the unrepresentable aggregate keep their
  refusals. Minimum host 1.23.0. The kinds arrive with their compiler, diff, Use and preview
  support, their rung on the capability ladder, an authoring example, a step in the
  agent-authoring gate and a phase in the blackbox prompt.
  Recorded outcomes, and only the outcomes that were measured: `Test-Production.ps1` passed,
  covering the repository gate, the production boundaries, the Workbench check, build and
  twenty-one unit suites (181 cases), and 1,038 .NET tests (Engine 721, Desktop 219, LocalMcp
  98); the payload and installer were rebuilt and `Test-NendoSetupIsolated.ps1` passed;
  `Test-AgentAuthoringGate.ps1` passed both phases, authoring the front page over MCP alone as
  its own proposal — the register's screens already fill a change set to its 128-operation
  ceiling — and reading off the running app its description, a count of three against the
  records seeded, a ring of one of three, both ends of a Date range, the second record type's
  remits, a drill from a front-page chart into the narrowed list it belongs to, and Light and
  Dark; `Review-NeutralityRuntime.ps1` passed all six phases with the Decision Log carrying a
  front page. Keyboard and screen-reader checks were not instrumented in this change; they
  remain owner-reported.
  Two defects the gate found, neither visible to a type checker. A record window carries the
  host's snapshot — `recordId`, `recordVersion`, calculations in dependency order — and every
  renderer speaks the plan's vocabulary; the recent list cast one to the other, which was
  wrong in three fields at once and silenced the type that said so. There were already two
  copies of the real projection; there is one now. And a civil date is answered as an exact
  lexeme, which for a date is that date as a JSON string, so **the range drew the quotes**:
  it reads the date now and keeps a number exactly as answered, so no trailing zero is lost
  on the way to the screen. The gate had been reporting "Uncaught" for every renderer
  exception, which names nothing; it reports the message and the stack now, which is what
  found both.
  **The owner caught a third in the screenshot the gate had already passed**: every Use
  surface takes its inset from its own kind's class, and the front page set none, so its
  title, its description and every tile sat sixteen pixels outside the line the rest of the
  app is drawn to. The gate measures that edge now rather than only capturing it, falsified
  by putting the defect back, which fails it with `{"toolbar":241,"heading":225,
  "description":225,"tile":225}`.
  One behaviour changed rather than broke, and the neutrality lane found it: a file that
  opens on its front page no longer lands on a screen that can add a record, because the
  front page belongs to the file and has no record type to add to. The record type is one
  step away in the same picker, which is where that lane now goes before it adds one.

- **S5, over time — accepted 2026-09-16.**
  Two kinds that group by a civil date rather than by a closed set of options: `trendChart`,
  which states one exact number per month or per week over a bounded stretch of time, and
  `activityGrid`, which states one exact count per day over a year. They are the first
  groupings whose groups are not knowable from the definition alone — a choice field's
  options are written down, and a month is not — and everything particular about this slice
  follows from that one difference.

  **A stored definition never carries a date.** `range` is a closed word the host resolves
  to civil-date bounds at read time, exactly as `today` already is, so a definition written
  in January still means the same thing in December and no stored screen goes stale. The
  closed set is `last12Months`, `last6Months`, `last90Days` and `last30Days` on a
  `trendChart`, and `thisYear` and `lastTwelveMonths` on an `activityGrid`. A word outside
  its kind's set is refused by name. There is no authored literal alternative: allowing one
  would put a date in a definition, which is the thing this rule exists to prevent.

  **An empty bucket is a bucket.** A month with nothing in it draws as a gap at zero, not as
  a missing column, and a day with nothing in it draws as the lightest tone rather than as a
  hole. The host generates the buckets from the resolved bounds and fills them from the
  grouped read, so what a person sees is the shape of the range and not the shape of the
  data that happens to exist. This is the one thing a chart over time gets wrong most often
  and it is a rule rather than a rendering detail: a year with three active days is a year
  of squares, three of them toned.

  **The ceiling was published before it was needed.** `MaximumAggregateGroups` is 366 and has
  been since S1, stated then so that "the day buckets of a later slice have a stated bound
  rather than a new rule". This is that slice, and it spends the bound as written: an
  `activityGrid` over a leap year is 366 groups and fits exactly, and nothing here raises it.
  A `trendChart` at its widest is 53 weekly buckets and sits far inside.

  **DateTime is refused by name**, as it is on the calendar and the timeline. `dateFieldId`
  takes a stored Date field; a DateTime field is refused with a diagnostic naming the field
  rather than silently truncated to its date, because a truncation is a time zone decision
  and this product has not made one (F-006). A calculated field cannot be grouped here
  either, which is the standing rule and not a new one.

  **What stays as it is.** These are tiles in the sense the S1 charts are, and they are
  accepted in exactly the places those are: `recordList`, `boardSurface`, `gallerySurface`,
  `detailSurface`, `section` and `overviewSurface`. **Not `relatedList`** — S1 left charts
  out of a related list deliberately, because one is not drawn there, and a kind accepted
  where nothing draws it is a kind that compiles and then silently disappears. The surfaces
  and charts plan lists `relatedList` among the parents; the plan is proposal and the code is
  current, and this entry follows the code. They take `filterClause` children, name their own
  `entityId` under an overview and refuse one anywhere else. `trendChart` takes `aggregate` and `fieldId` and
  answers the same exact aggregates over each bucket; `activityGrid` counts and takes
  neither, because a grid of toned squares reading a sum is a heat map of something a person
  cannot recover from the square. Drill-through is F5 unchanged — a bucket opens the
  entity's first list with that bucket's date predicate applied as a transient filter,
  file-session-local and never written to the file. `avg` stays refused by name, there is
  still no join and no expression over a result, and an unrepresentable aggregate still reads
  *Unavailable*. At most six authored clauses on a `trendChart`, because the host adds two
  date bounds of its own to the effective-filter budget of eight (F-013); the refusal names
  the two the host will add, since an author who spends all eight cannot otherwise know why
  six is the number.

  **Minimum host 1.25.0, not the 1.24.0 the plan proposed.** 1.24.0 went to the file purpose
  on 2026-09-15 while this slice was still unwritten. The ladder is monotone and rungs follow
  delivery order rather than proposal order — the same correction S2 and S3 already carry —
  and [the surfaces and charts plan](../design/surfaces-and-charts-plan.md) is updated to say
  so in the same change as this entry.

  **Delivery obligations.** The twelve of the F4 checklist in full. The owner accepted these
  rules on 2026-09-16, including the rung correction and `activityGrid` counting only, both
  put to them explicitly.
  Recorded outcomes, and only the outcomes that were measured: `Test-Production.ps1` passed,
  covering the repository gate, the production boundaries, the Workbench check, build and the
  unit suites, and 1,070 .NET tests (Engine 747 with one measurement harness skipped, Desktop
  225, LocalMcp 98); eight new Workbench cases cover the composition and the drawing.
  `Test-AgentAuthoringGate.ps1` passed both phases, authoring a trend of accepted axioms by
  month and an activity grid of a year of days over MCP alone, on the register's front page,
  and reading off the running app twelve columns for twelve months with eleven of them drawn
  empty, 365 squares for 365 days with one toned, a grid of seven rows, a drill from a column
  into the month it names, and both themes.
  **The guard was falsified twice, in two lanes.** Making the fold answer only the buckets
  the data touched — which is what a plain grouped read over a date does — failed the Engine
  tests with `Expected collection of size 6. Actual: 2` and `size 365. Actual: 1`, and then
  failed the gate in the running app with `The trend drew 1 months, not the twelve its range
  covers (built): ["Sep 2026: 1"]`. That second one is the useful one: a chart of one month
  holding one record looks entirely reasonable, which is exactly why the rule needed a
  measurement and not a screenshot.
  One thing the eye got wrong and the measurement settled: the activity grid looked too wide
  to be seven rows in the first capture, and it is seven — the card was cut off at the
  viewport, not misdrawn. The gate now measures the row count so the next person does not
  have to squint at it either.
  Keyboard and screen-reader behaviour is not instrumented here. Every column and square is a
  real button with a focus-visible outline and an `aria-label` naming its period and its
  number, and the gate asserts those labels; whether a screen reader reads the chart usefully
  remains owner-reported, as it does for S4.

- **S6, grids — accepted 2026-09-17.**
  Two kinds that state something the surfaces built so far cannot. `matrixSurface` crosses two
  stored choice dimensions — horizon against status, effort against value, the grid people
  draw on a whiteboard — and states one exact number in every cell. `rankedList` shows the few
  records at the top of one stored number, each with a bar against the exact largest, so a
  leaderboard reads as a shape rather than as a column of digits.

  **A matrix is one read, not one read per cell.** [The plan](../design/surfaces-and-charts-plan.md)
  proposed a cell tile spending the surface's clauses plus two predicates of its own, which is
  a `summaryTile` per cell: a five-by-four grid is twenty reads arriving four at a time, and
  the grid fills in like a slow page. It is one grouped read instead. The host produces every
  cell key before it reads a row — the cross product of the two fields' option sets, each with
  its unset key — and folds the record type once into those buckets, exactly as S5 produces
  every date bucket before it reads. A matrix therefore costs one read whether it has four
  cells or two hundred; every number in it is exact over the whole record type rather than
  over the page in view; and **a cell with nothing in it is still a cell**, for the same reason
  an empty month is still a month.

  **A cell holds cards and states a number, and they are not the same quantity.** The cards are
  the surface's one bounded window, placed client-side as a board places them, ordered by the
  surface's own `orderByFieldId`. The number is exact over everything the surface's clauses
  cover. Because the cell has both, it can say what a board's column has never been able to
  say without a tile of its own: *showing 4 of 17*. Where the two disagree it is the window
  that is partial, and the cell says so rather than leaving a person to assume the four are
  all there are.

  **Rows and columns are the options, less what the surface excludes.** The board's rule,
  applied twice: an `eq` on an axis field leaves one value and each `ne` removes one, and no
  other operator is read, because a comparison or a null test over a choice says nothing
  definite about which options remain. A board that declares *status is not Done* and then
  draws an empty Done column tells a person nothing is done; a matrix would tell them that in
  two dimensions. Every reachable option is drawn even when it is empty, because an option is
  something a person arranged and its emptiness is the answer. The **unset** row and column are
  different: nobody arranged them, so each is drawn only when its own exact number is not
  zero. That is a better rule than the board's, which decides from the loaded window, and it is
  affordable only because the cell numbers are exact.

  **Every record is in exactly one cell.** A record with no value on one axis is in that axis's
  unset lane; a record with neither is in the corner where the two unset lanes meet. A stored
  value that is none of the field's options stays a data issue stated as the board states it,
  counted apart and never folded into a cell nobody configured.

  **The size of a grid is bounded by a ceiling that already exists.** `MaximumAggregateGroups`
  is 366, and the cross product of the two axes, unset lanes included, must fit inside it: at
  nineteen options each, a matrix is at the wall. A definition whose cross product is already
  over it is refused when it is authored, by a diagnostic naming both fields and their counts.
  A definition that grows over it later is refused **when it is read**, and the surface states
  that it cannot draw the grid and names the same two counts — because the option sets change
  without the screen being touched, and a person who adds a twentieth option to a field has not
  edited the matrix. Drawing part of a grid would be the one wrong answer: a matrix missing its
  last four columns looks exactly like a matrix.

  **The two axes must be different fields**, refused by name. A field against itself is a
  diagonal with empty corners, which states nothing a breakdown chart does not state better —
  the same reason a `breakdownChart` at group scope may not break down a board's own grouping
  (`NUI352`). An axis is an active single-choice field or a Boolean, which is the grouping rule
  the charts already use rather than a new one; a calculated field cannot be an axis, as it
  cannot group or be totalled. This widens the plan's *both single-choice* at no cost, because
  the fold already answers a Boolean grouping.

  **A cell drills with two predicates**, opening the record type's first list narrowed to that
  cell — the second two-clause drill in the product after S5's bucket, and still F5 unchanged:
  transient, file-session-local, never written to the file, and it does not compose with the
  list's own filters. An unset lane drills with `isNull`, which is the operator the closed set
  already has.

  **Moving a card between cells is not in this slice.** A board's drag sets one field; the same
  gesture on a matrix sets two, which is a different promise about what one movement writes.
  Cells are read-only here and the record page is how both fields change.

  **A ranked list is a tile, not a root surface**, and this is the one place the entry departs
  from the plan's shape. Three reasons. A whole screen of it would be a `recordList` with
  `orderByFieldId`, which exists: what a ranking adds is rank numerals and a bar, which is the
  presentation of a bounded window — what a `recentList` already is. A kind that is both a root
  and a child must carry a root's properties in both positions, because the required-property
  set is per kind and not per position, so a front-page leaderboard would carry a
  `definitionVersion` that means nothing there. And the owner put S5's two charts on this
  planner's front page within a day of accepting them; a leaderboard that cannot go there
  arrives a slice late. So it is accepted where a `recentList` is accepted — under an
  `overviewSurface` and under a `section` within one, naming its own `entityId` and refused
  outside an overview.

  **What it ranks.** An active stored Integer or Decimal field. A Date is refused by name, and
  this is the one place a Date is refused where `rangeTile` accepts one: `min` and `max` over a
  Date are comparisons, and a bar is arithmetic — a bar proportional to a date is a bar
  proportional to nothing. A calculated field cannot be ranked, which is the standing rule.

  **A record with no number is not in the ranking.** The host adds an `isNotNull` predicate on
  the rank field, so a `rankedList` carries at most seven authored `filterClause` children
  where a tile elsewhere carries eight, and the refusal names the one the host adds — the
  trend's rule with one clause instead of two. `limit` is one to fifty, declared on the node
  and refused above rather than clamped, as a `recentList`'s ten is.

  **The bar is against the exact largest**, one `max` over the same scope, so the top row fills
  its row and every other row is a true proportion of it. When the largest is not greater than
  zero, **no bars are drawn at all** and every row states its number: a proportion of a
  non-positive maximum is a drawing of nothing, and negative numbers are ordinary in a Decimal
  field. When the maximum is absent there is nothing to rank and the tile is empty.

  **Equal numbers share a numeral**, and the next numeral skips it — two records holding the
  same number are not first and second. The limit is a limit on rows, so a tie straddling it is
  cut: *the top ten by value* is ten rows, not everyone tied at tenth. Both are stated here
  because they are the kind of thing that is otherwise discovered in use.

  **What stays as it is.** Every number exact or absent; `avg` refused by name; no join and no
  expression over a result; an unrepresentable aggregate reads *Unavailable*; `entityId`
  required under an overview and refused anywhere else; the safe-mode fold answering the same
  cells as SQLite, because an answer that is exact in one and *Unavailable* in the other is two
  answers to one question.

  **Three named departures from the plan**, collected so that accepting this entry is not
  accepting them by accident, and any one can be struck: the matrix is one grouped read rather
  than a tile per cell; an axis may be a Boolean as well as a single choice; and `rankedList` is
  an overview tile rather than a root surface.

  **What this slice does not do.** No matrix on the front page: it is a screen, and a 366-cell
  read sitting under a page of other reads is not a tile. No `scope: cell`, which this shape
  removes the need for. No drag between cells. No ordering of an axis other than the field's
  configured option order. And the Reading Log — the fourth reference application the plan asks
  for to prove S4 through S6 — is still unbuilt: S6 proves itself on the agent-authoring gate
  over the Axiom Register, which gains the second choice field S7 will want anyway, and on this
  planner, where the matrix is work by horizon against status and the ranking is work by value.

  **Minimum host 1.26.0**, one rung for both kinds, as S4 gave one rung to three. The plan
  proposes the same number and the ladder's next rung is free, so nothing is corrected here.

  **Delivery obligations.** The twelve of the F4 checklist in full, for each kind, and this
  entry is not closed until they are there. Recorded outcomes will be appended after delivery,
  and until they are, this entry authorises the work and asserts nothing about it.

  **The owner accepted these rules on 2026-09-17**, including all three departures from the
  plan, each put to them by name with the alternative it replaces. Delivered the same day.

  Recorded outcomes, and only the outcomes that were measured: `Test-Production.ps1` passed,
  covering the repository gate, the production boundaries, the Workbench check, build and the
  unit suites, and 1,095 .NET tests (Engine 772 with one measurement harness skipped, Desktop
  225, LocalMcp 98) beside 206 Workbench cases. `Test-AgentAuthoringGate.ps1` passed both
  phases, authoring the matrix and the ranking over MCP alone as their own proposal — the
  register's screens already fill a change set to its 128-operation ceiling — and reading off
  the running app nine cells with six of them drawn empty, three lanes on each axis with the
  unset column present and the unset row absent, a cell drilling by its two predicates into
  the one record it counts, a ranking of one row out of three records, and both themes.

  **The headline rule was falsified in both lanes, and the second attempt is the one worth
  recording.** Making the fold answer only the cells the data touched failed the Engine tests
  with `Assert.HasCount failed. Expected collection of size 12. Actual: 2`. The gate, with the
  same defect in place, **passed** — which is the signal, not a reassurance. The grid draws its
  lanes from the definition and takes each number from the read, and a missing number was being
  printed as `0`, so nine cells were still drawn and six of them stated a count the file had
  never given. A cell nobody answered now reads as absent rather than as zero, which is better
  behaviour on its own account, and the gate then failed against the restored defect with
  `Every cell names its own number and both lanes to a screen reader: ["No number for Draft and
  Storage", …]`. A guard that passes against the defect it exists for is guarding nothing.

  **Two defects the gate and the unit tests found that a type checker could not.** Every exact
  number reaches the renderer in a `$nendoNumber` envelope, and the ranking read the stored
  value directly: every bar was drawn at zero width against a maximum that had been read
  correctly, which looks exactly like a ranking of records that all hold nothing
  (`The top row's bar is 0 of a 657 track; it holds the largest value`). And a tile composes
  its scope's clauses with its own, while a matrix *is* its own scope — so the first version
  charged every authored clause twice against the budget of eight and would have refused at
  read time a grid the compiler had accepted.

  **Beside the slice, a lane that was not running.** The eight Workbench cases S5 recorded
  were never added to `npm test`, so they had not run in any lane since that slice landed.
  They are in it now and they pass; the count above includes them. The S5 entry's claim that
  they covered the composition and the drawing was true of the cases and not of the lane.

  Keyboard and screen-reader behaviour is not instrumented here. Every cell total and ranked
  row is a real button with an accessible name carrying its number and its lanes, and the gate
  asserts those names; what a screen reader makes of a grid stays owner-reported, as it does
  for S4 and S5.

- **S7, a board grouped by a reference — accepted 2026-09-17.**
  B5 of [the plan](../design/surfaces-and-charts-plan.md): `boardSurface.groupByFieldId` widened
  to accept a bound Reference field, so a board can have a lane per project, per person, per
  client. No new node kind, no new property, and no change to what a board *does* — only a
  different answer to the question of where its columns come from.

  **The columns are records, and the whole slice follows from that.** S5's buckets came from a
  resolved range and S6's cells from the cross product of two option sets, and both were knowable
  before a record was read: a month is arithmetic, and a field's options are written down in the
  definition. The columns of a reference board are rows of another record type. People create and
  delete them while the board is open, under a definition nobody edited, so the board must read
  them — and every rule below is a consequence of the columns being data.

  **Every active record of the target type is a column**, ordered by the reference's configured
  label field, ascending, which is the order the reference picker already reads them in. Not
  "only the records something points at". Three reasons, and the third is the one that decides
  it. An empty lane is an answer: S6 settled that an empty cell is a cell and S5 that an empty
  month is a month, and a project nobody has assigned work to is exactly the thing a board should
  show as empty rather than hide. A column that appeared and vanished as data changed would make
  the board's shape depend on which records happened to load. And the referenced-only set cannot
  be computed exactly anyway — it would have to come from the board's own loaded window, which
  is fifty records, so "the projects in use" would mean "the projects in use on this page". That
  is the mistake S6 refused when it stopped deciding the unset lane from the loaded window.

  **A column order that nobody chose is stated rather than assumed.** A choice field's options
  carry the order its author arranged; a record type has none. So the columns are label-ascending
  and that is all — `orderDirection` on the board continues to order the *cards* inside a lane,
  as it does today, and never the lanes. Ungrouped stays first, where the board already puts it.

  **The ceiling is one-sided, and this is the named departure from the S6 precedent.** S6 refuses
  a grid when it is authored if the cross product is already too large, and states it when it is
  read if the option sets grew. A reference board gets only the second half, because there is
  nothing to refuse at authoring: a definition cannot know how many records a record type holds,
  and the compiler validates against the schema, not against data. So the ceiling is a read-time
  rule, and the property note carries the number so an author meets it before they build rather
  than after.

  **The board refuses the whole grid or draws all of it.** Reading the target type one page
  longer than the ceiling is what finds out, so no new aggregate and no count read is needed.
  Over the ceiling, the surface draws no columns at all and states that it cannot: the target
  type, how many records it holds, and the bound. Drawing the first two dozen lanes would be the
  one wrong answer, for the reason S6 gives about a partial grid — a board missing its last lanes
  looks exactly like a board. It also keeps a second promise cheaply: because either every target
  is a column or there are no columns, no card can point at a column the board did not draw.

  **The number is twenty-four, and it is the one dial in this entry.** A board loads one window
  of fifty records and places them client-side, so twenty-four lanes average two cards a lane and
  forty average one; past that the board states nothing a filtered list does not state better,
  and the sideways scroll becomes the interface rather than the board. Twenty-four is where those
  two arguments meet, and it comfortably covers the plan's own examples — a team, a client list
  that is a real client list. Striking it for twelve or for thirty-two changes nothing else here.

  **Reference columns take the hue an untoned option takes.** A tone lives on a choice option
  because somebody arranged it there; a record has nowhere to put one and this slice adds no
  place. The renderer already has a habit for a value nobody coloured — a hue derived from the
  stored value, stable per value and shared by every surface — and a reference column takes that,
  unchanged. So the column dot and the accent dot on a list keep working, the file stores no
  tone, and no new rule is written. A palette for referenced records is a separate idea, not a
  consequence of this one.

  **A card can be dragged between reference columns, and it carries the target's version.** This
  is the second real decision. A board's drag writes one field and will still write one field, so
  the gesture's promise is unchanged — but a reference write is refused without the target
  record's current version (`target-version-required`), where a choice literal needs none. The
  board already holds those versions, because it read the target type to build its columns, so
  the drag carries the version of the column it lands on. Where the target changed since the
  board loaded, the write is refused (`target-version-conflict`) and the board says so in the
  board's own words and reloads its columns, rather than passing on a message about selecting a
  record again — there is no picker on a board to select it in. The alternative was read-only
  reference boards, which is smaller and can be struck to; it is not recommended, because a board
  whose cards cannot move is a list in columns.

  **Unset is the column the board already has.** A record with no reference is Ungrouped, drawn
  by the existing rule, and the drag into it clears the field as it does now. **A target that is
  not there** is not reachable through any path the host offers: deleting a record that something
  points at is already refused by name (`record-referenced`, which lists the referring records).
  So the board keeps the statement it already makes about a value that matches no column, worded
  for a reference, and this entry makes no promise that a dangling target can occur.

  **The rung is the part of this the tree cannot see.** A board grouped by a reference is
  shape-identical to a board grouped by a choice: same kind, same `groupByFieldId`, same
  children. The capability ladder reads the stored node tree and nothing else, so it would
  return 1.26.0 for a file that needs 1.27.0. Were there a host at 1.26.0 it would open the
  file, refuse the board — *the board needs an active bounded choice field* — and, because one
  refused surface makes the whole definition invalid, report that *a custom surface cannot run
  safely* over every authored screen in the file while naming none of them.

  **The owner's answer to that, recorded here because it is a standing decision and not only an
  answer about S7: there is no older host.** Nendo is in rapid development, nothing is installed
  anywhere but the machines it is built on, and the ladder is free to change as the product sees
  fit. So the migration argument above is not why the ladder moves. It moves because the ladder's
  one job is to say what a file needs, and a ladder that returns a number it can see is wrong is
  not doing that job — the same reason an unanswered cell reads as absent rather than as zero
  (S6, F-049). A rung nobody would currently trip is still a rung that tells the truth.

  So the ladder reads the field, not only the node: `RequiredHostVersion` takes the entity fields
  beside the nodes, and this feature is present when a `boardSurface` groups by a field whose
  storage kind is Reference. The recompute already fires at the right moment — the only way a
  board comes to group by a reference is a UI operation that sets `groupByFieldId` or adds the
  board, because no conversion turns a choice field into a reference one — so nothing new has to
  trigger it. The inspection path that reports the mismatch already has the entities in hand.
  This is a small widening of a stated rule (F4's *computed from the tree's shape*) and it is
  stated rather than done quietly: the schema already raises rungs through the other channel,
  where a rating presentation and a choice tone reach theirs through their own field operations.

  **What delivery owes this rule is a falsification, and one sized to the reason above.** The
  guard is that a definition whose board groups by a Reference field requires 1.27.0, seen
  failing against a ladder that reads only the tree. Building a 1.26.0 host to open the file
  with is not owed, because no such host exists to protect.

  **An unbound Reference field is refused when it is authored.** A reference with no target type
  and no label field has no columns and nothing to put in a heading, and binding it is a reviewed
  proposal of its own. That is the authoring-time half of this slice's validation, and it names
  the field and what is missing rather than repeating the choice-field diagnostic.

  **What stays as it is.** A column's exact number still comes from a `summaryTile` at group
  scope, composed as it is today — the board's clauses, the tile's own, and the column predicate
  — so a reference board spends no new filter budget and the ceiling of eight is untouched. The
  count under a heading is still the loaded window's, and still says so. The board is still one
  bounded window placed client-side. Drill-through, F5, is unchanged. Retired options have no
  analogue and no rule is invented for one.

  **What this slice does not do.** No second reference axis, and no matrix grouped by a reference
  — the matrix's cells come from one grouped read whose keys are closed by the definition, and
  opening that to data is a different piece of work with the 366 ceiling in it. No grouped
  aggregate over a reference field, for the same reason. No tone on a referenced record. No
  ordering of columns by anything but the label. No board on the front page: a board is a screen.

  **Minimum host 1.27.0**, which is the rung the plan proposes and the next one free.

  **The owner accepted these rules on 2026-09-17**, in full and without striking anything: the
  columns being every record of the target type, the one-sided ceiling, twenty-four as its
  number, the untoned hue, the drag carrying the target's version, and the ladder reading the
  field. They added the standing decision recorded above, that there is no older host and the
  ladder may change as the product sees fit.

  **Delivery obligations.** The twelve of the F4 checklist in full. It proves itself on the
  agent-authoring gate over the Axiom Register, which already has `axiom-remit` pointing at the
  Remit record type labelled by its name, so the step is a board grouped by that field with
  Remits as its lanes — including one Remit no axiom points at, drawn empty, because that is the
  rule this entry turns on. The gate drives the drag with a real pointer: `element.click()`
  dispatches no `pointerdown`, and four gate steps in three days passed against restored defects
  without one. Recorded outcomes are appended after delivery.

### Accepted amendment — 2026-09-12 (widening the semantic vocabulary)

The owner explicitly accepted this amendment on 2026-09-12. It authorizes the
following bounded additions within contract version 3. The rules below are the
architecture authority; the delivered behaviour and its diagnostics live in
[the semantic surfaces contract](../contracts/semantic-surfaces.md), and the
disposable implementation plan that sequenced the slices has been retired.

**Admission rule.** A kind or property must have an explicit owner-facing semantic
diff describing its effect on records, and an explicit path in both Use and
read-only proposal preview. Geometry alone is not application meaning. Every
allowed visible node must be reachable; unknown nodes must never fall through to
another presentation or disappear. Filters and command steps contribute to their
parent's meaning rather than requiring standalone controls.

**Accepted vocabulary and behavior:**

- `summaryTile` may be a child of `recordList` and `boardSurface`. Its optional
  `scope` is closed to `surface` (default) and `group`; `group` is legal only on
  a direct board child. Surface totals apply root filters AND tile filters over
  the entire matching set, independent of the loaded record page. Group totals
  additionally apply the stored choice ID, or `isNull` for the ungrouped column.
  Invalid non-null choice data must not be counted as null. Existing page and
  relation tile meanings remain unchanged. Exact aggregates, numeric lexemes,
  empty numeric sets and the named refusal of `avg` remain as previously accepted.
- `recordList`, `boardSurface`, `calendarSurface` and `recordCommand` may each
  have eight roots per entity. This is an
  initial bounded product choice, not a measured optimum. Existing nested
  commands remain supported. `detailSurface` and `recordForm` retain one root
  each and their existing page precedence: detail first, otherwise form.
- Use selects a stable surface ID per entity, in compiled root order, rather
  than selecting only a kind. Its default is the first eligible root. A missing
  selected root falls back without erasing the remembered choice. Selection is
  file-session-local renderer state, never stored application meaning. Each
  surface owns its query/window; Studio retains its independent browsing state.
- `tabGroup` is non-root, has an optional title and contains one or more titled
  `section` children only. It is allowed beneath `detailSurface`, `recordForm`
  and `section`. Nested tab groups, including through sections, are refused.
  Fields, related lists and tiles retain their authored positions within tabs.
  Tab changes preserve the record draft; validation activates and focuses a
  hidden invalid field. Saving remains one typed record mutation against its
  expected version. Tab selection is transient, keyboard-accessible host state.
  This does not add commands to the section child vocabulary.
- `calendarSurface` is a root with `definitionVersion`, `entityId`, required
  `dateFieldId`, optional `title`, and existing ordering properties. Its children
  are `fieldBinding` and `filterClause`. The bound field must be an active Date
  field; DateTime is refused in this slice. A Monday-first month view groups
  civil dates without UTC conversion, offers previous/next month and Today,
  and has a separate bounded undated view. Month queries use an inclusive start
  and exclusive next-month bound. Default ordering is date ascending with the
  existing stable record-ID tie-break; declared order governs entries per day.
  Cursor pages accumulate with an explicit partial/complete state and Load more;
  a first page must never look like a complete month. Entries open the existing
  record page or Studio inspector; date changes use existing typed forms.

**Bounded query composition.** Keep the existing maximum of eight effective
filters. Publish contextual constraints alongside the vocabulary and refuse an
over-budget definition before it can be accepted. Count inherited root/tile
clauses and implicit predicates: one for a board group or related-record
reference, two for a calendar month (at most six authored calendar clauses).
Do not drop predicates or widen a query to meet the limit. Pagination retains
the original query snapshot. Query/revision changes invalidate cursors; stale
responses after file or surface changes cannot replace current state. Failed
reads have visible retry states, never an unfiltered fallback.

**Compatibility.** Preserve the version-3 tree and gate new capabilities through
increasing minimum host versions. The assigned ladder is `1.12.0` list/board
tiles and `scope`, `1.13.0` several command roots, `1.14.0` several list/board
roots, `1.15.0` named tabs, `1.16.0` the Date calendar, `1.18.0` a `fieldBinding`
or `section` carrying `visibleWhen`. Intermediate hosts must not advertise later
features.
A central Engine calculation over the resulting definition must cover additions,
property changes and moves, including changes to existing roots that never set
`definitionVersion` again. Apply the calculation at the completed mutation
boundary, and use it in canonical evidence/promotion and inspection. An ordinary
existing definition keeps its minimum; removing a capability never lowers it.
Open does not rewrite a file. Preview names a minimum-host raise as irreversible,
rejection leaves the active file unchanged, and promotion remains operation replay.
Product release version and semantic contract version remain separate concepts.

**Why this remains declarative.** This amendment explicitly resolves the earlier
grouping revisit trigger for one bounded case: an existing board's single stored
choice field adds one equality/null predicate to an exact aggregate. It did not
authorize a grouping query language, cross-entity joins or dashboards; the
2026-09-14 amendment above admits charts and the overview page under its own
bounds, and nothing else here moves. Tabs name
record-information sections; calendars project a stored Date and bounded record
set. Neither stores arbitrary layout, expressions, components or executable logic.

Rejected alternatives: arbitrary custom surfaces; unbounded roots; direct mixed
children or recursive tab groups; inferring tile scope; client-side sample totals
presented as exact; and DateTime scheduling without a time-zone contract. DateTime,
recurrence, durations and drag-to-date remain outside this amendment. P7 scripting
and extensions still require their own accepted decisions. All existing authority,
storage, lineage, reversibility, permanent Studio and safe-mode invariants remain.

**Delivery obligations and evidence.** Publish a vocabulary addition only alongside
its compiler, diff, Use and preview support. Preview uses the validated clone and
labels bounded samples; it cannot read active-file totals or acquire write handlers.
Keep agent examples and contextual diagnostics aligned. Qualify filter boundaries,
cardinality, exact totals, independent windows, stale-response rejection, tab draft
preservation, calendar completeness, both themes, keyboard behavior, typed proposal
reject/accept/reopen and older-host refusal. Follow repository build, runtime and
installer gates; distinguish automated checks from owner-reported usability.

**Delivered 2026-09-12.** Every slice of this amendment landed together with the
declared-query pagination repair, which remains an independent correctness fix.
The recorded outcomes, and only the outcomes that were measured, are:

- `pwsh ./tools/Test-Production.ps1` passed, including the repository gate,
  the application- and client-neutrality boundaries, the Workbench dependency
  boundary, `npm run check`, `npm run build` and 676 .NET tests
  (Engine 456, Desktop 139, LocalMcp 81).
- `npm test` in `src/Nendo.Workbench` passed 57 cases, including new pure suites
  for the window query snapshot, tile scopes, the calendar model and the widened
  preview branches.
- `pwsh ./tools/Test-AgentAuthoringGate.ps1` passed both its build and reopen
  phases. It authors the whole widened vocabulary from an empty file over MCP
  alone, reviews and accepts each change set in the Workbench, then drives the
  running application: the surface selector naming four roots, a surface total
  and per-column totals, a second list with its own filter, the Monday-first
  month grid and the undated view, and a tab change that preserves an unsaved
  value. It also counts requests around a surface change: exactly one
  `data.queryRecords`, no history, agent-status or compile refetch, and no read at
  all when returning to a surface already loaded in this revision. A scripted
  click proves the review surface works; it is not owner review.
- `pwsh ./tools/Test-JourneyDrag.ps1` and `pwsh ./tools/Review-NeutralityRuntime.ps1`
  passed, both create and reopen phases, with Light and Dark evidence.
- `pwsh ./tools/Review-OutcomeRuntime.ps1` **fails**, and was measured to fail
  identically on the unmodified parent commit, so it is not a regression from
  this work. Two missing navigation waits in the lane script were repaired; it now
  reaches its board-rename scenario and times out waiting for that proposal.
  Recorded as a pre-existing lane limitation in the roadmap.
- The installer was not rebuilt and no packaging lane was run in this change;
  owner-reported usability was not collected.

### Accepted amendment — 2026-09-12 (contract versions 1 and 2 removed)

The owner accepted this amendment on 2026-09-12. It removes contract versions 1
and 2 from the host. Contract version 3 is the only shape a Nendo host compiles.

**Why now.** The compatibility clauses below were written for files in the world.
There are none: Nendo has never been distributed, and the only `.nendo` files that
exist belong to the maintainer, who asked for the removal. Keeping three compile
paths, three digest projections and a slot-shaped render plan beside the node tree
was paying a compatibility cost against a population of zero — and it was not free.
The renderer read the version 1 and 2 slots and silently rendered a version 3 board
as a list, because the slot it consulted was null and nothing said so.

- **One compile path.** `CompileOptionalApplications` and the version 1 compiler
  are gone. `Compile` validates the node tree or returns nothing.
- **One plan shape.** `NendoRenderPlan`, `NendoFormPlan`, `NendoListPlan`,
  `NendoBoardPlan` and `NendoCommandPlan` are removed, and with them
  `NendoCompileResult.Plan` and `NendoProposalPreview.PreviewPlan`. An entity's
  surfaces are `NendoApplicationPlan.Surfaces`, an ordered tree, and nothing else.
- **One digest projection.** The version 1 byte-frozen projection and the version 2
  projection are removed. Only the composable projection remains.
- **`cardFieldIds` is gone.** Board card fields were already taken from ordered
  `fieldBinding` children in version 3; the parallel property is removed from the
  vocabulary, the diff summariser and every fixture.
- **An older definition fails closed, and the file still opens.** A stored root
  declaring `definitionVersion` 1 or 2 is refused by `NUI003`, which names the
  supported version and says the earlier ones were removed. Every custom plan is
  suppressed, and Studio, the data and recovery are unaffected — the existing
  fail-closed path, not a new rejected-open state.
- **The MCP surfaces resource drops its slots.** `nendo://application/surfaces`
  no longer carries top-level `form`/`list`/`board`/`command`, and
  `applications[]` describes each entity through `surfaces` alone.
- **The built-in Idea Garden is authored at version 3,** so a new reference
  application raises `minimumHostVersion` to the composable version rather than
  the lifecycle one.

Not changed by this amendment: the vocabulary of version 3, the fail-closed rules,
the digest-as-compile-time-identity rule, promotion by canonical operation replay,
or permanent Studio access. Nothing here authorises scripting or expressions,
which remain ADR-0008's scope.

Rejected alternative: keeping the version 1 and 2 compile paths behind a
capability flag. That preserves the cost this amendment removes and keeps the
slot-shaped plan that hid the board defect, for the benefit of files that do not
exist.

### Accepted amendment — 2026-09-10 (exact numeric aggregates on `summaryTile`)

The owner accepted this amendment on 2026-09-10. It widens the `summaryTile`
aggregate set within contract version 3; it introduces no node kind, changes no
existing plan shape and weakens no fail-closed rule.

**What it corrects.** The P6 closure refused `sum`, `avg`, `min` and `max` on the
recorded ground that "a Decimal column has SQLite NUMERIC affinity and is
float-backed, so a SQL SUM would not be exact." That premise is wrong for files
this host writes. A Decimal is stored as the exact text
`nendo.decimal:<invariant lexeme>`, which NUMERIC affinity cannot coerce, so it
lands as TEXT with every digit intact — `typeof()` reports `text`, asserted by
`ADecimalColumnStoresExactTextRatherThanAFloat`. The conclusion survives the
correction and gets stronger: SQLite must not aggregate that column, because
`SUM` would coerce each non-numeric string to zero and return a confident wrong
answer. What does not survive is the claim that exactness was unreachable.

- **Accepted: `sum`, `min` and `max`** over one Integer or Decimal field, named
  by a new optional `fieldId` property on `summaryTile`. The host folds the
  stored lexemes itself, one streamed row at a time, so the result is exact and
  memory is constant. A sum accumulates as a scaled integer, so a total may
  exceed the magnitude of any single value without loss.
- **`count` is unchanged** and still takes no field. Declaring `fieldId` beside
  `count` is a diagnostic, not an ignored property.
- **Refused by name: `avg`.** The mean of exact decimals is not generally an
  exact decimal — three values summing to 1 have no exact mean — so accepting it
  would put one rounded number on a page of exact ones. It is published in the
  vocabulary description as a named refusal *with its reason*, so an authoring
  client is told why rather than inferring it from an absence. An exact-enough
  average needs its own amendment declaring a scale and a rounding rule.
- **Legacy files fail closed.** A pre-P5 file can hold a genuine REAL in a
  decimal column. Aggregating one is refused with `aggregate-not-exact` rather
  than returning a number that looks exact and is not.
- **Exactness on the wire.** The result carries `valueLexeme`, the exact numeric
  string, beside the JSON number, matching `numericLexemes` on the records
  resource. A client that parses the number as a float loses digits and trailing
  zeros; the lexeme is what the Workbench renders.
- **An empty set is stated, never zero.** Zero is a real sum, so a set that
  contributed no value returns null and the tile says so.

Diagnostics: `NUI291` unknown aggregate, `NUI292` refused by name with its
reason, `NUI293` numeric aggregate with no field, `NUI294` unknown, retired or
non-numeric field, `NUI295` `fieldId` declared beside `count`.

### Accepted amendment — 2026-09-09 (contract version 3: composable surfaces)

The owner accepted this amendment on 2026-09-09, authorizing contract version 3
implementation. Evidence is
EX-0010,
which passed its three bounded lanes the same day. Governing plan:
[P6 — Composable surfaces](../architecture.md).
Confidence is Medium; production compiler, adapter, renderer and qualification
obligations remain, and acceptance of the contract is not a delivery claim. This amendment widens the closed vocabulary
and the plan shape. It does not weaken any fail-closed rule below, and the
version 1 and version 2 clauses remain in force for existing files.

The recorded negative of this ADR — a bounded vocabulary cannot express
arbitrary applications — now binds. Five node kinds, a two-level tree, four
fixed plan slots per entity and a single string-valued `setField` effect mean
every agent-authored application is isomorphic to the Idea Garden reference.

- **Open plan shape.** Replace the fixed `Form`/`List`/`Board`/`Command` slots
  with an ordered tree of typed nodes. A new surface kind becomes a vocabulary
  entry rather than a new field on the plan record.
- **Per-kind child allow-list.** The hard-coded rule that only `fieldBinding`
  may have a parent is replaced by an explicit permitted-children table per
  kind. Depth is bounded by that table, not by a constant. Unknown kinds,
  unknown properties, illegal parenting, orphans, parent cycles and duplicate
  roots all fail closed with a code, `semanticId` and `propertyPath`, and
  produce no partial render plan.
- **Version 3 node kinds.** `recordForm`, `recordList`, `boardSurface`,
  `fieldBinding` and `recordCommand` are retained. Added: `detailSurface` (a
  single-record page), `section` (a titled group with no binding), `relatedList`
  (records of another entity that reference this one, addressed by
  `targetEntityId` and the `viaFieldId` pointing back), `commandStep`,
  `summaryTile` and `filterClause`.
- **Board card fields.** Version 3 takes card fields from ordered `fieldBinding`
  children only. The parallel `cardFieldIds` property is retained for versions 1
  and 2 and is not carried forward; holding the same list twice is the source of
  the recorded diff-summary defect that names non-existent fields.
- **Commands that can act.** An entity may declare more than one command. A
  command owns ordered `commandStep` children applied as one atomic mutation
  against one expected record version. Effects remain a closed set.
- **Closed value vocabulary,** shared by `commandStep` and `filterClause`:
  `literal` typed to the target field's storage kind, using the existing
  `$nendoNumber` envelope for Integer and Decimal; `today`; `now`; `null`. A
  value that does not match its field's storage kind is a diagnostic, never a
  host fault.
- **Declared filter and sort.** `filterClause` children are ANDed. Operators are
  the closed set `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull`, `isNotNull`.
  Ordering is `orderByFieldId` with `orderDirection`. There is no expression
  language and no free-text search operator.
- **Bounded aggregates.** `summaryTile` declares one of `count`, `sum`, `min`,
  `max`, `avg` over one field of a filtered set. `sum` and `avg` require Integer
  or Decimal and use exact decimal arithmetic. This is a number, not a chart.
- **Digest rule.** Every contract version hashes an explicit payload projection,
  never the plan record itself. The version 1 projection stays byte-frozen.
  Version 2 moves to an explicit projection, changing its digest value once.
  That is safe because the render-plan digest is a compile-time identity: it is
  never persisted, never an authority token, and never checked by promotion,
  which uses the canonical operation digest. The required properties are
  relational — stable, insensitive to meaningless ordering, sensitive to every
  semantic change including a node move, and non-colliding across contract
  versions because the version is inside the payload.
- **Self-describing vocabulary.** The permitted-kind, permitted-property,
  permitted-child, operator, value-kind and aggregate tables are emitted as a
  machine-readable description generated from the same tables the compiler
  validates against, so an authoring client is not required to discover the
  contract by probing.
- **Compatibility.** Version 1 and version 2 files open and compile unchanged
  and are never upgraded or rewritten on open. Mixed versions across present
  roots continue to fail closed. Version 3 raises `minimumHostVersion` through
  its explicit typed definition operation; old-host refusal requires
  qualification before release.
  *(Superseded by the 2026-09-12 amendment: versions 1 and 2 are removed and now
  fail closed with `NUI003`.)*

Not authorised by this amendment: general scripting or expressions, computed or
derived stored fields, arbitrary markup, CSS or renderer state in the file,
charts and dashboards (admitted later by the 2026-09-14 amendment), third-party
controls, scalar multi-choice, binary or
asset fields, cross-entity writes from a command, a new persistence provider,
and any storage-schema change. In particular the covering index on reference
columns recommended by EX-0010 lane C is an ADR-0003 matter and requires its own
note; it is not granted here.

Rejected alternatives: keeping the fixed slots and adding one plan field per new
kind, which makes every vocabulary addition a structural change; storing a
free-form definition document, which reintroduces the general extension problem
and destroys operation-level diff and promotion; and an expression language for
filters and derived values, which is deferred to ADR-0008 with its own value and
isolation evidence.

Revisit triggers: a required surface still cannot be expressed without renderer
state, which would make the extension model rather than the vocabulary the
answer; filtering needs exceed the closed operator set; aggregates need grouping
or cross-entity joins.

Nendo needs stored forms, lists and boards that survive renderer replacement and
can be inspected, diffed and authored through typed operations. Persisting React,
AG Grid, HTML, CSS or other renderer configuration would turn an implementation
choice into the file format and create an authority escape hatch.

## Decision drivers

1. Renderer-independent durable definitions.
2. Stable semantic targets for authoring, accessibility and automation.
3. Deterministic validation, compilation and diagnostics.
4. Operation-level diff, history, proposal and promotion behavior.
5. No arbitrary code, markup, style or privileged host invocation.
6. Safe failure that preserves permanent Studio access.

## Options considered

### Strict semantic tree compiled to a host-neutral render plan

Store stable typed nodes/bindings and compile them through a versioned closed
vocabulary before any renderer sees them.

### Persist renderer configuration

Store component names and configuration for React, AG Grid or another toolkit.
This is expedient but couples the file to a replaceable adapter.

### Store arbitrary markup or scripts

Allow HTML/CSS/JavaScript or generic control trees. This expands the MVP into an
executable extension platform and weakens deterministic validation.

## Decision

Nendo stores versioned semantic UI definitions and compiles them into an
immutable host-neutral render plan.

- Format version 1 supports bounded record forms, lists, simple grouped boards,
  field bindings and named declarative command effects.
- Every definition and node has a stable semantic ID. Parent, position, binding
  and supported typed properties are explicit.
- The canonical UI mutation primitives are typed operations such as
  `ui.addNode`, `ui.setProperty`, `ui.moveNode` and `ui.removeNode`.
- Whole-definition convenience input must validate and expand into canonical
  operations before diff, history, proposal or promotion.
- The compiler validates contract version, tree/identity integrity, supported
  properties, schema references, bindings, command effects and relevant record
  warnings. A core error produces no partial render plan.
- Unknown nodes, properties, command effects or incompatible versions fail
  closed with actionable diagnostics and permanent Studio/safe-mode access.
- Definitions cannot contain renderer components/configuration, HTML, CSS,
  XAML, JavaScript, arbitrary controls, SQL, paths or generic host calls.
- Render adapters derive stable accessibility/automation targets from semantic
  IDs. React and AG Grid configuration remains transient adapter state.
- Declarative commands may invoke only a small named effect vocabulary through
  typed application services. General scripting is outside the MVP.
- Agent-authored definition changes use the application proposal lane in
  ADR-0007.

## Evidence and validation obligations

The 2026-09-05 review requalifies
empty/schema-only Studio: zero custom nodes produce no plan and no malformed-UI
diagnostic. Schema-only proposals may validate independently of custom UI;
present definitions still require the current complete form/list/board/command
set. Optional individual roots and multiple custom application plans remain
explicit product/contract obligations in the separate P5 plan.

- EX-0002 compiled the Idea Garden form and five-group board deterministically,
  rejected arbitrary properties/effects and rendered stable browser targets.
- EX-0003 rendered the same typed semantic snapshot through all containing
  candidates and retained recovery after renderer failure.
- EX-0005 exercised bounded `ui.setProperty` proposal authoring through MCP.
- Production must add complete form/list/board adapter tests, version fixtures,
  invalid-definition safe-mode tests and typed persistence round trips.
- Accessibility and visual behavior remain obligations of the chosen adapter;
  a valid semantic plan is not by itself a usable UI result.

## Consequences

P5-C implementation evidence is recorded in the
optional surfaces checkpoint.
Its explicit version-2 extension permits optional roots and multiple entity
plans within this closed vocabulary; it does not authorize scripts or arbitrary
renderer state. Recorded tests do not replace the remaining adapter/release gates.

### Positive

- Durable definitions survive UI-library changes.
- One operation stream can drive authoring, diff, history and promotion.
- Invalid or future definitions fail without making data inaccessible.

### Negative

- The bounded vocabulary cannot express arbitrary applications.
- New semantic capabilities require contract/version work and adapter support.
- Renderer-specific features cannot simply be serialized into the file.

## Rejected alternatives

Renderer configuration and arbitrary markup/scripts are rejected because they
couple persistence to replaceable technology and silently reintroduce the
general extension problem that the MVP defers.

## Revisit triggers

- A required MVP surface cannot be represented without renderer-specific state.
- Contract versioning or migration becomes impractical.
- Post-MVP scripting or third-party controls receive a separately accepted
  capability/isolation decision.
