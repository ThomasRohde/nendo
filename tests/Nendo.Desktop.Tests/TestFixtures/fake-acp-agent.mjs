// A stand-in ACP agent for the launched-agent tests (ADR-0030). It speaks JSON-RPC on stdio, one
// message per line, records what Nendo told it in the file after --log, and answers prompts by
// their words:
//   permission  asks the person, then says which option came back
//   wait        works until it is cancelled
//   tool        reports a tool call that the next update completes
//   handle      sends and receives an application handle in a tool call and asks about it
//   spawn       starts a child process that runs until something ends it, and logs its pid
//   exit        writes to stderr and exits with code 3
//   anything else is echoed back in two chunks
// Flags: --no-http (cannot reach HTTP MCP), --version N (speaks ACP version N), --auth (asks to
// sign in first), --banner (prints a line that is not a message before speaking), --config (offers
// session config options, as Copilot CLI does), --legacy (offers the older modes and models, as
// OpenCode does). The prompt 'switch' makes the agent change its own mode.
import { appendFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const logPath = option('--log');
const log = (entry) => { if (logPath) appendFileSync(logPath, JSON.stringify(entry) + '\n'); };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });

let signedIn = !args.includes('--auth');
const configOptions = [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'agent',
    options: [{ value: 'agent', name: 'Agent' }, { value: 'plan', name: 'Plan' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sonnet',
    options: [{ group: 'fast', name: 'Fast', options: [{ value: 'haiku', name: 'Haiku' }] }, { group: 'smart', name: 'Smart', options: [{ value: 'sonnet', name: 'Sonnet' }] }] },
  { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: 'medium',
    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  { id: 'allow_all', name: 'Allow All', category: 'permissions', type: 'select', currentValue: 'off',
    options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] },
  { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false },
];
const legacy = { modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] },
  models: { currentModelId: 'big', availableModels: [{ modelId: 'big', name: 'Big' }, { modelId: 'small', name: 'Small' }] } };
let cancelTurn = null;
log({ started: true, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()) });
if (args.includes('--banner')) process.stdout.write('fake agent starting up\n');

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((block) => block.text ?? '').join('');
  log({ prompt: text });
  if (text === 'permission') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Write the record', kind: 'edit', status: 'pending', rawInput: { record: 'r1' } });
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-1' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    log({ permission: answer });
    const outcome = answer.outcome.outcome === 'selected' ? `selected ${answer.outcome.optionId}` : 'cancelled';
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `The person ${outcome}.` } });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (text === 'wait') {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working…' } });
    await new Promise((resolve) => { cancelTurn = resolve; });
    send({ id, result: { stopReason: 'cancelled' } });
    return;
  }
  if (text === 'tool') {
    update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Read the schema', priority: 'high', status: 'in_progress' }] });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'nendo.read.resource', kind: 'read', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '<b>three</b> record types' } }] });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (text === 'handle') {
    const handle = 'secret-handle-0123456789';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-3', title: 'nendo.lease.acquire', kind: 'other', status: 'completed',
      rawInput: { resumeApplicationHandle: handle },
      content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ applicationHandle: handle, leaseId: 'lease-1' }) } },
        { type: 'content', content: { type: 'text', text: JSON.stringify({ wrapped: JSON.stringify({ applicationHandle: handle }) }) } }] });
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-4', title: 'Release the lease', rawInput: { applicationHandle: handle, leaseId: 'lease-1' } },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    });
    log({ permission: answer });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (text === 'spawn') {
    // Detached, so Node's own job does not end it with this process: only Nendo's job can.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    child.unref();
    log({ child: child.pid, self: process.pid });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Started ${child.pid}.` } });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (text === 'switch') {
    if (args.includes('--config')) {
      configOptions[0].currentValue = 'plan';
      update(sessionId, { sessionUpdate: 'config_option_update', configOptions });
    } else {
      update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    }
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (text === 'exit') {
    process.stderr.write('fake agent gave up on purpose\n');
    setTimeout(() => process.exit(3), 50);
    return;
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You said: ' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  send({ id, result: { stopReason: 'end_turn' } });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.result ?? { outcome: { outcome: 'error' } });
    return;
  }
  log({ method: message.method, params: message.params });
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {
        protocolVersion: Number(option('--version') ?? 1),
        agentCapabilities: { loadSession: false, mcpCapabilities: { http: !args.includes('--no-http'), sse: false } },
        authMethods: args.includes('--auth') ? [{ id: 'browser', name: 'Sign in with a browser' }] : [],
        agentInfo: { name: 'fake-agent', title: 'Fake agent', version: '1.0.0' },
      } });
      break;
    case 'authenticate':
      signedIn = true;
      send({ id: message.id, result: {} });
      break;
    case 'session/new':
      if (!signedIn) send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
      else send({ id: message.id, result: { sessionId: 'session-1',
        ...(args.includes('--config') ? { configOptions, modes: legacy.modes } : {}),
        ...(args.includes('--legacy') ? legacy : {}) } });
      break;
    case 'session/set_config_option': {
      const option = configOptions.find((candidate) => candidate.id === message.params.configId);
      if (option === undefined || message.params.value === 'refuse') { send({ id: message.id, error: { code: -32602, message: 'No such value' } }); break; }
      option.currentValue = message.params.value;
      send({ id: message.id, result: { configOptions } });
      break;
    }
    case 'session/set_mode':
      legacy.modes.currentModeId = message.params.modeId;
      send({ id: message.id, result: {} });
      break;
    case 'session/set_model':
      legacy.models.currentModelId = message.params.modelId;
      send({ id: message.id, result: {} });
      break;
    case 'session/prompt':
      void prompt(message.id, message.params);
      break;
    case 'session/cancel':
      cancelTurn?.();
      cancelTurn = null;
      break;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
lines.on('close', () => process.exit(0));
