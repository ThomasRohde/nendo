// Measure actual paint/hit order, not merely whether a child's DOM node exists.
export const selectionProbe = `(async()=>{
  const records=await nendo.view.loadRecords();
  const children=new Map(records.map(r=>[r.recordId,[]]));
  for(const r of records){const list=children.get(r.values['cap.parent']);if(list)list.push(r.recordId);}
  const descendants=id=>{const out=[];const visit=p=>{for(const child of children.get(p)||[]){out.push(child);visit(child);}};visit(id);return out;};
  const cards=new Map([...document.querySelectorAll('.cap')].map(n=>[n.dataset.id,n]));
  const hidden=[];let groups=0,points=0,clicks=0;
  for(const parent of document.querySelectorAll('.cap.branch')){
    parent.click();groups++;
    for(const id of descendants(parent.dataset.id)){
      const card=cards.get(id);if(!card){hidden.push('Selecting '+parent.dataset.id+' removes '+id);continue;}
      const rect=card.getBoundingClientRect();const scale=rect.width/parseFloat(card.style.width);
      const probes=[[rect.left+rect.width/2,rect.top+8*scale]];
      if(card.classList.contains('leaf'))probes.push([rect.left+rect.width/2,rect.top+rect.height*.7]);
      for(const [x,y]of probes){points++;const top=document.elementFromPoint(x,y)?.closest('.cap');if(top!==card)hidden.push('Selecting '+parent.dataset.id+' obscures '+id+' behind '+(top?.dataset.id||'another element'));}
    }
    const childId=children.get(parent.dataset.id)?.[0];const child=cards.get(childId);
    if(child){const r=child.getBoundingClientRect(),scale=r.width/parseFloat(child.style.width);const top=document.elementFromPoint(r.left+r.width/2,r.top+8*scale)?.closest('.cap');if(top===child){top.click();clicks++;if(!child.classList.contains('selected'))hidden.push('Child '+childId+' could not be selected');}}
  }
  cards.get('bcm-cap-2')?.click();
  return {groups,points,clicks,hidden};
})()`;
