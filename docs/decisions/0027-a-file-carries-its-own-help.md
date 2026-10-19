# ADR-0027: A file carries its own help

- **Status:** Accepted
- **Date:** 2026-10-06
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The help-page tests named in the [Help contract](../contracts/help.md#what-pins-it)
- **Amends:** ADR-0013 (what a package's files may be for)
- **Depends on:** ADR-0013, ADR-0024
- **Contract:** [Help](../contracts/help.md), [custom views, Help pages](../contracts/custom-views.md#help-pages)

## Context

Help's *About this app* reference is generated from the schema: one topic per record type. It
cannot say what an app is for, how its pieces fit or what to try first. A file already carries
text for an agent (ADR-0024); this gives it text for the person, shown where they look for help.

## Decision

Every file under `help/` whose name ends in `.md`, in any package the file carries, is one of the
file's help pages.

- The Desktop host answers `help.readPages` with the pages as text: packages by title, then
  package ID; pages by path. A page that is not UTF-8, is larger than 128 KiB, is past the
  fortieth, or would pass 1 MiB together is left out and counted in `omitted`. A byte-order mark
  is dropped.
- Help lists them first under *About this app*, first in Help's index, before the generated
  reference. A page's first `# ` heading is its title (else its file name, less a leading
  number); the paragraph after it is its summary; the rest is rendered by the Workbench's Markdown
  renderer, which escapes every character first, with headings one level below the title. Help
  opened with no topic named opens on the file's first page.
- Pages are reviewed as any package file is when they enter the file, and nothing in them runs.
  Links show their text and are not followed.
- An agent reads the same pages at `nendo://application/extension/{packageId}/file`.
- No storage changes: no rung and no host raise. An older host shows no pages.

## Consequences

- An app explains itself where a person looks for help, in the file's own words.
- A folder name carries meaning: Markdown a view package ships under `help/` for its own use is
  shown in Help.
- Help pages need a package. A file with no views carries a package that holds only `help/`, and
  Studio lists it as a view package no view uses.

## Rejected alternatives

- **A package kind `help`:** a layout rung and a host raise for text the package model already carries.
- **A long-text definition beside the purpose:** one blob, where help is several pages.

## Revisit triggers

- A second kind of person-facing text (release notes, onboarding) wants its own place in the host.
- Pages need pictures, which is a decision about serving package files, not about this folder.
