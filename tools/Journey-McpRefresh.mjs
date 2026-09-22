import { createNendoMcpClient } from './Nendo-McpClient.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function verifyExternalMcpRefresh({processId, host, click, ready, evaluate, waitFor, assert}, entity) {
  await host('agent.setMode', {mode:'editData'});
  await click('#nav-agent'); await ready();
  const root=path.join(process.env.LOCALAPPDATA,'Nendo','Mcp','active');
  const discovery=await waitFor(async()=>{
    const entries=[];
    for(const name of (await fs.readdir(root)).filter(name=>name.endsWith('.json'))) {
      try {const entry=JSON.parse(await fs.readFile(path.join(root,name),'utf8'));if(entry.processId===Number(processId))entries.push(entry);} catch {}
    }
    assert(entries.length<=1,'Ambiguous owned MCP endpoint');return entries[0]??null;
  },'owned MCP discovery');
  assert(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/?$/.test(discovery.endpoint),'Unexpected endpoint');
  const { rpc, tool } = createNendoMcpClient(discovery, 'p5-mcprefreshruntime');
  await rpc('server/discover');
  const label='External MCP record appears on navigation';
  let lease;
  try {
    lease=await tool('nendo.lease.acquire');
    await tool('nendo.data.create_record',{applicationHandle: lease.applicationHandle, leaseId: lease.leaseId,entityId:entity.entityId,recordId:'p5-external-refresh',
      values:{[entity.fields[0].fieldId]:label},idempotencyKey:crypto.randomUUID()});
    await tool('nendo.lease.release',{applicationHandle: lease.applicationHandle, leaseId: lease.leaseId});lease=null;
    // No renderer reload, host snapshot injection, or UI mutation receipt.
    await click('#nav-data');await ready();
    assert(await evaluate(`document.querySelector('#studio-content').textContent.includes(${JSON.stringify(label)})`),
      'Navigation hid a record committed by external MCP');
  } finally {
    if(lease)await tool('nendo.lease.release',{applicationHandle: lease.applicationHandle, leaseId: lease.leaseId});
    
    await host('agent.setMode',{mode:'off'});
  }
}
