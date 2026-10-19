# Host Help and application reference

Help is a permanent route: reachable with no file open, with a read-only file and
during recovery, and never switched off by the read-only sweep. Every guide is
offline structured text, and a page the open file carries is Markdown. The renderer
escapes every string, and Markdown goes through the Workbench's own renderer, which
escapes every character before it adds a tag. A provider must not put HTML, scripts,
links or privileged actions in an article.

## What Help contains

Five categories, in this order: About this app, Getting started, How Nendo works,
Everyday work, Agents. With no file open, About this app is empty and the index
starts at Getting started. A category a host provider adds without naming it comes
after these five, in first-seen order.

- **About this app**: first, the file's own help pages
  ([ADR-0027](../decisions/0027-a-file-carries-its-own-help.md)): every `.md` under
  `help/` in a package the file carries, read with `help.readPages` when Help opens,
  packages by title and pages by path. A page's first `# ` heading is its title (else
  its file name, less a leading number), the paragraph after it its summary, both as
  plain text, and the rest its article, rendered as Markdown with its headings one
  level below the article title. The location line names the package. Help opened
  with no topic named opens on the first page. Topic IDs are
  `page:{packageId}/{path}`. Then the reference generated from the current typed
  entity snapshot and the validated render plan: record types, fields with their
  reference targets, calculated fields (by name, never with their expression) and
  configured screens. Topic identity uses stable entity IDs, so a rename keeps its
  place.
- **Getting started**: *Find your way around*, *Keyboard shortcuts* (generated from
  `shortcuts.ts`) and *What Nendo is*: the one file, the permanent Studio, Use
  against Studio, every key the window answers to, and the rule that the person
  accepts every change to the shape of the app.
- **How Nendo works**: seven topics that teach the model: the file and how it opens,
  the data model, screens as definitions, calculations and automatic actions, the two
  lanes and what a review shows, history and compensation, and what Nendo
  intentionally leaves out. They are written from the contracts and accepted ADRs.
  Every claim names something the code does today, in the words the screen uses
  (access levels, calculated-field states, reversibility labels, status pills).
- **Everyday work**: CSV, files and copies, editing and undo.
- **Agents**: *Connect an agent with MCP* (the only topic that can name a client),
  *What an agent can see and do* and *The MCP surface*. *What an agent can see and
  do* describes each access level in terms of the person's data, the lease, what the
  Agent page shows and what an agent never gets, and has *Launch an agent from
  Nendo*: the Agent page's Launch tab, what Nendo hands the agent, @ in the message
  box, and that closing the conversation's tab ends the agent
  ([launched agents](launched-agents.md)). *The MCP surface* describes every resource
  and tool, the limits, how a refusal reads and recovery after a lost answer.

## Content model

`src/Nendo.Workbench/src/help.ts` defines `HelpTopic`, `HelpSection`, `HelpTerm`,
`HelpContext` and `HelpProvider`, plus `helpCategoryOrder`, `groupHelpTopics()` and
`helpSearchText()`, all DOM-free so the Node test can build the module in isolation.
A section carries paragraphs, ordered steps, or terms. Terms render as a definition
list, and `code` marks a term that is an identifier. A topic can name `related`
topics, which render as *See also*. Topic IDs are stable and unique; the test rejects
duplicates and dangling links.

- `help.ts`: types and helpers, the Getting started and Everyday work guides, the
  generated reference, `helpTopics()`.
- `help-concepts.ts`: *What Nendo is* and the How Nendo works topics.
- `help-agents.ts`: the two Agents topics and `agentSurface`, which holds every
  resource and tool as data. The article, the Node test and the production gate all
  read that one list, so a tool added without a sentence fails the build.
- `client-help.ts`: the connect guide, the registration commands and the copyable
  setup request. It is the only production source file the neutrality gate allows to
  name a client.

## The index and the article

The index groups topics by category. Search matches the title, summary, headings,
paragraphs, steps and terms, hides a group with no remaining matches, and survives a
topic click. The article scrolls independently of the index. A topic click moves
focus to the new index entry; from *See also*, focus moves to the article heading.
Help opens from:

- the sidebar, on the file's first help page when it carries one, else on *Find your
  way around*;
- F1 (`shortcuts.ts`), which presses the sidebar's Help, so it opens in the same
  place and is refused wherever that click would be;
- the no-file screen (*Read how Nendo works*);
- the Agent page (*Learn how to connect with MCP*, *What an agent can see and do*).

None of these is a mutating action, so they stay live with no file open. The
copyable setup request contains the standard address only, never a credential.

## What pins it

- [`help.test.mjs`](../../src/Nendo.Workbench/scripts/help.test.mjs): offline
  availability, category order with the file's pages before its reference, a page's
  title, summary and article, the inventory against the closed tool and resource
  lists, parity with the words on screen, body search, links that resolve, and the
  mirrored vocabulary gates, so a forbidden word fails `npm test` naming the topic.
- [`DesktopHelpPagesTests`](../../tests/Nendo.Desktop.Tests/DesktopHelpPagesTests.cs):
  `help.readPages` reads every `.md` under `help/`, packages by title then pages by
  path, leaves out and counts a page that is not UTF-8, and drops a byte-order mark.
- [`Test-Production.ps1`](../../tools/Test-Production.ps1): the tool names and
  resource URI templates in `help-agents.ts` equal the set the LocalMcp source
  declares.
- [`Test-ApplicationNeutrality.ps1`](../../tools/Test-ApplicationNeutrality.ps1): no
  application or client vocabulary escapes into help copy outside `client-help.ts`.
