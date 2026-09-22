# Idea Garden reference journey

- **Fixture:** [`ideas.csv`](ideas.csv)
- **Expected shape:** [`expected-shape.json`](expected-shape.json)

## Purpose

The journey tests whether Nendo adds value beyond a competent local database table. It begins with an empty file, proves the permanent Studio path and then asks an agent to create a focused form and visual board over the same data.

A polished table alone is not a pass for the original product hypothesis.

## Starting conditions

- Nendo installed locally on Windows;
- no existing Idea Garden file;
- network disconnected once any external agent task has completed.

## Journey A — empty file and human fallback

1. Create `Idea Garden.nendo` from the application.
2. Verify that the file opens without a schema, sample records or custom surfaces.
3. Locate Data, Structure, Surfaces, History and Health without using an agent.
4. Create a temporary entity with two fields and one record manually.
5. Delete or retire the temporary entity through the supported flow.

Pass when the evaluator can explain that the file is valid while empty and can perform basic structure/data work without SQL or an agent.

## Journey B — agent creates the initial shape

Attach an MCP-capable agent in Application authoring mode and give it this prompt:

> Inspect this empty Nendo database. Create an Idea entity for title, notes, status, energy, created date and next action. Title must not be blank. Status values are Idea, Exploring, Trying, Paused and Done. Energy values are Low, Medium and High. Do not use raw SQL or executable scripts. Validate the proposed structure and show me the semantic change before it becomes active.

Expected observations:

- the agent first inspects application identity and current schema;
- the active file remains unchanged during authoring;
- the review names entities, fields, constraints, operations and reversibility classes;
- acceptance is a host-owned action;
- the resulting entity receives a usable generated table and record editor automatically.

## Journey C — load data

Import [`ideas.csv`](ideas.csv) through a host-owned file selection and mapping flow. The agent may propose the mapping, but it must not receive arbitrary filesystem authority or transport the complete file through chat.

Pass when all rows either commit atomically or the import fails without partial data. Imported rows must be visible through Studio before any custom surface exists.

## Journey D — create focused experiences

Give the agent this prompt:

> Create a focused Idea form and a visual board grouped by Status. Show Title, Energy and Next action on each card. Let me move an idea between status groups and add a declarative command that moves the selected idea to Trying. Use stable semantic IDs and typed UI operations. Preview and explain the change before applying it.

Expected observations:

- the proposal uses semantic form/board concepts rather than XAML, HTML or arbitrary code;
- the semantic diff is derived from typed node/command operations;
- the board uses the same records as Studio;
- moving a card creates one validated data transaction;
- unrelated record edits made during review do not stale a UI-only proposal;
- a changed definition or touched-record version does cause a clear conflict.

## Journey E — offline and recovery

1. Disconnect the agent and network.
2. Restart Nendo and reopen the file.
3. Use the table, form and board.
4. Disable or corrupt the custom board through a controlled fixture/test switch.
5. Recover the records through Studio and export them as CSV.
6. Inspect history and compensate one supported definition change.

Pass when the accepted application remains useful offline and broken custom presentation never becomes data loss.

## What a failure means

If Studio works but the form and board add nothing a competent table did not
already give you, the original hypothesis has not passed. That is a signal to
pivot or stop, not a backlog item — see [the vision](../../docs/vision.md).
