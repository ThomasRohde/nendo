# ADR-0018: Public website as a separate subproject with one deployment lane

- **Status:** Accepted
- **Date:** 2026-09-22
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** [ADR-0017](0017-production-composition-and-build-layout.md), [ADR-0001](0001-local-one-file-product-boundary.md), `docs/vision.md` axioms, and a built site at `site/` deployed from `.github/workflows/pages.yml` on 2026-09-22
- **Depends on:** Accepted ADRs 0001 and 0017
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Nendo is public on GitHub. All the information that a person can learn about it
is Markdown in this repository. The central material is inside documents of 30 to
45 KB:

- the eight axioms;
- the guarantee that no error an agent makes reaches the data before a person
  accepts it;
- the table of what is not qualified.

A new reader with no context does not find this material.

Two repository positions prevent a direct build of a site.

**ADR-0017 names the production composition** as Engine, Desktop, Workbench and
LocalMcp. It states that this composition is the smallest one that enforces the
boundaries. A fifth top-level directory needs an explicit statement. Without one,
the next person reads `site/` as a product component and starts to connect it to
one.

**`architecture.md` says "There is no CI, deliberately."** That sentence is a real
position, not an omission. The gate runs in about a minute locally. On a solo
project with no pull requests, a hosted copy of the gate adds no value. A GitHub
Actions workflow contradicts the sentence as written. If the contradiction
stayed, the document would be wrong, and the position would not change.

## Decision

**A public website is at `site/`, outside the product boundary. Exactly one CI
lane exists: it builds and deploys that website and nothing else.**

1. **`site/` is not a product component.** It is an Astro project that produces
   static HTML. The Engine, the Desktop host, the Workbench and the MCP adapter
   reference nothing in it. Nothing in it ships in the payload or the installer.
   No `.nendo` file, storage path or application service is reachable from it.
   The minimal production composition of ADR-0017 is unchanged, and the
   dependency arrows that it enforces do not change.

2. **The website is a reader, not a second source.** At build time, the site
   renders the repository documents under `docs/` from their own files. It does
   not copy them. Every rendered page links to its source on GitHub. A build step
   copies the brand assets and the application icon from `docs/assets/brand/` and
   `src/Nendo.Desktop/Assets/` into git-ignored directories. Thus no binary is
   committed twice. Screenshots are the exception, and they are committed. Only a
   run of the Windows host can capture them, and the deployment runs on Linux.

3. **`docs/design/` and `docs/reviews/` are not rendered.** They are the working
   material of the project: plans that the project has moved past, and review
   records that are evidence and not documentation. The build rewrites links into
   them to GitHub.

4. **One CI lane, with a named scope.** `.github/workflows/pages.yml` runs on a
   push to `main` that touches `site/`, `docs/` or the workflow itself. It builds
   the Astro project and deploys it to GitHub Pages. It does not restore, build or
   test any .NET project. It does not run `Test-Repository.ps1` or
   `Test-Production.ps1`. It cannot pass or fail on anything that the product gate
   covers.

5. **The product gate stays local and stays fast.** `tools/Test-Site.ps1` is the
   narrowest applicable build for website work. It is **not** added to
   `Test-Production.ps1`. That addition would put a second `npm ci` into a
   one-minute gate for a subproject that ships nothing.

6. **The honest-reporting rule applies to the copy on the website.** The site
   names what was measured and what was owner-reported. It reproduces the
   not-qualified table and does not summarise it away. It does not use
   "verified". If the roadmap refuses a claim, the website also refuses that
   claim.

## Consequences

- The repository now has CI. It has one lane, for something outside the product.
  `architecture.md` and `CONTRIBUTING.md` now state this precisely, and no longer
  state a position that they do not hold.
- A push catches a broken site build; no check catches it before the push. This
  is accepted: the deployment fails with a clear error, the previous site stays
  up, and the product is not affected. Anyone who wants the check locally first
  can use `tools/Test-Site.ps1`.
- The website can drift from the documents that it summarises. The rendered
  `docs/` section cannot drift, because it is the documents. The five authored
  pages can drift. Re-read those pages when the roadmap changes.
- `site/node_modules` and `site/dist` are git-ignored, as
  `Test-Repository.ps1` already requires of any tracked path. The committed
  screenshots are PNGs. `.gitattributes` declares PNGs binary, and
  `Test-BinaryAssets.ps1` checks them structurally. This decision introduces no
  new binary extension, and none may be introduced: a `.webp`, `.jpg` or `.woff2`
  would fail that lane for two reasons.
- This decision adds no new behavioural contract. Thus the blackbox review
  coverage check in `Test-Repository.ps1` is not affected. The website is not part
  of the blackbox review. That review exercises the product, and when a reviewer
  reads marketing copy, that is not evidence about the host.

## Alternatives considered

**Put the site in `src/`.** Rejected. `Test-ApplicationNeutrality.ps1` recurses
`src/` and fails any `.ts`, `.json` or `.css` file that contains `decision` or
`idea`. A page that lists the architecture decisions would fail that check
immediately. More importantly, `src/` is the product, and the site is not.

**A separate repository.** Rejected. The site renders `docs/` directly. If the
two were split, the rendered documentation would certainly go stale. The one
thing that this site can do and a hand-written marketing page cannot do is stay
attached to the source.

**Keep no CI and publish by hand.** Rejected. A manual deploy from a Windows
machine is a step that somebody forgets. The resulting site would then be older
than the documents that it claims to render, and nothing would show it.

**Run the full gate in the Pages workflow.** Rejected. It would need a Windows
runner for the Desktop host and take minutes instead of one minute. It would also
make the website deployment depend on the test suite of the product. This
decision exists to keep those two things apart.
