# ADR-0016: Vendor a pinned, curated set of first-party .NET agent skills

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** High
- **Evidence:** `.agents/skills/dotnet-skills.lock.json`, `tools/Sync-DotnetSkills.ps1`, exact upstream Git blob SHAs

## Context

Nendo is expected to become a multi-project .NET codebase, but it remains in an ADR-led exploration phase. Coding agents need current guidance for SDK setup, templates, MSBuild, Central Package Management and test-platform behaviour. User-level marketplace installations are mutable and differ between contributors.

Importing every available .NET skill would also add irrelevant activation candidates and could steer the project towards ASP.NET, MAUI, EF, AI or migration patterns that Nendo has not selected.

## Decision

Nendo vendors a small set of unmodified first-party skills from `dotnet/skills` under repository-root `.agents/skills/`.

The initial selection is:

1. `setup-local-sdk`;
2. `template-discovery`;
3. `template-instantiation`;
4. `template-smart-defaults`;
5. `directory-build-organization`;
6. `scaffold-dotnet-test-project`;
7. `platform-detection` and its command-mode reference;
8. `run-tests`;
9. `filter-syntax` as a hidden reference-only dependency.

The selected files are copied unchanged from the exact upstream commit recorded in `.agents/skills/dotnet-skills.lock.json`. The lock also records the source path and Git blob SHA for every file. The upstream MIT licence is retained beside the skills.

Nendo-specific instructions live in root `AGENTS.md`; copied skill files are not edited to encode local preferences.

Updates require an explicit 40-character upstream commit SHA:

```powershell
pwsh ./tools/Sync-DotnetSkills.ps1 -UpdateToCommit <commit-sha>
pwsh ./tools/Sync-DotnetSkills.ps1
```

The script downloads all selected files into temporary staging, validates front matter, replaces local files only after all downloads succeed, updates hashes, verifies the result and leaves the Git diff for review. It neither expands the selection nor creates a commit automatically.

Adding or removing a skill is a reviewed repository change tied to a concrete Nendo need. It updates the lock, local README and this ADR or a superseding ADR when the selection principle changes.

## Consequences

### Positive

- Every checkout gives Codex the same repo-scoped .NET guidance.
- Provenance and changes are visible as ordinary Git content and diffs.
- Ordinary use requires no marketplace account or network access.
- Curated scope reduces irrelevant activation and architecture drift.
- Upstream files remain byte-for-byte comparable.

### Negative

- Maintainers must review and refresh the copied guidance.
- Upstream corrections are not received automatically.
- The repository carries several documentation files.
- Some skills refer to non-vendored siblings; that is not permission to install them automatically.
- Other coding agents may use different local discovery conventions.

## Alternatives considered

### Require each contributor to install the marketplace

Rejected as the project default because it is mutable, user-scoped and not reproducible from a Nendo commit.

### Vendor the whole upstream repository

Rejected because most skills are unrelated to current Nendo work and would increase routing noise and review cost.

### Use a Git submodule

Rejected because discovery and fresh-checkout behaviour would depend on nested initialisation and an external layout.

### Rewrite the guidance as Nendo-specific skills

Rejected for general .NET tasks. It would lose upstream provenance and create a needless fork. A custom skill is appropriate only for a genuinely Nendo-specific workflow.

### Track upstream `main`

Rejected. Coding-agent instructions can change commands and prerequisites; unreviewed drift must not enter the project automatically.

## Validation

- `pwsh ./tools/Sync-DotnetSkills.ps1` verifies every recorded local Git blob SHA.
- The lock references an exact upstream commit and path for every copied file.
- `filter-syntax` remains hidden from direct invocation and available to `run-tests`.
- An update fails before local replacement when a source is unavailable or malformed.
- Selection changes remain visible in Git and the decision record.

## Revisit triggers

- Upstream publishes a dedicated WinUI or Nendo-relevant desktop skill.
- Codex provides a project lock mechanism with equivalent reproducibility.
- Organisational policy supplies a centrally governed pinned skill catalogue.
- Repeated sibling dependencies make the curated subset incoherent.
- The maintenance burden exceeds measured value.