# Host Help and application reference

Help is a permanent route. It is reachable with no file open, with a read-only
file and during recovery. The read-only sweep never switches it off. Every guide
is offline structured text, and a page the open file carries is Markdown. The
renderer escapes every string, and Markdown goes through the Workbench's own
renderer, which escapes every character before it adds a tag. A provider must
not put HTML, scripts, links or privileged actions in an article.

## What Help contains

Help has five categories, in this order: About this app, Getting started, How
Nendo works, Everyday work, Agents. The open file's app comes first because it is
what the person has in front of them; with no file open the category is empty and
the index starts at Getting started. If a host provider adds a category and does
not name it, that category comes after these five, in first-seen order.

- **Getting started**: *Find your way around* and *What Nendo is*. These cover
  the one file, the permanent Studio, Use against Studio, and the rule that the
  person accepts every change to the shape of the app.
- **How Nendo works**: seven topics that teach the model instead of the steps.
  The topics are the file and how it opens, the data model, screens as
  definitions, calculations and automatic actions, the two lanes and what a
  review shows, history and compensation, and what Nendo intentionally leaves
  out. They are written from the contracts and accepted ADRs. Every claim names
  something that the code does today, in the words that the screen uses (access
  levels, calculated-field states, reversibility labels, status pills).
- **Everyday work**: CSV, files and copies, editing and undo.
- **Agents**: *Connect an agent with MCP* (the only topic that can name a
  client), *What an agent can see and do* and *The MCP surface*. *What an agent
  can see and do* describes each access level in terms of the data of the
  person, the lease, what the Agent page shows and what an agent never gets.
  *The MCP surface* describes every resource and tool, the limits, how a refusal
  reads and recovery after a lost answer.
- **About this app**: first, the file's own help pages
  ([ADR-0027](../decisions/0027-a-file-carries-its-own-help.md)): every `.md`
  under `help/` in a package the file carries, read with `help.readPages` when
  Help opens, packages by title and pages by path. A page's first `# ` heading is
  its title (its file name, less a leading number, without one), the paragraph
  after it its summary, both as plain text, and the rest its article, rendered as
  Markdown with its headings one level below the article title. The location line
  names the package. Help opened with no topic named opens on the first page.
  Topic IDs are `page:{packageId}/{path}`. Then the reference generated from the
  current typed entity snapshot and the validated render plan. It lists record
  types, fields with their reference targets, calculated fields (by name, never
  with their expression) and configured screens. Topic identity uses stable
  entity IDs, so a rename keeps its place.

## Content model

`src/Nendo.Workbench/src/help.ts` defines `HelpTopic`, `HelpSection`, `HelpTerm`,
`HelpContext` and `HelpProvider`, plus `helpCategoryOrder`, `groupHelpTopics()`
and `helpSearchText()`. All of them are DOM-free, so the Node test can build the
module in isolation. A section carries paragraphs, ordered steps, or terms. Terms
render as a definition list, and `code` marks a term that is an identifier. A
topic can name `related` topics, which render as *See also*. Topic IDs are stable
and unique. The test rejects duplicates and dangling links.

The files own these parts:

- `help.ts`: types and helpers, the Getting started and Everyday work guides, the
  generated reference, `helpTopics()`.
- `help-concepts.ts`: *What Nendo is* and the How Nendo works topics.
- `help-agents.ts`: the two Agents topics and `agentSurface`, which holds every
  resource and tool as data. The article, the Node test and the production gate
  all read that one list. Thus if a tool is added without a sentence, the build
  fails.
- `client-help.ts`: the connect guide, the registration commands and the
  copyable setup request. It is the only production source file that the
  neutrality gate allows to name a client.

## The index and the article

The index groups topics by category. Search matches the title, summary,
headings, paragraphs, steps and terms. It hides a group that has no remaining
matches, and it survives a topic click. The article scrolls independently of the
index. A topic click moves focus to the new index entry. If the click came from
*See also*, focus moves to the article heading. Help opens from these places:

- the sidebar, on the file's first help page when it carries one, else on
  *Find your way around*;
- the no-file screen (*Read how Nendo works*);
- the Agent page (*Learn how to connect with MCP*, *What an agent can see and
  do*).

None of those links is a mutating action, so they stay live with no file open.
The copyable setup request contains the standard address only. It contains no
credential.

## What pins it

- [`help.test.mjs`](../../src/Nendo.Workbench/scripts/help.test.mjs): offline
  availability, category order with the file's pages before its reference, a
  page's title, summary and article, the inventory against the closed tool and
  resource lists, parity with the words on screen, body search, links that
  resolve, and the mirrored vocabulary gates. With these gates, a forbidden word
  fails at `npm test`, and the failure names the topic.
- [`DesktopHelpPagesTests`](../../tests/Nendo.Desktop.Tests/DesktopHelpPagesTests.cs):
  `help.readPages` reads every `.md` under `help/`, packages by title then pages
  by path, leaves a page that is not UTF-8 out and counts it, and drops a
  byte-order mark.
- [`Test-Production.ps1`](../../tools/Test-Production.ps1): the tool names and
  resource URI templates in `help-agents.ts` equal the set that the LocalMcp
  source declares.
- [`Test-ApplicationNeutrality.ps1`](../../tools/Test-ApplicationNeutrality.ps1):
  no application or client vocabulary escapes into help copy outside
  `client-help.ts`.
