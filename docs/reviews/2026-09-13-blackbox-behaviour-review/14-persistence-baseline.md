# Baseline captured just before the close/reopen test (Phase 6)

Measured now, to compare against after the person reopens the file.

- Integrity: `verify_integrity` -> rescanned true, state normal, integrityResult ok,
  integrityChangeSequence 27, integrityStale false.
- Surfaces: `nendo://application/surfaces` -> isValid true, state "valid", contractVersion
  3, diagnostics []. All 7 roots compiled:
  checkoutCalendar, lotPage (Identity section + Lot detail tabGroup of Stock/Quality/
  Schedule sections + Checkouts relatedList with a Grams-out sum tile), lotStoredList
  (two filters + count tile), lotFlaggedList, lotBoard (surface sum + group-scoped sum),
  lotWithdraw (recordCommand, commandId "lotWithdraw", 3 steps), varietyPage (section +
  Lots relatedList with a Seeds-held sum tile).
- The compiled surface tree carries every calculated-field binding by fieldId
  (shelfLabel, estimatedSeeds, seedsPerGram, maturityDays, lotCount, quarantinedLots,
  cleanLots) and the visibleWhen "needsRetest" gate — so the "unknown field" phrasing in
  the acceptance diff (evidence/04) was cosmetic; the surfaces compiled valid with those
  bindings intact.
- Revision counters at this point: definitionRevision 15, dataRevision 12,
  changeSequence 27.
- Data residue left in the file by the review (not cleaned up, per "do not fix
  anything"): lotSL0001 status "Released" (trigger), varBrandywine daysToMaturity 90 &
  version 2, lotSL0004 Withdrawn/quarantined (command), lotSL0003 back to 91.00 germ v3,
  lotSL0006 added, one variety alert unchanged because set_field on singleChoice failed.
