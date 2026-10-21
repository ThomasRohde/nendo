import type { AssistantStatus } from './extension-api/protocol';
import type { AgentSetting, LaunchableAgents, LaunchedAgentState, ViewAgentAccess } from './host-types';

/**
 * What a custom view's message to the launched agent needs next (ADR-0033), worked out from what
 * the Workbench knows. No DOM and no reads, so every branch is measured in the node lane;
 * view-assistant.ts shows the cards, launches, waits and sends.
 */

/** The conversation as far as a view's message cares. */
export interface AssistantConversation {
  exists: boolean;
  conversationId: string | null;
  state: LaunchedAgentState;
  working: boolean;
  name: string | null;
}

export interface AskFacts {
  access: ViewAgentAccess;
  conversation: AssistantConversation;
  /** What Launch offers on this computer; null where the host offers no Launch. */
  launchable: LaunchableAgents | null;
  /** The conversation (or `none`) this package was told Not now for, and when, if any. */
  declined: { key: string; at: number } | undefined;
  /** The time now, in the same clock as `declined.at`. */
  now: number;
  /** The conversation this package may message, if the person allowed it. */
  allowedFor: string | undefined;
  /**
   * The conversation launched from this package's card for an agent with no kept settings: its
   * own settings are shown, and the message goes on Send, before anything is sent.
   */
  settingsFor?: string | undefined;
}

export type AskStep =
  | { kind: 'refuse'; code: string; message: string }
  /** No agent can run now; the card says why and offers the Agent page. */
  | { kind: 'cannotLaunch'; reason: string }
  /** None installed and shown; the card offers the Agent page. */
  | { kind: 'noAgent' }
  /** None running: the card lists these to launch, with `selectedId` selected. */
  | { kind: 'launch'; agents: OfferedAgent[]; selectedId: string }
  /** Starting or signing in: wait for it. */
  | { kind: 'wait' }
  /** Launched from the card with no kept settings: show the agent's own, and send on Send. */
  | { kind: 'settings'; conversationId: string; agentName: string }
  /** Running, and the person has not said whether this view may message it. */
  | { kind: 'consent'; agentName: string }
  | { kind: 'send'; conversationId: string };

/** The key a Not now is kept under: the conversation it was said for, or `none` when none ran. */
export function conversationKey(conversation: AssistantConversation): string {
  return running(conversation) && conversation.conversationId !== null ? conversation.conversationId : 'none';
}

function running(conversation: AssistantConversation): boolean {
  return conversation.exists && conversation.state !== 'ended' && conversation.state !== 'none';
}

/** An agent a launch card lists, with its kept settings (null when it never ran here) and whether it was launched last. */
export interface OfferedAgent { id: string; name: string; settings: AgentSetting[] | null; last: boolean }

/**
 * The agents a view's card offers to launch: every one installed and shown, in the Agent page's
 * order, with the one last launched on this computer selected while it is still among them,
 * otherwise the first. The person picks; the view never does.
 */
export function agentsToOffer(launchable: LaunchableAgents): { agents: OfferedAgent[]; selectedId: string } | null {
  const hidden = new Set(launchable.hidden);
  const agents = launchable.agents.filter((agent) => agent.found && !hidden.has(agent.id))
    .map(({ id, name, settings }) => ({ id, name, settings: settings !== undefined && settings !== null && settings.length > 0 ? settings : null,
      last: id === launchable.lastAgentId }));
  if (agents.length === 0) return null;
  const last = agents.find((agent) => agent.id === launchable.lastAgentId);
  return { agents, selectedId: (last ?? agents[0]!).id };
}

/**
 * How long a Not now refuses a view without a card: long enough that a view asking again at once
 * cannot keep the card in front of the person, short enough that the person's own next press in
 * the view shows the card again. With no agent running the conversation never changes by itself,
 * so a Not now kept until it did refused every later press.
 */
export const declineHoldMs = 30_000;

export function nextAskStep(facts: AskFacts): AskStep {
  if (facts.access === 'never')
    return { kind: 'refuse', code: 'assistant-off', message: 'Views may not message the agent on this computer. The person can change it on the Agent page.' };
  const conversation = facts.conversation;
  if (facts.declined !== undefined && facts.declined.key === conversationKey(conversation) && facts.now - facts.declined.at < declineHoldMs)
    return { kind: 'refuse', code: 'assistant-declined', message: 'The person said Not now to this view just now. Ask again when they ask for it.' };
  if (!running(conversation)) {
    if (facts.launchable === null) return { kind: 'refuse', code: 'assistant-unavailable', message: 'This Nendo cannot launch an agent.' };
    if (!facts.launchable.canLaunch) return { kind: 'cannotLaunch', reason: facts.launchable.reason ?? 'An agent cannot be launched now.' };
    const offer = agentsToOffer(facts.launchable);
    return offer === null ? { kind: 'noAgent' } : { kind: 'launch', ...offer };
  }
  if (conversation.state !== 'ready' || conversation.conversationId === null) return { kind: 'wait' };
  if (facts.settingsFor === conversation.conversationId)
    return { kind: 'settings', conversationId: conversation.conversationId, agentName: conversation.name ?? 'the agent' };
  if (facts.access === 'ask' && facts.allowedFor !== conversation.conversationId)
    return { kind: 'consent', agentName: conversation.name ?? 'the agent' };
  // A turn running is no reason to refuse: the host keeps the message until it ends (ACP runs one
  // turn at a time), and refuses it as busy only past its bound.
  return { kind: 'send', conversationId: conversation.conversationId };
}

/** The status a view hears: nothing about the agent's model, effort or mode. */
export function assistantStatus(conversation: AssistantConversation, access: ViewAgentAccess): AssistantStatus {
  const state = !conversation.exists ? 'none' : conversation.state;
  return {
    state,
    name: conversation.exists ? conversation.name : null,
    working: conversation.exists && conversation.state !== 'ended' && conversation.working,
    access,
  };
}

/**
 * What a launch card sends with the agent: the settings the person changed from what is kept,
 * each a value the agent offered. Nothing for an agent with no kept settings.
 */
export function changedSettings(settings: AgentSetting[] | null, picked: ReadonlyMap<string, string>): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const setting of settings ?? []) {
    const value = picked.get(setting.id);
    if (value !== undefined && value !== setting.value && setting.values.some((candidate) => candidate.value === value)) changed[setting.id] = value;
  }
  return changed;
}

/** The first line of a view's message, for the card: at most `limit` characters. */
export function messagePreview(text: string, limit = 200): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
