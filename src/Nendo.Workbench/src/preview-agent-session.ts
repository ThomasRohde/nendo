import { WorkbenchHostError, type AgentCommand, type AgentOption, type AgentSetting, type AgentStatus, type AgentTranscriptEntry, type AgentTurn, type AgentUsage, type LaunchableAgent, type LaunchableAgents, type LaunchedAgentState, type LaunchedAgentView, type ViewAgentAccess } from './host-types';

/** A PNG of one pixel, which the preview agent shows when asked for a picture. */
const previewPicture = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * A launched agent for the browser preview (ADR-0030): the same requests and the same nudges as
 * the Desktop host, answered by a short script, so the Agent page's Launch and the conversation
 * tab can be seen and measured without an agent program. Every prompt gets a plan, a read, a
 * permission request and, once it is answered, a reply in chunks. The prompt "parallel" gets two
 * steps at once, the first of which says what came back only once the request is answered. A
 * custom view's message (ADR-0033) gets a read and a reply, and its turn is read back whole.
 *
 * A step it scheduled belongs to the launch and the turn that scheduled it: Stop, End or another
 * launch drops it, and a launch is refused while an agent runs, as the Desktop host does. Old
 * timers wrote into the next conversation and ran after Stop, so the agent-chat lane could read
 * states production never reaches.
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
  private conversationId: string | null = null;
  private launches = 0;
  /** Moves on with every turn that ends early (Stop) and with every launch and End. */
  private turn = 0;
  /** A "parallel" turn's first step, which completes once its request is answered. */
  private pendingStep: AgentTranscriptEntry | null = null;
  private customCommandLine: string | null = null;
  private hidden: string[] = [];
  private lastAgentId: string | null = null;
  private viewAccess: ViewAgentAccess = 'ask';
  private startInRepository = false;
  /** Turns started by a prompt, by ID: the order of the message, and how the turn stopped once it has. */
  private turns = new Map<string, { promptOrder: number; stopReason: string | null }>();
  private openTurn: string | null = null;
  /** Views' messages waiting for the turn that runs, as the Desktop host keeps them. */
  private queue: Array<{ turnId: string; text: string; from: string }> = [];
  // Slash commands as an ACP agent advertises them, trimmed.
  private commands: AgentCommand[] = [
    { name: 'review', description: 'Review the changes waiting in this file', hint: 'what to look at' },
    { name: 'compact', description: 'Summarise the conversation so far', hint: null },
    { name: 'init', description: 'Write a guide to this file for later sessions', hint: null },
  ];
  /** What each agent's settings were kept as on this computer: the options it offered and the person's picks (ADR-0030). */
  private kept = new Map<string, { options: AgentOption[]; picked: Map<string, string> }>();
  // The options Copilot CLI 1.0.93 offers, trimmed.
  private readonly defaultOptions: AgentOption[] = [
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
    { id: 'verbose', name: 'Verbose', description: 'Say more about each step', category: null, currentValue: 'false', type: 'boolean', values: [
      { value: 'true', name: 'On', description: null, group: null }, { value: 'false', name: 'Off', description: null, group: null }] },
  ];

  private options: AgentOption[] = structuredClone(this.defaultOptions);

  constructor(private readonly status: () => AgentStatus) {}

  /** The person picked `value` for `configId` of `agentId`: kept, with the options it offers now. */
  private keep(agentId: string, picks: Record<string, string>): void {
    const kept = this.kept.get(agentId) ?? { options: structuredClone(this.options), picked: new Map<string, string>() };
    for (const [id, value] of Object.entries(picks)) kept.picked.set(id, value);
    this.kept.set(agentId, kept);
  }

  private settingsOf(agentId: string): AgentSetting[] | null {
    const kept = this.kept.get(agentId);
    if (kept === undefined) return null;
    return kept.options.map((option) => {
      const picked = kept.picked.get(option.id);
      return { id: option.id, name: option.name, category: option.category,
        value: picked !== undefined && option.values.some((value) => value.value === picked) ? picked : option.currentValue,
        values: option.values.map(({ value, name, group }) => ({ value, name, group })) };
    });
  }

  onChanged(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The access level changed: the conversation's tab reads again, as the Desktop host tells it to. */
  levelChanged(): void {
    if (this.agent === null) return;
    const revision = this.revision;
    queueMicrotask(() => { for (const listener of this.listeners) listener(revision); });
  }

  handle(method: string, payload: Record<string, unknown>): unknown {
    // A request meant for a conversation since replaced is refused, as the Desktop host does.
    if (typeof payload.conversationId === 'string' && payload.conversationId !== this.conversationId)
      throw new WorkbenchHostError('agent-conversation-replaced', 'That conversation has been replaced by a new one. Nothing was sent.');
    switch (method) {
      case 'agentSession.list': return this.list();
      case 'agentSession.setCommand': {
        const line = typeof payload.commandLine === 'string' && payload.commandLine.trim() !== '' ? payload.commandLine.trim() : null;
        if (line !== this.customCommandLine) this.kept.delete('custom');
        this.customCommandLine = line;
        return this.list();
      }
      case 'agentSession.setHidden': {
        const agentId = String(payload.agentId ?? '');
        if (!['copilot', 'gemini', 'opencode', 'custom'].includes(agentId)) throw new WorkbenchHostError('validation', 'Choose one of the agents the Agent page offers.');
        this.hidden = this.hidden.filter((id) => id !== agentId);
        if (payload.hidden === true) this.hidden.push(agentId);
        return this.list();
      }
      case 'agentSession.setViewAccess': {
        const access = String(payload.access ?? '');
        if (access !== 'never' && access !== 'ask' && access !== 'always') throw new WorkbenchHostError('validation', 'Choose never, ask or always.');
        this.viewAccess = access;
        return this.list();
      }
      case 'agentSession.turn': return this.readTurn(String(payload.turnId ?? ''));
      case 'agentSession.setStartIn':
        this.startInRepository = payload.repository === true;
        return this.list();
      case 'agentSession.launch': return this.launch(String(payload.agentId ?? ''),
        typeof payload.settings === 'object' && payload.settings !== null ? payload.settings as Record<string, string> : {});
      case 'agentSession.read': return this.read(Number(payload.after ?? 0));
      case 'agentSession.image': {
        const id = String(payload.imageId ?? '');
        if (id !== 'p1') throw new WorkbenchHostError('agent-image-gone', 'That picture is no longer kept.');
        return { base64: previewPicture, length: atob(previewPicture).length, mediaType: 'image/png', next: null };
      }
      case 'agentSession.attach': return this.stagePicture(String(payload.uploadKey ?? ''), Number(payload.offset ?? 0), String(payload.base64 ?? ''));
      case 'agentSession.prompt': return this.sendPrompt(String(payload.text ?? ''), Number(payload.after ?? 0),
        [...this.pictures(payload.images), ...(Array.isArray(payload.context) ? payload.context.map((item) => String((item as { title?: unknown }).title ?? '')).filter((title) => title !== '') : [])],
        typeof payload.from === 'string' && payload.from !== '' ? payload.from : null);
      case 'agentSession.answer': return this.answer(String(payload.entryId ?? ''), payload.optionId == null ? null : String(payload.optionId), Number(payload.after ?? 0));
      case 'agentSession.cancel': return typeof payload.turnId === 'string'
        ? this.cancelTurn(payload.turnId, Number(payload.after ?? 0))
        : this.cancel(Number(payload.after ?? 0));
      case 'agentSession.end': return this.end('You ended the conversation.', Number(payload.after ?? 0));
      case 'agentSession.setOption': {
        const option = this.options.find((candidate) => candidate.id === payload.configId);
        if (option === undefined || !option.values.some((value) => value.value === payload.value))
          throw new WorkbenchHostError('validation', 'The agent does not offer that.');
        option.currentValue = String(payload.value);
        if (this.agent !== null) {
          this.keep(this.agent.id, { [option.id]: option.currentValue });
          this.kept.get(this.agent.id)!.options = structuredClone(this.options);
        }
        this.touch();
        return this.read(Number(payload.after ?? 0));
      }
      case 'agentSession.authenticate': throw new WorkbenchHostError('agent-not-signing-in', 'The agent is not waiting to sign in.');
      default: throw new WorkbenchHostError('unknown-method', `Preview does not implement ${method}.`);
    }
  }

  private list(): LaunchableAgents {
    const mode = this.status().mode;
    const npm = (id: string, name: string, commandLine: string, found: boolean, pkg: string): LaunchableAgent =>
      ({ id, name, commandLine, found, package: pkg, installCommand: `npm install -g ${pkg}`, renamedFrom: null, updateCommand: null, settings: this.settingsOf(id) });
    const agents: LaunchableAgent[] = [
      npm('copilot', 'GitHub Copilot CLI', 'copilot --acp', true, '@github/copilot'),
      npm('gemini', 'Gemini CLI', 'gemini --experimental-acp', false, '@google/gemini-cli'),
      npm('opencode', 'OpenCode', 'opencode acp', true, 'opencode-ai'),
      ...(this.customCommandLine === null ? [] : [{ id: 'custom', name: 'Your command', commandLine: this.customCommandLine, found: true,
        package: null, installCommand: null, renamedFrom: null, updateCommand: null, settings: this.settingsOf('custom') }]),
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
      hidden: [...this.hidden],
      lastAgentId: this.lastAgentId,
      viewAccess: this.viewAccess,
      startInRepository: this.startInRepository,
      repositoryFolder: 'C:\\Users\\you\\Projects\\atlas',
    };
  }

  private readTurn(turnId: string): AgentTurn {
    const turn = this.turns.get(turnId);
    if (turn === undefined) throw new WorkbenchHostError('agent-turn-gone', "That message's turn is no longer kept. Read the conversation instead.");
    const reply = turn.stopReason === null ? null
      : this.entries.filter((entry) => entry.kind === 'agent' && entry.order > turn.promptOrder).map((entry) => entry.text).join('\n\n');
    return { turnId, done: turn.stopReason !== null, reply, stopReason: turn.stopReason };
  }

  /** The turn running now ends, with ACP's word for why; the next view's message waiting starts. */
  private endTurn(stopReason: string): void {
    const turn = this.openTurn === null ? undefined : this.turns.get(this.openTurn);
    if (turn !== undefined && turn.stopReason === null) turn.stopReason = stopReason;
    this.openTurn = null;
    const next = this.state === 'ready' ? this.queue.shift() : undefined;
    if (next === undefined) return;
    this.working = true;
    this.count(next.text);
    const said = this.add({ kind: 'you', text: next.text, from: next.from });
    this.turns.set(next.turnId, { promptOrder: said.order, stopReason: null });
    this.openTurn = next.turnId;
    this.viewTurn(next.text, 0);
  }

  /** Every view's message still waiting ends unsent. */
  private dropQueue(stopReason: string): void {
    for (const waiting of this.queue) this.turns.set(waiting.turnId, { promptOrder: Number.MAX_SAFE_INTEGER, stopReason });
    this.queue = [];
  }

  /** A view stops its own turn: dropped while it waits, cancelled while it runs. */
  private cancelTurn(turnId: string, after: number): LaunchedAgentView {
    const index = this.queue.findIndex((waiting) => waiting.turnId === turnId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.turns.set(turnId, { promptOrder: Number.MAX_SAFE_INTEGER, stopReason: 'cancelled' });
      this.touch();
      return this.read(after);
    }
    if (this.openTurn !== turnId || !this.working) return this.read(after);
    this.turn += 1;
    this.working = false;
    for (const entry of this.entries.filter((candidate) => candidate.kind === 'permission' && candidate.answer === null))
      this.change(entry, { answer: 'Cancelled' });
    this.add({ kind: 'notice', text: 'Stopped.' });
    this.endTurn('cancelled');
    return this.read(after);
  }

  private launch(agentId: string, settings: Record<string, string> = {}): LaunchedAgentView {
    const offer = this.list();
    if (!offer.canLaunch) throw new WorkbenchHostError('agent-launch-unavailable', offer.reason ?? 'An agent cannot be launched now.');
    if (offer.running !== null)
      throw new WorkbenchHostError('agent-already-running', `${offer.running.name} is already running for this file. End it before launching another.`);
    const agent = offer.agents.find((candidate) => candidate.id === agentId && candidate.found);
    if (agent === undefined) throw new WorkbenchHostError('agent-not-found', 'That agent is not installed on this computer.');
    const offered = this.settingsOf(agent.id) ?? [];
    for (const [id, value] of Object.entries(settings))
      if (!offered.some((setting) => setting.id === id && setting.values.some((candidate) => candidate.value === value)))
        throw new WorkbenchHostError('validation', `Choose one of the values ${agent.name} offered for ${id}.`);
    if (Object.keys(settings).length > 0) this.keep(agent.id, settings);
    // Each start begins at the agent's own values, then takes the ones kept for it, before it is ready.
    this.options = structuredClone(this.defaultOptions);
    for (const [id, value] of this.kept.get(agent.id)?.picked ?? []) {
      const option = this.options.find((candidate) => candidate.id === id);
      if (option !== undefined && option.values.some((candidate) => candidate.value === value)) option.currentValue = value;
    }
    if (!this.kept.has(agent.id)) this.kept.set(agent.id, { options: structuredClone(this.defaultOptions), picked: new Map() });
    this.agent = agent;
    this.usage = null;
    this.sessionTitle = null;
    this.lastAgentId = agent.id;
    this.turns = new Map();
    this.openTurn = null;
    this.launches += 1;
    this.conversationId = `preview-${this.launches}`;
    this.entries = [];
    this.revision = 0;
    this.order = 0;
    this.state = 'starting';
    this.working = false;
    this.notice = null;
    this.turn += 1;
    this.pendingStep = null;
    // Ended while starting stays ended, as a real agent's process does.
    this.later(400, () => { if (this.state === 'starting') { this.state = 'ready'; this.touch(); } });
    return this.read(0);
  }

  /** The preview agent names the conversation after the person's first message, as agents do. */
  private sessionTitle: string | null = null;

  /** How full the preview agent's context is: it counts about a thousand tokens a message, and a sample cost. */
  private usage: AgentUsage | null = null;

  /** A message entered the conversation: the preview agent counts it, as an agent's usage_update would. */
  private count(text: string): void {
    if (this.sessionTitle === null && text.trim() !== '') this.sessionTitle = text.trim().slice(0, 60);
    const used = (this.usage?.used ?? 12_000) + 1_000 + text.length;
    this.usage = { used, size: 200_000, costAmount: Math.round(used * 0.0003) / 100, costCurrency: 'USD' };
  }

  /** Pictures staged for the next message, by key: only their size is kept, as the preview agent never looks at one. */
  private staged = new Map<string, number>();

  /** A chunk of a picture, as the host stages it (agentSession.attach): in order, within 5 MiB. */
  private stagePicture(uploadKey: string, offset: number, base64: string): { staged: number } {
    if (this.agent === null) throw new WorkbenchHostError('agent-not-launched', 'No agent was launched for this file.');
    const held = this.staged.get(uploadKey) ?? 0;
    if (offset !== held) throw new WorkbenchHostError('validation', `This picture has ${held} bytes staged under that key, so the next chunk starts at offset ${held}.`);
    const staged = held + atob(base64).length;
    if (staged > 5 * 1024 * 1024) {
      this.staged.delete(uploadKey);
      throw new WorkbenchHostError('agent-image-too-large', 'A picture is at most 5 MiB.');
    }
    this.staged.set(uploadKey, staged);
    return { staged };
  }

  /** The names of the pictures a message carries, each taken from what was staged under its key. */
  private pictures(images: unknown): string[] {
    if (!Array.isArray(images)) return [];
    return images.map((image) => {
      const { uploadKey, name } = image as { uploadKey?: unknown; name?: unknown };
      if (!this.staged.delete(String(uploadKey ?? ''))) throw new WorkbenchHostError('validation', `${String(name ?? 'A picture')} did not arrive. Add it again.`);
      return String(name ?? 'image');
    });
  }

  private sendPrompt(text: string, after: number, pointedAt: string[], from: string | null = null): LaunchedAgentView {
    if (from !== null && this.viewAccess === 'never')
      throw new WorkbenchHostError('assistant-off', 'Views may not message the agent on this computer. Change it on the Agent page.');
    if (this.state !== 'ready') throw new WorkbenchHostError('agent-not-ready', 'The agent is not ready for a message yet.');
    if (text.trim() === '' && pointedAt.length === 0) throw new WorkbenchHostError('validation', 'Type something for the agent first.');
    if (this.working && from !== null) {
      if (this.queue.length >= 8 || this.queue.filter((waiting) => waiting.from === from).length >= 2)
        throw new WorkbenchHostError('agent-working', 'Too many messages already wait for the agent.');
      const turnId = `t${this.turns.size + 1}`;
      this.turns.set(turnId, { promptOrder: Number.MAX_SAFE_INTEGER, stopReason: null });
      this.queue.push({ turnId, text: text.trim(), from });
      this.touch();
      return { ...this.read(after), turnId };
    }
    if (this.working) throw new WorkbenchHostError('agent-working', 'The agent is still working. Wait, or press Stop.');
    this.working = true;
    this.count(text);
    const said = this.add({ kind: 'you', text: text.trim(), title: pointedAt.length === 0 ? null : pointedAt.join(' · '), from });
    const turnId = `t${this.turns.size + 1}`;
    this.turns.set(turnId, { promptOrder: said.order, stopReason: null });
    this.openTurn = turnId;
    if (from !== null) return { ...this.viewTurn(text.trim(), after), turnId };
    if (text.trim() === 'parallel') return { ...this.parallel(after), turnId };
    // A slash command is the agent's own, run below, even one named /compact.
    const command = text.trim().startsWith('/');
    if (!command && /\bcompact\b/i.test(text)) {
      // The preview agent warns, then shortens the conversation, as an agent near its limit does.
      this.later(300, () => {
        this.add({ kind: 'notice', text: 'The conversation is close to its limit.', title: 'Context almost full', status: 'warning', origin: 'agent' });
        this.add({ kind: 'compaction', text: 'Kept: the request record type and its fields.', status: 'completed' });
        this.add({ kind: 'agent', text: 'Compacted.' });
        this.working = false;
        this.endTurn('end_turn');
        this.touch();
      });
      return { ...this.read(after), turnId };
    }
    if (!command && /\bpicture\b/i.test(text)) {
      // The preview agent answers a message about a picture with one of its own.
      this.later(300, () => {
        // As an agent's image generation does: the picture comes back from a tool, which the tab folds.
        this.add({ kind: 'tool', text: '', title: 'Image generation', toolKind: 'other', status: 'completed', origin: 'agent',
          images: [{ id: 'p1', mediaType: 'image/png', length: atob(previewPicture).length, width: 1, height: 1 }] });
        this.add({ kind: 'agent', text: 'Here is one.' });
        this.working = false;
        this.endTurn('end_turn');
        this.touch();
      });
      return { ...this.read(after), turnId };
    }
    if (text.trim().startsWith('/')) {
      const name = text.trim().slice(1).split(/\s/)[0];
      this.later(300, () => {
        this.add({ kind: 'agent', text: `Ran /${name}. (The preview agent only says so.)` });
        this.working = false;
        this.endTurn('end_turn');
        this.touch();
      });
      return { ...this.read(after), turnId };
    }
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
    return { ...this.read(after), turnId };
  }

  /** A custom view's message: one read of the file, then a reply in two chunks. */
  private viewTurn(text: string, after: number): LaunchedAgentView {
    this.later(300, () => this.add({ kind: 'tool', text: 'Two record types: Crew and Mission.', title: 'nendo-nendo-read-resource', toolKind: 'read', status: 'completed', input: '{"uri":"nendo://application/manifest"}', origin: 'nendo' }));
    let message: AgentTranscriptEntry | null = null;
    ['I read the file. ', `Here is my answer to "${text.slice(0, 80)}".`].forEach((chunk, index, words) => this.later(500 + 200 * index, () => {
      if (message === null) message = this.add({ kind: 'agent', text: chunk });
      else this.change(message, { text: message.text + chunk });
      if (index === words.length - 1) { this.working = false; this.endTurn('end_turn'); this.touch(); }
    }));
    return this.read(after);
  }

  /**
   * Two steps that run at once, as an agent that calls tools in parallel sends them: the first
   * says what came back only once the request is answered, so a step earlier in the run gains a
   * disclosure while the person has a later one open.
   */
  private parallel(after: number): LaunchedAgentView {
    this.pendingStep = this.add({ kind: 'tool', text: '', title: 'Count the records', toolKind: 'read', status: 'in_progress', origin: 'nendo' });
    this.add({ kind: 'tool', text: 'Crew, Mission', title: 'List the record types', toolKind: 'read', status: 'completed', input: '{"uri":"nendo://application/manifest"}', origin: 'nendo' });
    this.add({ kind: 'permission', text: '', title: 'Add operations to a change set', toolKind: 'edit', origin: 'nendo', input: '{"operations":[]}',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
    return this.read(after);
  }

  private answer(entryId: string, optionId: string | null, after: number): LaunchedAgentView {
    const entry = this.entries.find((candidate) => candidate.id === entryId && candidate.kind === 'permission' && candidate.answer === null);
    if (entry === undefined) throw new WorkbenchHostError('agent-question-gone', 'The agent is no longer waiting for that answer.');
    const option = entry.options?.find((candidate) => candidate.optionId === optionId) ?? null;
    this.change(entry, { answer: option?.name ?? 'Cancelled' });
    if (this.pendingStep !== null) {
      this.change(this.pendingStep, { text: '42 records', status: 'completed' });
      this.pendingStep = null;
    }
    const words = option?.optionId === 'allow'
      ? ['I proposed a **Task** record type ', 'with a title and a due date. ', 'Review it on the Agent page.']
      : ['Understood, I left the file as it was.'];
    let message: AgentTranscriptEntry | null = null;
    words.forEach((chunk, index) => this.later(300 * (index + 1), () => {
      if (message === null) message = this.add({ kind: 'agent', text: chunk });
      else this.change(message, { text: message.text + chunk });
      if (index === words.length - 1) { this.working = false; this.endTurn('end_turn'); this.touch(); }
    }));
    return this.read(after);
  }

  private cancel(after: number): LaunchedAgentView {
    if (this.working) {
      // The stopped turn's steps still to come are dropped with it, and so is every view's message waiting.
      this.dropQueue('cancelled');
      this.turn += 1;
      this.pendingStep = null;
      this.working = false;
      for (const entry of this.entries.filter((candidate) => candidate.kind === 'permission' && candidate.answer === null))
        this.change(entry, { answer: 'Cancelled' });
      this.add({ kind: 'notice', text: 'Stopped.' });
      this.endTurn('cancelled');
    }
    return this.read(after);
  }

  private end(notice: string, after: number): LaunchedAgentView {
    if (this.agent === null) throw new WorkbenchHostError('agent-not-launched', 'No agent is running for this file. Launch one from the Agent page.');
    if (this.state !== 'ended') {
      this.turn += 1;
      this.pendingStep = null;
      this.state = 'ended';
      this.working = false;
      this.notice = notice;
      this.add({ kind: 'notice', text: notice });
      this.dropQueue('ended');
      this.endTurn('ended');
    }
    return this.read(after);
  }

  private read(after: number): LaunchedAgentView {
    const changed = this.entries.filter((entry) => entry.revision > after);
    return {
      exists: this.agent !== null,
      conversationId: this.conversationId,
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
      commands: this.agent === null || this.state === 'starting' ? [] : structuredClone(this.commands),
      firstOrder: this.entries[0]?.order ?? this.order + 1,
      signingIn: false,
      queued: this.queue.length,
      // The preview agent reads pictures, so the box takes them once it is ready.
      takesImages: this.agent !== null && this.state !== 'starting',
      usage: this.usage,
      sessionTitle: this.sessionTitle,
    };
  }

  private add(fields: Partial<AgentTranscriptEntry> & Pick<AgentTranscriptEntry, 'kind' | 'text'>): AgentTranscriptEntry {
    this.order += 1;
    const entry: AgentTranscriptEntry = {
      id: `e${this.order}`, order: this.order, revision: this.revision + 1, title: null, toolKind: null, status: null,
      input: null, options: null, answer: null, plan: null, origin: null, from: null, ...fields,
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

  /** A step of this launch's current turn, dropped if the turn or the launch has moved on by then. */
  private later(delay: number, step: () => void): void {
    const conversation = this.conversationId;
    const turn = this.turn;
    window.setTimeout(() => {
      if (this.state !== 'ended' && this.conversationId === conversation && this.turn === turn) step();
    }, delay);
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
