# Reported (person-observed, from screenshots): Phase 7, and one wire-invisible finding

The person shared six screenshots and answered the four questions. Labelled "reported"
because I did not render these myself; the values in them I can cross-check against my
own wire reads, and do below.

## Q1 — calculated fields read correctly, Use view and Studio: YES

Use-view record editor for SL-0001 (Version 2): Estimated seeds 312500, Seeds per gram
312.5, Days to maturity 90, Needs retest No, Shelf label "SL-0001 seed lot". Each in a
distinct card tagged CALCULATED with the formula shown
(e.g. `RoundAway(grams * spg, 0)`, `SeedsPerGram(gpt)`, `germ < 70`). All match the wire.

Studio grid: every derived column present and matching the wire, including SL-0004
Withdrawn v4 seeds/gram 142.8571, SL-0003 v3, SL-0006 seeds/gram 400.

Divide-by-zero on SL-0005 renders as `Estimated seeds: Unavailable`,
`Seeds per gram: Cannot calculate` in Studio — a worded error, not a wrong number and
not a crash. This is the wire's `state:"error"` surfaced legibly on screen.

## Q2 — clear which fields are read-only: YES

Calculated fields are visually separated CALCULATED cards; stored fields are input
controls (text boxes, dropdowns for Quarantined/Status, a date picker). The distinction
is unambiguous.

## Q3 — the visibleWhen gate: NOT VERIFIED

The record screen the person opened is the DEFAULT record editor ("Seed lot details …
Save changes / Delete record"), which lists every stored field in storage order. It is
not my custom `detailSurface` lotPage (no Identity section header, no Stock/Quality/
Schedule tabs). In that default editor the Status field shows on SL-0001 even though
SL-0001 has needsRetest=false — because the default editor shows all stored fields and
visibleWhen is a detailSurface property that does not govern it.

So I could not confirm the visibleWhen gate on screen, and I could not confirm whether my
custom detailSurface is used as the record page in the Use view at all. The board and
lists (custom surfaces) clearly do render in Use; the record page may or may not. Left
unverified rather than claimed.

## Q4 — Light/Dark: reported fine

Person reports dark mode looks fine. Screenshots are light mode; a sun/moon toggle is
present in the Use view header.

## The wire-invisible finding: SUM refuses to overflow, on screen

The board "Lots by status" (Use view) shows two summaryTile totals reading:

    Unavailable   [Retry]
    SEEDS IN LIBRARY / SEEDS IN COLUMN
    "The exact sum is outside the range this host can represent."

- "SEEDS IN LIBRARY" is the board surface total (sum of lotSeedCount over all lots). It
  includes SL-0002, whose seed count is 9223372036854775807 (int64 max). Any sum that
  adds anything to that exceeds int64, so the exact total is unrepresentable.
- The "Testing" column total fails the same way: its members are SL-0002 (int64 max) and
  SL-0005 (100); 9223372036854775807 + 100 cannot be represented.
- The columns that can be represented show exact totals: Stored 5020
  (4200 + 820), Released 9007199254740993 (SL-0001 alone, the 2^53+1 value shown in
  full), Withdrawn 500.

This is the same exact-or-nothing philosophy as the numeric layer, now visible in an
aggregate: rather than wrap, saturate, or silently drop the overflowing member, the tile
refuses and says why. I could not have seen this from the wire — surfaces read as
definitions, and I have no MCP route to a compiled tile's computed value. It only showed
up because a person looked at the board.

Two caveats on it, described not graded:
- It is also a real ceiling: a Sum cannot represent a total beyond int64 even though a
  single stored integer may reach int64 max. A library with several large lots cannot
  see its own seed total. The refusal is correct; the ceiling is a limit worth knowing.
- The affordance offered is "Retry". An int64 overflow is deterministic — retrying
  recomputes the same unrepresentable sum. "Retry" implies a transient failure; this is
  not one.

## Minor: authoring internals leak into the Use view

The CALCULATED cards show the raw expression including my terse binding IDs — `gpt`,
`spg`, `dtm`. An end user in the Use view sees `SeedsPerGram(gpt)` and `dtm` rather than
a friendly description. Harmless, but it exposes authoring identifiers to a
non-authoring audience.

## Endpoint dropped on reopen (Phase 6)

After the person closed and reopened the file, my next wire calls returned "Unable to
connect. Is the computer able to access the url?" — the endpoint moved, exactly as
PROMPT.md warned ("closing it drops your endpoint"). Phase 6's condition — the app works
with no agent connected — is therefore satisfied literally: the person confirms the app
works (lists, board, record page, Withdraw button), and no agent can currently connect.
Persistence is corroborated by my pre-reopen baseline (evidence/14): integrity ok, all 7
surfaces valid, at change sequence 27.
