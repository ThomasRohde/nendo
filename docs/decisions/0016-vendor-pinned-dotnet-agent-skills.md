# ADR-0016: Vendor a pinned, curated set of first-party .NET agent skills

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** High
- **Evidence:** `.agents/skills/dotnet-skills.lock.json`, `tools/Sync-DotnetSkills.ps1`, exact upstream Git blob SHAs

## Context

Nendo is expected to become a multi-project .NET codebase. But it remains in an ADR-led exploration phase. Coding agents need current guidance for SDK setup, templates, MSBuild, Central Package Management and test-platform behaviour. User-level marketplace installations are mutable and differ between contributors.

If the project imported every available .NET skill, it would also add irrelevant activation candidates. Those skills could steer the project towards ASP.NET, MAUI, EF, AI or migration patterns that Nendo has not selected.

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

The selected files are copied unchanged from the exact upstream commit that `.agents/skills/dotnet-skills.lock.json` records. The lock also records the source path and Git blob SHA for every file. The upstream MIT licence is kept beside the skills.

Nendo-specific instructions are in root `AGENTS.md`. Copied skill files are not edited to encode local preferences.

Updates require an explicit 40-character upstream commit SHA:

```powershell
pwsh ./tools/Sync-DotnetSkills.ps1 -UpdateToCommit <commit-sha>
pwsh ./tools/Sync-DotnetSkills.ps1
```

The script does these steps:

1. It downloads all selected files into temporary staging.
2. It validates the front matter.
3. It replaces local files only after all downloads succeed.
4. It updates the hashes.
5. It verifies the result.
6. It leaves the Git diff for review.

The script does not expand the selection, and it does not create a commit automatically.

To add or remove a skill, make a reviewed repository change that is tied to a concrete Nendo need. The change updates the lock and the local README. When the selection principle changes, it also updates this ADR or a superseding ADR.

## Consequences

### Positive

- Every checkout gives Codex the same repo-scoped .NET guidance.
- Provenance and changes are visible as ordinary Git content and diffs.
- Ordinary use requires no marketplace account or network access.
- The curated scope reduces irrelevant activation and architecture drift.
- Upstream files remain byte-for-byte comparable.

### Negative

- Maintainers must review and refresh the copied guidance.
- Upstream corrections are not received automatically.
- The repository carries several documentation files.
- Some skills refer to non-vendored siblings. That reference does not give permission to install them automatically.
- Other coding agents may use different local discovery conventions.

## Alternatives considered

### Require each contributor to install the marketplace

Rejected as the project default. The marketplace is mutable and user-scoped, and a Nendo commit cannot reproduce it.

### Vendor the whole upstream repository

Rejected. Most skills are unrelated to current Nendo work, and they would increase routing noise and review cost.

### Use a Git submodule

Rejected. Discovery and fresh-checkout behaviour would depend on nested initialisation and an external layout.

### Rewrite the guidance as Nendo-specific skills

Rejected for general .NET tasks. It would lose upstream provenance and create an unnecessary fork. A custom skill is appropriate only for a workflow that is specific to Nendo.

### Track upstream `main`

Rejected. Coding-agent instructions can change commands and prerequisites. Unreviewed drift must not enter the project automatically.

## Validation

- `pwsh ./tools/Sync-DotnetSkills.ps1` verifies every recorded local Git blob SHA.
- The lock references an exact upstream commit and path for every copied file.
- `filter-syntax` remains hidden from direct invocation and available to `run-tests`.
- When a source is unavailable or malformed, an update fails before local replacement.
- Selection changes remain visible in Git and the decision record.

## Revisit triggers

- Upstream publishes a dedicated WinUI or Nendo-relevant desktop skill.
- Codex provides a project lock mechanism with equivalent reproducibility.
- Organisational policy supplies a centrally governed pinned skill catalogue.
- Repeated sibling dependencies make the curated subset incoherent.
- The maintenance burden exceeds measured value.