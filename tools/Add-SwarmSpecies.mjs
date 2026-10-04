// Add this bounded species recipe through Swarm's typed services; no schema change.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createNendoMcpClient } from './Nendo-McpClient.mjs';
import { lanternColony } from './swarm/lantern-colony.mjs';
import { validate, Simulation, replay } from '../extensions/swarm/simulation.mjs';
import { entities } from './swarm/definition.mjs';
const args=process.argv.slice(2), endpoint=args[args.indexOf('--endpoint')+1];
const dry=args.includes('--dry-run');
if(!dry&&(!args.includes('--endpoint')||!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint)))throw Error('Supply Swarm’s current --endpoint http://127.0.0.1:PORT/mcp.');
const client=dry?null:createNendoMcpClient({endpoint},'codex-lantern-colony');
const read=async uri=>JSON.parse((await client.rpc('resources/read',{uri})).contents[0].text);
async function records(entity){const out=[];let cursor;do{const page=await read(`nendo://application/entity/${entity}/records?limit=100`+(cursor?'&cursor='+encodeURIComponent(cursor):''));out.push(...page.items);cursor=page.nextCursor;}while(cursor);return out;}
let habitat={id:'sw_habitat_meadow',name:'Open meadow',width:1000,height:620};
if(!dry){
  const instances=await read('nendo://host/instances'), manifest=await read('nendo://application/manifest');
  assert.equal(instances.instances.find(i=>i.isThisOne)?.displayName,'Swarm.nendo','This endpoint is not Swarm.');
  assert.equal(manifest.applicationId,'application-220387f8025f403b82a50a5d5ce80969','This is not the authored Swarm application.');
  const h=(await records('sw.habitat'))[0];if(!h)throw Error('Swarm has no habitat.');
  habitat={id:h.recordId,name:h.values['sw.habitat.name'],width:h.values['sw.habitat.width'],height:h.values['sw.habitat.height']};
}
const model=lanternColony(habitat);assert.deepEqual(validate(model),[]);
const sim=new Simulation(model), states=new Set();
for(let t=0;t<2400;t++){if([120,480,900,1500].includes(t))sim.disturb(sim.agents[0].x,sim.agents[0].y);sim.step();Object.keys(sim.metrics.states).forEach(s=>states.add(s));}
assert.equal(states.size,5,'The recipe did not exercise all five movement states.');
assert.deepEqual(replay(sim.snapshot()).digest(),sim.digest());
console.log(`Lantern Colony: ${model.species.population} creatures, ${model.nodes.length} nodes, 8 decisions, ${model.links.length} transitions. 2,400 simulated steps; all five states; exact replay.`);
if(dry)process.exit(0);
const pack=(entity,record)=>Object.fromEntries(entities.find(e=>e.id===entity).fields.map(([key])=>[`${entity}.${key}`,key==='waypoints'?JSON.stringify(record[key]??[]):record[key]??null]));
const groups=[['sw.species',[{...model.species}]],['sw.node',model.nodes.map(n=>({...n,species:model.species.id}))],['sw.link',model.links.map(l=>({...l,species:model.species.id}))]];
const existing=new Map();for(const [entity] of groups)existing.set(entity,new Map((await records(entity)).map(r=>[r.recordId,r])));
// Check every collision before any writes. A user-edited existing recipe is never reset.
for(const [entity,items] of groups)for(const item of items){const prior=existing.get(entity).get(item.id);if(prior)assert.deepEqual(prior.values,pack(entity,item),`Existing ${entity}/${item.id} differs; nothing was overwritten.`);}
const lease=await client.tool('nendo.lease.acquire'),owned={applicationHandle:lease.applicationHandle,leaseId:lease.leaseId};
try{
  let created=0;
  for(const [entity,items] of groups){
    const refs=entities.find(e=>e.id===entity).refs??[];
    const pending=items.filter(item=>!existing.get(entity).has(item.id)).map(item=>({recordId:item.id,values:pack(entity,item),expectedTargetVersions:Object.fromEntries(refs.map(([key,target])=>{const r=existing.get(target).get(item[key]);if(!r)throw Error(`Missing target ${target}/${item[key]}`);return [`${entity}.${key}`,r.recordVersion];}))}));
    if(!pending.length)continue;
    await client.tool('nendo.data.create_records',{...owned,entityId:entity,records:pending,idempotencyKey:crypto.randomUUID()});created+=pending.length;
    existing.set(entity,new Map((await records(entity)).map(r=>[r.recordId,r])));
  }
  // Reconstruct the saved graph; check the file, not only the recipe.
  const {fromRecords}=await import('../extensions/swarm/model.mjs');
  const adapt=rows=>rows.map(r=>({...r,version:r.recordVersion}));
  const saved=fromRecords({species:adapt([...existing.get('sw.species').values()]),nodes:adapt([...existing.get('sw.node').values()]),links:adapt([...existing.get('sw.link').values()]),habitats:adapt(await records('sw.habitat'))},model.species.id);
  assert.deepEqual(validate(saved),[]);
  assert.equal(saved.nodes.length,19);assert.equal(saved.links.length,27);
  await fs.mkdir('artifacts/swarm',{recursive:true});
  await fs.writeFile('artifacts/swarm/lantern-colony-result.json',JSON.stringify({applicationId:'application-220387f8025f403b82a50a5d5ce80969',created,speciesId:model.species.id,nodes:saved.nodes.length,links:saved.links.length,states:[...states],replay:'exact',habitat}));
  console.log(`${created} records created through typed MCP services; saved graph valid. Other species preserved.`);
}finally{await client.tool('nendo.lease.release',owned);}
