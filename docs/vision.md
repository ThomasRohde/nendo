# Vision — malleable software

## The problem

AI can generate a small application in minutes. Each one becomes another silo:
the data is coupled to disposable code, every change means regeneration, and the
user has no visibility into schema migration, history or recovery. When the
generated code stops working, the data goes with it.

Low-code platforms solve the reuse problem by owning the runtime, but they
require a hosted platform and proprietary storage. They are not a durable local
file you can copy, inspect and reopen offline in ten years.

## The proposition

Software should behave like structured clay. One portable SQLite file — the
`.nendo` file — holds durable identity, schema, data, application meaning and
history. People and coding agents reshape it in place through typed semantic
operations. No generated project, no build step, no regeneration.

The name is the thesis: *nendo* (粘土) is Japanese for clay.

- The file keeps identity, schema, data and application meaning.
- The installed host supplies a reliable human database Studio, always.
- Humans and agents reshape the application through the same typed services.
- Common changes require no generated project and no build.
- Shape changes are previewed on a physical clone and promoted by replaying
  validated operations against the active file.
- Custom surfaces can fail without making the data inaccessible.

## Product axioms

These are load-bearing. A change that violates one needs an accepted ADR.

- **Empty files are valid.** A `.nendo` file with no user schema is a working
  application, not an error state.
- **Studio is permanent and host-owned.** No application content and no agent can
  remove the route back to the data.
- **Data is usable before specialised presentation.** The table works before the
  form exists, and after it breaks.
- **All clients share one authority and validation path.** Native UI, web
  Workbench and MCP adapter call the same typed application services.
- **Agents never receive raw SQL or filesystem authority.** No SQL, no SQLite
  handle, no database path, no generic host invocation.
- **Preview is physically separate from active state.** Validation happens on a
  clone with no authority over the active file.
- **History and reversibility claims are explicit.** Every operation declares its
  reversibility class. There is no universal undo.
- **Local and offline use never depends on an agent or a Nendo service.**

## Primary user

A technically curious individual with a modest local dataset who wants a polished
application experience without managing SQL, Git, package managers or a hosted
platform. The MVP is personal and single-user; it is not an enterprise
deployment product.

## The core loop

```text
Create empty file
  → add or import schema and data
  → work in the default Studio table
  → ask an agent to create or reshape a form, board or record page
  → review the semantic diff
  → accept, observe, and compensate where the operation supports it
```

## What would falsify this

The proof is that an agent, given only the MCP interface, can build an
application whose shape nobody anticipated — and that a human can review that
change and understand what it does before accepting it.

If Studio succeeds but semantic surfaces cannot deliver value the table alone
does not, Nendo has not passed its hypothesis. That is a pivot-or-stop signal,
not a backlog item.

Four reference applications exist as falsification, each one shaped differently
from the last: **Idea Garden** (the original form and board), **Decision Log**
(the neutrality proof that the path is not Idea-specific), the **Axiom
Register** (record pages, related lists, declared filters, summary tiles and
multi-step commands — none of it expressible in the earlier vocabulary), and
**Nendo Station** (every kind of screen this host compiles, the charts, the
calculations, an automatic action and a custom view of its own). The Axiom
Register was authored end to end through the MCP interface alone, reading the
vocabulary off the wire rather than from this repository; the station was built
the same way from an empty file, and [its walkthrough](nendo-station.md) is where
the loop above is performed in front of somebody.

## Scope boundary

**In:** empty-file lifecycle, scalar schema, relational data, Studio table and
editor, CSV import/export, semantic forms, lists, boards, record pages, related
lists, declared filters, summary tiles, declarative commands, MCP inspection and
authoring, proposal preview and promotion, history, bounded compensation, safe
mode, bounded calculations and local actions.

**Out:** general scripting and expressions, plug-ins and third-party controls,
an embedded agent, scalar multi-choice, binary and asset fields, collaboration,
cloud sync, background agents, other database engines, cross-platform parity.

The scope list describes the shipped product. Bounded calculations and local
actions are in it because [ADR-0008](decisions/0008-general-scripting-and-capability-isolation.md)
is delivered; general scripting, plug-ins, third-party controls and external
effects still require additional accepted authority.

**Charts and dashboards came into scope on 2026-09-14**, and the slices S0 to S7
are delivered. A
chart in Nendo is an exact aggregate over a closed grouping — a choice field's
options, a Boolean, a Date field's months — drawn as proportion with its numbers
beside it; a dashboard is a page of such tiles and charts over one file. Neither
stores layout, an expression or a sample. The ideas and their order are in
[surfaces-and-charts-plan.md](design/surfaces-and-charts-plan.md); each lands as
an accepted [ADR-0004](decisions/0004-versioned-semantic-ui-contract.md)
amendment, and the axioms above hold throughout.

## Success criterion

A new user creates an empty file, shapes or imports a modest dataset, uses it
productively through Studio, has an external agent build a materially better
focused surface, reviews and accepts the semantic change, restarts offline, and
recovers the data without that surface.
