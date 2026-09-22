import type { HelpProvider } from './help';

export const standardEndpoint = 'http://127.0.0.1:41763/mcp';

export type ConnectionClient = 'claude' | 'codex';

/** The whole client configuration is the address: no credential, no discovery file to read. */
export function connectionCommand(client: ConnectionClient, endpoint: string): string {
  return client === 'claude'
    ? `claude mcp add --transport http nendo ${endpoint}`
    : `codex mcp add nendo --url ${endpoint}`;
}

/** The copy buttons on the Agent page. Client names live in this file only; the page renders the list. */
export const connectionClients: ReadonlyArray<{ id: ConnectionClient; label: string }> = [
  { id: 'claude', label: 'Copy for Claude Code' },
  { id: 'codex', label: 'Copy for Codex' },
];

export const setupRequest = connectionClients.map((item) => connectionCommand(item.id, standardEndpoint)).join('\n');

export const clientHelp: HelpProvider = () => [
  { id: 'mcp', title: 'Connect an agent with MCP', category: 'Agents', summary: 'Connect your agent, choose access and review proposed changes.', setupRequest, related: ['agent-access', 'agent-surface', 'lanes'], sections: [
    { heading: 'What MCP does', paragraphs: ['MCP lets a compatible assistant read or change your open Nendo file through a local connection. The assistant runs in its own app. Switching Agent access on makes Nendo available; it does not connect the assistant automatically.', 'What each access level lets an agent do to your data is in “What an agent can see and do”. Every resource and tool it can call, with the limits and refusals, is in “The MCP surface”.'] },
    { heading: 'Connect your agent', steps: [
      'Open your .nendo file and leave Nendo running.',
      'Click Agent in the sidebar. Select Inspect for a first, read-only connection.',
      `Register the address with your client once. The address is the whole configuration; there is no credential. Claude Code: ${connectionCommand('claude', standardEndpoint)} — Codex: ${connectionCommand('codex', standardEndpoint)} — Agent → Connection shows the live address and copies either command.`,
      'Ask your agent to list your record types. In Nendo → Agent, check Recent activity for the reads. Most recent agent shows request activity, not a persistent connection. Editing ownership lasts until explicit release or revocation. Lease expiry is off unless the person turns it on.',
    ] },
    { heading: 'Choose what the agent may do', paragraphs: ['Inspect can read. Edit data can change existing records, create records and import them in bulk. Shape app also allows proposals for record types, fields and screens. Unattended lets the agent accept those proposals itself and run the automatic actions they install, without showing you first. Off stops local connections. Higher levels include the earlier abilities, and none of them is remembered when the file closes.', 'To request a screen, select Shape app, then ask: “Propose a simple screen for my records. Keep the existing records and titles, and wait for me to review.” Open Agent → Pending changes to inspect the proposal. Accept changes applies it; Reject leaves your active data unchanged.', 'Revoke edit access ends the current editing lease. Set access to Off to prevent the client from requesting access again. Closing or switching files also ends every lease.'] },
    { heading: 'If it does not connect', paragraphs: [
      'Confirm both apps are on the same computer, the file is still open and Agent access is not Off. “Ready for local agents” means Nendo is listening, not that an agent has used it.',
      'If port 41763 was already taken when access was switched on, Nendo listens on a temporary port for that session and Agent → Connection shows the address to use instead. Turning Fixed port off always uses a temporary port.',
      'Closing or switching files keeps the address but ends every lease; the agent acquires a new one. Another agent may own the editing lease; wait for it to finish or revoke editing in Nendo.',
    ] },
    { heading: 'Connection requirements', paragraphs: [
      `The server is loopback Streamable HTTP at ${standardEndpoint} while a file is open with access on. There is no credential: anything running on this computer can connect at the chosen access level, so leave access Off when no agent is working. A client may use the standard initialize handshake or MCP 2026-07-28; a handshake client appears as “Local agent” in Recent activity because its name travels only in the handshake. Editing requires the private application handle and lease returned by Nendo; release it when finished, and renew only if lease expiry has been turned on. Closing the agent alone does not release editing.`,
    ] },
  ] },
];
