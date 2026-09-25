# Reviews

Two kinds of file live here.

- [`blackbox-prompt.md`](blackbox-prompt.md) — the reusable instruction handed to a
  reviewing agent that has never seen this repository. Copy it whole into an empty working
  directory; it is the reviewer's entire brief.
- Dated files and folders — what a particular review found, with its screenshots beside it.

A blackbox review is the only lane that measures what the interface teaches. The gates in
`tools/` prove the host accepts what it should and refuses what it should not; they cannot
tell us that a capable client could not find the read path, because they were written by
somebody who already knew where it was. Findings from these reviews are answered in the
contracts and carried in [`../roadmap.md`](../roadmap.md) under *Agent authoring
ergonomics*.

## Running a round

1. Review what a person would actually get: `Publish-NendoPayload.ps1` →
   `Build-NendoInstaller.ps1` → the installed app, or the published payload. Not a debug
   build.
2. Open Nendo, File → New for an empty file, Agent access → **Shape app**. Leave
   **Fixed port** on (the default) — the prompt asks the person to close and reopen the
   file, and a fixed port is what keeps the registration valid across that. The reviewer
   will ask for **Unattended** during Phase 4b; that request is part of the review, so
   grant it then rather than setting it in advance, and lower it again afterwards.
3. Register the endpoint with the reviewing client. The address is the whole
   configuration; there is no credential:

   ```text
   claude mcp add --transport http nendo http://127.0.0.1:41763/mcp
   codex mcp add nendo --url http://127.0.0.1:41763/mcp
   ```

   With two windows open only one holds port 41763; Agent → Connection shows which
   address each is on.

4. Copy `blackbox-prompt.md` into an empty directory **outside this repository** and start
   the reviewer there. The reviewer writes its own `findings.md` and `evidence/`.
5. Bring the report back as a dated file here, and answer the findings where they belong —
   in the contract, in the roadmap, or in code. Do not edit the report to match what was
   fixed afterwards; it is a record of what an outside client met on that day.

Use a capable model. The lane is mostly judgement — noticing what the interface failed to
say — and a weaker reviewer produces a weaker instrument, not a cheaper one.

## Keeping the prompt current

The prompt must exercise every contract this repository publishes, or a review passes
over a feature and we mistake silence for health. `tools/Test-Repository.ps1` checks that
every contract is named in the table below and that every phase named here exists in the
prompt; it cannot check that the phase actually exercises the contract, so that part is
yours.

When a change adds something a client or a person can see, update the prompt in the same
change: add or extend a phase, and move *Focus for this round* onto what just landed.

| Contract | Exercised by | Note |
| --- | --- | --- |
| [mcp-interface.md](../contracts/mcp-interface.md) | Phase 1, Phase 4b | Every resource including the templated ones, and the first impression the tool list alone gives; then whether the fifth access level and what it gives up are legible from the wire before it is asked for |
| [reads-and-authority.md](../contracts/reads-and-authority.md) | Phase 1, Phase 5 | What a read is bounded by, and what happens past the bound |
| [scalars.md](../contracts/scalars.md) | Phase 2 | Digits that a JavaScript number would round |
| [relationships.md](../contracts/relationships.md) | Phase 2 | Reference, rename with data, blocked delete, retirement |
| [semantic-surfaces.md](../contracts/semantic-surfaces.md) | Phase 3 | Every screen kind, read back and compared with what was authored |
| [queries.md](../contracts/queries.md) | Phase 3, Phase 5 | Filters, ordering and cursors; refusal to query by a calculated field |
| [calculations-and-actions.md](../contracts/calculations-and-actions.md) | Phase 4, Phase 6 | Catalogue, dependent calculations, trigger, conditional visibility, exact division, and reversing a save that acted |
| [operation-outcomes.md](../contracts/operation-outcomes.md) | Phase 6 | Idempotent replay, a lost response recovered through its receipt, integrity staleness |
| [studio.md](../contracts/studio.md) | Phase 7 | Person-owned: Studio against the Use view, and which fields nobody can type into |
| [help.md](../contracts/help.md) | Phase 7 | Person-owned: the Help route read by someone who has not met the product; the reviewer also checks the MCP surface article against what it met on the wire |
| [csv.md](../contracts/csv.md) | Phase 4b, Phase 7 | Both sides now: the person's own Import and Export in Phase 7, and the agent's paged export resource and import tool in Phase 4b, round-tripped through awkward values. Paths stay person-owned in both — native file selection still owns them, and nothing over the wire names one |
| [custom-views.md](../contracts/custom-views.md) | Phase 9, Phase 10 | A package written through MCP and reviewed as code, the view running as soon as it is shown, the device and file switches, a view that hangs, Stop and Reload, what a view's code cannot reach, and removal and its compensation; in Phase 9, a view that somebody else's file carries |
