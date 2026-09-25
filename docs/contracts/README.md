# Contracts

These are the behavioural contracts for the delivered system. Each contract
states what the host guarantees, what it refuses, and where the assertions live.
Load only the contract that your task touches. Do not load all of them.

The [architecture](../architecture.md) describes the structure of the system.
The contracts give the rules. [Accepted ADRs](../decisions/README.md) remain the
authority above both.

| Contract | Covers |
| --- | --- |
| [mcp-interface.md](mcp-interface.md) | The sixteen resources and nineteen tools that an agent sees, lease and handle authority, cursor rules |
| [semantic-surfaces.md](semantic-surfaces.md) | How stored surface definitions compile into render plans, across contract versions 1-3 |
| [studio.md](studio.md) | The permanent host-owned database editor |
| [scalars.md](scalars.md) | Exact values through storage, the Workbench bridge and the MCP wire |
| [queries.md](queries.md) | Bounded record queries: sorting, predicates, cursors |
| [relationships.md](relationships.md) | Reference fields, renames, deletion, retirement, reviewed backfill |
| [csv.md](csv.md) | The faithful CSV profile for import and export |
| [reads-and-authority.md](reads-and-authority.md) | Bounded reads and how read authority is scoped |
| [operation-outcomes.md](operation-outcomes.md) | How a client learns that an operation committed, and what a lost response permits |
| [help.md](help.md) | The permanent Help route and generated application reference |
| [calculations-and-actions.md](calculations-and-actions.md) | Stored calculations, reusable functions, local actions and triggers (ADR-0008, stages S1-S9; P1-P8 satisfied) |
| [custom-views.md](custom-views.md) | The custom-view execution boundary, and packages carried in the file: what the host guarantees and refuses for a view package (ADR-0013) |

If a contract and the code disagree, the code is current. Fix the contract in
the same change.
