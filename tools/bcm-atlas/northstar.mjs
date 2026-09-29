// The fictional Northstar model the Capability Atlas ships with: the 60-capability starter
// with its applications, support links and initiatives, and the catalogue in
// northstar-expansion.txt that grows it to 635 capabilities. Deterministic, so the fixture
// lane and the live file are built from the same records. Nothing here writes to Nendo.
import fs from 'node:fs';
import { migrated, demonstration, scopedFromPrimary, demonstrationScope } from './assessments.mjs';

/** The starter records, each with entityId, level (seed order), recordId and values. */
export function starterSeed() {
const domains=[
 ['Strategy & governance','Maya Chen',[
 ['Enterprise strategy','Portfolio planning','Performance management'],['Risk & compliance','Enterprise risk','Regulatory compliance'],['Business architecture','Capability planning','Operating model design']]],
 ['Customer & market','Jonas Berg',[
 ['Market intelligence','Customer insight','Market sensing'],['Brand & engagement','Brand management','Campaign orchestration'],['Customer relationships','Account management','Customer success']]],
 ['Products & services','Aisha Patel',[
 ['Product strategy','Value proposition design','Product portfolio'],['Product development','Service design','Product engineering'],['Product lifecycle','Release management','Product performance']]],
 ['Sales & fulfilment','Oliver Reed',[
 ['Demand to order','Opportunity management','Order capture'],['Order to delivery','Delivery planning','Service fulfilment'],['Customer care','Case resolution','Service recovery']]],
 ['Operations & supply','Sofia Lind',[
 ['Supply management','Supplier collaboration','Strategic sourcing'],['Operational delivery','Resource scheduling','Quality assurance'],['Operational resilience','Continuity planning','Incident response']]],
 ['Enterprise enablement','Daniel Okafor',[
 ['People & culture','Talent acquisition','People development'],['Finance & control','Financial planning','Financial reporting'],['Technology & data','Data governance','Technology operations']]]
];
const seed=[];let count=0;const add=(name,code,parent,owner,level)=>{const i=++count,m=i%9===0?null:1+(i*7%5),target=m==null?4:Math.min(5,m+1+(i%2));const r={recordId:`bcm-cap-${code.replaceAll('.','-')}`,values:{'cap.name':name,'cap.code':`CAP-${code}`,'cap.parent':parent,'cap.owner':owner,'cap.description':`The ability to ${({'Enterprise strategy':'set enterprise direction and align business choices','Customer insight':'understand customer needs and translate evidence into business decisions','Capability planning':'identify capability gaps and guide investment','Data governance':'establish trusted data ownership, quality and responsible use'})[name]||'manage '+name.toLowerCase()+' consistently to achieve agreed business outcomes'}.`,'cap.maturity':m,'cap.target':target,'cap.importance':level===0?'Core':i%3===0?'Differentiating':i%3===1?'Core':'Supporting','cap.investment':i%11===0?'Migrate':i%17===0?'Eliminate':m!=null&&m<3?'Invest':'Tolerate','cap.lifecycle':i%17===0?'Retiring':'Active','cap.reviewed':m==null?null:'2026-09-15','cap.evidence':m==null?null:'Fictional baseline assessment: '+(m<3?'Practices vary between teams; ownership and measures need strengthening.':'Documented practices are in use; further measurement and continuous improvement remain opportunities.'),'cap.order':i}};seed.push({entityId:'bcm.capability',level, ...r});return r.recordId;};
domains.forEach(([name,owner,groups],di)=>{const root=add(name,String(di+1),null,owner,0);groups.forEach(([group,...leaves],gi)=>{const p=add(group,`${di+1}.${gi+1}`,root,owner,1);leaves.forEach((leaf,li)=>add(leaf,`${di+1}.${gi+1}.${li+1}`,p,owner,2));});});
const apps=[['Orbit CRM','Customer relationships','Jonas Berg','High'],['Prism Insights','Customer insight','Jonas Berg','Medium'],['Forge PLM','Product lifecycle','Aisha Patel','High'],['Flow OMS','Order capture','Oliver Reed','High'],['Relay Service','Case resolution','Oliver Reed','High'],['Meridian ERP','Financial reporting','Daniel Okafor','High'],['PeopleSpace','People development','Daniel Okafor','Medium'],['Atlas Data','Data governance','Daniel Okafor','High']];
apps.forEach(([name,cap,owner,criticality],i)=>{const recordId=`bcm-app-${i+1}`;seed.push({entityId:'bcm.application',level:0,recordId,values:{'app.name':name,'app.code':`APP-${String(i+1).padStart(3,'0')}`,'app.owner':owner,'app.criticality':criticality,'app.lifecycle':i===2?'Retiring':'Active','app.vendor':'Northstar demo vendor','app.description':`Fictional application supporting ${cap.toLowerCase()}.`}});const capability=seed.find(x=>x.values['cap.name']===cap).recordId;seed.push({entityId:'bcm.support',level:0,recordId:`bcm-support-${i+1}`,values:{'support.name':`${name} → ${cap}`,'support.capability':capability,'support.application':recordId,'support.role':'Primary','support.fit':i%3===0?'Poor':i%3===1?'Adequate':'Strong','support.notes':'Fictional coverage assessment. Review with the capability owner.'}});});
const projects=[['One customer view','Customer insight','Discovery','Unified customer profiles available to all customer-facing teams.'],['Product lifecycle renewal','Product lifecycle','Delivery','Retire duplicate product records and standardise lifecycle decisions.'],['Frictionless fulfilment','Order capture','Proposed','Reduce avoidable order corrections in the demonstration operating model.'],['Trusted data foundations','Data governance','Delivery','Assign ownership and quality measures to every critical data domain.'],['Resilience by design','Continuity planning','Discovery','Exercise recovery plans for the most critical services.'],['Skills for tomorrow','People development','Complete','Establish a role-based learning pathway for priority capabilities.']];
projects.forEach(([name,cap,stage,success],i)=>{const capability=seed.find(x=>x.values['cap.name']===cap);seed.push({entityId:'bcm.initiative',level:0,recordId:`bcm-initiative-${i+1}`,values:{'initiative.name':name,'initiative.code':`INI-${String(i+1).padStart(3,'0')}`,'initiative.capability':capability.recordId,'initiative.description':success,'initiative.owner':capability.values['cap.owner'],'initiative.stage':stage,'initiative.start':`2026-${String(4+i).padStart(2,'0')}-01`,'initiative.end':`2026-${String(7+i).padStart(2,'0')}-28`,'initiative.priority':i%2?'High':'Medium','initiative.success':success}});});
return seed;
}

