# Codemap

Status: **planned**; no slice is built as of 2026-10-10. There is no Codemap file, view or
tool in the repository yet.

Codemap is a Nendo application that maps every repository the owner works in, for coding
agents and for the owner. One `.nendo` file per machine holds the map. Claude Code, working in
any repository, reads that repository and writes the map over the Nendo MCP server. The owner
opens one repository at a time and looks into it. A question or note pinned to a place on the
map is answered there on the agent's next pass. The owner asked for it on 2026-10-08. It is initiative I-008 in the planner; this plan is
W-185, the slices are W-186 to W-194 and W-196, and the choice of direction is D-004.

This document is the plan. It covers the record types, how agents write and reach the file,
the skill the file carries, where the files live, the views, the ADRs, and the slices that
build it. The design canvas drew four directions for looking into a repository, A to D, in both
themes: <https://claude.ai/artifact/M4b2TTHP6EfHBoytiS9m5r>. The canvas is private to the owner.
On 2026-10-08 the owner chose all four, each as a view of its own rather than as modes of one
view (D-004). The artboards are kept in [`codemap-canvas/`](codemap-canvas/README.md), so a
session that cannot open the canvas can still read them.

Codemap stays within ADR-0013 (custom views carry their code), ADR-0019 (a declared hierarchy),
ADR-0020 (unique fields), ADR-0022 (a new file of the application), ADR-0024 (a file carries
its own skill) and ADR-0027 (a file carries its own help). It needs one new ADR,
[ADR-0029](../decisions/0029-a-skill-may-carry-scripts-its-client-runs.md), because its skill
carries the scanner that an agent runs. It needs no other host change.

## The answers in brief

