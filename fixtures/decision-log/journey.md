# Decision Log neutrality proof journey

- **Purpose:** Falsify Idea-specific coupling in the production semantic path.
- **Fixture:** `expected-shape.json` and `records.json` beside this file.
- **Evidence type:** Implementation-team technical proof, not human usability.

1. Create an empty valid `.nendo` file.
2. Submit the fixture definition as canonical schema and semantic operations to
   the generic proposal service.
3. Reject the first proposal and verify that the active file is byte-identical.
4. Prepare it again, inspect the semantic diff and accept exact replay.
5. Create both Decision records through the generic record service.
6. Edit the first record's Owner with its expected record version.
7. Execute the stored Accept decision command and verify State becomes Accepted.
8. Attempt a stale edit and verify the record is unchanged.
9. Close and reopen the file; compare the render-plan digest and exact records.
10. Open the production Desktop without preview mode and verify the form, list,
    three-group board, the gallery of decision cards, the timeline of decisions from
    their decided date to their review date, command, Studio and renderer recovery in
    Light and Dark.

The journey fails if production Engine, Desktop or shared Workbench code needs a
Decision-specific method, ID check, label, option value or rendering branch.
