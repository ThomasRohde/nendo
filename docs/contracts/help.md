# Host Help and application reference

Help is a permanent route: reachable with no file open, with a read-only file and
during recovery, and never switched off by the read-only sweep. Every guide is
offline structured text. The renderer escapes every string; a provider must not
put HTML, scripts, links or privileged actions in an article.

## What Help contains

Five categories, in this order: Getting started, How Nendo works, Everyday work,
Agents, About this app. A category a host provider adds without naming it follows
these, in first-seen order.

- **Getting started** — *Find your way around* and *What Nendo is*: one file, the
  permanent Studio, Use against Studio, and that every change to the app's shape is
  accepted by the person.
- **How Nendo works** — seven topics that teach the model rather than the steps:
  the file and how it opens, the data model, screens as definitions, calculations
  and automatic actions, the two lanes and what a review shows, history and
  compensation, and what Nendo deliberately leaves out. Written from the contracts
  and accepted ADRs; every claim names something the code does today, in the words
  the screen uses (access levels, calculated-field states, reversibility labels,
  status pills).
- **Everyday work** — CSV, files and copies, editing and undo.
- **Agents** — *Connect an agent with MCP* (the only topic that may name a client),
  *What an agent can see and do* (each access level in terms of the person's data,
  the lease, what the Agent page shows, what an agent never gets) and *The MCP
  surface* (every resource and tool, the limits, how a refusal reads, recovery after
  a lost answer).
- **About this app** — generated from the current typed entity snapshot and
  validated render plan: record types, fields with their reference targets,
  calculated fields (named, never their expression) and configured screens. Topic
  identity uses stable entity IDs, so a rename keeps its place. This is generated
  reference, not a claim that authored help is stored in the file; authored content
  would need a versioned typed contract and the proposal/replay path.

## Content model

`src/Nendo.Workbench/src/help.ts` defines `HelpTopic`, `HelpSection`, `HelpTerm`,
`HelpContext` and `HelpProvider`, plus `helpCategoryOrder`, `groupHelpTopics()` and
`helpSearchText()`, all DOM-free so the Node test can build the module in isolation.
A section carries paragraphs, ordered steps, or terms — rendered as a definition
list, with `code` marking a term that is an identifier. A topic may name `related`
topics, rendered as *See also*. Topic IDs are stable and unique; the test rejects
duplicates and dangling links.

Which file owns what:

- `help.ts` — types and helpers, the Getting started and Everyday work guides, the
  generated reference, `helpTopics()`.
- `help-concepts.ts` — *What Nendo is* and the How Nendo works topics.
- `help-agents.ts` — the two Agents topics and `agentSurface`: every resource and
  tool as data. The article, the Node test and the production gate all read that one
  list, so a tool added without a sentence fails the build.
- `client-help.ts` — the connect guide, the registration commands and the copyable
  setup request. The only production source file the neutrality gate allows to name
  a client.

## The index and the article

The index groups topics by category. Search matches title, summary, headings,
paragraphs, steps and terms, hides a group with nothing left in it, and survives a
topic click. The article scrolls independently of the index. A topic click moves
focus to the new index entry, or to the article heading when it came from *See
also*. Help opens from the sidebar, from the no-file screen (*Read how Nendo works*)
and from the Agent page (*Learn how to connect with MCP*, *What an agent can see and
do*); none of those links is a mutating action, so they stay live with no file open.
The copyable setup request contains the standard address only; there is no
credential.

## What pins it

- [`help.test.mjs`](../../src/Nendo.Workbench/scripts/help.test.mjs) — offline
  availability, category order, the inventory against the closed tool and resource
  lists, parity with the words on screen, body search, links that resolve, and the
  vocabulary gates mirrored so a forbidden word fails at `npm test` with the topic
  named.
- [`Test-Production.ps1`](../../tools/Test-Production.ps1) — the tool names and
  resource URI templates in `help-agents.ts` equal the set the LocalMcp source
  declares.
- [`Test-ApplicationNeutrality.ps1`](../../tools/Test-ApplicationNeutrality.ps1) —
  no application or client vocabulary escapes into help copy outside
  `client-help.ts`.
