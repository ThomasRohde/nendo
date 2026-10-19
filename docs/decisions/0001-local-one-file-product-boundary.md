# ADR-0001: Define the local one-file product boundary

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `FormatAndLifecycleTests`, `BackupTests`, `IdentityCopyTests`, `RestoreTests` (Engine) and `DesktopLocationTests` (Desktop)

## Context

Nendo needs a durable local artefact that stays useful without an account, an
agent, a hosted service or generated application code. SQLite creates journals,
backups and proposal clones while the application runs, so "one file" separates the
canonical artefact at rest from the host-owned derivatives that exist while it is
open. The product is personal, single-user and Windows-first. Cloud sync,
collaboration and hostile same-user isolation are outside its boundary.

## Decision

Nendo's canonical artefact is one local `.nendo` SQLite file at rest.

- A new file holds only protected compatibility and identity metadata and a genesis
  history entry. A file with no user entities or records is valid.
- The file holds relational user data, protected Nendo metadata, semantic
  definitions and semantic history ([ADR-0003](0003-relational-user-data-and-protected-metadata.md)).
- A custom view's code travels in the file as protected metadata and runs only in
  its view ([ADR-0013](0013-custom-views-with-code-in-the-file.md)). A skill package
  may carry scripts, which the connected agent's client runs on its own machine and
  Nendo never runs ([ADR-0029](0029-a-skill-may-carry-scripts-its-client-runs.md)). A
  package's help pages are text ([ADR-0027](0027-a-file-carries-its-own-help.md)).
  Device settings, such as the switches that turn views off, stay on the device.
- Media (pictures, sound and video) may be user data, embedded once per content or
  linked by address ([ADR-0031](0031-media-in-user-data.md)). Other binary and asset
  fields, and multi-file application bundles, are excluded.
- The host permanently provides Studio and recovery. Custom surfaces, custom views
  and agents cannot hide or revoke that route.
- Journals, backup outputs, staged restores and proposal clones are operational
  derivatives with a host-defined owner, lifetime and cleanup. They are not
  canonical artefacts.
- A copy of an open file uses SQLite backup or an equivalent host-coordinated
  snapshot. A raw copy of the main file while derivatives exist is not presented as
  a current backup. Duplicate, Fork and New follow
  [ADR-0010](0010-file-identity-duplicate-fork-backup-and-restore.md); journal and
  close discipline follow [ADR-0011](0011-local-sqlite-journal-and-copy-discipline.md).
- Files in known sync-managed locations (OneDrive, Dropbox, Google Drive) are
  unsupported for writable use. Nendo warns where it can and makes no sync-safety
  claim.
- The security boundary is the operating-system user account. Nendo does not claim
  protection from malware, privileged processes or hostile writers running as that
  user, and does not sandbox a received file's view code
  ([ADR-0012](0012-safe-mode-compatibility-and-migration.md)).

## Consequences

### Positive

- The person's durable unit is simple, portable and independently inspectable.
- Studio and safe mode recover data without generated code or an agent.
- Temporary complexity stays inside a host-owned lifecycle boundary.

### Negative

- Copying an open file needs an explicit host operation; an Explorer copy is not
  treated as transactionally current.
- Sync-managed folders get a conservative unsupported-use warning.
- A received file's view code runs when its view is shown.

## Rejected alternatives

- Directory bundle: partial copies and externally reordered writes become normal
  failure modes.
- Hosted or account-backed authority: conflicts with the offline, durable-file
  proposition.

## Revisit triggers

- Binary or asset fields beyond ADR-0031's media become a product requirement.
- Extension code needs to run outside a view, or across files.
- Cloud sync or collaboration becomes explicit scope.
- SQLite can no longer meet the local durability and inspectability requirements.
- Cross-platform delivery needs a materially different artefact contract.
