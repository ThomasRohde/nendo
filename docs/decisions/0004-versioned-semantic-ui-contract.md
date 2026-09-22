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

The owner accepted this amendment on 2026-09-20, the same day it was proposed for W-040.

**What it authorises.** The person who reads a front page or a record page can fold a
section away and open it again. An author can set how the section starts. The owner asked
for this on the front page of the planner: *Recently delivered* and *Latest observations*
must fold, so that a long page shows only the parts that a person reads. Today a section
takes `title` and `visibleWhen` and no other property. No kind has a fold.

**The decision: one thing is stored and one is not.** How a section *starts* is
application meaning. When an author says "this part of the page is closed until wanted",
the author states a fact about the application, as `visibleWhen` states a fact about a
record. So it is stored as one property on `section`: `opens`, which takes the closed words
`open` and `closed`. When the property is absent, the value is `open`. What a person does
after that (folds this section, opens that one) is the person's own view of the page. It
is renderer state in the same sense as a selected tab (F-027). It is file-scoped. It is
cleared when the file session ends: when the person opens another file, or closes or
reopens this one. It is never durable and never in the file.

The project considered persisting the fold state and rejected it for two reasons. This
ADR's decision keeps renderer state out of definitions. Also, a fold that followed a person
across a reopen would be the only piece of renderer state that did so. The project also
considered storing only the default and rejected it, because then a person could not fold
a section that an author had not made foldable. The project rejected storing nothing,
because then an author could not say "starts closed", which is most of the request.

