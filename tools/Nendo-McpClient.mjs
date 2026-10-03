// Task-owned protocol harness on the 2026-07-28 discover path. Application handles stay in memory.

// Whether the Nendo that wrote a discovery entry is still running. A process that ends without
// closing its host leaves its entry behind (F-212); Nendo's own readers skip it, and so must ours,
// or a tool picks a closed file's port and is refused.
export function isRunning(discovery) {
  const processId = discovery?.processId;
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try { process.kill(processId, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function createNendoMcpClient(discovery, name) {
  const endpoint = new URL(discovery.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp')
    throw Error('Invalid local MCP discovery');
  let serial = 0;
  const headers = (method, params = {}) => ({
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method, ...((params.name ?? params.uri) ? { 'Mcp-Name': params.name ?? params.uri } : {}),
  });
  const envelope = (method, params = {}, id = ++serial) => ({ jsonrpc: '2.0', id, method,
    params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name, version: '1.0' },
    } },
  });
  async function rpc(method, params = {}) {
    const body = envelope(method, params);
    const response = await fetch(endpoint, { method: 'POST', headers: headers(method, params),
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error(`MCP ${method} HTTP ${response.status}`);
    if (response.headers.has('Mcp-Session-Id')) throw Error('Unexpected legacy MCP session');
    const text = await response.text();
    const messages = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : [JSON.parse(text)];
    const reply = messages.find(message => message.id === body.id);
    if (!reply || reply.error) {
      const message = reply?.error?.message;
      const error = Error(`MCP ${method} failed: ${reply?.error?.code ?? 'no reply'}${message ? ': ' + message : ''}`);
      error.code = message?.match(/^\s*(NENDO_[A-Z_]+)\b/)?.[1];
      throw error;
    }
    if (reply.result.resultType !== 'complete') throw Error(`Unexpected MCP result type for ${method}`);
    return reply.result;
  }
  async function tool(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError) {
      const said = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join(' ').slice(0, 2000);
      const error = Error(`MCP tool ${name} rejected${said ? ': ' + said : ''}`);
      // Only a protocol tool refusal carries a Nendo code. HTTP/transport errors
      // must never be reclassified as an access-level refusal by a caller.
      error.code = said.match(/^\s*(NENDO_[A-Z_]+)\b/)?.[1];
      throw error;
    }
    return result.structuredContent;
  }
  return { endpoint, headers, envelope, rpc, tool };
}
