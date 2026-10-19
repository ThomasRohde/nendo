# ADR-0016: Vendor a pinned, curated set of first-party .NET agent skills

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** High
- **Evidence:** `.agents/skills/dotnet-skills.lock.json`, `tools/Sync-DotnetSkills.ps1`, exact upstream Git blob SHAs

## Context

Coding agents need current guidance for SDK setup, templates, MSBuild, Central Package
Management and test-platform behaviour. User-level marketplace installations are mutable
and differ between contributors. Importing every available .NET skill would add irrelevant
activation candidates that steer towards ASP.NET, MAUI, EF, AI or migration patterns Nendo
has not selected.

## Decision

Nendo vendors a small set of unmodified first-party skills from `dotnet/skills` under
`.agents/skills/`:

1. `setup-local-sdk`;
2. `template-discovery`;
3. `template-instantiation`;
4. `template-smart-defaults`;
5. `directory-build-organization`;
6. `scaffold-dotnet-test-project`;
7. `platform-detection` and its command-mode reference;
8. `run-tests`;
9. `filter-syntax`, hidden from direct invocation and available to `run-tests`.

- Files are copied unchanged from the exact upstream commit that
  `.agents/skills/dotnet-skills.lock.json` records, with each file's source path and Git
  blob SHA. The upstream MIT licence sits beside them.
- Nendo-specific instructions live in `AGENTS.md`. Vendored files are never edited.
- An update names a 40-character upstream commit:

  ```powershell
  pwsh ./tools/Sync-DotnetSkills.ps1 -UpdateToCommit <commit-sha>
  pwsh ./tools/Sync-DotnetSkills.ps1
  ```

  The script stages every selected file, validates the front matter, replaces local files
  only after all downloads succeed, updates the hashes, verifies the result and leaves the
  diff for review. Run without arguments, it verifies every recorded blob SHA. It never
  expands the selection or commits.
- Adding or removing a skill is a reviewed change tied to a concrete Nendo need, updating
  the lock and the local README, and this ADR when the selection principle changes.

## Consequences

**Positive.** Every checkout gives agents the same repo-scoped .NET guidance, with
provenance visible in Git and no marketplace account or network needed. The curated scope
limits irrelevant activation, and files stay byte-comparable with upstream.

**Negative.** Maintainers review and refresh the copies; upstream fixes do not arrive by
themselves. Some skills mention siblings that are not vendored, which is no licence to
install them. Other agents may discover skills differently.

## Rejected alternatives

- **Each contributor installs the marketplace.** Mutable, user-scoped and not reproducible
  from a commit.
- **Vendor the whole upstream repository.** Routing noise and review cost.
- **A Git submodule.** Discovery depends on nested initialisation.
- **Rewrite as Nendo-specific skills.** Loses provenance; a custom skill is only for a
  Nendo-specific workflow.
- **Track upstream `main`.** Unreviewed drift in commands and prerequisites.

## Revisit triggers

- Upstream publishes a WinUI or otherwise Nendo-relevant desktop skill.
- The agent client provides a project lock with equivalent reproducibility.
- Repeated sibling dependencies make the subset incoherent.
- The maintenance burden exceeds the measured value.
