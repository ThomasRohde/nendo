# Architecture decisions

Accepted ADRs are the architecture authority for Nendo. A Deferred ADR grants no
implementation authority. [ADR-0000](0000-record-architecture-decisions.md) and
[the template](template.md) define the format.

Each ADR states its decision as it stands. A change to a decision is made in the ADR
itself, by topic, and the affected [contract](../contracts/) and
[`../architecture.md`](../architecture.md) change in the same commit.

| ADR | Status | Decision |
| --- | --- | --- |
| [0000](0000-record-architecture-decisions.md) | Accepted | How decisions are recorded, numbered and changed |
| [0001](0001-local-one-file-product-boundary.md) | Accepted | A local one-file product, host-owned derivatives, no sync-managed locations |
| [0002](0002-containing-desktop-architecture-and-process-model.md) | Accepted | A thin WinUI host, one local WebView2 Workbench, bounded native recovery |
| [0003](0003-relational-user-data-and-protected-metadata.md) | Accepted | Relational user tables, stable semantic mappings, protected metadata |
| [0004](0004-versioned-semantic-ui-contract.md) | Accepted | Strict versioned semantic UI trees with stable node IDs and typed operations |
| [0005](0005-host-application-services-and-write-coordinator.md) | Accepted | Host application services and one coordinator-owned writer |
| [0006](0006-split-revisions-audit-and-compensation.md) | Accepted | Split revision lineages, total audit order, idempotency, explicit compensation |
| [0007](0007-proposal-clone-validation-and-replay-promotion.md) | Accepted | Proposals validated on a clone and promoted by replay |
| [0008](0008-general-scripting-and-capability-isolation.md) | Accepted | Bounded calculations, functions, local actions and automatic triggers |
| [0009](0009-local-mcp-transport-authority-and-change-sets.md) | Accepted | Client-neutral local MCP with server-owned authority, leases and change sets |
| [0010](0010-file-identity-duplicate-fork-backup-and-restore.md) | Accepted | File identity, and typed Duplicate, Fork, Backup and Restore |
| [0011](0011-local-sqlite-journal-and-copy-discipline.md) | Accepted | Rollback journaling, FULL synchronous, host-owned copy discipline |
| [0012](0012-safe-mode-compatibility-and-migration.md) | Accepted | Explicit compatibility and safe-mode states, staged migration, permanent safe mode |
| [0013](0013-custom-views-with-code-in-the-file.md) | Accepted | Custom views carry their code in the file and run in their own frame |
| [0014](0014-drop-embedded-agent-mcp-is-the-agent-surface.md) | Accepted | No embedded agent: MCP is the agent surface |
| [0015](0015-host-owned-database-studio-and-ag-grid-community.md) | Accepted | Host-owned Studio on AG Grid Community |
| [0016](0016-vendor-pinned-dotnet-agent-skills.md) | Accepted | A pinned, curated set of first-party .NET agent skills |
| [0017](0017-production-composition-and-build-layout.md) | Accepted | Engine, Desktop, Workbench and LocalMcp composition and the build layout |
| [0018](0018-public-website-and-deployment-lane.md) | Accepted | The public website in `site/`, outside the product, with the only CI lane |
| [0019](0019-hierarchies-in-the-schema.md) | Accepted | A self-reference declared as a hierarchy: no cycles, sibling order, tree reads |
| [0020](0020-unique-and-generated-fields.md) | Accepted | Unique fields and host-allocated sequences |
| [0021](0021-folding-old-history.md) | Accepted | Fold old history into a checkpoint so a file keeps accepting writes |
| [0022](0022-new-file-keeping-the-records-an-application-ships-with.md) | Accepted | A new file of the same application keeps the records it ships with |
| [0023](0023-a-view-undoes-its-own-revisions.md) | Accepted | A view undoes and redoes its own revisions through compensation |
| [0024](0024-a-file-carries-its-own-agent-skill.md) | Accepted | A file carries its own agent skill |
| [0025](0025-mcp-apps-and-a-proposal-review-card.md) | Deferred | MCP Apps, with a read-only proposal review card first |
| [0026](0026-allowed-links.md) | Accepted | A link type declares the combinations it allows, enforced by the Engine |
| [0027](0027-a-file-carries-its-own-help.md) | Accepted | A file carries its own help pages |
| [0028](0028-full-text-search-in-the-file.md) | Accepted | A full-text index in the file, one search read for every client |
| [0029](0029-a-skill-may-carry-scripts-its-client-runs.md) | Accepted | A skill may carry scripts its client runs; Nendo never runs them |
| [0030](0030-launch-the-persons-own-agent-over-acp.md) | Accepted | Launch the person's own agent over ACP, in a tab |
| [0031](0031-media-in-user-data.md) | Accepted | Media in user data, embedded or linked |
| [0032](0032-a-views-runtime-events-reach-its-agent.md) | Accepted | A custom view's runtime events reach its agent |
