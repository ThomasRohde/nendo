# ADR-0026: Allowed links

- **Status:** Accepted
- **Date:** 2026-10-06
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `LinkRuleTests`, `LinkRuleProtocolTests` and `link-rule-markup.test.mjs`
- **Depends on:** ADR-0003, ADR-0005, ADR-0006, ADR-0007, ADR-0012, ADR-0020, ADR-0022
- **Contract:** [relationships](../contracts/relationships.md#allowed-links)
- **Related design:** [Archi in Nendo](https://github.com/ThomasRohde/nendo-apps/blob/main/docs/design/archi-in-nendo.md), in `nendo-apps`

## Context

Some record types are links: a record that joins two others, with a kind that says how. A
notation such as ArchiMate allows only some kinds between some endpoints, and its table is data:
12,829 allowed (source type, target type, relationship) rows. A rule kept in one view leaves
forms, imports, automatic actions and agents free to write an invalid link, and the formula
language cannot express a three-key lookup.

## Decision

A link record type may declare a rule whose allowed combinations are ordinary records.

1. **The rule.** `schema.declareLinkRule { entityId, sourceFieldId, targetFieldId, kindFieldId,
   sourceKindFieldId, targetKindFieldId, tableEntityId, tableSourceFieldId, tableTargetFieldId,
   tableKindFieldId }`; `schema.removeLinkRule { entityId }`. One rule per link type
   (`link-rule-already-declared`). Definition lane, `ReversibleWithRetainedState`, each the
   other's inverse; removing keeps every record.
2. **Its shape.** Source and target are configured references of the link type; the kind is a
   field of it; each endpoint kind is a field of the type its reference points at. The table is
   another record type, and each of its three fields matches the field it stands for: a reference
   to the same type, or single-line Text to single-line Text. No two of the link type's three
   fields are the same, nor two of the table's; all ten are active. Anything else is
   `link-rule-invalid`, naming the field.
3. **What is allowed.** A link whose source, target and kind are all set is allowed when a table
   record holds its source's kind, its target's kind and its own kind, compared exactly as stored.
   An end with no kind or empty text as its kind matches no row. A link missing its source, target
   or kind (or with empty text as its kind) is not checked.
4. **Declaring checks the data.** On the proposal clone, links that are not allowed fail
   validation as `links-not-allowed`, naming the first 20 and how many. Nothing is changed. A
   declaration in the same change as its table type or an endpoint's kind field is checked at the
   end of that mutation, once the columns exist, so the table's rows are written first.
5. **At the end of every mutation**, after its operations and automatic actions and before the
   revision is recorded, the store checks each link the mutation created, restored, or set the
   source, target or kind of; each link whose endpoint had its kind set; and every link when a
   table record was changed or deleted. Named links are checked in slices of 400. A link not
   allowed refuses the whole mutation as `link-not-allowed`, naming the link and, for reference
   kinds, the three kind records by ID; a text kind by its field only. A batch may pass through a
   state that is not allowed on its way to one that is. Both apply paths call the check, so every
   writer reaches it, History's undo and a restore included.
6. **In use.** While declared, retiring either record type or any of the ten fields, or changing a
   field's presentation, is `link-rule-field-in-use`. Renaming is allowed.
7. **New files.** A new file of the application (ADR-0022) checks every kept link against the kept
   table and refuses with `links-not-allowed`.
8. **Storage.** `__nendo_link_rule`, keyed by the link type, the `-linkrule-` rung (host 1.45.0);
   a file that declares none keeps its layout and minimum host. Declaring creates
   `nendo_link_<table>` on the table's three columns, outside the protected namespace, so each
   check is one lookup; removing drops it.
9. **Where it shows.** The schema read (MCP, the view API's `schema.describe`) carries `linkRule`
   with the ten IDs. A proposal names the rule in words; Studio's Structure names it on the link
   type and its table. It is authored as a change set; Studio has no form for it.
10. **Archi** declares it on Concepts (Source, Target, Type; Type on both ends) over *Allowed
    relationships*, three references to Concept types seeded with the 12,829 rows and kept in new
    files. An `.archimate` import holding an invalid relationship is refused, naming it.

## Consequences

- A link type holds its own grammar, whoever writes, and the grammar is records a person can read.
- A new refusal on every write path and one more rung.
- An import from a tool that tolerates invalid links is refused rather than flagged.

## Rejected alternatives

- **Checked inside each write:** refuses honest batches half way through.
- **A trigger with `Refuse()`:** needs a lookup the formula language lacks, and holds only where
  consent was given.
- **Wildcard cells:** 7,605 rows instead of 11,569 triples, for a second meaning of empty.
- **Choice-valued kinds:** a table field cannot hold another field's options; a reference to a
  kinds type does the same.

## Revisit triggers

- A link type that needs two rules, or a rule over more than one hop.
- A kind that is a single choice.
- Instance rules, such as ArchiMate's junction checks, that compare a link with its neighbours.
