import { WorkbenchHostError, type AgentOption, type AgentStatus, type AgentTranscriptEntry, type LaunchableAgents, type LaunchedAgentState, type LaunchedAgentView } from './host-types';

/**
 * A launched agent for the browser preview (ADR-0030): the same requests and the same nudges as
 * the Desktop host, answered by a short script, so the Agent page's Launch and the conversation
 * tab can be seen and measured without an agent program. Every prompt gets a plan, a read, a
 * permission request and, once it is answered, a reply in chunks.
 */
export class PreviewAgentSession {
  private readonly listeners = new Set<(revision: number) => void>();
  private entries: AgentTranscriptEntry[] = [];
  private revision = 0;
  private order = 0;
  private state: LaunchedAgentState = 'none';
  private working = false;
  private notice: string | null = null;
  private agent: { id: string; name: string; commandLine: string } | null = null;
  private customCommandLine: string | null = null;
  // The options Copilot CLI 1.0.93 offered when probed on 2026-10-08, trimmed.
  private options: AgentOption[] = [
    { id: 'mode', name: 'Mode', description: null, category: 'mode', currentValue: 'agent', values: [
      { value: 'agent', name: 'Agent', description: null, group: null }, { value: 'plan', name: 'Plan', description: null, group: null },
      { value: 'autopilot', name: 'Autopilot', description: null, group: null }] },
    { id: 'model', name: 'Model', description: null, category: 'model', currentValue: 'sonnet-4.6', values: [
      { value: 'auto', name: 'Auto', description: null, group: null }, { value: 'sonnet-4.6', name: 'Sonnet 4.6', description: null, group: null },
      { value: 'haiku-4.5', name: 'Haiku 4.5', description: null, group: null }, { value: 'gpt-5.4', name: 'GPT-5.4', description: null, group: null }] },
    { id: 'reasoning_effort', name: 'Reasoning Effort', description: null, category: 'thought_level', currentValue: 'medium', values: [
      { value: 'low', name: 'Low', description: null, group: null }, { value: 'medium', name: 'Medium', description: null, group: null },
      { value: 'high', name: 'High', description: null, group: null }, { value: 'max', name: 'Max', description: null, group: null }] },
    { id: 'allow_all', name: 'Allow All', description: 'Run every tool without asking', category: 'permissions', currentValue: 'off', values: [
      { value: 'on', name: 'On', description: null, group: null }, { value: 'off', name: 'Off', description: null, group: null }] },
  ];

  constructor(private readonly status: () => AgentStatus) {}

