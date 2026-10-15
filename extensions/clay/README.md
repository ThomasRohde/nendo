# Clay

A collect-anything app that starts empty and grows its own shape. `workspace/Clay.nendo`
opens on it (`clay.home`, an `extensionView` with `opensFile`). The package is
`org.nendo.clay`, and this folder is exactly what the file carries.

## Use

- **Shelves** are the file's record types, all of them, including any made in Studio. **Make
  shelf** opens a form: the shelf's name, then a **label** and a **type** for each field, and
  **Create shelf**. One proposal makes the record type, its required Name and every field. The
  idea chips (Books, Plants, Recipes…) open the form with fields such a shelf usually holds.
- **+ Add fields** on a shelf opens the same form for that shelf, with **Create fields**.
  Types are text, long text, whole number, number with decimals, date, yes or no, rating, choice
  (with its options listed) and a link to another shelf.
- **Items** are records. Add one by name, and set a detail as `Label: value` on its card.
- An item's `Label: value` with a label the shelf does not have opens the field form with that
  label and a type guessed from the value. Once the field is accepted, Clay fills in the value.

| Typed | Guessed type |
| --- | --- |
| `1965` | a whole number |
| `12.50`, `12,50`, `€9.99` | a number (decimal) |
| `2026-10-15`, `15/10/2026`, `today` | a date |
| `yes`, `no` | yes or no |
| `★★★★`, `***`, `4/5` | a rating from 1 to 5 |
| `Reading \| Finished \| Wishlist` | a choice, with the first as the value |
| the name of an item on any shelf | a link to that shelf |
| more than 80 characters | long text |
| anything else | text |

Cards are compact: short details on one line, the first long text cut to two lines, and the
rest behind **Show**.

A link to a name the target shelf does not have offers to add it there and link it, in
one revision. Retiring a detail (its ×) or a shelf (**Put away**) is a proposal too.
Retiring keeps the stored values in the file.

**How Clay grew** lists each accepted change, kept as the package's view state.

## Limits

One Clay proposal waits at a time, as Nendo allows one per package. While it waits, Clay asks
for its outcome every 1.5 seconds, because a rejection commits nothing. A proposal
from an earlier session of the file is settled by reading the schema. Clay reads at most 2,000
items per shelf. A choice cannot gain options after it is made; there is no operation that
adds one. The value typed with a growing detail waits in this device's browser storage until
the proposal is decided.

## Build

`shape.mjs` is the pure part (inference, coercion and operations) and
`tools/clay/shape.test.mjs` covers it: `node --test tools/clay/shape.test.mjs`.
`node tools/Build-Clay.mjs --endpoint http://127.0.0.1:PORT/mcp` authors the package and
its view into an empty file as one proposal. It never adds a record type, since a Clay file
starts with none.
