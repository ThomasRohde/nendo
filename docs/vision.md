# Vision — malleable software

## The problem

AI can generate a small application in minutes. Each application becomes another
silo. The data is coupled to disposable code, and every change means
regeneration. The user cannot see schema migration, history or recovery. When the
generated code stops working, the data is lost with it.

Low-code platforms solve the reuse problem because they own the runtime. But they
require a hosted platform and proprietary storage. They do not give you a durable
local file that you can copy, inspect and reopen offline in ten years.

## The proposition

Software should behave like structured clay. One portable SQLite file (the
`.nendo` file) holds durable identity, schema, data, application meaning and
history. People and coding agents change it in place through typed semantic
operations. There is no generated project, no build step and no regeneration.

The name comes from this idea: *nendo* (粘土) is Japanese for clay.

- The file keeps identity, schema, data and application meaning.
- The installed host always supplies a reliable human database Studio.
- Humans and agents change the application through the same typed services.
- Common changes require no generated project and no build.
- The host previews shape changes on a physical clone. It promotes them when it
  replays the validated operations against the active file.
- Custom surfaces can fail, and the data stays accessible.

## Product axioms

These axioms are fundamental. A change that violates one needs an accepted ADR.

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

The primary user is a technically curious individual with a modest local dataset.
This person wants a polished application experience and does not want to manage
SQL, Git, package managers or a hosted platform. The MVP is personal and
single-user. It is not an enterprise deployment product.

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

The proof has two parts. First, an agent that has only the MCP interface can
build an application with a shape that nobody anticipated. Second, a human can
review that change and understand what it does before accepting it.

If Studio succeeds but semantic surfaces cannot deliver value that the table
alone does not, Nendo has not passed its hypothesis. That result is a signal to
pivot or stop. It is not a backlog item.

Four reference applications are the falsification tests, each a different shape:

- **Idea Garden**: a form and a board.
- **Decision Log**: the proof that the path is not specific to one record type.
- The **Axiom Register**: record pages, related lists, declared filters, summary
  tiles and multi-step commands.
- **Nendo Station**: every kind of screen the host compiles except the outline,
  with charts, calculations, an automatic action and a custom view of its own.

The Axiom Register and the station were authored from an empty file through the MCP
interface alone, reading the vocabulary from the wire. [The station's
walkthrough](nendo-station.md) performs the loop above for an observer.

## Scope boundary

**In:** empty-file lifecycle, scalar schema, relational data, Studio table and
editor, CSV import/export, semantic forms, lists, boards, record pages, related
lists, declared filters, summary tiles, declarative commands, MCP inspection and
authoring, proposal preview and promotion, history, bounded compensation, safe
mode, bounded calculations and local actions, custom views that carry their own
code in the file, with the full typed API
([ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md)), and launching
the person's own installed agent from the Agent page, in a tab
([ADR-0030](decisions/0030-launch-the-persons-own-agent-over-acp.md)), and media fields:
pictures, sound and video embedded in the file or linked by address
([ADR-0031](decisions/0031-media-in-user-data.md), pictures first), Nendo in a browser with
the same Engine and no install
([ADR-0036](decisions/0036-nendo-runs-in-a-browser.md)), and exporting an application as one
web page that runs it, a copy whose edits Nendo replays
([ADR-0035](decisions/0035-an-app-exported-as-one-web-page.md)).

**Out:** general scripting in formulas, extension code that runs without a view
(a skill's script runs in the agent's client, never in Nendo:
[ADR-0029](decisions/0029-a-skill-may-carry-scripts-its-client-runs.md)),
an embedded agent (a model client in the host), scalar multi-choice, binary and asset fields other than media, collaboration,
cloud sync, background agents, other database engines, cross-platform parity.

The scope list covers what is shipped and what an accepted ADR has decided.
[ADR-0008](decisions/0008-general-scripting-and-capability-isolation.md)'s bounded
expressions are the formula language. A custom view's code travels in the file and
runs in the view's own frame; it is one more client of the same typed services, so
the axioms hold for it. The [custom-view contract](contracts/custom-views.md) states
what is delivered. Extension code that runs without a view, such as a contributed
command or a background job, needs its own accepted decision.

**Charts and dashboards are in scope.** A chart is an exact aggregate over a closed
grouping: a choice field's options, a Boolean, or a Date field's weeks or months.
Nendo draws it as a proportion and shows its numbers beside it. A dashboard is a page
of such tiles and charts over one file. Neither stores layout, an expression or a
sample. A new kind lands as an accepted
[ADR-0004](decisions/0004-versioned-semantic-ui-contract.md) amendment.

## Success criterion

A new user creates an empty file, shapes or imports a modest dataset, uses it
productively through Studio, has an external agent build a materially better
focused surface, reviews and accepts the semantic change, restarts offline, and
recovers the data without that surface.
