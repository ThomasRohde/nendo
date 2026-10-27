# Contracts

The behavioural contracts of the delivered system: what the host guarantees, what it
refuses, and where the assertions live. Load only the contract your task touches.
The [architecture](../architecture.md) describes the structure;
[accepted ADRs](../decisions/README.md) are the authority above both. If a contract
and the code disagree, the code is current: fix the contract in the same change.

| Contract | Covers |
| --- | --- |
| [mcp-interface.md](mcp-interface.md) | The resources and tools an agent sees, lease and handle authority, cursors |
| [semantic-surfaces.md](semantic-surfaces.md) | How stored surface definitions compile into render plans (contract version 3) |
| [studio.md](studio.md) | The permanent host-owned database editor |
| [scalars.md](scalars.md) | Exact values through storage, the Workbench bridge and the MCP wire |
| [queries.md](queries.md) | Bounded record queries, cursors, tree reads, search and record windows |
| [relationships.md](relationships.md) | References, hierarchies, unique fields, allowed links, retirement, deletion, new files |
| [csv.md](csv.md) | The faithful CSV profile for import and export |
| [reads-and-authority.md](reads-and-authority.md) | Bounded reads and how read authority is scoped |
| [operation-outcomes.md](operation-outcomes.md) | How a client learns that an operation committed, and what a lost response permits |
| [help.md](help.md) | The permanent Help route and generated application reference |
| [calculations-and-actions.md](calculations-and-actions.md) | Calculated fields, reusable functions, automatic actions and triggers (ADR-0008) |
| [custom-views.md](custom-views.md) | Custom views carried in the file, the `window.nendo` API, kill switches (ADR-0013) |
| [media.md](media.md) | Media fields: addresses, embedded pictures, opening without the content, serving (ADR-0031) |
| [launched-agents.md](launched-agents.md) | The person's own agent launched from the Agent page over ACP (ADR-0030) |
| [web-export.md](web-export.md) | An application exported as one web page, what the page keeps, and Apply changes (ADR-0035) |
