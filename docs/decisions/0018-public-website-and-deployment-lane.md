# ADR-0018: Public website as a separate subproject with one deployment lane

- **Status:** Accepted
- **Date:** 2026-09-22
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The Astro site at `site/`, built by `tools/Test-Site.ps1` and deployed by `.github/workflows/pages.yml`
- **Depends on:** Accepted ADRs 0001 and 0017
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

Nendo is public on GitHub, and a reader with no context needs a short account of what it
is, its axioms and what is not qualified. [ADR-0017](0017-production-composition-and-build-layout.md)
names the production composition, so a new top-level directory needs an explicit statement
that it is not a product component. The product gate runs locally; a hosted copy adds
nothing to a one-person project with no pull requests.

## Decision

**A public website lives at `site/`, outside the product boundary. Exactly one CI lane
exists, and it builds and deploys that website and nothing else.**

1. **`site/` is not a product component.** It is an Astro project that produces static
   HTML. The Engine, Desktop, Workbench and MCP adapter reference nothing in it. Nothing in
   it ships in the payload or the installer, and no `.nendo` file, storage path or
   application service is reachable from it. ADR-0017's composition and dependency
   direction are unchanged.

2. **The site carries its own guides.** A small set of hand-written guides in
   `site/src/content/docs/` describes the product as it is now, for outsiders, with no ADR
   numbers, work codes or amendment history. The site does not render `docs/`; `docs/` is
   the engineering authority, read on GitHub, and the site links there for contributors.
   The code is the ground truth: when a change alters something a guide states, the guide
   is updated in the same change.

3. **Assets.** The build copies the brand assets from `docs/assets/brand/` and the
   application icon from `src/Nendo.Desktop/Assets/` into git-ignored directories, so no
   binary is committed twice. Screenshots are committed, because only the Windows host can
   capture them (`tools/Capture-SiteScreenshots.ps1`) and the deployment runs on Linux.
   They are PNGs, which `.gitattributes` declares binary and `Test-BinaryAssets.ps1` reads
   structurally. A `.webp`, `.jpg` or `.woff2` under `site/` fails that lane.

4. **One CI lane, with a named scope.** `.github/workflows/pages.yml` runs on a push to
   `main` that touches `site/`, `docs/assets/brand/`, the application icon,
   `Directory.Build.props` or `global.json` (the site prints the product version and the
   pinned SDK), `docs/roadmap.md` (the Status page reproduces its Not qualified table) or
   the workflow itself, and when started by hand. It builds the Astro project and deploys it
   to GitHub Pages. It restores, builds and tests no .NET project and runs neither
   `Test-Repository.ps1` nor `Test-Production.ps1`, so it cannot pass or fail on anything the
   product gate covers.

5. **The product gate stays local.** `tools/Test-Site.ps1` is the narrowest build for
   website work. It is not part of `Test-Production.ps1`, which would gain a second
   `npm ci` for a subproject that ships nothing.

6. **Honest reporting applies to the site.** It names what was measured and what was
   owner-reported, reproduces the Not qualified table rather than summarising it away, does
   not use "verified", and refuses any claim the roadmap refuses.

## Consequences

- The repository has one CI lane, for something outside the product. `architecture.md`
  and `CONTRIBUTING.md` say so.
- A broken site build is caught on push, not before. The deployment fails with a clear
  error, the previous site stays up, and the product is unaffected. `tools/Test-Site.ps1`
  checks it locally first.
- The guides can drift from the code; updating them with the change is the control.
- `.gitignore` excludes every `dist/`, `site/.astro/` and the copied assets, and
  `Test-Repository.ps1` refuses a tracked path under any `node_modules`.
- The website is not evidence about the host.

## Rejected alternatives

- **The site in `src/`.** `src/` is the product, and `Test-ApplicationNeutrality.ps1`
  would refuse a page that lists the architecture decisions.
- **A separate repository.** The site's assets and version come from this repository.
- **No CI, publishing by hand.** A forgotten manual step leaves the site older than the
  product, and nothing shows it.
- **The full gate in the Pages workflow.** It needs a Windows runner and ties the website's
  deployment to the product's test suite.
- **Rendering `docs/` on the site.** The engineering record reads as process to an outsider.
