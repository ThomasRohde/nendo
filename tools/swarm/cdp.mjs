// App-scoped browser instrumentation. Connect only to the explicitly named test host.
export async function connect(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', no, { once: true }); });
  let serial = 0; const pending = new Map(), contexts = new Map();
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.executionContextCreated') contexts.set(`${msg.sessionId}/${msg.params.context.id}`, { ...msg.params.context, sessionId: msg.sessionId });
    if (msg.method === 'Runtime.executionContextDestroyed') contexts.delete(`${msg.sessionId}/${msg.params.executionContextId}`);
    if (msg.method === 'Runtime.executionContextsCleared') for (const [key, value] of contexts) if (value.sessionId === msg.sessionId) contexts.delete(key);
    const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.no(Error(msg.error.message)) : p.ok(msg.result);
  });
  const command = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); no(Error(`Timed out: ${method}`)); }, 30000);
    pending.set(id, { ok, no, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const targets = async () => (await command('Target.getTargets')).targetInfos;
  const attach = async targetId => (await command('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const evaluate = async (session, expression, contextId) => {
    const r = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, session);
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { command, targets, attach, evaluate, contexts: () => [...contexts.values()], close: () => ws.close() };
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/cdp.mjs')) {
  const c = await connect(Number(process.argv[2]));
  try {
    const targets = await c.targets();
    const target = targets.find(t => t.type === 'page' && t.url.startsWith('https://app.nendo.local/'));
    if (!target) console.log(JSON.stringify(targets.map(t => ({ type: t.type, url: t.url }))));
    else { const session = await c.attach(target.targetId); console.log(JSON.stringify(await c.evaluate(session, process.argv[3] || '({title:document.title,text:document.body.innerText.slice(0,3500),buttons:[...document.querySelectorAll("button")].map(b=>({text:b.textContent.trim(),id:b.id,mode:b.dataset.agentMode,action:b.dataset.action,view:b.dataset.view}))})'))); }
  } finally { c.close(); }
}
