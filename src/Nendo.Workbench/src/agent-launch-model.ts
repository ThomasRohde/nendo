import { escapeAttribute, escapeHtml } from './format';
import type { LaunchableAgent } from './host-types';

/**
 * One row under Launch on the Agent page (ADR-0030). A found agent is a button that launches it.
 * One that is missing says what installs it, and one found from a package that was renamed and
 * left behind says so: the old name keeps its last version, and an agent that falls behind its
 * own settings refuses to start. Both commands are for the person to run in a terminal, with a
 * Copy beside them; Nendo never runs them.
 */
export function launchRowMarkup(agent: LaunchableAgent, launchable: boolean): string {
  const name = `<strong>${escapeHtml(agent.name)}</strong>`;
  if (!agent.found) {
    const install = agent.installCommand;
    return `<li><div class="launch-agent is-missing" data-agent-row="${escapeAttribute(agent.id)}">
      <span class="launch-name">${name}<small>${escapeHtml(install === null ? `Not found on this computer · ${agent.commandLine}` : `Not installed · ${install}`)}</small></span>
      ${install === null ? '' : `<button class="launch-copy" type="button" data-copy-agent="${escapeAttribute(agent.id)}" aria-label="Copy the command that installs ${escapeAttribute(agent.name)}">Copy</button>`}</div></li>`;
  }
  const renamed = agent.renamedFrom !== null && agent.updateCommand !== null
    ? `<div class="launch-renamed"><p>Installed from <code>${escapeHtml(agent.renamedFrom)}</code>, a package that was renamed and no longer gets updates. It may refuse to start.</p><button class="launch-copy" type="button" data-copy-agent="${escapeAttribute(agent.id)}" aria-label="Copy the commands that move ${escapeAttribute(agent.name)} to ${escapeAttribute(agent.package ?? '')}">Copy update</button></div>`
    : '';
  return `<li><button class="launch-agent" type="button" data-launch-agent="${escapeAttribute(agent.id)}" data-action ${launchable ? '' : 'disabled'}>
      <span class="launch-name">${name}<small>${escapeHtml(agent.commandLine)}</small></span>
      <span class="launch-go" aria-hidden="true">Launch</span></button>${renamed}</li>`;
}

/** What Copy puts on the clipboard for an agent's row, or null when the row offers none. */
export function launchCopyText(agent: LaunchableAgent): string | null {
  return agent.found ? agent.updateCommand : agent.installCommand;
}
