import { escapeAttribute, escapeHtml } from './format';
import type { LaunchableAgent, LaunchableAgents } from './host-types';
import { icon } from './icons';

/**
 * A Copy that just ran on the Agent page: whether the text reached the clipboard, and the text.
 * It is drawn where the person clicked, on the button and in a line under it, rather than only
 * announced: the owner could not tell that anything had been copied (2026-10-08).
 */
export interface CopyFeedback { ok: boolean; text: string }

/** What a Copy button says: its label, or that it copied. */
export function copyButtonContent(label: string, copy: CopyFeedback | null): string {
  return copy?.ok === true ? `${icon('check')}<span>Copied</span>` : escapeHtml(label);
}

/**
 * The line under a Copy that just ran: what to do with the text, or, when the clipboard refused
 * it, the text itself to run by hand. `next` finishes "run it…", for example ", then open this
 * page again".
 */
export function copyHintMarkup(copy: CopyFeedback | null, next: string): string {
  if (copy === null) return '';
  return copy.ok
    ? `<p class="copy-hint" role="status">${icon('check')}<span>Copied to the clipboard. Paste it into a terminal and run it${escapeHtml(next)}.</span></p>`
    : `<p class="copy-hint is-failed" role="status"><span>Copy failed. Run this in a terminal${escapeHtml(next)}:</span><code>${escapeHtml(copy.text)}</code></p>`;
}

/** What Copy puts on the clipboard for an agent's tile, or null when the tile offers none. */
export function launchCopyText(agent: LaunchableAgent): string | null {
  return agent.found ? agent.updateCommand : agent.installCommand;
}

/** The ID the person's own command is hidden by, as the host keeps it. */
export const customAgentId = 'custom';

/** The Agent page's tabs (W-199, the owner's design A of 2026-10-09). */
export type AgentTab = 'activity' | 'launch' | 'connect';

export const agentTabs: ReadonlyArray<{ id: AgentTab; label: string }> = [
  { id: 'activity', label: 'Activity' },
  { id: 'launch', label: 'Launch' },
  { id: 'connect', label: 'Connect' },
];

/**
 * The tab strip. Each tab says in a word what is behind it, so a person need not open one to
 * know: how many changes wait, which agent runs, and where agents connect.
 */
export function agentTabsMarkup(selected: AgentTab, facts: { pending: number; running: string | null; endpoint: string | null }): string {
  const note = (tab: AgentTab): string => {
    switch (tab) {
      case 'activity': return facts.pending === 0 ? '' : `<span class="tab-badge">${facts.pending} waiting</span>`;
      case 'launch': return facts.running === null ? '' : `<span class="tab-dot" aria-hidden="true"></span><span class="tab-note">${escapeHtml(facts.running)} running</span>`;
      case 'connect': return `<span class="tab-note">${escapeHtml(facts.endpoint === null ? 'Off' : shortEndpoint(facts.endpoint))}</span>`;
    }
  };
  return `<div class="agent-tabs" role="tablist" aria-label="Agent access">${agentTabs.map((tab) => {
    const on = tab.id === selected;
    return `<button class="agent-tab" type="button" role="tab" id="agent-tab-${tab.id}" data-agent-tab="${tab.id}" aria-selected="${on}" aria-controls="agent-panel-${tab.id}" tabindex="${on ? 0 : -1}">${tab.label}${note(tab.id)}</button>`;
  }).join('')}</div>`;
}

function shortEndpoint(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, '').replace(/\/mcp\/?$/, '');
}

/** How Launch is drawn now: whether it may launch, what runs, whether hidden agents show, and any Copy that ran. */
export interface LaunchTilesView {
  canLaunch: boolean;
  running: { agentId: string; name: string; label: string } | null;
  showHidden: boolean;
  copyFor(agentId: string): CopyFeedback | null;
}

/**
 * Launch as tiles (ADR-0030, W-199): the running agent first, then the installed ones, the
 * person's own command, and the ones not installed. Each can be hidden on this computer, where
 * the person does not use it ("at work we only have Copilot"); a hidden one comes back from the
 * line under the tiles. The running agent is never hidden from view while it runs.
 */
export function launchTilesMarkup(offer: LaunchableAgents, view: LaunchTilesView): string {
  const hidden = new Set(offer.hidden);
  const running = view.running;
  const shown = (id: string): boolean => view.showHidden || !hidden.has(id) || running?.agentId === id;
  const known = offer.agents.filter((agent) => agent.id !== customAgentId);
  const order = [
    ...known.filter((agent) => agent.id === running?.agentId),
    ...known.filter((agent) => agent.found && agent.id !== running?.agentId),
  ];
  const missing = known.filter((agent) => !agent.found && agent.id !== running?.agentId);
  const tiles = [
    ...order.filter((agent) => shown(agent.id)).map((agent) => agentTileMarkup(agent, view, hidden.has(agent.id))),
    shown(customAgentId) ? customTileMarkup(offer, view, hidden.has(customAgentId)) : '',
    ...missing.filter((agent) => shown(agent.id)).map((agent) => agentTileMarkup(agent, view, hidden.has(agent.id))),
  ].join('');
  const names = [...known.filter((agent) => hidden.has(agent.id)).map((agent) => agent.name), ...(hidden.has(customAgentId) ? ['Your own command'] : [])];
  const hiddenLine = names.length === 0 ? '' : `<p class="launch-hidden-note">${view.showHidden
    ? `<span>Hidden agents are shown so you can bring one back with Show.</span><button class="text-button" type="button" data-toggle-hidden>Done</button>`
    : `<span>${names.length} hidden on this computer: ${escapeHtml(names.join(', '))}.</span><button class="text-button" type="button" data-toggle-hidden>Show hidden</button>`}</p>`;
  const empty = tiles === '' ? '<p class="quiet-state">Every agent is hidden on this computer.</p>' : '';
  return `${empty}<ul class="launch-grid">${tiles}</ul>${hiddenLine}`;
}

