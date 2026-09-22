# Repo-local .NET agent skills

Nendo vendors a deliberately small set of first-party skills from `dotnet/skills` under the repository-root `.agents/skills/` directory. Codex discovers this location for every working directory inside the repository, so contributors receive the same guidance without depending on a user-level marketplace installation.

## Source and update policy

- **Upstream:** `https://github.com/dotnet/skills`
- **Authoritative pin and per-file hashes:** `dotnet-skills.lock.json`
- **Initial import:** upstream `dotnet/skills` commit `34950f875e1db782ab97417bfb6e44d1c4a9acf9`, retrieved 2026-09-01
- **Licence:** MIT; see `LICENSE.dotnet-skills`

The copied upstream files are intentionally unchanged. Nendo-specific instructions belong in the root `AGENTS.md`. Updates are explicit review events: never track upstream `main`, run an automatic marketplace upgrade, or overwrite these files without reviewing the diff.

## Initial curated set

| Skill | Why it is present now |
| --- | --- |
| `setup-local-sdk` | Reproducible project-local SDK setup without changing the machine-wide installation. |
| `template-discovery` | Inspect installed templates and exact options before choosing the provisional WinUI 3 and supporting project templates. |
| `template-instantiation` | Scaffold projects while respecting neighbouring target frameworks and Central Package Management. |
| `template-smart-defaults` | Preserve explicit choices and resolve related template parameters consistently. |
| `directory-build-organization` | Establish a coherent multi-project MSBuild and Central Package Management structure when production scaffolding is authorised. |
| `scaffold-dotnet-test-project` | Create or repair the first test project and ensure the repository entry point actually discovers it. |
| `platform-detection` | Distinguish VSTest, Microsoft.Testing.Platform, test framework, and command mode from repository evidence. |
| `run-tests` | Run the narrowest repository-compatible .NET test command and report literal outcomes. |
| `filter-syntax` | Hidden reference-only guidance loaded by test execution when a framework-specific filter is needed. |

At the currently pinned commit recorded in the lock, there is no dedicated WinUI skill. `template-discovery` recognises WinUI intent and maps it to the `winui3` template, but agents must still inspect what is installed and run the template's current `--help` or `--dry-run` rather than assume flags or output.

The initial set excludes ASP.NET Core, Blazor, MAUI, EF/data, AI/ML, upgrade, migration, diagnostics, performance, and broad test-generation skills. They may be added later when a concrete task or accepted ADR makes them relevant. Curating prevents unrelated guidance from steering Nendo towards a framework or architecture it has not chosen.

## Verify the vendored copy

From the repository root:

```powershell
pwsh ./tools/Sync-DotnetSkills.ps1
```

The default operation computes each local file's Git blob SHA and compares it with the lock manifest. It performs no network access and makes no changes.

## Review an upstream update

Use an exact 40-character upstream commit SHA:

```powershell
pwsh ./tools/Sync-DotnetSkills.ps1 -UpdateToCommit <commit-sha>
pwsh ./tools/Sync-DotnetSkills.ps1
```

The update mode downloads every already-selected file into a temporary staging directory, validates skill front matter, replaces the local copies only after all downloads succeed, and rewrites the lock manifest with the new blob SHAs. It does **not** add new skills or create a Git commit.

Review the resulting diff for:

1. changed activation descriptions and routing between skills;
2. new prerequisites, commands, network access, or destructive operations;
3. dependencies on sibling skills that are not vendored;
4. guidance that conflicts with Nendo's ADRs or authority boundary;
5. licence changes;
6. whether a skill should be added, removed, or kept pinned separately.

Commit the reviewed update together with any selection or ADR changes. A failed check means the local copy has drifted from the recorded upstream content; do not silently regenerate the expected hashes from modified files.