/** The capabilities the catalogue adds under existing capability records, parents first. */
export function expandCatalogue(existing) {
const all=[...existing], additions=[], byCode=new Map(existing.map(r=>[r.values['cap.code'].replace(/^CAP-/,''),r]));
const catalogue=fs.readFileSync(new URL('./northstar-expansion.txt',import.meta.url),'utf8');
for(const line of catalogue.split('\n').filter(l=>l.trim()&&!l.startsWith('#'))) {
  const [parentCode,children]=line.split('|').map(s=>s.trim());
  const parent=byCode.get(parentCode);check(parent,`Missing parent ${parentCode}`);
  const peers=all.filter(r=>r.values['cap.parent']===parent.recordId);
  let index=Math.max(0,...peers.map(r=>Number(r.values['cap.code'].split('.').at(-1))));
  for(const name of children.split(';').map(s=>s.trim())) {
    const code=`${parentCode}.${++index}`, n=additions.length+1;
    check(!byCode.has(code),`Duplicate code ${code}`);
    check(!all.some(r=>r.values['cap.parent']===parent.recordId&&r.values['cap.name']===name),`Duplicate sibling ${name}`);
    const maturity=n%11===0?null:1+(n*7+Math.floor(n/13))%5;
    const record={recordId:`bcm-cap-${code.replaceAll('.','-')}`,values:{
      'cap.name':name,'cap.code':`CAP-${code}`,'cap.parent':parent.recordId,
      'cap.description':`The ability to perform ${name.toLowerCase()} within ${parent.values['cap.name'].toLowerCase()}, with clear ownership, repeatable practices and measurable outcomes. Fictional Northstar demonstration capability.`,
      'cap.owner':parent.values['cap.owner'],'cap.order':index,
      'cap.maturity':maturity,'cap.target':maturity===null?4:Math.min(5,maturity+1+(n%3===0?1:0)),
      'cap.importance':['Core','Supporting','Differentiating','Core'][n%4],
      'cap.investment':maturity===null?'Invest':maturity<3?'Invest':n%7===0?'Migrate':n%17===0?'Eliminate':'Tolerate',
      'cap.lifecycle':n%19===0?'Proposed':n%31===0?'Retiring':'Active',
      'cap.reviewed':maturity===null?null:'2026-09-26',
      'cap.evidence':maturity===null?'Fictional demonstration data: assessment pending.':'Fictional demonstration assessment, generated to exercise the model. This rating is not evidence about a real organisation.',
    }};
    check(!all.some(r=>r.recordId===record.recordId));
    additions.push(record);all.push(record);byCode.set(code,record);
  }
}
return additions;
}

function check(ok, message) { if (!ok) throw new Error(message); }

/**
 * The whole shipped model: 635 capabilities, 8 applications, 8 support links, 6 initiatives, and
 * their assessments (W-080): each current maturity as an assessment, and fictional history.
 */
export function northstarModel() {
  const seed = starterSeed();
  const capabilities = seed.filter(r => r.entityId === 'bcm.capability');
  const additions = expandCatalogue(capabilities);
  const of = entityId => seed.filter(r => r.entityId === entityId).map(({ recordId, values }) => ({ recordId, values }));
  const all = [...capabilities.map(({ recordId, values }) => ({ recordId, values })), ...additions];
  return {
    'bcm.capability': all,
    'bcm.application': of('bcm.application'),
    'bcm.support': of('bcm.support'),
    'bcm.initiative': of('bcm.initiative'),
    'bcm.assessment': [...migrated(all), ...demonstration(all)],
    'bcm.scope': [...scopedFromPrimary(of('bcm.initiative')), ...demonstrationScope(of('bcm.initiative'), all)],
  };
}