function hideButton(id: string, name: string, isHidden: boolean): string {
  return isHidden
    ? `<button class="launch-hide" type="button" data-agent-show="${escapeAttribute(id)}" aria-label="Show ${escapeAttribute(name)} again">Show</button>`
    : `<button class="launch-hide" type="button" data-agent-hide="${escapeAttribute(id)}" aria-label="Hide ${escapeAttribute(name)} on this computer">Hide</button>`;
}

function agentTileMarkup(agent: LaunchableAgent, view: LaunchTilesView, isHidden: boolean): string {
  const id = escapeAttribute(agent.id);
  const copy = view.copyFor(agent.id);
  const copied = copy?.ok === true ? ' is-copied' : '';
  const head = `<div class="launch-tile-head"><strong>${escapeHtml(agent.name)}</strong>${hideButton(agent.id, agent.name, isHidden)}</div>`;
  const faded = isHidden ? ' is-hidden' : '';
  if (!agent.found) {
    const install = agent.installCommand;
    return `<li class="launch-tile is-missing${faded}" data-agent-tile="${id}">${head}
      <small class="launch-line">${escapeHtml(install === null ? `Not found on this computer · ${agent.commandLine}` : 'Not installed')}</small>
      ${install === null ? '' : `<code class="launch-command-line">${escapeHtml(install)}</code><div class="launch-tile-foot"><button class="launch-copy${copied}" type="button" data-copy-agent="${id}" aria-label="Copy the command that installs ${escapeAttribute(agent.name)}">${copyButtonContent('Copy install command', copy)}</button></div>${copyHintMarkup(copy, ', then open this page again')}`}</li>`;
  }
  const renamed = agent.renamedFrom !== null && agent.updateCommand !== null
    ? `<div class="launch-renamed"><p>Installed from <code>${escapeHtml(agent.renamedFrom)}</code>, a package that was renamed and no longer gets updates. It may refuse to start.</p><button class="launch-copy${copied}" type="button" data-copy-agent="${id}" aria-label="Copy the commands that move ${escapeAttribute(agent.name)} to ${escapeAttribute(agent.package ?? '')}">${copyButtonContent('Copy update', copy)}</button>${copyHintMarkup(copy, ', then open this page again')}</div>`
    : '';
  const running = view.running?.agentId === agent.id ? view.running : null;
  const foot = running !== null
    ? `<span class="launch-state"><span class="tab-dot" aria-hidden="true"></span>${escapeHtml(running.label)}</span><button class="secondary-button" type="button" data-open-agent-chat>Open conversation</button>`
    : `<button class="secondary-button" type="button" data-launch-agent="${id}" data-action ${view.canLaunch && view.running === null && !isHidden ? '' : 'disabled'}>Launch</button>`;
  return `<li class="launch-tile${running !== null ? ' is-running' : ''}${faded}" data-agent-tile="${id}">${head}
      <code class="launch-command-line">${escapeHtml(agent.commandLine)}</code>${renamed}<div class="launch-tile-foot">${foot}</div></li>`;
}

function customTileMarkup(offer: LaunchableAgents, view: LaunchTilesView, isHidden: boolean): string {
  const custom = offer.agents.find((agent) => agent.id === customAgentId) ?? null;
  const running = view.running?.agentId === customAgentId ? view.running : null;
  const foot = custom === null
    ? '<small class="launch-line">Any program that speaks ACP on stdio</small>'
    : running !== null
      ? `<span class="launch-state"><span class="tab-dot" aria-hidden="true"></span>${escapeHtml(running.label)}</span><button class="secondary-button" type="button" data-open-agent-chat>Open conversation</button>`
      : custom.found
        ? `<button class="secondary-button" type="button" data-launch-agent="${customAgentId}" data-action ${view.canLaunch && view.running === null && !isHidden ? '' : 'disabled'}>Launch</button>`
        : '<small class="launch-line">Not found on this computer</small>';
  return `<li class="launch-tile is-custom${running !== null ? ' is-running' : ''}${isHidden ? ' is-hidden' : ''}" data-agent-tile="${customAgentId}"><div class="launch-tile-head"><strong>Your own command</strong>${hideButton(customAgentId, 'Your own command', isHidden)}</div>
      <label class="launch-command-field"><span class="visually-hidden">Your own command</span><input id="agent-command" type="text" spellcheck="false" autocomplete="off" maxlength="1000" value="${escapeAttribute(offer.customCommandLine ?? '')}" placeholder="program --acp"></label>
      <div class="launch-tile-foot">${foot}</div></li>`;
}