  onChanged(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  handle(method: string, payload: Record<string, unknown>): unknown {
    switch (method) {
      case 'agentSession.list': return this.list();
      case 'agentSession.setCommand':
        this.customCommandLine = typeof payload.commandLine === 'string' && payload.commandLine.trim() !== '' ? payload.commandLine.trim() : null;
        return this.list();
      case 'agentSession.launch': return this.launch(String(payload.agentId ?? ''));
      case 'agentSession.read': return this.read(Number(payload.after ?? 0));
      case 'agentSession.prompt': return this.sendPrompt(String(payload.text ?? ''), Number(payload.after ?? 0));
      case 'agentSession.answer': return this.answer(String(payload.entryId ?? ''), payload.optionId == null ? null : String(payload.optionId), Number(payload.after ?? 0));
      case 'agentSession.cancel': return this.cancel(Number(payload.after ?? 0));
      case 'agentSession.end': return this.end('You ended the conversation.', Number(payload.after ?? 0));
      case 'agentSession.setOption': {
        const option = this.options.find((candidate) => candidate.id === payload.configId);
        if (option === undefined || !option.values.some((value) => value.value === payload.value))
          throw new WorkbenchHostError('validation', 'The agent does not offer that.');
        option.currentValue = String(payload.value);
        this.touch();
        return this.read(Number(payload.after ?? 0));
      }
      case 'agentSession.authenticate': throw new WorkbenchHostError('agent-not-signing-in', 'The agent is not waiting to sign in.');
      default: throw new WorkbenchHostError('unknown-method', `Preview does not implement ${method}.`);
    }
  }

  private list(): LaunchableAgents {
    const mode = this.status().mode;
    const agents = [
      { id: 'copilot', name: 'GitHub Copilot CLI', commandLine: 'copilot --acp', found: true },
      { id: 'gemini', name: 'Gemini CLI', commandLine: 'gemini --experimental-acp', found: false },
      { id: 'opencode', name: 'OpenCode', commandLine: 'opencode acp', found: true },
      ...(this.customCommandLine === null ? [] : [{ id: 'custom', name: 'Your command', commandLine: this.customCommandLine, found: true }]),
    ];
    const running = this.agent !== null && this.state !== 'ended'
      ? { agentId: this.agent.id, name: this.agent.name, state: this.state, working: this.working }
      : null;
    return {
      canLaunch: mode !== 'off',
      reason: mode === 'off' ? 'Choose Inspect or a higher access level first. The agent works at the level you choose.' : null,
      agents,
      customCommandLine: this.customCommandLine,
      running,
    };
  }

  private launch(agentId: string): LaunchedAgentView {
    const offer = this.list();
    if (!offer.canLaunch) throw new WorkbenchHostError('agent-launch-unavailable', offer.reason ?? 'An agent cannot be launched now.');
    const agent = offer.agents.find((candidate) => candidate.id === agentId && candidate.found);
    if (agent === undefined) throw new WorkbenchHostError('agent-not-found', 'That agent is not installed on this computer.');
    this.agent = agent;
    this.entries = [];
    this.revision = 0;
    this.order = 0;
    this.state = 'starting';
    this.working = false;
    this.notice = null;
    window.setTimeout(() => { this.state = 'ready'; this.touch(); }, 400);
    return this.read(0);
  }

  private sendPrompt(text: string, after: number): LaunchedAgentView {
    if (this.state !== 'ready' || this.working) throw new WorkbenchHostError('agent-not-ready', 'The agent is not ready for a message yet.');
    if (text.trim() === '') throw new WorkbenchHostError('validation', 'Type something for the agent first.');
    this.working = true;
    this.add({ kind: 'you', text: text.trim() });
    const plan = this.add({ kind: 'plan', text: '', plan: [
      { text: 'Read the record types', status: 'in_progress' },
      { text: 'Add a record type for the request', status: 'pending' },
    ] });
    this.later(500, () => this.add({ kind: 'tool', text: 'Two record types: Crew and Mission.', title: 'nendo-nendo-read-resource', toolKind: 'read', status: 'completed', input: '{"uri":"nendo://application/manifest"}', origin: 'nendo' }));
    this.later(700, () => this.add({ kind: 'tool', text: '{ "examples": [ … ] }', title: 'Read its saved tool output', toolKind: 'execute', status: 'completed', input: '{"command":"Get-Content $env:TEMP\\\\copilot-tool-output.txt -Raw"}', origin: 'agent' }));
    this.later(900, () => {
      this.change(plan, { plan: [{ text: 'Read the record types', status: 'completed' }, { text: 'Add a record type for the request', status: 'in_progress' }] });
      this.add({ kind: 'permission', text: '', title: 'Add operations to a change set', toolKind: 'edit', origin: 'nendo', input: '{"applicationHandle":"(hidden)","operations":[{"operationType":"schema.createEntity"}]}',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    });
    return this.read(after);
  }

  private answer(entryId: string, optionId: string | null, after: number): LaunchedAgentView {
    const entry = this.entries.find((candidate) => candidate.id === entryId && candidate.kind === 'permission' && candidate.answer === null);
    if (entry === undefined) throw new WorkbenchHostError('agent-question-gone', 'The agent is no longer waiting for that answer.');
    const option = entry.options?.find((candidate) => candidate.optionId === optionId) ?? null;
    this.change(entry, { answer: option?.name ?? 'Cancelled' });
    const words = option?.optionId === 'allow'
      ? ['I proposed a **Task** record type ', 'with a title and a due date. ', 'Review it on the Agent page.']
      : ['Understood, I left the file as it was.'];
    let message: AgentTranscriptEntry | null = null;
    words.forEach((chunk, index) => this.later(300 * (index + 1), () => {
      if (message === null) message = this.add({ kind: 'agent', text: chunk });
      else this.change(message, { text: message.text + chunk });
      if (index === words.length - 1) { this.working = false; this.touch(); }
    }));
    return this.read(after);
  }

  private cancel(after: number): LaunchedAgentView {
    if (this.working) {
      this.working = false;
      for (const entry of this.entries.filter((candidate) => candidate.kind === 'permission' && candidate.answer === null))
        this.change(entry, { answer: 'Cancelled' });
      this.add({ kind: 'notice', text: 'Stopped.' });
    }
    return this.read(after);
  }

  private end(notice: string, after: number): LaunchedAgentView {
    if (this.agent === null) throw new WorkbenchHostError('agent-not-launched', 'No agent is running for this file. Launch one from the Agent page.');
    if (this.state !== 'ended') {
      this.state = 'ended';
      this.working = false;
      this.notice = notice;
      this.add({ kind: 'notice', text: notice });
    }
    return this.read(after);
  }

  private read(after: number): LaunchedAgentView {
    const changed = this.entries.filter((entry) => entry.revision > after);
    return {
      exists: this.agent !== null,
      agentId: this.agent?.id ?? null,
      name: this.agent?.name ?? null,
      commandLine: this.agent?.commandLine ?? null,
      endpoint: this.status().endpoint ?? 'http://127.0.0.1:41763/mcp',
      level: levelName(this.status().mode),
      state: this.state,
      working: this.working,
      notice: this.notice,
      agentTitle: this.agent === null ? null : `${this.agent.name} (preview)`,
      revision: this.revision,
      entries: structuredClone(changed),
      more: false,
      signInMethods: [],
      options: this.agent === null || this.state === 'starting' ? [] : structuredClone(this.options),
    };
  }

  private add(fields: Partial<AgentTranscriptEntry> & Pick<AgentTranscriptEntry, 'kind' | 'text'>): AgentTranscriptEntry {
    this.order += 1;
    const entry: AgentTranscriptEntry = {
      id: `e${this.order}`, order: this.order, revision: this.revision + 1, title: null, toolKind: null, status: null,
      input: null, options: null, answer: null, plan: null, origin: null, ...fields,
    };
    this.entries.push(entry);
    this.touch();
    return entry;
  }

  private change(entry: AgentTranscriptEntry, fields: Partial<AgentTranscriptEntry>): void {
    Object.assign(entry, fields, { revision: this.revision + 1 });
    this.touch();
  }

  private touch(): void {
    this.revision += 1;
    const revision = this.revision;
    queueMicrotask(() => { for (const listener of this.listeners) listener(revision); });
  }

  private later(delay: number, step: () => void): void {
    window.setTimeout(() => { if (this.state !== 'ended') step(); }, delay);
  }
}

function levelName(mode: AgentStatus['mode']): string {
  switch (mode) {
    case 'inspect': return 'Inspect';
    case 'editData': return 'Edit data';
    case 'shapeApp': return 'Shape app';
    case 'unattended': return 'Unattended';
    default: return 'Off';
  }
}
