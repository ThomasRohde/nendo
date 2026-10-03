import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';

// Execute the shipped CLI with controlled disk/MCP boundaries. No real file,
// application or edit lease is opened by this lane.
const source = (await fs.readFile(new URL('./Put-NendoPackage.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/main\(\)\.catch\(error => fail\(error\.stack \?\? String\(error\)\)\);/, '');

async function run({ files = 16, extra = 0, acceptError, accept = false } = {}) {
  const calls = [], logs = [], errors = [];
  const mockProcess = { argv: ['node', 'uploader', '/fixture', '--endpoint', 'http://127.0.0.1:1/mcp',
    ...(extra ? ['--operations', '/extra.json'] : []), ...(accept ? ['--accept'] : [])], env: {}, exitCode: 0,
    exit(code) { this.exitCode = code; throw Error('process-exit-' + code); } };
  const mockFs = {
    async readdir(root) { return root === '/fixture' ? Array.from({ length: files }, (_, i) =>
      ({ isFile: () => true, name: `file-${i}.txt`, parentPath: '/fixture' })) : []; },
    async readFile(file) {
      if (file.endsWith('nendo-package.json')) return JSON.stringify({ packageId: 'fixture', title: 'Fixture', entryPoint: 'file-0.txt' });
      if (file === '/extra.json') return JSON.stringify(Array.from({ length: extra }, (_, i) =>
        ({ operationType: 'definition.setNode', payload: { nodeId: `node-${i}` } })));
      return Buffer.from('content');
    },
  };
  const context = vm.createContext({ fs: mockFs, path, crypto, process: mockProcess,
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')) },
    createNendoMcpClient: () => ({ rpc: async () => ({ contents: [{ text: '{"applicationId":"fixture"}' }] }),
      tool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'nendo.lease.acquire') return { applicationHandle: 'fixture', leaseId: 'fixture' };
        if (name === 'nendo.change_set.begin') return { changeSetId: 'draft-fixture' };
        if (name === 'nendo.change_set.validate') return { isValid: true, diagnostics: [] };
        if (name === 'nendo.change_set.accept') { if (acceptError) throw acceptError; return { applied: true, definitionRevision: 2 }; }
        return {};
      } }),
  });
  vm.runInContext(source, context);
  await context.main();
  return { calls, logs, errors, exitCode: mockProcess.exitCode };
}

for (const fixture of [{ files: 16 }, { files: 1, extra: 16 }, { files: 47, extra: 16 }]) {
  test(`every uploader call stays within sixteen total operations: ${JSON.stringify(fixture)}`, async () => {
    const result = await run(fixture);
    const sent = result.calls.filter(c => c.name === 'nendo.change_set.add_operations');
    const counts = sent.map(c => c.args.mutations.reduce((sum, m) => sum + m.operations.length, 0));
    assert.ok(counts.every(count => count <= 16), `MCP calls exceeded sixteen total operations: ${counts}`);
    assert.equal(counts.reduce((a, b) => a + b, 0), fixture.files + 1 + (fixture.extra ?? 0));
    assert.equal(result.calls.at(-1).name, 'nendo.lease.release');
  });
}

for (const failure of [Error('MCP tools/call HTTP 503'), Object.assign(Error('stale proposal'), { code: 'NENDO_CHANGE_SET_STALE' }), Error('response lost')]) {
  test(`acceptance failure is reported as failure: ${failure.message}`, async () => {
    const result = await run({ files: 1, accept: true, acceptError: failure });
    assert.equal(result.exitCode, 1, 'An uncertain or refused acceptance must exit unsuccessfully.');
    assert.ok(!result.logs.some(line => line.includes('not at Unattended')));
    assert.ok(result.errors.some(line => line.includes('draft-fixture')));
    assert.equal(result.calls.at(-1).name, 'nendo.lease.release');
  });
}

test('only the explicit access-level refusal leaves a successful handoff', async () => {
  const result = await run({ files: 1, accept: true,
    acceptError: Object.assign(Error('Unattended required'), { code: 'NENDO_UNATTENDED_REQUIRED' }) });
  assert.equal(result.exitCode, 0);
  assert.ok(result.logs.some(line => line.includes('not at Unattended')));
  assert.equal(result.calls.at(-1).name, 'nendo.lease.release');
});

test('the MCP client preserves explicit Nendo refusals from both protocol and tool errors', async () => {
  const fetchBefore = globalThis.fetch;
  try {
    for (const protocol of [true, false]) {
      globalThis.fetch = async (_, request) => {
        const { id } = JSON.parse(request.body);
        const reply = protocol
          ? { error: { code: -32602, message: 'NENDO_UNATTENDED_REQUIRED: Choose Unattended.' } }
          : { result: { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'NENDO_UNATTENDED_REQUIRED: Choose Unattended.' }] } };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...reply }), { headers: { 'Content-Type': 'application/json' } });
      };
      const client = createNendoMcpClient({ endpoint: 'http://127.0.0.1:1/mcp' }, 'test');
      await assert.rejects(client.tool('nendo.change_set.accept'), { code: 'NENDO_UNATTENDED_REQUIRED' });
    }
    globalThis.fetch = async () => new Response('', { status: 503 });
    const client = createNendoMcpClient({ endpoint: 'http://127.0.0.1:1/mcp' }, 'test');
    await assert.rejects(client.tool('nendo.change_set.accept'), error => error.code === undefined && /HTTP 503/.test(error.message));
  } finally { globalThis.fetch = fetchBefore; }
});
