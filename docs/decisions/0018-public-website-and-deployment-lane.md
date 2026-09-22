# ADR-0018: Public website as a separate subproject with one deployment lane

- **Status:** Accepted
- **Date:** 2026-09-22
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** [ADR-0017](0017-production-composition-and-build-layout.md), [ADR-0001](0001-local-one-file-product-boundary.md), `docs/vision.md` axioms, and a built site at `site/` deployed from `.github/workflows/pages.yml` on 2026-09-22
- **Depends on:** Accepted ADRs 0001 and 0017
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Nendo is public on GitHub, and everything a person can learn about it is Markdown
in this repository. The material that carries the idea — the eight axioms, the
guarantee that nothing an agent gets wrong reaches the data before a person
accepts it, and the honest table of what is not qualified — is inside documents
of 30 to 45 KB. A reader arriving cold does not find it.

Two repository positions stand in the way of simply building a site.

**ADR-0017 names the production composition** as Engine, Desktop, Workbench and
LocalMcp, and says that composition is the smallest one that enforces the
boundaries. A fifth top-level directory needs saying out loud, or the next person
reads `site/` as a product component and starts wiring it to one.

**`architecture.md` says "There is no CI, deliberately."** That is a real
position, not an omission: the gate runs in about a minute locally, and on a solo
project with no pull requests a hosted copy of it earns nothing. A GitHub Actions
workflow contradicts the sentence as written, and leaving the contradiction in
place would make the document wrong rather than making the position change.

## Decision

**A public website lives at `site/`, outside the product boundary, and exactly one
CI lane exists: it builds and deploys that website and nothing else.**

1. **`site/` is not a product component.** It is an Astro project that produces
   static HTML. Nothing in it is referenced by the Engine, the Desktop host, the
   Workbench or the MCP adapter; nothing in it ships in the payload or the
   installer; no `.nendo` file, storage path or application service is reachable
   from it. ADR-0017's minimal production composition is unchanged, and the
   dependency arrows it enforces are untouched.

2. **The website is a reader, not a second source.** The repository documents
   under `docs/` are rendered from their own files at build time rather than
   copied, and every rendered page links to its source on GitHub. The brand
   assets and the application icon are copied out of `docs/assets/brand/` and
   `src/Nendo.Desktop/Assets/` by a build step into git-ignored directories, so
   no binary is committed twice. Screenshots are the exception and are committed,
   because they can only be captured by running the Windows host and the
   deployment runs on Linux.

3. **`docs/design/` and `docs/reviews/` are not rendered.** They are the
   project's own working material — plans it has moved past, and review records
   that are evidence rather than documentation. Links into them are rewritten to
   GitHub.

4. **One CI lane, scoped by name.** `.github/workflows/pages.yml` runs on a push
   to `main` that touches `site/`, `docs/` or the workflow itself. It builds the
   Astro project and deploys it to GitHub Pages. It does not restore, build or
   test any .NET project, does not run `Test-Repository.ps1` or
   `Test-Production.ps1`, and cannot pass or fail on anything the product gate
   covers.

5. **The product gate stays local and stays fast.** `tools/Test-Site.ps1` is the
   narrowest applicable build for website work and is **not** added to
   `Test-Production.ps1`, which would add a second `npm ci` to a one-minute gate
   for a subproject that ships nothing.

6. **The honest-reporting rule applies to the website's copy.** The site names
   what was measured and what was owner-reported, reproduces the not-qualified
   table rather than summarising it away, and does not use "verified". A claim
   the roadmap refuses is a claim the website refuses.

## Consequences

- The repository no longer has no CI. It has one lane, for something outside the
  product, and `architecture.md` and `CONTRIBUTING.md` now say so precisely
  instead of stating a position they no longer hold.
- A broken site build is caught on push rather than before it. That is accepted:
  the deployment fails loudly, the previous site stays up, and nothing about the
  product is affected. `tools/Test-Site.ps1` is available for anyone who wants
  the check locally first.
- The website can drift from the documents it summarises. The rendered `docs/`
  section cannot, because it is the documents; the five authored pages can, and
  are the thing to re-read when the roadmap changes.
- `site/node_modules` and `site/dist` are git-ignored, which
  `Test-Repository.ps1` already requires of any tracked path. The committed
  screenshots are PNGs, which `.gitattributes` declares binary and
  `Test-BinaryAssets.ps1` structurally checks. No new binary extension is
  introduced, and none may be: a `.webp`, `.jpg` or `.woff2` would fail that lane
  twice over.
- No new behavioural contract is added, so the blackbox review coverage check in
  `Test-Repository.ps1` is unaffected. The website is not part of the blackbox
  review: that review exercises the product, and a reviewer reading marketing
  copy is not evidence about the host.

## Alternatives considered

**Put the site in `src/`.** Rejected. `Test-ApplicationNeutrality.ps1` recurses
`src/` and fails any `.ts`, `.json` or `.css` file containing `decision` or
`idea`, which a page listing the architecture decisions would trip immediately.
More importantly `src/` is the product, and this is not.

**A separate repository.** Rejected. The site renders `docs/` directly; splitting
them guarantees the rendered documentation goes stale, and the one thing this
site does that a hand-written marketing page cannot is stay attached to the
source.

**Keep no CI and publish by hand.** Rejected. A manual deploy from a Windows
machine is a step somebody forgets, and the resulting site would silently be
older than the documents it claims to render.

**Run the full gate in the Pages workflow.** Rejected. It would need a Windows
runner for the Desktop host, take minutes rather than one, and make the website
deployment depend on the product's test suite — coupling two things this decision
exists to keep apart.
