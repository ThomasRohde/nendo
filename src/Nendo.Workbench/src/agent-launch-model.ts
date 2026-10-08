import { escapeAttribute, escapeHtml } from './format';
import type { LaunchableAgent } from './host-types';
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

/**
 * One row under Launch on the Agent page (ADR-0030). A found agent is a button that launches it.
 * One that is missing says what installs it, and one found from a package that was renamed and
 * left behind says so: the old name keeps its last version, and an agent that falls behind its
 * own settings refuses to start. Both commands are for the person to run in a terminal, with a
 * Copy beside them; Nendo never runs them. `copy` is the Copy that just ran on this row.
 */
export function launchRowMarkup(agent: LaunchableAgent, launchable: boolean, copy: CopyFeedback | null = null): string {
  const name = `<strong>${escapeHtml(agent.name)}</strong>`;
  const copied = copy?.ok === true ? ' is-copied' : '';
  const hint = copyHintMarkup(copy, ', then open this page again');
  if (!agent.found) {
    const install = agent.installCommand;
    return `<li><div class="launch-agent is-missing" data-agent-row="${escapeAttribute(agent.id)}">
      <span class="launch-name">${name}<small>${escapeHtml(install === null ? `Not found on this computer · ${agent.commandLine}` : `Not installed · ${install}`)}</small></span>
      ${install === null ? '' : `<button class="launch-copy${copied}" type="button" data-copy-agent="${escapeAttribute(agent.id)}" aria-label="Copy the command that installs ${escapeAttribute(agent.name)}">${copyButtonContent('Copy', copy)}</button>`}</div>${install === null ? '' : hint}</li>`;
  }
  const renamed = agent.renamedFrom !== null && agent.updateCommand !== null
    ? `<div class="launch-renamed"><p>Installed from <code>${escapeHtml(agent.renamedFrom)}</code>, a package that was renamed and no longer gets updates. It may refuse to start.</p><button class="launch-copy${copied}" type="button" data-copy-agent="${escapeAttribute(agent.id)}" aria-label="Copy the commands that move ${escapeAttribute(agent.name)} to ${escapeAttribute(agent.package ?? '')}">${copyButtonContent('Copy update', copy)}</button>${hint}</div>`
    : '';
  return `<li><button class="launch-agent" type="button" data-launch-agent="${escapeAttribute(agent.id)}" data-action ${launchable ? '' : 'disabled'}>
      <span class="launch-name">${name}<small>${escapeHtml(agent.commandLine)}</small></span>
      <span class="launch-go" aria-hidden="true">Launch</span></button>${renamed}</li>`;
}

/** What Copy puts on the clipboard for an agent's row, or null when the row offers none. */
export function launchCopyText(agent: LaunchableAgent): string | null {
  return agent.found ? agent.updateCommand : agent.installCommand;
}
