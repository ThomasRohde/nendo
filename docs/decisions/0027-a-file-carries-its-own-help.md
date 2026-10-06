# ADR-0027: A file carries its own help

- **Status:** Accepted
- **Date:** 2026-10-06
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The owner's request of 2026-10-06 that Garden's built-in help be "more
  elaborate and exciting", pointing at Help's *About this app*, and the choice that a file
  carry its own help pages. Accepted on the owner's standing pre-acceptance of ADR changes
  (2026-09-24)
- **Amends:** ADR-0013 (what a package's files may be for)
- **Depends on:** ADR-0013 packages in the file, ADR-0024 a file carries its own agent skill
- **Related design:** [Custom views contract](../contracts/custom-views.md), [Garden](../design/garden.md)

## Context

Help's *About this app* is generated from the schema: one topic per record type, listing its
fields and screens. It is the same flat reference for a garden of notes as for a CRM. It
cannot say what the app is for, how its pieces fit, what to try first or which keys matter,
because nothing in the file says it in a form Help reads. The Garden view grew its own guide
inside the view, which reaches a person only once they are in that view.

A file already carries text written for one reader: a skill package for an agent (ADR-0024).
What is missing is text for the person, shown where they look for help.

## Decision drivers

1. Help for an app travels with the file, and changes by proposal like everything else in it.
2. Text from the file is never markup: Help renders it with the host's own Markdown renderer,
   which escapes every character first.
3. No new storage. The file format and the minimum host stay as they are, and an older host
   simply shows no pages.
4. The person's own app is what they look at first.

## Options considered

### A. A package kind `help`

A third package kind beside `view` and `skill`. Clean separation, but the kind table's
`CHECK (kind = 'skill')` makes it a new protected table on the layout ladder, a minimum-host
raise for every file that carries help, and every kind-aware path (validation, review, Studio,
import and export) learns a third case.

### B. Markdown under `help/` in any package

A package's files under `help/` that end in `.md` are the file's help pages. A view package
documents itself beside its code; a file of record types alone carries a package whose files
are only its help. Nothing about storage, review or serving changes.

### C. A long-text definition beside the purpose

`application.setPurpose` already stores text. Costs: one blob instead of pages, its own size
bound, and a definition that grows a document's worth of text.

## Decision

Option B. Every file under `help/` whose name ends in `.md`, in any package the file carries,
is one of the file's help pages.

- The Desktop host answers `help.readPages` with the pages as text: packages by title, then
  package ID; pages by path. A page that is not UTF-8, larger than 128 KiB, past the fortieth
  or past 1 MiB together is left out and counted in `omitted`. A byte-order mark is dropped.
- Help lists them first under *About this app*, which is first in Help's index, before the
  reference generated from the record types. A page's first `# ` heading is its title (or its
  file name, less a leading number); the paragraph after it is its summary; the rest is the
  article, rendered by the Workbench's Markdown renderer with headings one level below the
  article title. Help opened with no topic named opens on the file's first page.
- Pages are reviewed as any package file is when they enter the file, and nothing in them
  runs. Links show their text and are not followed, as everywhere the renderer is used.
- Package files are already readable over MCP, so an agent reads the same pages through
  `nendo://application/extension/{packageId}/file`.

## Consequences

### Positive

- An app explains itself where a person looks for help, in the file's own words, and the
  Garden guide reaches a person before they open the Garden view.
- No format change: no rung, no host raise, and a file with pages still opens on an older host.

### Negative

- A folder name carries meaning. A view package that happens to ship Markdown under `help/`
  for its own use has it shown in Help.
- Help pages cannot be carried without a package. A file with no views needs a package that
  holds only `help/`, and Studio lists it as a view package with no view using it.

## Rejected alternatives

Option A was rejected for its cost: a layout rung and a host raise to carry text the existing
package model already carries and reviews. Option C was rejected because help is several pages
a person moves between, not one paragraph of purpose.

## Revisit triggers

- A second kind of person-facing text appears (release notes, onboarding) that wants its own
  place in the host, which would make a `help` kind worth its rung.
- Pages need pictures. Package files can hold images, but Help has no way to show one from the
  file; that is a decision about serving, not about this folder.
