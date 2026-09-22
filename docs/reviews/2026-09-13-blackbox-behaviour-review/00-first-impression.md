# First impression — from the tool surface alone, before any call

Written before calling a single tool. Sources: the 17 `nendo_*` tool names, their
descriptions, their JSON input schemas, and the server's `instructions` block.

## What I could tell

- **It is a structured application builder with a proposal workflow.** The noun set
  (`entity`, `field`, `record`, `change_set`, `definition revision`, `data revision`)
  is unambiguous. `nendo_data_execute_command` mentions a "compiled semantic surface",
  which is the only hint in the whole tool list that screens exist.
- **The most legible thing in the surface is an absence.** `change_set` has
  `begin`, `add_operations`, `preview`, `validate`, `amend`, `reject` — and no
  `accept`, `commit` or `apply`. An agent can withdraw its own proposal but cannot
  approve it. The acceptance boundary is readable from the tool list alone, without
  reading a word of prose. This is the single best thing about the first impression.
- **Exact numerics are advertised up front.** `{"$nendoNumber":"lexeme"}` appears in
  four separate schemas, with "never a rounded JavaScript number" said out loud. I
  knew the answer to "will a 19-digit integer survive" before I sent one.
- **Lost-response recovery is a first-class tool**, not a doc note:
  `nendo_data_get_receipt` takes an unprivileged `receiptContext` and explicitly
  "grants no edit access".
- **Two published ceilings are in the schemas themselves**: 1–8 mutations / ≤16
  operations per `add_operations` call; ≤50 records per `create_records`.
- **No escape hatch exists at the tool layer.** No SQL, no path, no process, no
  generic "run". Phase 5's last item is already half-answered by the shape of the list.

## What I could not tell

- **Nothing in the tool list names the newest feature.** "formula", "calculation",
  "computed", "trigger", "action", "screen", "view" appear in zero tool names and
  (except "compiled semantic surface") zero descriptions. Phase 4 of my brief is about
  calculations; from the tools alone I would not have known the product had them.
- **The tool surface is write-only.** Every read is a resource. An agent that enumerates
  tools and stops sees a product it can mutate but not inspect.
- **Where to begin is stated in prose, not structure.** "Read nendo://application/describe
  first" is in the server instructions; nothing in the tool list points at it.

## Two things that read oddly before I start

1. **The server instructions are addressed to the wrong reader.** They tell me to
   "call server/discover, then send each request with MCP-Protocol-Version, Mcp-Method
   and Mcp-Name headers and params._meta keys ... camelCase exactly as written", and
   that "an initialize call is refused". I am an agent behind a host MCP client; I do
   not construct headers. Either my host already speaks this dialect or nothing will
   work. This paragraph is operational detail for a transport implementer that costs
   an agent-reader attention and can be acted on by no one in my position.
2. **Two secrets, threaded through twelve tools.** Every owned call needs both
   `applicationHandle` and `leaseId`. The schemas do not say why one is not enough.

## Prediction I am recording so I can be wrong in public

The vocabulary resource will be large, and the gap between "the tool list" and "what I
actually need to author a formula" will be the whole review.