**Every section folds, and an author does not have to author anything for that.** The
reasoning of the 2026-09-18 entry applies without change. An author has nothing left to
say about whether a titled part of a page may be closed. The fold grants no authority. A
property would leave every existing screen (this planner's screens included) without the
fold until somebody edited it. There are two exceptions, and both are diagnostics:

- A section that is a tab's body does not fold and does not accept `opens`. A folded tab
  body is a strange object, and the tab strip already answers the question that the fold
  would answer.
- The compiler refuses `opens` on any kind other than `section`.

`visibleWhen` and `opens` compose and do not compete. The first decides whether the
section is on the page. The second decides how the section starts when it is on the page.

**A closed section reads nothing.** While a section is closed, the renderer does not read
its tiles, charts, ranges, recent and ranked lists or related lists. If it did, folding
would save the person nothing and cost the file the same reads. The chases that fill a
page treat the descendants of a closed section as not pending. When the person opens the
section, they become pending and they read then. Until the read, they show the state that
a tile shows before its first read. A value that was read stays until the file changes, so
closing and reopening a section reads nothing new. On a record page, the fields of a
closed section stay in the form, hidden and not removed, as `visibleWhen` keeps them. So a
save carries the same values that it carried before. A required field that is left empty
reveals its section in the same way that it already reveals its tab.

**The fold is a disclosure.** The heading of the section is the control. It is marked as
expanded or collapsed for assistive technology. It opens and closes from the keyboard in
the same way as from a pointer. It is drawn in Light and Dark. Like every node, it carries
an automation target derived from the node's ID.

**Rung.** `opens` is a property, and a host that does not know it refuses the surface. So
a file that carries the property needs a host that knows it: a `section` with `opens` is
minimum host 1.28. A file without the property needs the same host as before, because the
fold on every section is renderer behaviour and puts nothing in the file.

**Review.** When a section is added with `opens`, the review reads *Add the section
"Lately", starting closed.* When the property changes on a section that the file already
has, the review reads *Start the section closed.* or *Start the section open.* The
read-only preview draws a section in its starting state.

**Delivery obligations.** The F4 checklist applies in full, because this is a property.
The same change must deliver:

- the vocabulary row and its note;
- the two refusals of the compiler;
- the capability rung with its constant, and the ladder row of the contract;
- the diff sentences and their tests;
- the Workbench front page and record page;
- the file-scoped fold state;
- the chase exclusions;
- the preview and Help;
- a step in `Gate-AgentAuthoring.mjs`;
- a line in the blackbox prompt;
- the contract and architecture text.

The gate proves the change on the Axiom Register. Through the host, it adds a section that
starts closed and holds a count tile and a relation on the Remit page. It adds one more on
the front page that holds a tile. Then the gate measures the result and does not only look
at it:

- The section is drawn closed.
- Nothing for the tiles of the section crossed the bridge while the section was closed.
  The gate counts this on the bridge in the same way as the outcome lane counts.
- A real pointer press on the heading opens the section, the reads land and the numbers
  appear.
- When the section is folded again, the reads stop on the next chase interval.
- When the file is reopened, the section goes back to its stored default.

The gate runs in Light and Dark. Two falsifications are owed, and each must be seen to
fail. The first is a closed section that still reads; the bridge count catches it. The
second is a stored default that the renderer ignores; the initial state catches it.

**Not in this amendment.** These items are not in this amendment:

- Remembering the folds of a person across a reopen (F-027 stands).
- Folding a tab, a related list or a whole surface.
- Animation.
- A fold on the proposal review itself.

### Accepted amendment — 2026-09-18 (a related list is a way in)

The owner accepted this amendment on 2026-09-18. It is the first entry under this ADR that
adds nothing to the vocabulary: no kind, no property, no diagnostic, no diff sentence and
no rung. It changes what a `relatedList` *does*. It does not change what a `relatedList`
is.

**What it authorises.** A related list offers two actions that it did not offer before:

- **Add** opens a new record of the related type. The reference back to the record in
  view is already filled in.
- **Open** opens a related row as its own record page, with one step back to the place it
  was opened from.

A related list was display-only from the time contract version 3 shipped it. To record a
linked record, a person had to leave the page that already knew the record, find the
record again in a picker, and navigate back (F-031; also C-044, where the workaround was
accepted so that W-001 could close).

**The decision: neither action is authored.** The alternative was a property: a related
list that offers Add only where somebody asked for it. The project rejected it for three
reasons, and the third reason decides it:

1. The node already carries both halves of the relation, and the compiler already proves
   them. `targetEntityId` names an active record type, and `viaFieldId` names an active
   Reference field on it that points at this record type. If not, the surface does not
   compile (`NUI260`–`NUI266`). So an author has nothing left to say.
2. The action grants no authority. The toolbar of Use already adds a record of any type
   that Use shows. The related list adds the same record with one field filled in.
3. A stored property would leave every screen built before today unchanged until somebody
   edited it. That includes the file in which this product is planned. That file would
   need a reviewed proposal to get a button that needs nothing from the file.

**So nothing is stored, and there is no rung.** Every slice under the 2026-09-14 amendment
added a rung, because each slice put a shape in the file that an older host would refuse.
This entry puts nothing in the file. The only job of a rung is to say what a file needs. A
file that is byte-for-byte unchanged needs the same host as before. A host without this
change reads the same definition and draws the same list without the buttons. That is the
correct outcome, and it is not a failure to protect against.

**The form is the record type's own page.** Add renders the `detailSurface` of the target
type as a create form, with its sections, tabs, required fields and reference controls. It
renders the form in the place where the record page was. If a type has no page, the form
falls back to its field list, as a create form already does today. So the question *where
does the form come from* has no new answer. It is the answer that Use already gives when a
person presses Add in the toolbar. A field that a type requires stays required here.

**The filled-in reference carries the version of the parent, because the Engine refuses a
reference write without it** (`target-version-required`). The record for which the
relation is shown is on screen, so its version is available and nothing has to be read to
get it. The value is shown by its label, as the picker shows it, and not as the stable ID,
which nobody recognises. The value stays editable. The picker already permits a person to
repoint it. A new rule to forbid it would make this one reference behave unlike every other
reference.

**A record page with unsaved edits declines both actions**, with the same words that the
drag on the board already uses for the same reason. Both actions redraw the page, and a
redraw discards what is typed into a form. This is the existing behaviour and not a new
rule: the board refuses to move a card while the inspector beside it is dirty. The
alternative was to save the record for the person so that the next click can proceed.
That is a write that nobody asked for. A tab switch still keeps a draft. That path does not
redraw, and this change does not touch it.

**Back is one step and not a history.** A related record opened from a page offers a return
to that page. If the person opens a third record, the new return replaces the first one and
does not stack behind it. The return is transient renderer state, in the same sense as a
drill-through or a selected surface. It never reaches the file. It is cleared when the file
session ends: when the person opens another file, or closes or reopens this one. A stack would be state that accumulates, and a trail that nobody asked to
keep.

**Where the related type has no screen, the list offers neither action** and states this.
Use shows the record types that have a compiled surface. A record created in a type without
a surface would have no place to go after creation and no page to open on. A button that
leaves a person with no way forward is worse than no button. Use already draws this
boundary in its record-type picker; this is not a new boundary.

**What this does not do.** It does not allocate the reference codes that the convention of
a file may require. This product requires a Reference field to be non-empty. It does not
fill the field in, enforce uniqueness or stop a change to it. So in a file whose records are
named `C-044`, a person still decides which number is next. That is an application
convention and a separate piece of work, and this entry records that it did not remove it.
There is no bulk add and no delete from a related list. There is no related list inside a
create form: a record that does not exist has nothing that points at it, so the question
does not occur.

**Delivery obligations.** The F4 checklist is a checklist for a new kind, and most of it
does not apply. There is no vocabulary row, no diagnostic, no diff sentence, no rung and no
authoring example, because there is nothing to author. The owed items are:

- the Use path;
- the read-only preview, which says what a reviewer accepts;
- Workbench tests;
- a step in `Gate-AgentAuthoring.mjs`;
- a phase in the blackbox prompt;
- the contract and architecture text in the same change;
- recorded checks for Light and Dark, keyboard and screen reader.

The gate proves the change on the Axiom Register. Its Remit page already carries an Axioms
relation with a count tile. The gate adds an axiom from the Remit, sees it in the list and
sees the count change, opens it, and comes back. The gate drives this with a real pointer,
for the reason that S7 records. F-031 is the report that this change answers, so a guard is
owed, and it must be seen to fail against the restored defect.

**Delivered 2026-09-18.** These are the recorded outcomes, and only the measured ones:

- `Test-Production.ps1` passed. It covered the repository gate, the production boundaries,
  the Workbench check, build and twenty-eight unit suites (236 cases), and 1,122 .NET tests
  (Engine 795 with one skipped, Desktop 225, LocalMcp 102).
- The payload and installer were rebuilt. `Test-NendoSetupIsolated.ps1` passed.
  `Test-NendoInstaller.ps1` declined by interlock, because an owner installation is
  present.
- `Test-AgentAuthoringGate.ps1` passed both phases. Its new step added an axiom from the
  relation of the Data remit, over a register that an agent built without knowledge of
  these actions. The step read these results off the running app:
  - the reference was filled in with the name of the remit and carried its version,
    although no picker was opened;
  - the relation went to four rows and its count tile to 4 without leaving the page;
  - the new axiom opened on its own headed page, although the surface behind it is
    filtered to exclude it;
  - the way back named the Data remit and was gone after it was taken.
- Captures were taken in Light and Dark.
- Keyboard and screen-reader checks were not instrumented in this change. They remain
  owner-reported.

The falsification is the Workbench guard. It was seen to fail against the related list with
its actions removed again: *The input did not match the regular expression
/data-related-add="rel\.checks"/. Input: actual:
`'<header class="related-head"><h3>Acceptance checks</h3></header>'`* and *The input did not
match the regular expression /data-related-open="c044"/. Input: actual:
`'<li><strong>C-044</strong><span>Accepted exception</span></li>'`*. That is the
display-only relation that this entry is about. The gate step was not run separately
against that restored defect. But it was seen to fail twice against two real defects in
this change, and that is how both defects were found:

- `refreshDerived` dropped a selection that it could not find in the loaded window of the
  surface. That applies to every record opened from a relation, so the page navigated and
  then showed nothing (*Timed out waiting for the new axiom's own page*). A focused record
  is now read again there, like every other window.
- The way back named the record **type** and not the record, because the Remit page
  declares no `titleFieldId`. It now falls back to the first field that the page binds, as
  a card and a recent list already do.

### Accepted amendment — 2026-09-14 (colour, charts and the overview page)

The owner accepted this amendment on 2026-09-14, the day when the [vision](../vision.md)
admitted charts and dashboards into scope. It authorises the bounded additions below
within contract version 3. [The surfaces and charts plan](../design/surfaces-and-charts-plan.md)
lists the ideas that this amendment sequences and the order in which to build them. Each
slice of that plan is recorded under this heading when it lands. Its rules are in
[the semantic surfaces contract](../contracts/semantic-surfaces.md).

**What it authorises.**

- A choice option may carry a `tone` from a closed set of named hues. The author sets it
  through the existing choice-metadata operation. It is a semantic token in the same
  sense as a field presentation, and never a hex value. The renderer owns the Light and
  Dark colours behind it.
- A chart is an exact aggregate over one closed grouping, drawn as proportion. The
  grouping is the options of a single-choice field, a Boolean, or the months, weeks or
  days of a Date field between two bounds. The chart shows its numbers, and a table of
  them is one toggle away. A chart never draws a page of records as the whole set. It
  never shows a proportion without both of its numbers.
- An `overviewSurface` is one file-level root of sections, tiles, charts and short
  recent lists. Each of them names its own entity.
- Drill-through from a chart into a filtered list is transient renderer state, like
  surface selection.

**What it does not.** None of this stores layout, an expression, a sample or renderer
configuration. There is still no grouping query language, no cross-entity join and no
expression over a result. The refusal of `avg` still names it. A calculated field still
cannot be grouped or totalled. An aggregate that cannot be represented still reads
*Unavailable*. This amendment supersedes the sentence in the 2026-09-12 amendment that
refused dashboards, and that sentence states this.

**Delivery obligations.** Each kind arrives with the checklist that the plan states once:

- its compiler, diff, Use and preview support;
- its own rung on the capability ladder;
- an authoring example;
- a step in the agent-authoring gate;
- a phase in the blackbox prompt.

Every slice is recorded below when it lands.

- **S0, colour and the record-page header — delivered 2026-09-14.** The slice added
  `tone` on a choice option, stored in its own protected table at the end of the layout
  ladder. It added `titleFieldId`, `subtitleFieldId` and `accentFieldId` on
  `detailSurface`. A file that uses either addition needs minimum host 1.19.0. These are
  the recorded outcomes, and only the measured ones:
  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and twelve unit suites, and 856 .NET tests
    (Engine 603, Desktop 157, LocalMcp 96).
  - The payload and installer were rebuilt, and `Test-NendoSetupIsolated.ps1` passed.
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored three toned statuses
    and a headed page over MCP alone, and read the tones off the running board and the
    record page.

  The same change repaired the surface-picker assertion of the gate. The assertion read
  the whole text of a button, but the picker had started to append the kind of each
  surface. So the assertion had failed since the 2026-09-12 polish, and nobody had run
  it.
- **S1, the first charts — delivered 2026-09-14.** The slice added:
  - One exact grouped aggregate in the Engine over a closed grouping (the options of a
    single-choice field, or a Boolean). It answers in one read, with the unset group last
    and a value outside the options counted separately.
  - `breakdownChart` and `progressTile`, accepted where a `summaryTile` is accepted. They
    are not yet accepted inside a `relatedList`; there they are refused and not drawn
    empty. They are validated with the shared rules of the tile, at minimum host 1.20.0.
  - A pure SVG chart kit in the Workbench.
  - Drill-through from a segment or a ring into the first list of the record type, as
    renderer state.

  These are the recorded outcomes, and only the measured ones:
  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and fourteen unit suites, and 874 .NET tests
    (Engine 621, Desktop 157, LocalMcp 96, the worked example included).
  - The payload and installer were rebuilt, and `Test-NendoSetupIsolated.ps1` passed.
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored a breakdown by status
    on the board and a ring on the open list over MCP alone. It read these results off
    the running app: the exact counts of the legend; the tones of the segments; the table
    of the same numbers; a drill that opened the first list narrowed to one group, with
    exactly one record read and a pill; the list restored on dismissal; and the ring
    reading 1 of 2.
- **S3, the timeline — delivered 2026-09-14.** The slice added `timelineSurface`. It is a
  root that places records on a spine by a Date field. It shows one civil year at a time,
  with a heading for every month. It has these parts:
  - An optional `endDateFieldId`, drawn as a span from its start. The days are inclusive.
    The span is cut at 31 December, and the entry states this. An end before its start is
    stated on the entry as a data issue.
  - `titleFieldId` and `accentFieldId`, under the rules of the record page.
  - The undated view of the calendar.

  Placement uses the start date only. The year header states the scale and that rule on
  the surface. The refusals are `NUI370`–`NUI374`. A year reserves two implicit predicates,
  as a month does. The minimum host is 1.21.0. S2 was not built when the owner asked for
  S3, so S3 took the next rung and S2 takes 1.22.0. The page accumulator and loader of the
  calendar now serve both surfaces under one map. Three focus and today rings read an
  undeclared `--accent` token; they now read `--cobalt`. These are the recorded outcomes,
  and only the measured ones:
  - `Test-Production.ps1` passed on its third run. It covered the repository gate, the
    production boundaries, the Workbench check, build and nineteen unit suites (156
    cases), and 900 .NET tests (Engine 647, Desktop 157, LocalMcp 96).
  - The first run failed on two `IdentityCopyTests` rows and on one
    `InstanceOwnershipTests` row. The expectation of the two `IdentityCopyTests` rows
    hard-coded the old minimum host of the Decision Log; it is now stated per
    application. The `InstanceOwnershipTests` row failed with a file lock. The lock did
    not reproduce in three isolated runs or in the two gate runs after it.
  - The payload and installer were rebuilt, and `Test-NendoSetupIsolated.ps1` passed.
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored the timeline as its own
    proposal over MCP alone, because the surfaces proposal of the register already held
    128 operations, the ceiling. The minimum-host raise was its own diff line. The gate
    read these results off the running app: one record read per selection; the twelve
    month headings of this year; the accepted axiom as a span in the green tone, cut at
    the year end with a statement of this; the state line and the scale note; the undated
    view with two records; an entry that opened the headed record page; and the spine
    captured in Light and Dark.
  - `Review-NeutralityRuntime.ps1` passed all six phases, with the Decision Log carrying
    a timeline from decided date to review date.
  - Keyboard and screen-reader checks were not instrumented in this change. They remain
    owner-reported.

- **S2, the gallery and the rating scale — delivered 2026-09-14.** The slice added two
  things.

  `gallerySurface` is a root that draws one card per record over exactly the bounded
  window of a `recordList`, with the same pager and the same tile and chart children. Its
  `titleFieldId` and `accentFieldId` follow the rules of the record page, with card
  wording. The compiler refuses them as `NUI380` and `NUI381`. Both are optional, because
  a card with no declared title leads with its first bound field, as a timeline entry
  does. The gallery adds no implicit predicate. So it joins the list and the board in the
  clause table of the compiler and carries the full eight. If it were left out of that
  table, the compiler would scope it as a page. Its own clauses would then not count
  against the budget of a tile while the renderer composed them.

  `presentation: rating` applies to an Integer field with a closed `min` and `max` of at
  most ten values. It is stored in `__nendo_field_scale` as the new last rung of the
  layout ladder, for the reason that the tone table gives. The author reaches it through
  the evidence of the field operation, as for a tone. The scale bounds the drawing and
  does not bound the column. A value outside the scale is written and read back exactly.
  It is reported as `NDATA012`, beside the warning that a value outside the choices of a
  field already gives, because a scale may be declared over values that already exist.

  Either addition needs minimum host 1.22.0. S3 was built before S2, so S2 took the later
  rung. Rungs follow delivery order because the ladder is monotone. These are the recorded
  outcomes, and only the measured ones:
  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and nineteen unit suites (167 cases), and 938
    .NET tests (Engine 683, Desktop 157, LocalMcp 98).
  - The payload and installer were rebuilt, and `Test-NendoSetupIsolated.ps1` passed.
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored a rated field and a
    gallery over MCP alone. It read these results off the running app: three toned cards
    in one record read; a rating drawn as four filled dots of five and named "4 of 5"; the
    surface total covering every matching record; the pager of the list; a card that
    opened the record page with the stored value of the rating chosen in its radios; and
    the grid in Light and Dark. The same change corrected two of its assertions. The
    rating moved the minimum-host raise from the timeline proposal to the structure
    proposal that now carries the scale. Also, the record page had never bound the rated
    field.
  - `Review-NeutralityRuntime.ps1` passed all six phases, with the Decision Log carrying
    a gallery of decision cards.
  - Keyboard and screen-reader checks were not instrumented in this change. They remain
    owner-reported.

  **The first build laid the gallery out incorrectly, and the gate passed anyway.** The
  owner found this in the screenshot. There were two defects:
  - The totals row was indented past the cards that it describes. The margin override of
    the gallery was written before the rule that it overrides, and it lost on order at
    equal specificity.
  - Cards took the height of their content, so a card whose value was drawn as dots was
    shorter than its neighbours.

  Both defects are fixed. Cards now stretch to their row, and their version footers share
  a baseline. The gate now measures those three geometries and does not only capture
  them. The guard was falsified: the reintroduced defect failed it with "Cards in one row
  have different heights: 158, 158, 150".

  The owner then found a third defect: when a person opened a card, the grid reflowed,
  because the inspector takes its space from the surface. The gallery now keeps its
  width, and the surface scrolls. That is the rule of the calendar for its day tracks. The
  gate measures a card and the grid across the click. Without the rule, it fails with
  "card 248 to 427, grid 767 to 427". So the reflow was a collapse from three columns to
  one, and not the small slide that it seemed to be.

  A fourth defect followed, in the control of the rating itself. The radio and a dot
  drawn beside it gave every value two circles of the same shape. The base rule that sizes
  every input for typing drew the mark as a 21 by 39 oval. The radio is now the dot, sized
  by the rule of the rating. The gate reads the count, the drawing of the browser and the
  measured box. It was falsified at "The rating radio is drawn by the browser as well as
  by the stylesheet" and "The rating dot is drawn 21 by 39, not as a dot".

  In the same report, the owner stated that the text of the form could be selected. A
  drag from a field name sweeps a selection across the whole form. So names, legends and
  the pills now start no selection, and the values stay copyable. That drag was
  reproduced and fixed in a browser, not in the gate. WebView2 does not drive a selection
  from the synthetic mouse events of CDP. So the gate reads the rule off the five elements
  that it has to reach, and falsifies at "A drag over the form's chrome can still sweep
  it". Two of the falsification runs of this session proved nothing until this was
  noticed: a CSS comment placed before a selector does not disable the rule.

- **What the file is for — accepted 2026-09-15, delivered the same day.** The owner
  approved this amendment in advance, on the observation that opened it: every running
  instance of Nendo looks the same, and nothing in a file says what the file is for. S4
  delivered the narrow half: an `overviewSurface` carries a `description` drawn under its
  title. S4 stopped there by intent, because a node cannot speak for a file that has no
  overview. This entry is the other half.

  A file carries **one purpose of its own**. The purpose is prose that the author writes,
  at most 4,000 characters. Above that limit it is refused, not cut. One canonical
  operation on the definition lane, `application.setPurpose`, sets or clears it. It is not
  a node and not a property of a node.

  `nendo://application/describe` **leads** with the purpose, before the manifest. An agent
  that meets an unknown file must learn what the file is for before it gets revisions and
  a schema from which to infer the purpose. The narrow `manifest` read carries the purpose
  too. A person reads it from **About this file** in the File menu, which is reachable
  whether or not the file has a front page. For half a day, the purpose was drawn in the
  menu itself. But prose of a useful length pushed the actions below it off the bottom of
  the menu that a person had opened to reach them. So the purpose moved to a page of its
  own.

  If the author of a file wrote no purpose, the file carries nothing. A clear deletes the
  row and does not store a blank, so absence is absence in the storage as well as in the
  read. Nothing is ever derived from the file name. The purpose is stored in its own
  protected table as the new last rung of the layout ladder. It is never a column on the
  manifest, because the protected layout of the manifest is a fingerprint of verbatim DDL,
  and an `ALTER TABLE` cannot reproduce that byte for byte.

  The minimum host is **1.24.0**. The evidence of the operation declares it, and the
  capability ladder does not. The ladder walks UI nodes and would never see a value that
  has no node. A file with no purpose takes no rung and raises nothing. The review names
  the purpose as its own `purposeBefore`/`purposeAfter` pair. It does not leave the purpose
  to be found among the record types and screens: that is where the front page was
  invisible until commit `7d86566`. The panel no longer tells a person that a purpose-only
  proposal "changes structure and data only".

  These are the recorded outcomes, and only the measured ones:
  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and unit suites, and 1,046 .NET tests (Engine
    729, Desktop 219, LocalMcp 98).
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored the purpose over MCP on
    a file that had no front page yet, accepted it in the running app, and read it back
    from the top of `describe` and out of the rendered file menu.
  - Three guards were falsified and seen to fail:
    - Table creation on a clear made the file unreadable
      (`Expected:<production-semantic-v1>. Actual:<>`).
    - A move of the member off first position broke the payload order
      (`Expected string length 7 but was 8`).
    - Removal of the pair from the proposal summary failed the gate with `The proposal
      summary does not carry the purpose it sets: null`.
  - A fourth falsification restored the pre-existing bug beside it. A cleared front-page
    description used to read "Say what this file is for: a description". That was the
    fallback of the diff, printed as though the author had typed it. This change fixes
    that line and adds its own test.
  - The installer lanes and the neutrality lane are recorded separately below.

- **S4, the overview page — accepted and delivered 2026-09-15.** The owner accepted both
  halves of this slice on 2026-09-15, after the plan in
  [the S4 transfer](../design/s4-overview-plan.md) stated the cost of each.

  An `overviewSurface` is a root that belongs to the file and not to a record type. There
  is one per file, with no `entityId` of its own. It holds sections, tab groups, tiles,
  charts and short recent lists, and each of them names the record type that it reads. It
  carries an optional `description`, because a file that opens on a front page must say
  what it is for. Otherwise every running instance looks the same. The sentence that a
  person reads on the front page is the sentence that an agent must be told first.

  Use opens the overview first when one exists. A file without one is unchanged. In both
  cases, the empty-but-valid file and the permanent host-owned Studio route are not
  touched. The overview composes nothing across record types. It is several bounded reads
  side by side. Each read spends its own filter budget over the one record type that it
  names. There is still no join, no expression over a result and no stored layout.

  A `recentList` is the ordered window of a list, bounded to at most ten records. The
  bound is declared on the node, and a value above ten is refused, not clamped.

  A `rangeTile` is **not** a chart in the sense that this amendment defines. It has no
  grouping. It is the two exact aggregates `min` and `max` of one field, drawn as a strip
  with both ends labelled. It widens those two aggregates from Integer and Decimal to a
  Date, which orders by comparison and not by arithmetic. The refusal of `sum` over a Date
  still names it. The safe-mode fold answers a Date too: an aggregate that is exact in
  SQLite and *Unavailable* in safe mode would be two answers to one question. Every number
  stays exact or absent. `avg`, calculated-field grouping and the aggregate that cannot be
  represented keep their refusals.

  The minimum host is 1.23.0. The kinds arrive with their compiler, diff, Use and preview
  support, their rung on the capability ladder, an authoring example, a step in the
  agent-authoring gate and a phase in the blackbox prompt.

  These are the recorded outcomes, and only the measured ones:
  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and twenty-one unit suites (181 cases), and
    1,038 .NET tests (Engine 721, Desktop 219, LocalMcp 98).
  - The payload and installer were rebuilt, and `Test-NendoSetupIsolated.ps1` passed.
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored the front page over MCP
    alone as its own proposal, because the screens of the register already fill a change
    set to its 128-operation ceiling. It read these results off the running app: the
    description; a count of three against the seeded records; a ring of one of three;
    both ends of a Date range; the remits of the second record type; a drill from a
    front-page chart into the narrowed list that the chart belongs to; and Light and Dark.
  - `Review-NeutralityRuntime.ps1` passed all six phases, with the Decision Log carrying a
    front page.
  - Keyboard and screen-reader checks were not instrumented in this change. They remain
    owner-reported.

  The gate found two defects, and a type checker could see neither:
  - A record window carries the snapshot of the host (`recordId`, `recordVersion`,
    calculations in dependency order), and every renderer uses the vocabulary of the plan.
    The recent list cast one to the other. The cast was wrong in three fields at once, and
    it silenced the type that reported the error. There were already two copies of the
    real projection; now there is one.
  - A civil date is answered as an exact lexeme. For a date, that is the date as a JSON
    string, so **the range drew the quotes**. The range now reads the date. It keeps a
    number exactly as answered, so no trailing zero is lost on the way to the screen.

  The gate reported "Uncaught" for every renderer exception, which names nothing. It now
  reports the message and the stack, and that is how it found both defects.

  **The owner found a third defect in the screenshot that the gate had already passed.**
  Every Use surface takes its inset from the class of its own kind, and the front page set
  none. So its title, its description and every tile were sixteen pixels outside the line
  to which the rest of the app is drawn. The gate now measures that edge and does not only
  capture it. The guard was falsified: with the defect put back, it fails with
  `{"toolbar":241,"heading":225,
  "description":225,"tile":225}`.

  One behaviour changed but did not break, and the neutrality lane found it. A file that
  opens on its front page no longer lands on a screen that can add a record, because the
  front page belongs to the file and has no record type to add to. The record type is one
  step away in the same picker. The neutrality lane now goes there before it adds a
  record.

- **S5, over time — accepted 2026-09-16.**
  The slice adds two kinds that group by a civil date and not by a closed set of options:
  - `trendChart` states one exact number per month or per week over a bounded period.
  - `activityGrid` states one exact count per day over a year.

  They are the first groupings whose groups the definition alone does not make known. The
  options of a choice field are written down; a month is not. Every particular rule of
  this slice follows from that one difference.

  **A stored definition never carries a date.** `range` is a closed word. The host
  resolves it to civil-date bounds at read time, in the same way as `today`. So a
  definition written in January has the same meaning in December, and no stored screen
  becomes stale. The closed set is `last12Months`, `last6Months`, `last90Days` and
  `last30Days` on a `trendChart`, and `thisYear` and `lastTwelveMonths` on an
  `activityGrid`. The refusal of a word outside the set of its kind names the word. There
  is no authored literal alternative. A literal would put a date in a definition, and this
  rule exists to prevent that.

  **An empty bucket is a bucket.** A month with no records draws as a gap at zero, not as
  a missing column. A day with no records draws as the lightest tone, not as a hole. The
  host generates the buckets from the resolved bounds and fills them from the grouped
  read. So a person sees the extent of the range, not only the data that exists. Charts
  over time get this wrong most often, and it is a rule, not a rendering detail. A year
  with three active days is a year of squares, and three of them are toned.

  **The ceiling was published before it was needed.** `MaximumAggregateGroups` is 366,
  and it has been 366 since S1. S1 stated it so that "the day buckets of a later slice
  have a stated bound rather than a new rule". This is that slice, and it uses the bound
  as written. An `activityGrid` over a leap year is 366 groups and fits exactly. Nothing
  here raises the bound. A `trendChart` at its widest is 53 weekly buckets and is far
  inside the bound.

  **The refusal of DateTime names it**, as on the calendar and the timeline. `dateFieldId`
  takes a stored Date field. A DateTime field is refused with a diagnostic that names the
  field; it is not silently truncated to its date. A truncation is a time zone decision,
  and this product has not made one (F-006). A calculated field cannot be grouped here
  either. That is the standing rule and not a new one.

  **What stays as it is.** These kinds are tiles in the same sense as the S1 charts. They
  are accepted in exactly the same places: `recordList`, `boardSurface`, `gallerySurface`,
  `detailSurface`, `section` and `overviewSurface`. **Not `relatedList`**: S1 left charts
  out of a related list by intent, because a related list does not draw a chart. A kind
  that is accepted where nothing draws it compiles and then silently disappears. The
  surfaces and charts plan lists `relatedList` among the parents. The plan is a proposal
  and the code is current, and this entry follows the code.

  The kinds take `filterClause` children. Under an overview they name their own
  `entityId`, and anywhere else they refuse one. `trendChart` takes `aggregate` and
  `fieldId` and answers the same exact aggregates over each bucket. `activityGrid` counts
  and takes neither, because a grid of toned squares that reads a sum is a heat map of a
  value that a person cannot recover from the square. Drill-through is F5 without change.
  A bucket opens the first list of the entity with the date predicate of that bucket
  applied as a transient filter. The filter is local to the file session and is never
  written to the file. The refusal of `avg` still names it. There is still no join and no
  expression over a result. An aggregate that cannot be represented still reads
  *Unavailable*.

  A `trendChart` takes at most six authored clauses, because the host adds two date
  bounds of its own to the effective-filter budget of eight (F-013). The refusal names the
  two clauses that the host will add. Without that, an author who uses all eight cannot
  know why the number is six.

  **Minimum host 1.25.0, not the 1.24.0 the plan proposed.** 1.24.0 went to the file
  purpose on 2026-09-15, while this slice was not yet written. The ladder is monotone, and
  rungs follow delivery order, not proposal order. S2 and S3 already carry the same
  correction. The same change as this entry updates
  [the surfaces and charts plan](../design/surfaces-and-charts-plan.md) to state this.

  **Delivery obligations.** All twelve items of the F4 checklist apply. The owner accepted
  these rules on 2026-09-16. That acceptance included the rung correction and the rule
  that `activityGrid` only counts; both were put to the owner explicitly.

  These are the recorded outcomes, and only the measured ones:
  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and the unit suites, and 1,070 .NET tests
    (Engine 747 with one measurement harness skipped, Desktop 225, LocalMcp 98). Eight new
    Workbench cases cover the composition and the drawing.
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored a trend of accepted
    axioms by month and an activity grid of a year of days over MCP alone, on the front page
    of the register. It read these results off the running app: twelve columns for twelve
    months, with eleven of them drawn empty; 365 squares for 365 days, with one toned; a
    grid of seven rows; a drill from a column into the month that it names; and both
    themes.

  **The guard was falsified twice, in two lanes.** The falsification made the fold answer
  only the buckets that the data touched, which is what a plain grouped read over a date
  does. The Engine tests failed with `Expected collection of size 6. Actual: 2` and
  `size 365. Actual: 1`. Then the gate failed in the running app with `The trend drew 1
  months, not the twelve its range covers (built): ["Sep 2026: 1"]`. The second failure is
  the useful one. A chart of one month with one record looks correct, and that is why the
  rule needed a measurement and not a screenshot.

  In one case the eye was wrong and the measurement settled it. In the first capture, the
  activity grid looked too wide to be seven rows. It is seven rows: the viewport cut off
  the card, and the card was drawn correctly. The gate now measures the row count, so the
  next person does not have to inspect it by eye.

  Keyboard and screen-reader behaviour is not instrumented here. Every column and square is
  a real button with a focus-visible outline and an `aria-label` that names its period and
  its number. The gate asserts those labels. Whether a screen reader reads the chart
  usefully remains owner-reported, as for S4.

- **S6, grids — accepted 2026-09-17.**
  The slice adds two kinds that state something that the existing surfaces cannot state:
  - `matrixSurface` crosses two stored choice dimensions (horizon against status, effort
    against value, the grid that people draw on a whiteboard). It states one exact number
    in every cell.
  - `rankedList` shows the few records at the top of one stored number. Each record has a
    bar against the exact largest, so a leaderboard reads as a shape and not as a column of
    digits.

  **A matrix is one read, not one read per cell.** [The plan](../design/surfaces-and-charts-plan.md)
  proposed a cell tile that spends the clauses of the surface plus two predicates of its
  own. That is a `summaryTile` per cell. A five-by-four grid is twenty reads that arrive
  four at a time, and the grid fills in like a slow page. Instead, the matrix is one
  grouped read. The host produces every cell key before it reads a row: the cross product
  of the option sets of the two fields, each with its unset key. It folds the record type
  once into those buckets, in the same way as S5 produces every date bucket before it
  reads. So:
  - A matrix costs one read, whether it has four cells or two hundred.
  - Every number in it is exact over the whole record type, not over the page in view.
  - **A cell with no records is still a cell**, for the same reason that an empty month is
    still a month.

  **A cell holds cards and states a number, and they are not the same quantity.** The cards
  are the one bounded window of the surface. The client places them as a board places
  them, in the order of the surface's own `orderByFieldId`. The number is exact over all
  records that the clauses of the surface cover. Because the cell has both, it can state
  what the column of a board cannot state without its own tile: *showing 4 of 17*. Where
  the two disagree, the window is partial. The cell states this, so a person does not
  assume that the four cards are all the records.

  **Rows and columns are the options, minus what the surface excludes.** This is the rule
  of the board, applied twice. An `eq` on an axis field leaves one value, and each `ne`
  removes one. No other operator is read, because a comparison or a null test over a
  choice says nothing definite about which options remain. A board that declares *status is
  not Done* and then draws an empty Done column tells a person that nothing is done. A
  matrix would tell them that in two dimensions. Every reachable option is drawn, even when
  it is empty, because a person arranged the option and its emptiness is the answer. The
  **unset** row and column are different. Nobody arranged them, so each is drawn only when
  its own exact number is not zero. That rule is better than the rule of the board, which
  decides from the loaded window. It is affordable only because the cell numbers are exact.

  **Every record is in exactly one cell.** A record with no value on one axis is in the
  unset lane of that axis. A record with no value on either axis is in the corner where the
  two unset lanes meet. A stored value that is not one of the options of the field stays a
  data issue, stated as the board states it. It is counted separately and never folded into
  a cell that nobody configured.

  **A ceiling that already exists bounds the size of a grid.** `MaximumAggregateGroups` is
  366. The cross product of the two axes, unset lanes included, must fit inside it. At
  nineteen options each, a matrix is at the limit. If the cross product of a definition is
  already over the limit, the definition is refused when it is authored. The diagnostic
  names both fields and their counts. If a definition grows over the limit later, it is
  refused **when it is read**. The surface then states that it cannot draw the grid and
  names the same two counts. This is necessary because the option sets change without an
  edit to the screen: a person who adds a twentieth option to a field has not edited the
  matrix. To draw part of a grid would be the one wrong answer, because a matrix without its
  last four columns looks exactly like a complete matrix.

  **The two axes must be different fields**, and the refusal names them. A field against
  itself is a diagonal with empty corners. It states nothing that a breakdown chart does not
  state better. For the same reason, a `breakdownChart` at group scope may not break down
  the grouping of its own board (`NUI352`). An axis is an active single-choice field or a
  Boolean. That is the grouping rule that the charts already use, and not a new rule. A
  calculated field cannot be an axis, as it cannot group or be totalled. This widens the
  *both single-choice* of the plan at no cost, because the fold already answers a Boolean
  grouping.

  **A cell drills with two predicates.** It opens the first list of the record type,
  narrowed to that cell. This is the second two-clause drill in the product, after the
  bucket of S5, and it is still F5 without change. It is transient and local to the file
  session. It is never written to the file, and it does not compose with the filters of the
  list itself. An unset lane drills with `isNull`, which is an operator in the existing closed
  set.

  **Moving a card between cells is not in this slice.** The drag on a board sets one field.
  The same gesture on a matrix sets two, and that is a different promise about what one
  movement writes. Cells are read-only here. A person changes both fields on the record
  page.

  **A ranked list is a tile, not a root surface.** This is the one place where the entry
  departs from the structure of the plan. There are three reasons:
  1. A whole screen of it would be a `recordList` with `orderByFieldId`, which exists. A
     ranking adds rank numerals and a bar. That is the presentation of a bounded window,
     which a `recentList` already is.
  2. A kind that is both a root and a child must carry the properties of a root in both
     positions, because the required-property set is per kind and not per position. So a
     front-page leaderboard would carry a `definitionVersion` that has no meaning there.
  3. The owner put the two charts of S5 on the front page of this planner within a day of
     accepting them. A leaderboard that cannot go there arrives one slice late.

  So it is accepted where a `recentList` is accepted: under an `overviewSurface` and under
  a `section` within one. It names its own `entityId`, and it is refused outside an
  overview.

  **What it ranks.** It ranks an active stored Integer or Decimal field. The refusal of a
  Date names it. This is the one place where a Date is refused and `rangeTile` accepts one.
  `min` and `max` over a Date are comparisons, and a bar is arithmetic: a bar proportional
  to a date is a bar proportional to nothing. A calculated field cannot be ranked, which is
  the standing rule.

  **A record with no number is not in the ranking.** The host adds an `isNotNull` predicate
  on the rank field. So a `rankedList` carries at most seven authored `filterClause`
  children, where a tile elsewhere carries eight. The refusal names the clause that the
  host adds. This is the rule of the trend, with one clause and not two. `limit` is one to
  fifty. It is declared on the node, and a value above fifty is refused, not clamped, as
  for the ten of a `recentList`.

  **The bar is against the exact largest**: one `max` over the same scope. So the top row
  fills its row, and every other row is a true proportion of it. When the largest is not
  greater than zero, **no bars are drawn**, and every row states its number. A proportion
  of a maximum that is not positive is a drawing of nothing, and negative numbers are
  ordinary in a Decimal field. When the maximum is absent, there is nothing to rank and the
  tile is empty.

  **Equal numbers share a numeral**, and the next numeral skips it. Two records with the
  same number are not first and second. The limit is a limit on rows, so the limit cuts a
  tie that crosses it: *the top ten by value* is ten rows, not every record tied at tenth.
  This entry states both rules, because otherwise people discover them in use.

  **What stays as it is.**
  - Every number is exact or absent.
  - The refusal of `avg` names it.
  - There is no join and no expression over a result.
  - An aggregate that cannot be represented reads *Unavailable*.
  - `entityId` is required under an overview and refused anywhere else.
  - The safe-mode fold answers the same cells as SQLite, because an answer that is exact in
    one and *Unavailable* in the other is two answers to one question.

  **Three named departures from the plan.** They are collected here so that acceptance of
  this entry does not accept them by accident. The owner can strike any one of them:
  - The matrix is one grouped read, not a tile per cell.
  - An axis may be a Boolean as well as a single choice.
  - `rankedList` is an overview tile, not a root surface.

  **What this slice does not do.**
  - No matrix on the front page. It is a screen, and a 366-cell read under a page of other
    reads is not a tile.
  - No `scope: cell`. This structure removes the need for it.
  - No drag between cells.
  - No order of an axis other than the configured option order of the field.
  - The Reading Log is still not built. It is the fourth reference application that the
    plan asks for to prove S4 through S6. S6 proves itself on the agent-authoring gate over
    the Axiom Register, which gains the second choice field that S7 will need anyway. It
    also proves itself on this planner, where the matrix is work by horizon against status
    and the ranking is work by value.

  **Minimum host 1.26.0.** Both kinds take one rung, as S4 gave one rung to three kinds.
  The plan proposes the same number, and the next rung of the ladder is free, so nothing is
  corrected here.

  **Delivery obligations.** All twelve items of the F4 checklist apply, for each kind. This
  entry is not closed until they are present. The recorded outcomes follow the acceptance
  below.

  **The owner accepted these rules on 2026-09-17.** The acceptance includes all three
  departures from the plan. Each was put to the owner by name, with the alternative that it
  replaces. The slice was delivered the same day.

  These are the recorded outcomes, and only the measured ones:
  - `Test-Production.ps1` passed. It covered the repository gate, the production
    boundaries, the Workbench check, build and the unit suites, and 1,095 .NET tests
    (Engine 772 with one measurement harness skipped, Desktop 225, LocalMcp 98), beside 206
    Workbench cases.
  - `Test-AgentAuthoringGate.ps1` passed both phases. It authored the matrix and the
    ranking over MCP alone as their own proposal, because the screens of the register
    already fill a change set to its 128-operation ceiling. It read these results off the
    running app: nine cells, with six of them drawn empty; three lanes on each axis, with
    the unset column present and the unset row absent; a cell that drilled by its two
    predicates into the one record that it counts; a ranking of one row out of three
    records; and both themes.

  **The main rule was falsified in both lanes, and the second attempt is the important
  record.** The falsification made the fold answer only the cells that the data touched. The
  Engine tests failed with `Assert.HasCount failed. Expected collection of size 12. Actual:
  2`. With the same defect in place, the gate **passed**. That result is a warning signal,
  not a reassurance. The grid draws its lanes from the definition and takes each number from
  the read, and the renderer printed a missing number as `0`. So nine cells were still
  drawn, and six of them stated a count that the file had never given. A cell that nobody
  answered now reads as absent, not as zero, which is better behaviour in its own right.
  The gate then failed against the restored defect with `Every cell names its own number and
  both lanes to a screen reader: ["No number for Draft and
  Storage", …]`. A guard that passes against its own defect guards nothing.

  **The gate and the unit tests found two defects that a type checker could not find:**
  - Every exact number reaches the renderer in a `$nendoNumber` envelope, but the ranking
    read the stored value directly. Every bar was drawn at zero width against a maximum
    that was read correctly. That looks exactly like a ranking of records that all hold
    nothing (`The top row's bar is 0 of a 657 track; it holds the largest value`).
  - A tile composes the clauses of its scope with its own clauses, but a matrix *is* its
    own scope. So the first version charged every authored clause twice against the budget
    of eight. At read time, it would have refused a grid that the compiler had accepted.

  **Beside the slice, a lane that was not running.** The eight Workbench cases that S5
  recorded were never added to `npm test`. So they had not run in any lane since that slice
  landed. They are in it now and they pass, and the count above includes them. The claim of
  the S5 entry that they covered the composition and the drawing was true of the cases and
  not of the lane.

  Keyboard and screen-reader behaviour is not instrumented here. Every cell total and ranked
  row is a real button with an accessible name that carries its number and its lanes. The
  gate asserts those names. What a screen reader makes of a grid stays owner-reported, as
  for S4 and S5.

- **S7, a board grouped by a reference — accepted 2026-09-17.**
  This is B5 of [the plan](../design/surfaces-and-charts-plan.md).
  `boardSurface.groupByFieldId` is widened to accept a bound Reference field, so a board can
  have a lane per project, per person or per client. There is no new node kind, no new
  property, and no change to what a board *does*. Only the source of its columns changes.

  **The columns are records, and all of this slice follows from that.** The buckets of S5
  came from a resolved range, and the cells of S6 from the cross product of two option sets.
  Both were known before a record was read: a month is arithmetic, and the options of a field
  are written in the definition. The columns of a reference board are rows of another record
  type. People create and delete them while the board is open, under a definition that
  nobody edited. So the board must read them, and every rule below follows from the fact
  that the columns are data.

  **Every active record of the target type is a column.** The columns are in ascending
  order of the configured label field of the reference, which is the order in which the
  reference picker already reads them. The columns are not "only the records something
  points at". There are three reasons, and the third decides it:
  1. An empty lane is an answer. S6 settled that an empty cell is a cell, and S5 that an
     empty month is a month. A project to which nobody has assigned work is exactly what a
     board must show as empty and not hide.
  2. A column that appeared and disappeared as data changed would make the layout of the
     board depend on which records loaded.
  3. The referenced-only set cannot be computed exactly. It would have to come from the
     loaded window of the board, which is fifty records. So "the projects in use" would
     mean "the projects in use on this page". S6 refused that mistake when it stopped
     deciding the unset lane from the loaded window.

  **A column order that nobody chose is stated and not assumed.** The options of a choice
  field carry the order that their author arranged. A record type has no such order. So the
  columns are in ascending label order, and nothing more. `orderDirection` on the board
  continues to order the *cards* inside a lane, as it does today, and never the lanes.
  Ungrouped stays first, where the board already puts it.

  **The ceiling is one-sided, and this is the named departure from the S6 precedent.** S6
  refuses a grid at authoring time if the cross product is already too large. It states the
  problem at read time if the option sets grew. A reference board gets only the second half,
  because there is nothing to refuse at authoring time. A definition cannot know how many
  records a record type holds, and the compiler validates against the schema, not against
  data. So the ceiling is a read-time rule. The property note carries the number, so that
  an author meets it before building and not after.

  **The board refuses the whole grid or draws all of it.** The board reads the target type
  one page longer than the ceiling to find out. So no new aggregate and no count read is
  necessary. Over the ceiling, the surface draws no columns and states that it cannot. It
  states the target type, the number of records in it, and the bound. To draw the first two
  dozen lanes would be the one wrong answer, for the reason that S6 gives about a partial
  grid: a board without its last lanes looks exactly like a complete board. This rule also
  keeps a second promise at low cost. Either every target is a column or there are no
  columns, so no card can point at a column that the board did not draw.

  **The number is twenty-four, and it is the one adjustable value in this entry.** A board
  loads one window of fifty records and places them on the client. So twenty-four lanes
  average two cards per lane, and forty average one. Past that, the board states nothing
  that a filtered list does not state better, and the horizontal scroll becomes the
  interface in place of the board. Twenty-four is where those two arguments meet. It covers
  the examples of the plan with margin: a team, or a client list that is a real client
  list. If the owner strikes it for twelve or for thirty-two, nothing else here changes.

  **Reference columns take the hue that an untoned option takes.** A tone is on a choice
  option because somebody arranged it there. A record has no place for one, and this slice
  adds no place. The renderer already has a behaviour for a value that nobody coloured: a
  hue derived from the stored value, stable per value and shared by every surface. A
  reference column takes that hue without change. So the column dot and the accent dot on a
  list keep working, the file stores no tone, and no new rule is written. A palette for
  referenced records is a separate idea and not a consequence of this one.

  **A person can drag a card between reference columns, and the drag carries the version of
  the target.** This is the second real decision. The drag on a board writes one field and
  will still write one field, so the promise of the gesture does not change. But the Engine
  refuses a reference write without the current version of the target record
  (`target-version-required`), and a choice literal needs no version. The board already
  holds those versions, because it read the target type to build its columns. So the drag
  carries the version of the column on which it lands. If the target changed after the
  board loaded, the write is refused (`target-version-conflict`). The board then states
  this in its own words and reloads its columns. It does not pass on a message about
  selecting a record again, because a board has no picker in which to select it. The
  alternative was read-only reference boards. That option is smaller, and the owner can
  choose it. It is not recommended, because a board whose cards cannot move is a list in
  columns.

  **Unset is the column that the board already has.** A record with no reference is
  Ungrouped, drawn by the existing rule, and a drag into it clears the field as it does now.
  **A target that is not there** cannot be reached through any path that the host offers.
  The host already refuses to delete a record that something points at, and the refusal
  names it (`record-referenced`, which lists the referring records). So the board keeps the
  statement that it already makes about a value that matches no column, worded for a
  reference. This entry makes no promise that a dangling target can occur.

  **The rung is the part of this that the tree cannot see.** A board grouped by a reference
  has the same structure as a board grouped by a choice: the same kind, the same
  `groupByFieldId`, the same children. The capability ladder reads the stored node tree and
  nothing else, so it would return 1.26.0 for a file that needs 1.27.0. A host at 1.26.0, if
  one existed, would open the file and refuse the board (*the board needs an active bounded
  choice field*). One refused surface makes the whole definition invalid. So that host would
  report that *a custom surface cannot run safely* over every authored screen in the file,
  and name none of them.

  **The answer of the owner to that is recorded here, because it is a standing decision and
  not only an answer about S7: there is no older host.** Nendo is in rapid development.
  Nothing is installed anywhere except on the machines on which it is built, and the ladder
  can change as the product needs. So the migration argument above is not the reason why the
  ladder moves. It moves because the only job of the ladder is to say what a file needs. A
  ladder that returns a number that it can see is wrong does not do that job. The same reason
  makes an unanswered cell read as absent and not as zero (S6, F-049). A rung that nobody
  would currently trip is still a rung that tells the truth.

  So the ladder reads the field, not only the node. `RequiredHostVersion` takes the entity
  fields beside the nodes. This feature is present when a `boardSurface` groups by a field
  whose storage kind is Reference. The recompute already runs at the correct moment. The only
  way for a board to group by a reference is a UI operation that sets `groupByFieldId` or adds
  the board, because no conversion turns a choice field into a reference field. So nothing
  new has to trigger it. The inspection path that reports the mismatch already has the
  entities. This is a small widening of a stated rule (F4's *computed from the tree's
  shape*), and this entry states it and does not make it silently. The schema already raises
  rungs through the other channel: a rating presentation and a choice tone reach their rungs
  through their own field operations.

  **Delivery owes a falsification of this rule, sized to the reason above.** The guard is
  that a definition whose board groups by a Reference field requires 1.27.0. It must be seen
  to fail against a ladder that reads only the tree. A 1.26.0 host to open the file with is
  not owed, because no such host exists to protect.

  **An unbound Reference field is refused when it is authored.** A reference with no target
  type and no label field has no columns and nothing to put in a heading. To bind it is a
  separate reviewed proposal. That is the authoring-time half of the validation of this
  slice. The diagnostic names the field and what is missing, and does not repeat the
  choice-field diagnostic.

  **What stays as it is.**
  - The exact number of a column still comes from a `summaryTile` at group scope, composed
    as it is today: the clauses of the board, the clauses of the tile itself, and the column
    predicate. So a reference board spends no new filter budget, and the ceiling of eight
    does not change.
  - The count under a heading is still the count of the loaded window, and still states
    this.
  - The board is still one bounded window placed on the client.
  - Drill-through, F5, does not change.
  - Retired options have no equivalent, and no rule is invented for one.

  **What this slice does not do.**
  - No second reference axis, and no matrix grouped by a reference. The cells of the matrix
    come from one grouped read whose keys the definition closes. To open that to data is a
    different piece of work, with the 366 ceiling in it.
  - No grouped aggregate over a reference field, for the same reason.
  - No tone on a referenced record.
  - No order of columns by anything except the label.
  - No board on the front page: a board is a screen.

  **Minimum host 1.27.0.** That is the rung that the plan proposes, and the next free rung.

  **The owner accepted these rules on 2026-09-17**, in full and with no strikes:
  - the columns are every record of the target type;
  - the one-sided ceiling;
  - twenty-four as its number;
  - the untoned hue;
  - the drag carries the version of the target;
  - the ladder reads the field.

  The owner added the standing decision recorded above: there is no older host, and the
  ladder may change as the product needs.

  **Delivery obligations.** All twelve items of the F4 checklist apply. The slice proves
  itself on the agent-authoring gate over the Axiom Register. The register already has
  `axiom-remit`, which points at the Remit record type and is labelled by its name. So the
  step is a board grouped by that field, with Remits as its lanes. The lanes include one
  Remit that no axiom points at, drawn empty, because this entry turns on that rule. The gate
  drives the drag with a real pointer: `element.click()` dispatches no `pointerdown`, and
  without a real pointer, four gate steps in three days passed against restored defects.

  *(Note 2026-09-22: no outcomes were recorded in this entry. The slice is in the code,
  and later entries build on 1.27.0. The rung is `ReferenceBoardMinimumHostVersion` in
  `src/Nendo.Engine/NendoFormat.cs`. The Engine tests are in
  `tests/Nendo.Engine.Tests/ReferenceBoardTests.cs`, and the gate step is the reference
  board in `tools/Gate-AgentAuthoring.mjs`. The contract section "A board grouped by a
  reference" describes the delivered behaviour.)*

### Accepted amendment — 2026-09-12 (widening the semantic vocabulary)

The owner accepted this amendment on 2026-09-12. It authorizes the following bounded
additions within contract version 3. The rules below are the architecture authority. The
delivered behaviour and its diagnostics are in
[the semantic surfaces contract](../contracts/semantic-surfaces.md). The disposable
implementation plan that sequenced the slices is retired.

**Admission rule.** A kind or property must have an explicit owner-facing semantic diff
that describes its effect on records. It must have an explicit path in both Use and the
read-only proposal preview. Geometry alone is not application meaning. Every allowed
visible node must be reachable. Unknown nodes must never fall through to another
presentation or disappear. Filters and command steps contribute to the meaning of their
parent. They do not require standalone controls.

**Accepted vocabulary and behavior:**

- `summaryTile` may be a child of `recordList` and `boardSurface`. Its optional `scope`
  is closed to `surface` (default) and `group`. `group` is legal only on a direct board
  child. Surface totals apply root filters AND tile filters over the entire matching set,
  independent of the loaded record page. Group totals also apply the stored choice ID, or
  `isNull` for the ungrouped column. Invalid non-null choice data must not be counted as
  null. Existing page and relation tile meanings do not change. Exact aggregates, numeric
  lexemes, empty numeric sets and the named refusal of `avg` remain as previously
  accepted.
- `recordList`, `boardSurface`, `calendarSurface` and `recordCommand` may each have eight
  roots per entity. This is an initial bounded product choice, not a measured optimum.
  Existing nested commands remain supported. `detailSurface` and `recordForm` keep one
  root each and their existing page precedence: detail first, otherwise form.
- Use selects a stable surface ID per entity, in compiled root order. It does not select
  only a kind. Its default is the first eligible root. If the selected root is missing,
  Use falls back and does not erase the remembered choice. Selection is file-session-local
  renderer state, never stored application meaning. Each surface owns its query/window.
  Studio keeps its independent browsing state.
- `tabGroup` is non-root. It has an optional title and contains only one or more titled
  `section` children. It is allowed beneath `detailSurface`, `recordForm` and `section`.
  Nested tab groups, including nesting through sections, are refused. Fields, related
  lists and tiles keep their authored positions within tabs. A tab change preserves the
  record draft. Validation activates and focuses a hidden invalid field. A save remains
  one typed record mutation against its expected version. Tab selection is transient,
  keyboard-accessible host state. This does not add commands to the section child
  vocabulary.
- `calendarSurface` is a root with `definitionVersion`, `entityId`, required
  `dateFieldId`, optional `title`, and the existing ordering properties. Its children are
  `fieldBinding` and `filterClause`. The bound field must be an active Date field.
  DateTime is refused in this slice. A Monday-first month view groups civil dates without
  UTC conversion. It offers previous/next month and Today, and it has a separate bounded
  undated view. Month queries use an inclusive start and an exclusive next-month bound.
  The default order is date ascending, with the existing stable record-ID tie-break. The
  declared order governs the entries per day. Cursor pages accumulate with an explicit
  partial/complete state and Load more. A first page must never look like a complete
  month. Entries open the existing record page or Studio inspector. Date changes use the
  existing typed forms.

**Bounded query composition.** Keep the existing maximum of eight effective filters.
Publish contextual constraints alongside the vocabulary. Refuse an over-budget definition
before it can be accepted. Count inherited root/tile clauses and implicit predicates:

- one for a board group or a related-record reference;
- two for a calendar month (at most six authored calendar clauses).

Do not drop predicates or widen a query to meet the limit. Pagination keeps the original
query snapshot. Query/revision changes invalidate cursors. Stale responses after file or
surface changes cannot replace current state. Failed reads have visible retry states,
never an unfiltered fallback.

**Compatibility.** Preserve the version-3 tree, and gate new capabilities through
increasing minimum host versions. The assigned ladder is:

- `1.12.0` list/board tiles and `scope`;
- `1.13.0` several command roots;
- `1.14.0` several list/board roots;
- `1.15.0` named tabs;
- `1.16.0` the Date calendar;
- `1.18.0` a `fieldBinding` or `section` that carries `visibleWhen`.

*(Note 2026-09-22: this ladder has no `1.17.0` rung. `1.17.0` went to stored behaviour
definitions under ADR-0008 (`BehaviourMinimumHostVersion` in
`src/Nendo.Engine/NendoFormat.cs`). That rung is not a shape of the node tree.)*

Intermediate hosts must not advertise later features.

A central Engine calculation over the resulting definition must cover additions, property
changes and moves. This includes changes to existing roots that never set
`definitionVersion` again. Apply the calculation at the completed mutation boundary. Use it
in canonical evidence/promotion and inspection. An ordinary existing definition keeps its
minimum. Removal of a capability never lowers it. Open does not rewrite a file. Preview
names a minimum-host raise as irreversible. Rejection leaves the active file unchanged, and
promotion remains operation replay. Product release version and semantic contract version
remain separate concepts.

**Why this remains declarative.** This amendment resolves the earlier grouping revisit
trigger for one bounded case: the single stored choice field of an existing board adds one
equality/null predicate to an exact aggregate. It did not authorize a grouping query
language, cross-entity joins or dashboards. The 2026-09-14 amendment above admits charts and
the overview page under its own bounds, and nothing else here moves. Tabs name
record-information sections. Calendars project a stored Date and a bounded record set.
Neither stores arbitrary layout, expressions, components or executable logic.

Rejected alternatives:

- arbitrary custom surfaces;
- unbounded roots;
- direct mixed children or recursive tab groups;
- inferred tile scope;
- client-side sample totals presented as exact;
- DateTime scheduling without a time-zone contract.

DateTime, recurrence, durations and drag-to-date remain outside this amendment. P7
scripting and extensions still require their own accepted decisions. All existing
authority, storage, lineage, reversibility, permanent Studio and safe-mode invariants
remain.

**Delivery obligations and evidence.** Publish a vocabulary addition only together with its
compiler, diff, Use and preview support. Preview uses the validated clone and labels
bounded samples. It cannot read active-file totals or acquire write handlers. Keep agent
examples and contextual diagnostics aligned. Qualify these behaviours:

- filter boundaries and cardinality;
- exact totals and independent windows;
- stale-response rejection;
- tab draft preservation and calendar completeness;
- both themes and keyboard behavior;
- typed proposal reject/accept/reopen;
- older-host refusal.

Follow the repository build, runtime and installer gates. Distinguish automated checks from
owner-reported usability.

**Delivered 2026-09-12.** Every slice of this amendment landed together with the
declared-query pagination repair, which remains an independent correctness fix. These are
the recorded outcomes, and only the measured ones:

- `pwsh ./tools/Test-Production.ps1` passed. It included the repository gate, the
  application- and client-neutrality boundaries, the Workbench dependency boundary,
  `npm run check`, `npm run build` and 676 .NET tests (Engine 456, Desktop 139, LocalMcp
  81).
- `npm test` in `src/Nendo.Workbench` passed 57 cases. These include new pure suites for
  the window query snapshot, tile scopes, the calendar model and the widened preview
  branches.
- `pwsh ./tools/Test-AgentAuthoringGate.ps1` passed both its build and reopen phases. It
  authors the whole widened vocabulary from an empty file over MCP alone. It reviews and
  accepts each change set in the Workbench. Then it drives the running application: the
  surface selector that names four roots, a surface total and per-column totals, a second
  list with its own filter, the Monday-first month grid and the undated view, and a tab
  change that preserves an unsaved value. It also counts requests around a surface change:
  exactly one `data.queryRecords`, no history, agent-status or compile refetch, and no read
  when the person returns to a surface already loaded in this revision. A scripted click
  proves that the review surface works. It is not owner review.
- `pwsh ./tools/Test-JourneyDrag.ps1` and `pwsh ./tools/Review-NeutralityRuntime.ps1`
  passed, both create and reopen phases, with Light and Dark evidence.
- `pwsh ./tools/Review-OutcomeRuntime.ps1` **fails**. It was measured to fail in the same
  way on the unmodified parent commit, so it is not a regression from this work. Two
  missing navigation waits in the lane script were repaired. The lane now reaches its
  board-rename scenario and times out while it waits for that proposal. This is recorded
  as a pre-existing lane limitation in the roadmap.
- The installer was not rebuilt, and no packaging lane was run in this change.
  Owner-reported usability was not collected.

### Accepted amendment — 2026-09-12 (contract versions 1 and 2 removed)

The owner accepted this amendment on 2026-09-12. It removes contract versions 1 and 2 from
the host. Contract version 3 is the only shape that a Nendo host compiles.

**Why now.** The compatibility clauses below were written for files in distribution. There
are none. Nendo was never distributed, and the only `.nendo` files that exist belong to the
maintainer, who asked for the removal. Three compile paths, three digest projections and a
slot-shaped render plan beside the node tree paid a compatibility cost for a population of
zero. That cost was not zero. The renderer read the version 1 and 2 slots and silently
rendered a version 3 board as a list, because the slot that it read was null and nothing
reported it.

- **One compile path.** `CompileOptionalApplications` and the version 1 compiler are
  removed. `Compile` validates the node tree or returns nothing.
- **One plan shape.** `NendoRenderPlan`, `NendoFormPlan`, `NendoListPlan`,
  `NendoBoardPlan` and `NendoCommandPlan` are removed, and with them
  `NendoCompileResult.Plan` and `NendoProposalPreview.PreviewPlan`. The surfaces of an
  entity are `NendoApplicationPlan.Surfaces`, an ordered tree, and nothing else.
- **One digest projection.** The version 1 byte-frozen projection and the version 2
  projection are removed. Only the composable projection remains.
- **`cardFieldIds` is removed.** Version 3 already took board card fields from ordered
  `fieldBinding` children. The parallel property is removed from the vocabulary, the diff
  summariser and every fixture.
- **An older definition fails closed, and the file still opens.** `NUI003` refuses a
  stored root that declares `definitionVersion` 1 or 2. The diagnostic names the supported
  version and states that the earlier ones were removed. Every custom plan is suppressed.
  Studio, the data and recovery are not affected. This is the existing fail-closed path,
  not a new rejected-open state.
- **The MCP surfaces resource drops its slots.** `nendo://application/surfaces` no longer
  carries top-level `form`/`list`/`board`/`command`. `applications[]` describes each
  entity through `surfaces` alone.
- **The built-in Idea Garden is authored at version 3.** So a new reference application
  raises `minimumHostVersion` to the composable version, not to the lifecycle version.

This amendment does not change the vocabulary of version 3, the fail-closed rules, the
digest-as-compile-time-identity rule, promotion by canonical operation replay, or
permanent Studio access. Nothing here authorises scripting or expressions, which remain
the scope of ADR-0008.

Rejected alternative: keep the version 1 and 2 compile paths behind a capability flag.
That keeps the cost that this amendment removes. It also keeps the slot-shaped plan that
hid the board defect, for the benefit of files that do not exist.

### Accepted amendment — 2026-09-10 (exact numeric aggregates on `summaryTile`)

The owner accepted this amendment on 2026-09-10. It widens the `summaryTile` aggregate
set within contract version 3. It introduces no node kind, changes no existing plan shape
and weakens no fail-closed rule.

**What it corrects.** The P6 closure refused `sum`, `avg`, `min` and `max` on the recorded
ground that "a Decimal column has SQLite NUMERIC affinity and is float-backed, so a SQL SUM
would not be exact." That premise is wrong for files that this host writes. A Decimal is
stored as the exact text `nendo.decimal:<invariant lexeme>`, which NUMERIC affinity cannot
coerce. So it lands as TEXT with every digit intact: `typeof()` reports `text`, and
`ADecimalColumnStoresExactTextRatherThanAFloat` asserts it. The conclusion survives the
correction and becomes stronger. SQLite must not aggregate that column, because `SUM` would
coerce each non-numeric string to zero and return a confident wrong answer. The claim that
exactness was unreachable does not survive.

- **Accepted: `sum`, `min` and `max`** over one Integer or Decimal field. A new optional
  `fieldId` property on `summaryTile` names the field. The host folds the stored lexemes
  itself, one streamed row at a time, so the result is exact and memory is constant. A sum
  accumulates as a scaled integer, so a total may exceed the magnitude of any single value
  without loss.
- **`count` does not change.** It still takes no field. A `fieldId` declared beside
  `count` is a diagnostic, not an ignored property.
- **Refused by name: `avg`.** The mean of exact decimals is not generally an exact
  decimal: three values that sum to 1 have no exact mean. So acceptance would put one
  rounded number on a page of exact numbers. The vocabulary description publishes it as a
  named refusal *with its reason*. So an authoring client learns the reason and does not
  have to infer it from an absence. An average that is exact enough needs its own amendment
  that declares a scale and a rounding rule.
- **Legacy files fail closed.** A pre-P5 file can hold a REAL value in a decimal
  column. An aggregate over one is refused with `aggregate-not-exact`. The host does not
  return a number that looks exact and is not.
- **Exactness on the wire.** The result carries `valueLexeme`, the exact numeric string,
  beside the JSON number. This matches `numericLexemes` on the records resource. A client
  that parses the number as a float loses digits and trailing zeros. The Workbench renders
  the lexeme.
- **An empty set is stated, never zero.** Zero is a real sum. So a set that contributed no
  value returns null, and the tile states this.

Diagnostics:

- `NUI291` unknown aggregate;
- `NUI292` refused by name with its reason;
- `NUI293` numeric aggregate with no field;
- `NUI294` unknown, retired or non-numeric field;
- `NUI295` `fieldId` declared beside `count`.

### Accepted amendment — 2026-09-09 (contract version 3: composable surfaces)

The owner accepted this amendment on 2026-09-09. It authorizes the implementation of
contract version 3. The evidence is
EX-0010,
which passed its three bounded lanes the same day. Governing plan:
P6 — Composable surfaces. That plan was a disposable document and is retired. The
delivered system is described in [Semantic surfaces](../architecture.md#semantic-surfaces).
Confidence is Medium. Production compiler, adapter, renderer and qualification obligations
remain, and acceptance of the contract is not a delivery claim. This amendment widens the
closed vocabulary and the plan shape. It does not weaken any fail-closed rule below, and the
version 1 and version 2 clauses remain in force for existing files.

The recorded negative of this ADR now applies: a bounded vocabulary cannot express
arbitrary applications. There are five node kinds, a two-level tree, four fixed plan slots
per entity and a single string-valued `setField` effect. So every agent-authored application
is isomorphic to the Idea Garden reference.

- **Open plan shape.** Replace the fixed `Form`/`List`/`Board`/`Command` slots with an
  ordered tree of typed nodes. A new surface kind becomes a vocabulary entry, not a new
  field on the plan record.
- **Per-kind child allow-list.** An explicit table of permitted children per kind replaces
  the hard-coded rule that only `fieldBinding` may have a parent. That table bounds the
  depth; no constant bounds it. Unknown kinds, unknown properties, illegal parenting,
  orphans, parent cycles and duplicate roots all fail closed with a code, `semanticId` and
  `propertyPath`. They produce no partial render plan.
- **Version 3 node kinds.** `recordForm`, `recordList`, `boardSurface`, `fieldBinding` and
  `recordCommand` are kept. These kinds are added:
  - `detailSurface` (a single-record page);
  - `section` (a titled group with no binding);
  - `relatedList` (records of another entity that reference this one, addressed by
    `targetEntityId` and the `viaFieldId` that points back);
  - `commandStep`;
  - `summaryTile`;
  - `filterClause`.
- **Board card fields.** Version 3 takes card fields from ordered `fieldBinding` children
  only. The parallel `cardFieldIds` property is kept for versions 1 and 2 and is not carried
  forward. The same list held twice is the source of the recorded diff-summary defect that
  names non-existent fields.
- **Commands that can act.** An entity may declare more than one command. A command owns
  ordered `commandStep` children, applied as one atomic mutation against one expected record
  version. Effects remain a closed set.
- **Closed value vocabulary,** shared by `commandStep` and `filterClause`:
  - `literal`, typed to the storage kind of the target field, with the existing
    `$nendoNumber` envelope for Integer and Decimal;
  - `today`;
  - `now`;
  - `null`.

  A value that does not match the storage kind of its field is a diagnostic, never a host
  fault.
- **Declared filter and sort.** `filterClause` children are ANDed. The operators are the
  closed set `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `isNull`, `isNotNull`. Ordering is
  `orderByFieldId` with `orderDirection`. There is no expression language and no free-text
  search operator.
- **Bounded aggregates.** `summaryTile` declares one of `count`, `sum`, `min`, `max`, `avg`
  over one field of a filtered set. `sum` and `avg` require Integer or Decimal and use exact
  decimal arithmetic. This is a number, not a chart.
  *(Superseded in part by the 2026-09-10 amendment: the host refuses `avg` by name,
  with `NUI292`.)*
- **Digest rule.** Every contract version hashes an explicit payload projection, never the
  plan record itself. The version 1 projection stays byte-frozen. Version 2 moves to an
  explicit projection, which changes its digest value once. That is safe because the
  render-plan digest is a compile-time identity. It is never persisted, never an authority
  token, and never checked by promotion, which uses the canonical operation digest. The
  required properties are relational:
  - stable;
  - insensitive to meaningless ordering;
  - sensitive to every semantic change, including a node move;
  - non-colliding across contract versions, because the version is inside the payload.
- **Self-describing vocabulary.** The permitted-kind, permitted-property, permitted-child,
  operator, value-kind and aggregate tables are emitted as a machine-readable description.
  It is generated from the same tables against which the compiler validates. So an
  authoring client is not required to discover the contract by probing.
- **Compatibility.** Version 1 and version 2 files open and compile unchanged. They are
  never upgraded or rewritten on open. Mixed versions across present roots continue to fail
  closed. Version 3 raises `minimumHostVersion` through its explicit typed definition
  operation. Old-host refusal requires qualification before release.
  *(Superseded by the 2026-09-12 amendment: versions 1 and 2 are removed and now
  fail closed with `NUI003`.)*

This amendment does not authorise:

- general scripting or expressions;
- computed or derived stored fields;
- arbitrary markup, CSS or renderer state in the file;
- charts and dashboards (admitted later by the 2026-09-14 amendment);
- third-party controls;
- scalar multi-choice;
- binary or asset fields;
- cross-entity writes from a command;
- a new persistence provider;
- any storage-schema change.

In particular, EX-0010 lane C recommended a covering index on reference columns. That index
is an ADR-0003 matter and requires its own note. This amendment does not grant it.

Rejected alternatives:

- Keep the fixed slots and add one plan field per new kind. That makes every vocabulary
  addition a structural change.
- Store a free-form definition document. That reintroduces the general extension problem
  and destroys operation-level diff and promotion.
- An expression language for filters and derived values. That is deferred to ADR-0008,
  with its own value and isolation evidence.

Revisit triggers:

- A required surface still cannot be expressed without renderer state. The extension model
  would then be the answer, not the vocabulary.
- Filtering needs exceed the closed operator set.
- Aggregates need grouping or cross-entity joins.

Nendo needs stored forms, lists and boards that survive renderer replacement and that can be
inspected, diffed and authored through typed operations. Persisted React, AG Grid, HTML,
CSS or other renderer configuration would turn an implementation choice into the file
format and create an authority escape hatch.

## Decision drivers

1. Renderer-independent durable definitions.
2. Stable semantic targets for authoring, accessibility and automation.
3. Deterministic validation, compilation and diagnostics.
4. Operation-level diff, history, proposal and promotion behavior.
5. No arbitrary code, markup, style or privileged host invocation.
6. Safe failure that preserves permanent Studio access.

## Options considered

### Strict semantic tree compiled to a host-neutral render plan

Store stable typed nodes/bindings. Compile them through a versioned closed vocabulary
before any renderer sees them.

### Persist renderer configuration

Store component names and configuration for React, AG Grid or another toolkit. This is
expedient, but it couples the file to a replaceable adapter.

### Store arbitrary markup or scripts

Allow HTML/CSS/JavaScript or generic control trees. This expands the MVP into an executable
extension platform and weakens deterministic validation.

## Decision

Nendo stores versioned semantic UI definitions and compiles them into an immutable
host-neutral render plan.

- Format version 1 supports bounded record forms, lists, simple grouped boards, field
  bindings and named declarative command effects.
- Every definition and node has a stable semantic ID. Parent, position, binding and
  supported typed properties are explicit.
- The canonical UI mutation primitives are typed operations such as `ui.addNode`,
  `ui.setProperty`, `ui.moveNode` and `ui.removeNode`.
- Whole-definition convenience input must validate and expand into canonical operations
  before diff, history, proposal or promotion.
- The compiler validates contract version, tree/identity integrity, supported properties,
  schema references, bindings, command effects and relevant record warnings. A core error
  produces no partial render plan.
- Unknown nodes, properties, command effects or incompatible versions fail closed with
  actionable diagnostics and permanent Studio/safe-mode access.
- Definitions cannot contain renderer components/configuration, HTML, CSS, XAML,
  JavaScript, arbitrary controls, SQL, paths or generic host calls.
- Render adapters derive stable accessibility/automation targets from semantic IDs. React
  and AG Grid configuration remains transient adapter state.
- Declarative commands may invoke only a small named effect vocabulary through typed
  application services. General scripting is outside the MVP.
- Agent-authored definition changes use the application proposal lane in ADR-0007.

## Evidence and validation obligations

The 2026-09-05 review requalifies empty/schema-only Studio: zero custom nodes produce no
plan and no malformed-UI diagnostic. Schema-only proposals may validate independently of
custom UI. Present definitions still require the current complete form/list/board/command
set. Optional individual roots and multiple custom application plans remain explicit
product/contract obligations in the separate P5 plan.

- EX-0002 compiled the Idea Garden form and five-group board deterministically, rejected
  arbitrary properties/effects and rendered stable browser targets.
- EX-0003 rendered the same typed semantic snapshot through all containing candidates and
  kept recovery after renderer failure.
- EX-0005 exercised bounded `ui.setProperty` proposal authoring through MCP.
- Production must add complete form/list/board adapter tests, version fixtures,
  invalid-definition safe-mode tests and typed persistence round trips.
- Accessibility and visual behavior remain obligations of the chosen adapter. A valid
  semantic plan is not by itself a usable UI result.

## Consequences

P5-C implementation evidence is recorded in the
optional surfaces checkpoint.
Its explicit version-2 extension permits optional roots and multiple entity plans within
this closed vocabulary. It does not authorize scripts or arbitrary renderer state. Recorded
tests do not replace the remaining adapter/release gates.
*(Note 2026-09-22: the 2026-09-12 amendment removed contract versions 1 and 2. Contract
version 3 is the only shape that a host compiles. It keeps optional roots and several
roots per record type.)*

### Positive

- Durable definitions survive UI-library changes.
- One operation stream can drive authoring, diff, history and promotion.
- Invalid or future definitions fail without making data inaccessible.

### Negative

- The bounded vocabulary cannot express arbitrary applications.
- New semantic capabilities require contract/version work and adapter support.
- Renderer-specific features cannot simply be serialized into the file.

## Rejected alternatives

Renderer configuration and arbitrary markup/scripts are rejected. They couple persistence to
replaceable technology, and they silently reintroduce the general extension problem that
the MVP defers.

## Revisit triggers

- A required MVP surface cannot be represented without renderer-specific state.
- Contract versioning or migration becomes impractical.
- Post-MVP scripting or third-party controls receive a separately accepted
  capability/isolation decision.
