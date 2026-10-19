# Clay

A collect-anything app that starts empty and grows its own shape. `workspace/Clay.nendo` opens on
it (`clay.home`, an `extensionView` with `opensFile`). The package is `org.nendo.clay`; everything
in this folder but `nendo-package.json` and `README.md` is what the file carries.

## Use

- **Shelves** are the file's record types, including any made in Studio. **Make shelf** opens a
  form: the shelf's name, then a **label** and **type** per field, and **Create shelf**. One
  proposal makes the record type, its required Name and every field. The idea chips (Books,
  Plants, Recipes…) prefill typical fields.
- **+ Add fields** opens the same form for an existing shelf. Types: text, long text, whole number,
  number with decimals, date, yes or no, rating, choice (with its options) and a link to another
  shelf.
- **Items** are records. Add one by name and set a detail as `Label: value` on its card. A label
  the shelf lacks opens the field form with a type guessed from the value; once the field is
  accepted, Clay fills in the value.

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

Cards show short details on one line, the first long text cut to two lines, and the rest behind
**Show**. A link to a name the target shelf lacks offers to add it there and link it in one
revision. Retiring a detail (its ×) or a shelf (**Put away**) is a proposal too, and keeps the
stored values. **How Clay grew** lists each accepted change, kept as the package's view state.

## Limits

- One Clay proposal waits at a time, as Nendo allows one per package. While it waits, Clay polls
  its outcome every 1.5 seconds, since a rejection commits nothing. A proposal from an earlier
  session is settled by reading the schema.
- At most 2,000 items are read per shelf.
- A choice cannot gain options after it is made; no operation adds one.
- The value typed with a new detail waits in this device's browser storage until the proposal is
  decided.

## Build and test

`shape.mjs` is the pure part (inference, coercion, operations), covered by
`node --test tools/clay/shape.test.mjs`. `node tools/Build-Clay.mjs --endpoint
http://127.0.0.1:PORT/mcp` authors the package and its view into an empty file as one proposal. It
adds no record type, since a Clay file starts with none.