| Question | Recommendation |
| --- | --- |
| Granularity | A **folder** is the unit. Files are counted into their folder. The scanner promotes a few hot files, and in a cowork folder every document, to units of their own. A repository has at most 600 units |
| Stored or summarised | Stored: structure, own sizes, change counts, fingerprints, a one-line summary per unit, links between modules or documents, questions, tours and passes. Not stored: file contents, symbols, file-level imports, history beyond counts. Folder totals are calculations over the hierarchy |
| Agent access | The owner sets **Edit data** once, on the Agent page. Agents write records with no approval. Every change to the application itself (schema, screens, the view, the skill, help) is a proposal the owner accepts |
| Reaching the file | Codemap keeps its own fixed port on the device (41775 on this machine today). Register it once at user scope as `nendo-codemap`. Every Claude Code session in every repository then has it, while Codemap is open |
| The skill | `dev.nendo.codemap`: how to map a repository, re-map it, answer pinned questions and write tours, with `scan.mjs`, a dependency-free scanner the agent runs |
| Live file | `workspace/Codemap.nendo`, git-ignored like the planner, made with *File → New codemap* |
| Demo file | `workspace/Codemap Demo.nendo`, tracked, built by `tools/Build-Codemap.mjs` from this repository and from `docs/` scanned as a cowork folder |
| Views | Native screens for every record type. Five custom views in one package: the Overview of all repositories, which opens the file, and four views of one repository, each its own screen: Map (A), Links (B), Tours (C) and Brief (D) |
| ADRs | ADR-0029 only: a skill may carry scripts its client runs |
| Slices | Ten, listed under [Build slices](#build-slices) |

## What the file is for

- **The agent maps.** In a repository, Claude Code runs the skill's scanner. The scanner counts
  files, lines, bytes and changes per folder and fingerprints each one. The agent writes what
  changed, then adds the judgement no scanner has: a one-line summary per unit, which modules
  depend on which, which units are hotspots, and guided tours ("How a write reaches the
  database": ordered steps, each pointing at a unit and a file).
- **The person views.** They pick a repository and look at it four ways, each a screen of its
  own. The Map draws it as a treemap (ECharts), sized by lines and coloured by recent changes,
  freshness or questions. Links draws the dependency or reference graph (Cytoscape.js, laid
  out by ELK) beside an outline. Tours draws a sunburst and walks a tour along the bottom. The
  Brief is a page to read. The Overview shows every repository together.
- **The person asks; the agent answers.** A question or note pinned to a unit is a record. The
  next pass reads the open questions for its repository and writes the answer into the same
  record, so the answer appears where the question was asked. A tour is walked step by step
  in the Tours view.
- **Two kinds of repository, one model.** A code repository has modules, imports and git
  history. A cowork folder holds documents, decks, sheets and notes. It may have no git. Units
  are folders and documents there, links are references between documents, and summaries
  carry the weight that import graphs carry in code. The record types are the same, and so are
  the views. The `kind` of the repository and of each unit says which is which.
- **Re-mapping is incremental.** In git, it runs from the commit last mapped to `HEAD`. In a
  folder without git, it runs from the fingerprints recorded last time. Only units that changed
  are written. A unit whose content moved since its summary was written shows as stale until
  an agent summarises it again.

## Record types

### Why the folder is the unit

Four limits decide the granularity:

1. **Records.** A file holds at most 100,000 user records across all its types
   (`SqliteNendoStore.Inspection.cs`). One machine-wide file maps every repository. At file
   granularity, five repositories of this one's size (1,302 tracked files) use a tenth of that
   on files alone, and one large monorepo uses all of it.
2. **History.** Writes stop at 99,000 operation rows until the person folds history
   (ADR-0021). A record created is one row whatever it holds, but every field set is one row,
   and a value set to what it already held still writes a row
   (`SqliteNendoStore.Operations.cs`, `ExecuteSetFieldAsync`). Only the person can fold. So
   the design must write little per pass, and the agent must compare before it writes.
3. **The agent's tokens.** Every record an agent writes passes through its context. At file
   granularity, a first map of this repository is 1,302 records. At folder granularity it is
   about 120.
4. **Reading.** A treemap of a few hundred tiles can be read. Several thousand cannot.

So a **folder** is the unit, and the scanner applies these rules:

- It skips what git ignores, plus `.git`, `node_modules`, `bin`, `obj`, `dist`, `build`,
  `artifacts`, `vendor`, `.venv`, `__pycache__`, `target` and `coverage`.
- A folder with fewer than three files beneath it folds into its parent. Folders deeper than
  six levels below the root fold into their ancestor at depth six.
- A folder that holds a manifest is a **Module**: `*.csproj`, `package.json`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml` or `build.gradle`. A top-level folder
  is an **Area**. Every other folder is a **Folder**.
- In code, the files that matter most become **File** units: the ones with the most changes
  weighted by size, at most one unit in twenty and never more than 60. The agent may promote
  a file when it answers a question about it.
- In a cowork folder, every document is a **Document** unit, up to 400. Past that, documents
  are counted into their folders, as code files are.
- A repository has at most 600 units. Over that, the smallest leaf folders fold into their
  parents until it fits.

Each unit keeps a short **top files** list of the files counted into it that change most, so
the inspector can name them without storing a record for each.

The scanner's rules applied to this repository give about 90 folder units and about 30 file
units.

### The types

Every entity, field and node ID starts with `cm.`. Record IDs are chosen by the scanner from
the repository's slug and a hash of the path, such as `cm.unit.r.nendo.3f2a9c1e07b4`, so the
same path always maps to the same record.

| Type | Fields | Notes |
| --- | --- | --- |
| **Repository** `cm.repo` | Name (title), slug (unique), kind (Code, Cowork), location (the local path), remote, method (Git, Folder scan), purpose (one line), summary (Markdown), languages, mapped commit, head seen, commits behind, mapped at (date-time), stale units, open questions, status (Mapping, Current, Behind, Paused), root (the repository's root unit) | One per repository or cowork folder. The counts of stale units and open questions are written by each pass, because a FilteredCount over more than 256 related rows is an error (`calculations-and-actions.md`) |
| **Unit** `cm.unit` | Repository (required), parent and order (the hierarchy, ADR-0019), key (unique: `slug:path`), path, name (title), kind (Root, Area, Module, Folder, File, Document), format (C#, TypeScript, Markdown, Word, Slides, Sheet…), own files, own lines, own bytes, changes, recent changes, last changed (date), measured on (date), fingerprint, summary (one line, at most 200 characters), notes (Markdown), summary of (the fingerprint the summary describes), hotspot (boolean), top files (Markdown), status (Present, Gone) | Own sizes and changes count only the files directly in the unit. Totals are calculations |
| **Link** `cm.link` | Repository (required), from and to (both Unit, required), kind (Uses, Tests, Builds, Hosts, References, Describes, Mentions), weight, source (Scanned, Agent, Person), note | Between modules in code and between documents in a cowork folder. File-level imports are counted into module links, never stored |
| **Question** `cm.ask` | Repository (required), unit (optional), about (a file or symbol inside the unit), kind (Question, Note, Request), text (Markdown, required), status (Open, Answered, Closed), answer (Markdown), answered at, answered by, asked at | A Request asks for work, such as a tour or a deeper map. A Note is kept and never answered |
| **Tour** `cm.tour` | Repository (required), title, question it answers, summary, status (Current, Stale, Draft), written at commit | "How a write reaches the database" |
| **Tour step** `cm.step` | Tour (required), order, unit (required), about (file or symbol), title, text (Markdown) | Ordered by `order` |
| **Pass** `cm.pass` | Repository (required), kind (First map, Re-map, Refresh, Answers), started, finished, from commit, to commit, units added, changed, removed and summarised, questions answered, rows written, client, note | One record per pass: what the agent did and what it cost |

Choices stay under 32 options and every unique field is single-line text, as ADR-0020
requires. Required booleans and counts are always written, because a FilteredCount refuses a
null member.

**Calculations** (no automatic actions, so a schema change never asks for behaviour consent
again):

- On a unit: files, lines, bytes, changes and recent changes, each the unit's own value plus a
  `SubtreeAggregate` Sum of its descendants'. A commit therefore rewrites only the units whose
  own files changed. Their ancestors' totals follow by themselves. Sums stay correct because a
  change is counted per file: a commit that touches three files in one folder counts three.
- *Is stale*: the summary is present and *summary of* differs from *fingerprint*.
- *Questions* and *open questions*: a Count and a FilteredCount of `cm.ask` on the unit.
- On a repository, *units*, a Count. On a tour, *steps*, a Count.

**What a fingerprint is.** In git, it is a hash over the blob IDs of the unit's own files
(`git ls-files -s`). A change below a folder does not touch the folder's own fingerprint, so
an area is not marked stale every time a file deep inside it changes. In a folder without git,
it is a SHA-256 over each own file's path, size and content hash.

**Recent changes** are file changes in the 90 days before *measured on*. A unit touched by a
pass is measured again. A weekly Refresh pass measures again the units whose recent count
should have decayed. The views fade a unit whose *measured on* is old.

**A folder that disappears** is not deleted at once. A reference has no cascade, so questions,
links and steps pointing at the unit would refuse the delete. The pass sets it to Gone and
re-points what it can. A Gone unit that nothing references is deleted on a later pass, leaves
first. Deleting leaves a tombstone that history folding keeps (ADR-0021). For that reason the
scanner's stable IDs matter: a renamed folder is one Gone unit and one new unit, never churn.

### The write budget

What each event costs, in operation rows, from the Engine's rules above:

| Event | Rows |
| --- | --- |
| First map of this repository: about 120 units, 20 links, the repository and the pass | About 140, one per record created, in three calls |
| A re-map after a commit that touches five units | About 30: five fields on each of five units, four on the repository, one pass |
| Summarising a stale unit again | 2: the summary and *summary of* |
| A weekly Refresh of 40 active units | About 40 |
| A question asked and answered | 4: one create and three fields |
| A tour of six steps | 7 |

**A heavy week** is five active repositories with 20 re-maps each, their Refreshes, 60
summaries and 10 questions: about 3,400 rows. An empty file reaches the 99,000-row wall after
about 29 weeks. After a fold, which keeps at most 25,000 rows, the next fold is about 22 weeks
away. **The owner folds Codemap's history about twice a year**, from History, which warns at
80% of the bound. No agent can fold.

Records stay far from their ceiling: 25 repositories of 600 units are 15,000 units. The skill
keeps the last 100 passes per repository and deletes older ones.

## How agents write without asking every time

Nendo has five access levels per file and device: Off, Inspect, Edit data, Shape app and
Unattended (ADR-0009, `AgentAccessMode.cs`). Record writes need **Edit data** and never wait
for acceptance. Change sets need Shape app. Accepting one's own proposal needs Unattended.

**The owner sets once:**

1. *Edit data* on Codemap's Agent page. The level is remembered for the file on this device
   and comes back whenever the file opens writable.
2. *Fixed port* on (the default), so the port the file claims stays its own.

**Then:**

- Every pass writes records directly: units, links, repository fields, answers, tours, passes.
  Nothing waits for the owner.
- Every change to the application (record types, screens, the Map and Overview package, the
  skill, help pages) is a proposal the owner accepts. `tools/Build-Codemap.mjs upgrade`
  prepares it at Shape app and prints its exact title. At Edit data no agent can propose
  anything, so an agent working in an untrusted repository cannot install view code or change
  the skill other agents read.
- Folding history is the owner's, twice a year by the estimate above.
- Codemap has no automatic actions, so behaviour consent never comes up.

**Why not Unattended.** Codemap is written by agents working in many repositories, and a
repository's content can carry instructions an agent might follow. At Unattended such an
agent could accept its own proposal: a view package whose code runs in Nendo with network
access (ADR-0013), or a changed skill that every later agent loads. At Edit data the worst it
can do is write records, which History keeps and undoes. The cost is one step per upgrade:
raise to Shape app, accept, lower again.

**The lease.** Every write needs the file's single edit lease, which has no queue. A pass
takes the lease, reads its repository's units, writes the changes in one `apply_writes` call
where it can (at most 200 records, one revision), records the pass and releases the lease,
usually within a minute. A second session that meets `NENDO_LEASE_HELD` retries three times
over a minute and then skips its pass and says so. It never revokes another client's lease.
A crashed holder blocks writes until the owner revokes it from the Agent page.

## Reaching the file from any repository

**The port.** Each open file runs its own Nendo process and listener, on the port that file
keeps on this device (`agent-ports.json`, from the base port 41763). Planner.nendo keeps 41766
and Copilot.nendo 41774. Codemap would claim 41775 when access is first switched on. Another
file being open changes nothing, because each open file runs in its own window and process.

**User-level registration**, once per machine:

```bash
claude mcp add --transport http --scope user nendo-codemap http://127.0.0.1:41775/mcp
```

For Codex, the same entry in `~/.codex/config.toml`:

```toml
[mcp_servers.nendo-codemap]
url = "http://127.0.0.1:41775/mcp"
```

The name follows the `nendo-<slug>` convention in `client-help.ts`. A project's own `nendo`
server, such as this repository's planner, keeps its name, so both are available here. The
host checks the loopback address and an exact `127.0.0.1:<port>` Host header. It needs no
credential.

**Telling the agent when to use it.** Three lines in the user-level `~/.claude/CLAUDE.md` (and
`~/.codex/AGENTS.md`):

```markdown
## Codemap
When the `nendo-codemap` server is connected, read its skill (skill://dev.nendo.codemap/codemap/SKILL.md)
before mapping. Map a repository only when asked; re-map one Codemap knows at the end of a task that
changed it, and answer the questions pinned to it. If the server is not connected, do not mention Codemap.
```

**When Codemap is not open**, nothing listens on its port and the connection is refused.
Claude Code reports `nendo-codemap` as failed at startup and offers no tools. The session goes
on without Codemap and the pass is skipped. MCP tools do not come back after a drop, so a
session started before Codemap opened needs `/mcp` to reconnect. Two habits keep Codemap
available:

- Closing Nendo's window keeps the file open in the notification area. That is the default.
- A shortcut in the Startup folder runs `Nendo.Desktop.exe "<path>\Codemap.nendo"`. That
  opens Codemap at sign-in with no host change.

**Is this the right file?** The skill tells the agent to read `nendo://application/manifest`
and `entity/cm.repo/schema` before it writes. A file without `cm.repo`, or a skill package
other than `dev.nendo.codemap`, means the port belongs to another file: the agent stops and
says which one it found. The check does not use the application ID. A file made with
*File → New codemap* has a new identity, and the skill it carries must still work there.

## The skill

`dev.nendo.codemap`, from `tools/codemap-skill/`: a skill package (ADR-0024) of `SKILL.md`
and `scan.mjs`. Its sections:

1. **Identify the file.** Check the manifest and schema as above, then find the repository
   by matching its location to the working directory. In git, also match its remote.
2. **Map a repository** (only when asked). Run
   `node scan.mjs <root> --slug <slug>`. It prints JSON: the repository's facts, its units
   with their record IDs and parents, and scanned links. Create the repository, then the
   units from the root down in calls of at most 50 records, then the links. Then summarise:
   the areas and modules first, from their README, manifest and entry points, at most 30
   summaries per pass, biggest and most changed first. The rest show as *not summarised yet*.
3. **Re-map** (at the end of a task that changed the repository). Take the lease. Read the
   repository's units, keeping only key, version, fingerprint, own counts and status. Pass
   them to `scan.mjs --previous`, which prints only what differs. Write only those fields,
   with each record's version. Summarise the stale units again, within the budget. Record
   the pass and release the lease.
4. **Answer questions.** Read the open questions for the repository, at most three per pass,
   oldest first. Read the code the question is about, then write *answer*, *answered at*,
   *answered by* and status Answered on the same record. A Request may be answered by making
   a tour or promoting files, and the answer says what was made.
5. **Write a tour.** One `cm.tour` and its steps in one call. Each step names a unit and the
   file or symbol. A tour is Current at the commit it was written at. A re-map that changes a
   step's unit sets the tour to Stale.
6. **Rules.** Compare before writing. Never write a value that did not change. Never store
   file contents, secrets or anything from an ignored file. Summaries are one line and
   describe the role, not the implementation. Leave Reference-style fields to Nendo. Release
   the lease at the end, including after an error.

`scan.mjs` reads the repository and prints. It never writes, never opens the network and
needs only Node. In git it uses `git ls-files -s`, `git log --name-only` and `git diff
--name-status <mapped>..HEAD`. In a folder without git it walks the tree and hashes the
files. It finds links mechanically: project references, workspace dependencies, relative
imports in JavaScript and TypeScript counted up to their modules, and Markdown and HTML links
between documents. The agent adds, corrects and explains links, with source *Agent*.

The skill's `scan.mjs` is a copy of `tools/codemap/scan.mjs`, the one the builder uses for the
demo. A test refuses a difference, so the demo cannot disagree with what agents run.

**Help** for the person is in the view package, under `help/` (ADR-0027): what Codemap is,
reading the map, asking, tours, freshness, setting it up for agents, and folding its history.

## Where the files live

- **The live file** is `workspace/Codemap.nendo`. It is owner data, git-ignored by name as
  `workspace/Planner.nendo` is, and backed up by the owner. It is made with
  *File → New codemap* from the demo file: a new file of the application (ADR-0022) with the
  record types, screens, views, skill and help, and no repositories.
- **The demo file** is `workspace/Codemap Demo.nendo`, tracked and checked by
  `tools/Test-BinaryAssets.ps1` like the other demo files. `tools/Build-Codemap.mjs` builds it,
  following `tools/Build-Garden.mjs`:
  - It finds the file by name in the discovery folder and refuses the planner and a non-empty
    file.
  - It builds in stages, each a change set of at most 128 operations: `schema`, `colour`,
    `behaviour` (the calculations), `screens`, `codemap` (the package and its two views),
    `vendor` (the large libraries in their own change set, under the 4 MiB budget), `skill`
    and `data`.
  - `data` runs `tools/codemap/scan.mjs` over this repository and over `docs/` as a cowork
    folder (`--method folder`). It writes the units and links, with summaries from
    `tools/codemap/demo-summaries.mjs`, plus one tour, two questions and their answers. Dates
    are pinned with `--as-of` so that a rebuild compares equal.
  - `compare` reads the file back. `upgrade` brings a built file up to the folders.

`docs/` is the sample cowork folder because it is real knowledge work, written in Markdown
and linked document to document, and it needs no fixture. A cowork folder of Word, slide and
sheet files cannot be committed here: `Test-BinaryAssets.ps1` reads only `.png`, `.ico`,
`.mp4` and `.nendo`.

## Views

### Host-compiled screens

These keep the data usable without the custom views, as the axioms require:

- **Repositories**: a gallery and a record page with Brief, Units, Questions, Tours and
  Passes tabs.
- **Units**: an outline of the hierarchy, and a list with *Stale*, *Hotspots* and *Not
  summarised* filters. The record page shows the summary and totals, links out and in,
  questions, tour steps and parts.
- **Questions**: a board by status, so Open is the queue of what waits for an agent, and a
  list.
- **Tours**: a list. The page lists its steps in order.
- **Passes**: a list, newest first.

Links and Tour steps have record pages and no screen of their own, as Garden's derived types
do.

### Custom views

One package, `dev.nendo.codemap` in `extensions/codemap/`, carries five `extensionView`s of the
file (a file may have eight). The owner chose the canvas's four directions as four views, each
its own screen in the navigation with its own toolbar, rather than modes of one view (D-004):

- **Overview** (`cm.home`) opens the file. It shows every repository as a card: a small
  treemap, freshness, units, stale summaries and open questions. A treemap of all
  repositories together sits above the cards. Choosing a repository opens its Map.
- **Map** (`cm.map`), direction A: the treemap of one repository, coloured by changes,
  freshness or questions, with stale units hatched and pins for questions, beside the
  inspector of the picked unit (summary, totals, links, hot files, questions, the Ask box and
  the tours through it). It is the view a repository opens on.
- **Links** (`cm.links`), direction B: the outline of the units beside the link graph, with
  areas as compound nodes; picking a unit lights its neighbours, and the panel lists them with
  the unit's questions and the Ask box.
- **Tours** (`cm.tours`), direction C: a sunburst of the repository and the tour rail along
  the bottom. Each step lights its unit on the sunburst and shows the step's title, file and
  text; Previous, Next and the arrow keys move along it.
- **Brief** (`cm.brief`), direction D: a page to read: purpose, freshness, the areas as cards,
  a treemap of the picked area, hotspots, questions and tours.

The views share code and context, not screens:

- One set of modules in the package reads a repository (`queryAll` with a `cm.unit.repo`
  filter), computes the heat scale and draws the inspector, so the four views agree.
- The repository and unit picked last are kept in the package's own storage, which all its
  frames share, so moving from the Map to Links keeps both. A view hands a place to another
  through that storage and `ui.openScreen`, as Garden's Overview hands a note to the Garden
  view.
- Each view writes questions and notes with `records.create` under a `writeKey`, and listens
  to `changes`, so an answer appears while the person looks.

An `extensionRecordPanel` on the unit page, showing where the unit sits, can follow later.

**Libraries**, pinned in `tools/codemap/package.json` and copied by `tools/codemap/bundle.mjs`
with their licences into `extensions/codemap/vendor/`, as `tools/garden/bundle.mjs` does:

- **ECharts** (Apache-2.0). esbuild bundles a custom build of `echarts/core` with the treemap
  and sunburst charts, the tooltip and the **SVG renderer**. SVG lets the theme colour every
  mark from Nendo's tokens, lets the lane measure the tiles it draws, and keeps up with a few
  hundred tiles. The bundle carries Apache's `NOTICE` and the licences of ZRender (BSD-3-Clause)
  and tslib (0BSD).
- **Cytoscape.js** (MIT) draws the graph on a canvas. The lane measures it through
  Cytoscape's own API (`renderedBoundingBox`) rather than the DOM.
- **elkjs** 0.12.0 (EPL-2.0), the version `extensions/work-dependencies` vendors, lays the
  graph out in a Web Worker: layered, with areas as compound nodes. Positions go into
  Cytoscape's `preset` layout. ELK runs as work-dependencies runs it (`new ELK({ workerUrl })`,
  a timeout and a fallback). The `cytoscape-elk` adapter is not used, because it runs ELK on
  the view's main thread.
- `vendor/THIRD-PARTY-NOTICES.txt` is generated from `node_modules`, and the bundler refuses
  a dependency without a licence. A definition test checks that every vendored file has its
  licence beside it and is the pinned version, as Garden's test does.

There are no fonts (the Windows faces) and no binary assets. Colours come from the
`--nendo-*` tokens. Both libraries are given colours from the tokens, read again on the
`theme` event. The heat scale for changes is five steps of one hue that differ in lightness,
chosen per theme so that a label on any step keeps 4.5:1.

## ADRs

**[ADR-0029](../decisions/0029-a-skill-may-carry-scripts-its-client-runs.md): a skill may
carry scripts its client runs.** It was written for this plan and accepted on the owner's
standing pre-acceptance. It is needed because:

- `AGENTS.md` says JavaScript a file carries runs only as custom-view code.
- The vision puts "extension code that runs without a view" out of scope.
- The review of a skill package says "Nothing in it runs."

A scanner in the skill, run by the agent on its own machine, sits across all three. The ADR
keeps Nendo from ever running such a script. It requires the review and Studio to name every
script a skill carries, and it makes the client's own approval the gate for running it. Slice
S1 builds the review wording.

Everything else fits accepted ADRs:

- Data writes at Edit data (ADR-0009).
- The hierarchy and subtree sums (ADR-0019) and the unique key (ADR-0020).
- A new codemap with no records kept (ADR-0022).
- The skill (ADR-0024) and help (ADR-0027).
- The views and their libraries (ADR-0013).

User-level registration is client configuration. The per-file port already exists.

Considered and not proposed:

- **A broker that routes one stable port to a file by application ID.** It would amend
  ADR-0009's one listener per open file. The fixed per-file port already gives Codemap a
  stable address.
- **Nendo opening a file at sign-in.** A Startup shortcut does it today.

## Build slices

Each slice is a planner work item under the Codemap initiative. It has its own acceptance
criteria and the gate that proves them. Every guard a slice adds is falsified once: put the
defect back, watch the guard fail, quote the failure text in a Finding (`AGENTS.md`).

| Slice | What | Acceptance and gate |
| --- | --- | --- |
| **S1** (W-186) Skill scripts are named in review | ADR-0029's host part: the proposal line and Studio's card name each script file a skill package carries, and say that it runs in the agent's client and never in Nendo; the contract and Help say so | Engine test: a skill package with `scan.mjs` validates and its review line names the file; a package with no script keeps today's line. Workbench test for the card. `Test-Production.ps1 -SkipRestore` |
| **S2** (W-187) Definition, scanner and demo file | `tools/codemap/definition.mjs`, `scan.mjs`, `demo-summaries.mjs`, `tools/Build-Codemap.mjs`; the record types, calculations and native screens; `workspace/Codemap Demo.nendo` built from this repository and `docs/` | `node --test tools/codemap/*.test.mjs`: the granularity rules (fold under three files, depth six, the 600 cap, promotion), stable IDs, git and folder fingerprints, `--previous` printing only differences, link extraction, every field a screen names exists, each stage under 128 operations. `Build-Codemap.mjs` then `compare`. `Test-BinaryAssets.ps1` reads the tracked file. Measured: the demo's operation rows and records per repository, against the budget above |
| **S3** (W-188) The skill and help | `tools/codemap-skill/` (SKILL.md and the `scan.mjs` copy), help pages, `Put-NendoPackage` into the demo | A test that the skill's scanner is the builder's, byte for byte, and that SKILL.md's worked example matches the scanner's output. Agent-observed: a fresh Claude Code session in another repository, registered at user scope against a copy of the demo, maps it, re-maps after a commit writing only the changed fields, and answers one pinned question. The pass record's rows are recorded as evidence |
| **S4** (W-189) The Map view (A) | `cm.map`, with ECharts vendored and the shared modules (repository read, heat scale, inspector, the picked repository and unit in package storage): the treemap, colour by changes, freshness and questions, stale hatching, pins, the inspector, the repository picker, both themes | `tools/Review-Codemap.ps1` (in `Test-Production.ps1`) on the fixture broker. It measures: every unit of the fixture drawn once and inside the map; tile area in proportion to lines within 2%; the heat step of each tile; stale tiles hatched and others not; a click opening the right unit under a real pointer; the theme's tokens in Light and Dark; no sideways scroll at 700 px. The definition test checks the notices |
| **S5** (W-190) The Links view (B) | `cm.links`: the outline beside the Cytoscape graph laid out by ELK, areas as compound nodes, picking lights neighbours, the neighbour panel | In the same lane: one edge per link, no node outside the frame, a pick dimming exactly the non-neighbours, ELK's fallback when the worker is refused |
| **S6** (W-191) Ask and answer | Pinning a question or note from the Map and Links; the Questions board; the skill's answer step; the answer appearing in place | Lane: a pin creates one `cm.ask` with its unit, one write under a `writeKey`, and a fixture answer arriving through `changes` shows without a reload. Agent-observed: an answer written by a real pass |
| **S7** (W-192) The Tours view (C) | `cm.tours`: the sunburst and the tour rail; each step's unit, title, file and text; Previous, Next and the keys | Lane: the sunburst's angles in proportion to lines, each step lights its own unit and only it, and the keys move between steps. A re-map that changes a step's unit marks the tour Stale (scanner test) |
| **S8** (W-193) Overview of all repositories | `cm.home` opens the file: repository cards and the cross-repository treemap | Lane: one card per repository with the counts the records hold, the treemap's top level is the repositories, and a card hands its repository to the Map and opens it |
| **S10** (W-196) The Brief view (D) | `cm.brief`: purpose, freshness, the areas as cards, the picked area's treemap, hotspots, questions and tours | Lane: one card per area with the totals the records hold, the treemap shows the picked area's units, the hotspots are the units with the most recent changes in order, and a card, a hotspot or a tour hands its place to the Map or Tours view |
| **S9** (W-194) The live file and registration | *File → New codemap*, Edit data, the fixed port, the user-scope registration, the user-level instructions, `.gitignore` for `workspace/Codemap.nendo`, and `docs/dogfooding.md`'s neighbour for Codemap | Owner-reported: Codemap open in the tray, two real repositories mapped from their own sessions (one code, one cowork), a question answered in place. The first pass's rows against the budget |

The order is S2, S1, S3, then S4, which brings the shared modules and ECharts. S5 to S8 and
S10 follow in any order. S9 can start once S3 is done. S4 to S8 and S10 change only the
package, so each is an `upgrade` of the demo and needs one acceptance.

## Open questions

1. **Edit data or Unattended for the live file?** Edit data is recommended: agents from
   untrusted repositories can write records but never change the app. The cost is one level
   change per upgrade.
2. **The scanner in the skill (ADR-0029), or commands only?** The scanner is recommended. It
   makes passes deterministic and cheap. With commands only, each agent counts lines and
   changes in its own context, and the demo and real passes can disagree.
3. **`docs/` as the sample cowork folder, or a synthetic fixture?** `docs/` is recommended: it
   is real, linked and needs no maintenance. A fixture could not hold Office files anyway.
