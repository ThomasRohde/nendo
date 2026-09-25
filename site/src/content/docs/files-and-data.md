---
title: Files and data
description: What a .nendo file holds and its limits, CSV import and export, history and undo, the four kinds of copy, and what you can still do when a file opens read-only or needs recovery.
group: Use
order: 50
---

## The .nendo file

A Nendo application is one SQLite file with the extension `.nendo`. There is no server and no account. You can move the file, copy it and back it up like any other file.

### What the file holds

- **Record types and records.** Each record type is an ordinary table. Stable semantic IDs connect record types and fields to their tables, so a rename does not break anything that refers to them.
- **The definition.** Fields, screens, calculations, functions, actions and triggers, and the sentence that says what the file is for.
- **History.** Every accepted change, as typed operations grouped into revisions.
- **Identity.** An application ID and an instance ID. [Copies](#copies) explains how they differ.
- **Revision counters.** A definition revision, a data revision, one change sequence across both, and a version on each record.

Some things are stored on the computer and never in the file: your approval of a file's automatic actions, installed custom-view packages and your permission for a custom view. A copy of the file on another computer, or a Duplicate or Fork on this one, asks for those again.

### Size limits

Before Nendo grants any capability, it inspects the whole file. That sets two limits.

| Limit | Value | What it means in practice |
| --- | --- | --- |
| File size | 256 MiB | About 75,000 records that each carry 1.3 KB of text. A cold open at that size takes several seconds. |
| Rows in each history or definition table | 100,000 | The history table gains one row for each record write and each later edit, so a file reaches this at about 100,000 writes, whatever their size. |

Nendo refuses a write when the file is within 32 MiB or 1,000 rows of a limit. The 32 MiB leaves room for the largest single change, which is a custom view's code arriving in the file. The refusal says that nothing changed and that the file still opens. Nendo does not warn you as a file approaches a limit. A file over a limit does not open, and Nendo does not change it.

### Minimum host version

Each file records the minimum version of Nendo's file capabilities that it needs. This number is separate from the product version shown in the status bar. An empty file needs the least. When a change makes the file use a newer capability, such as a timeline, a calculated field or a custom view, the review of that proposal shows that the minimum rises. That line is not compensatable.

- **An older Nendo** refuses a file that needs a newer one. It does not open the file partially.
- **A newer Nendo** opens an older file without upgrading or rewriting it. The minimum rises only when an accepted change needs it, and never goes down.
- **A file from an early layout** opens for inspection only. Health offers **Upgrade file…**, which moves it to the current format as an explicit step.

## CSV import and export

Both directions are in the file menu: **Import CSV…** and **Export CSV…**. Both need a file that is open for editing and has at least one active record type.

### Profiles

| Profile | Use it for | Empty cells and null |
| --- | --- | --- |
| **Nendo CSV** | Files that Nendo exported, or files you wrote to the same rules. | `\N` is null. A doubled leading backslash keeps literal text that starts with a backslash. Null, empty text and the text `\N` stay distinct. |
| **External CSV** | Any other CSV. | Text is literal, backslashes included. Empty text stays empty unless you select **treat empty cells as null**. |

Both profiles read UTF-8 (a BOM is accepted, invalid UTF-8 is refused), comma delimiters, double-quote escaping and CRLF or LF line endings. Nendo writes CRLF. Quoted cells keep embedded line breaks, and text is not trimmed. Numbers are exact strings; `true` and `false` are Booleans. Choice and reference values are stable IDs. Formula-like text that starts with `=`, `+`, `-` or `@` is kept as written in both directions.

### Import

1. Choose **Import CSV…**, select the destination record type and a `.csv` file.
2. Choose the profile, then map each source column to a field. Nendo shows the mapping before it writes anything. Duplicate or missing headers are reported, not mapped silently.
3. Choose **Validate first batch** and review the rows and their typed values.
4. Choose **Import** to commit the batch, or **Cancel remaining import**.

A batch holds at most 100 rows. All rows in a batch commit, or none do. An invalid row stops the batch; Nendo does not skip it. Each accepted batch has a durable receipt and becomes one entry in History. If you cancel, the batches already committed stay committed, and Nendo reports how many rows it imported and how many it did not.

| Input limit | Value |
| --- | --- |
| File size | 16 MiB |
| Data rows | 10,000 |
| Columns | 100 |
| Characters in one cell | 65,536 |

Import does not:

- update, merge with or overwrite existing records (it only creates new ones);
- create record types or fields;
- keep record IDs, versions or history from the source;
- match a reference by its label, or repair one that does not resolve;
- accept a choice value that is not one of the field's options;
- guess field types from the data.

A rating outside its scale is kept, and Nendo says so.

An agent imports through MCP with the same profile and decoding. That path commits 50 rows to each revision, up to 500 rows in one call, without a review step. See [Agents](/nendo/docs/agents).

### Export

**Export CSV…** writes the active fields of one record type, in the Nendo CSV profile, to a new file. It never overwrites an existing file. A CSV export is not a backup: importing it creates new records and does not bring back IDs or history.

## History and undo

Each accepted change is a **revision** in History. An entry shows its lane (Definition or Data), how many operations it holds and who made it: you, an agent, or a trigger that ran on your edit. **View changes** opens the operations. CSV batches and agent writes are ordinary entries. History shows 50 entries per page and is never rewritten.

Every operation declares a reversibility class. Nendo shows it in the review before you accept a proposal, and again in History.

| Class | Meaning | Examples |
| --- | --- | --- |
| Reversible | Nendo can produce the exact inverse. | A field set to a new value; a record created. |
| Compensatable with retained state | Nendo kept what it needs and can restore it while the current state allows. | A deleted record; a retired field or record type. |
| Not compensatable | There is no inverse. | A new record type or field; a conversion; a change of identity; a raised minimum version. |

**Compensate** applies the inverse of an entry as a new revision. It does not rewind history. A restored record gets a new version. If the current state no longer allows the inverse (a referenced record is gone, a field is now required), Nendo refuses. If a save triggered an automatic action, Compensate reverses the whole entry, including the action's changes. To bring back a deleted record, find its Delete entry in History and choose **Compensate**.

There is no universal undo. A backup does not make an irreversible change reversible; it gives you an older file to go back to. Make a backup before a change you cannot compensate.

## Copies

The file menu has a **Copies** section, and **Restore backup…** under **Recovery**. Each action asks for a destination and never overwrites an existing file. The source file stays unchanged.

| Action | Application ID | Instance ID | History | Use it to |
| --- | --- | --- | --- | --- |
| **Create backup…** | Kept | Kept | Kept exactly | Save a recovery copy. |
| **Duplicate…** | Kept | New | Kept, plus one entry for the copy | Make another instance of the same application. |
| **Fork…** | New | New | Kept as lineage, plus one entry for the fork | Start a separate application from the current content. |
| **Restore backup…** | Taken from the backup | Taken from the backup | The backup's | Replace the current file with a backup. |

Restore checks the backup first, then replaces the current file. It keeps the previous file beside it and never deletes those retained copies. If a replacement is interrupted, the next open says so and **Review recovery record…** resolves it; Nendo does not adopt a staged file on its own. The Duplicate and Fork entries in History are not compensatable.

A copy made in Explorer keeps both IDs. Nendo does not rewrite them. One instance can be open for editing in only one Nendo session at a time, so if you open a raw copy or a backup while the original is open, Nendo offers to open it read-only or to make a Duplicate or Fork. Moving or renaming a file keeps its identity.

## Cloud-sync folders

Nendo does not support a writable file in a folder that a sync service manages. When a file is in a OneDrive, Dropbox or Google Drive folder that Nendo recognises, it shows a warning and asks you to choose another location, inspect the file read-only, or accept unsupported use explicitly. Pausing sync is not a safety guarantee. Detection is incomplete, so the absence of a warning does not mean a location is safe.

## Open states

Nendo inspects a file before it opens it and puts it in one of four states. Health shows the state and the reason.

| State | Shown as | Why | What you can still do |
| --- | --- | --- | --- |
| Normal | Ready for editing | The file passed every check. | Everything. |
| Read-only | Open read-only | The file is marked read-only, or the same instance is open for editing elsewhere. | Read data, history and screens; create a backup; export readable data. Editing and agent access are off. |
| Recovery | Recovery required | Nendo found something it will not edit past: tables that differ from the definition, inconsistent revisions or references, a screen or calculation it cannot run, calculations written for a calculation contract this Nendo does not run, unrecognised views or triggers, an interrupted replacement, or an early file layout that needs an upgrade. | Read the data in Studio; read history where it is readable; create a backup where the storage allows; export readable data; open another file or a backup. Custom screens, editing and agent access are off. |
| Rejected | The reason is shown on open | Not a Nendo file, a format or host version this Nendo does not support, over a size limit, or a failed integrity check. | Nothing in this file. Nendo does not open or change it. Open a backup instead. |

A file that another program has busy, or that has an unfinished storage operation, also shows as needing recovery, but with nothing readable until that program closes it. Choose **Inspect file again** then.

Nendo never guesses a repair. It does not rewrite a file to make it open. Studio stays reachable in every state that opens, so your readable data is always one click away.

Health's **Recovery actions** are:

- **Inspect Data** opens the Studio table.
- **Export readable data…** writes the stored values of one record type to a CSV file. It is limited to 4 MiB and 10,000 rows, and it says so if the result is partial.
- **Create backup…** and **Restore backup…**.
- **Inspect file again** re-runs the checks, for example after you close the program that had the file busy.
- **Save diagnostics…** writes a report you can share.
- **Review recovery…** resolves an interrupted replacement.
- **Open file or backup…** opens another file.

Two other conditions turn editing off without a change of state. A file with automatic actions stays read-only until you choose **Approve automatic actions** under Health. A screen definition that does not compile switches off every custom screen, and Studio still works.

## Integrity check

Nendo runs SQLite's full integrity check every time it opens a file, and rejects a file that fails. When you open **Health** on a file that is open for editing, Nendo runs the check again and shows **Last integrity check** with its time and the change number it covered. An agent can run the same check with `nendo.health.verify_integrity`.
