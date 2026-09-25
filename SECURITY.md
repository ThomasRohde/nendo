# Security

Nendo is an experimental prototype. There is no release channel, no support
commitment and no security-patch schedule. What follows is the boundary the
design actually claims, so a report can be judged against it rather than against
an assumed one.

## The trust boundary, stated plainly

**The boundary is this computer, at the access level the owner chose.** While a
file is open with Agent access on, Nendo listens on `127.0.0.1:41763`. Any
process on the machine, under any account, can connect at that level. There is
no credential: exact Host and Origin matching keeps browser origins and DNS
rebinding out, and the owner's controls are the access level (Off by default),
lease revocation and the approval dialog for application changes.

**It is not an anti-malware boundary, and it is the wrong posture for a shared
machine.** That is a deliberate choice for single-user iteration speed, recorded
in [ADR-0009](docs/decisions/0009-local-mcp-transport-authority-and-change-sets.md)
and listed as an accepted limitation in [the roadmap](docs/roadmap.md).

Inside that perimeter, three boundaries are real and a bypass of any of them is a
vulnerability:

| Boundary | What it claims |
| --- | --- |
| Agents to storage | An agent gets typed semantic operations only — never SQL, a connection, a database path or the filesystem. Physical table and column names are validated against a strict allow-list and quoted |
| Proposal to file | Authoring changes are validated on a physical clone and shown as a diff. Accepting replays the exact validated operations. At every access level but *Unattended*, a person accepts |
| Custom view to Workbench | A view is a cross-origin frame on an origin of its own, `https://{package}-{key}.example`, in a renderer process of its own. It reaches the file only through the broker's closed method table in `window.nendo`, never the Workbench's document, the host bridge, SQL, a path, another file or a device setting. It cannot navigate the Workbench away, load the Workbench in a frame, or accept a proposal |

*Unattended* access is the one level where an agent accepts its own proposal. It
is off by default, confirmed before it takes effect, never persisted, and ends
when the level drops or the file closes. That it can change a file with nobody
reading the diff is the documented point of it, not a defect.

**Custom views are code, and a file carries them.** Since 2026-09-25
([ADR-0013](docs/decisions/0013-custom-views-with-code-in-the-file.md)) a view's
code lives in the `.nendo` file and runs when its view is shown: no install step,
no consent, no pin. That is the owner's chosen trade for an exploratory project.
A received file's code can read all of that file's records, reach the network
(loopback included) and the clipboard, and start downloads. The controls are the
kill switches: **Run custom views** on this device, a switch for each file, and
**Restart without custom views** in recovery. A view never runs in a file that is
in recovery or not healthy.

## What to report

Please report anything that crosses one of the three boundaries above — for
example an agent operation that reaches arbitrary SQL or a path, a proposal that
reaches the active file without validation or acceptance, a custom view that
reaches the Workbench's document or the host bridge, calls a method outside the
broker's table, or runs while views are switched off, or a way for a non-loopback
or browser-origin request to be accepted.

Please do **not** report the accepted limitations: that any local process can
connect while access is on, that there is no account boundary on a shared
machine, that the installer is unsigned, that *Unattended* access does what it
says, or that a custom view carried in a file runs with network, clipboard and
record access when it is shown. These are stated in [the roadmap](docs/roadmap.md)
and in ADR-0013, and changing them needs a decision, not a patch.

## How to report

**There is no private channel today.** GitHub's private vulnerability reporting
is not enabled on this repository and no security address is published. Saying so
is better than pointing at a button that is not there.

Open a public issue naming the **area** only — which of the boundaries above,
roughly where, and what kind of bypass. No working exploit, no proof-of-concept
payload, no steps that hand someone else the bug. Say that you have the detail,
and a private channel will be arranged before you send it.

If that is not good enough for what you have found, say only that you have
something and wait to be contacted.

Expect a slow, best-effort reply from one person. There is no embargo process, no
CVE pipeline and no bounty. Nendo runs on one machine, against one person's own
file, with the agent endpoint off by default — the realistic blast radius of
anything found here is the person who chose to turn it on.

## Reading the code

[docs/architecture.md](docs/architecture.md) describes the system as built, and
its "Where things live" table points at the files behind each boundary above.
The enforcement worth reading first:

- `src/Nendo.LocalMcp/NendoMcpSecurityMiddleware.cs` — the loopback perimeter
- `src/Nendo.LocalMcp/NendoAgentAuthority.cs` — access levels and leases
- `src/Nendo.Engine/Storage/SqliteNendoStore.Operations.cs` — identifier
  validation and quoting, the only place SQL is built
- `src/Nendo.Desktop/Extensions/ExtensionAssetServer.cs` and
  `ExtensionWebViewPolicy.cs` — serving views from the file, and what a view may
  do in the browser
- `src/Nendo.Workbench/src/extension-broker.ts` — the only door from a view to
  the file

`tools/Test-Production.ps1` asserts several of these boundaries directly, so a
change that relaxes one fails the gate by name.
