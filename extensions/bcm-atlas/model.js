export const E = 'bcm.capability';
export const F = Object.fromEntries(['name','code','parent','description','owner','maturity','target','importance','investment','lifecycle','reviewed','evidence','order'].map(k=>[k,`cap.${k}`]));
export const maturityLabels = ['Unassessed','Initial','Repeatable','Defined','Managed','Optimising'];
export const importanceOptions = ['Supporting','Core','Differentiating'];
export const investmentOptions = ['Tolerate','Invest','Migrate','Eliminate'];
export const lifecycleOptions = ['Proposed','Active','Retiring'];
export const value = (r,k) => r?.values?.[F[k]] ?? null;
export const title = r => String(value(r,'name') || '(Unnamed capability)');
export const gap = r => value(r,'maturity') == null || value(r,'target') == null ? null : Number(value(r,'target'))-Number(value(r,'maturity'));
export function hierarchy(records) {
  const byId=new Map(records.map(r=>[r.recordId,r]));
  const parents=new Map(), issues=[];
  for(const r of records){const p=value(r,'parent');if(p&&!byId.has(p))issues.push(`${title(r)} has a missing parent; shown at the top level.`);parents.set(r.recordId,byId.has(p)?p:null);}
  // Cut one edge per cycle, deterministically. Every record remains visible and editable.
  for(const id of [...byId.keys()].sort()) {const seen=new Set();let p=id;while(p){if(seen.has(p)){parents.set(p,null);issues.push(`${title(byId.get(p))} has a circular hierarchy; repair its parent.`);break;}seen.add(p);p=parents.get(p);}}
  const children=new Map([...byId.keys()].map(id=>[id,[]]));const roots=[];
  for(const r of records){const p=parents.get(r.recordId);(p?children.get(p):roots).push(r);}
  const sort=list=>list.sort((a,b)=>(Number(value(a,'order')??999)-Number(value(b,'order')??999))||String(value(a,'code')||'').localeCompare(String(value(b,'code')||''))||title(a).localeCompare(title(b))||a.recordId.localeCompare(b.recordId));
  sort(roots);for(const list of children.values())sort(list);
  const descendants=id=>{const out=[];const visit=p=>{for(const r of children.get(p)||[]){out.push(r);visit(r.recordId);}};visit(id);return out;};
  const tree=r=>({id:r.recordId,name:title(r),children:(children.get(r.recordId)||[]).map(tree)});
  return {byId,parents,children,roots,issues,descendants,tree};
}
export function validParent(records,id,parent){if(!parent)return true;if(id===parent)return false;const byId=new Map(records.map(r=>[r.recordId,r]));if(!byId.has(parent))return false;const seen=new Set();while(parent){if(parent===id||seen.has(parent))return false;seen.add(parent);parent=value(byId.get(parent),'parent');}return true;}

// At enterprise scope, roots are level 1. A focused group is context (level 0),
// so selecting one level still reveals its immediate children.
export function projectHierarchy(h,scope,levels=Infinity) {
  const focused=scope&&h.byId.has(scope);
  const roots=focused?[h.byId.get(scope)]:h.roots;
  const rows=[],hiddenCounts=new Map();let maxDepth=0;
  function measure(r,depth){maxDepth=Math.max(maxDepth,depth);let count=0;for(const child of h.children.get(r.recordId)||[])count+=1+measure(child,depth+1);hiddenCounts.set(r.recordId,count);return count;}
  roots.forEach(r=>measure(r,focused?0:1));
  function visit(r,depth){rows.push({r,depth:focused?depth:depth-1});return {id:r.recordId,name:title(r),children:depth<levels?(h.children.get(r.recordId)||[]).map(c=>visit(c,depth+1)):[]};}
  const tree=roots.map(r=>visit(r,focused?0:1));
  return {tree,rows,hiddenCounts,maxDepth};
}
