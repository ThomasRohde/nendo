// A species recipe; its authoritative instances are ordinary Swarm records.
import { size } from '../../extensions/swarm/model.mjs';
export function lanternColony(habitat) {
  const id = key => `sw_lantern_${key}`;
  const node = (key, kind, name, x, y, extra = {}) => ({ id: id(key), kind, name, x, y, action: 'Wander', condition: 'Nearby', duration: 24, ...extra });
  const nodes = [
    node('born', 'Start', 'Awaken', 30, 86),
    node('scout', 'Action', 'Scout', 120, 72),
    node('alarm', 'Decision', 'Startled?', 300, 79, { condition: 'Disturbed' }),
    node('escape', 'Action', 'Burst away', 450, 20, { action: 'Flee', duration: 45 }),
    node('threat', 'Decision', 'Still threatened?', 650, 27, { condition: 'Disturbed' }),
    node('recover', 'Action', 'Recover', 810, 20, { action: 'Rest', duration: 32 }),
    node('nearby', 'Decision', 'Company nearby?', 450, 210),
    node('crowd', 'Decision', 'Too crowded?', 650, 210, { condition: 'Crowded' }),
    node('gather', 'Action', 'Join the colony', 620, 380, { action: 'Gather', duration: 42 }),
    node('settled', 'Decision', 'Room to stay?', 800, 387, { condition: 'Crowded' }),
    node('room', 'Action', 'Make room', 810, 210, { action: 'Wander', duration: 44 }),
    node('align', 'Action', 'Travel together', 950, 380, { action: 'Align', duration: 80 }),
    node('rest', 'Action', 'Settle and rest', 1130, 380, { action: 'Rest', duration: 38 }),
    node('wake', 'Decision', 'Safe to wake?', 1165, 570, { condition: 'Disturbed' }),
    node('companions', 'Decision', 'Colony still here?', 985, 570),
    node('patrol', 'Action', 'Patrol together', 790, 570, { action: 'Align', duration: 50 }),
    node('search', 'Action', 'Find a new group', 450, 380, { action: 'Wander', duration: 35 }),
    node('check', 'Decision', 'Colony crowded?', 650, 577, { condition: 'Crowded' }),
    node('quiet', 'Action', 'Quiet pause', 450, 570, { action: 'Rest', duration: 24 }),
  ];
  // Crowded means Yes is the overcrowded path, including the "Room to stay?" gate.
  nodes.find(n => n.id === id('settled')).name = 'Crowded after joining?';
  nodes.find(n => n.id === id('wake')).name = 'Startled on waking?';
  const paths = [
    ['born', 'scout'], ['scout', 'alarm'], ['alarm', 'escape', 'Yes'], ['alarm', 'nearby', 'No'],
    ['escape', 'threat'], ['threat', 'escape', 'Yes'], ['threat', 'recover', 'No'], ['recover', 'nearby'],
    ['nearby', 'crowd', 'Yes'], ['nearby', 'search', 'No'], ['search', 'alarm'],
    ['crowd', 'room', 'Yes'], ['crowd', 'gather', 'No'], ['room', 'nearby'],
    ['gather', 'settled'], ['settled', 'room', 'Yes'], ['settled', 'align', 'No'],
    ['align', 'rest'], ['rest', 'wake'], ['wake', 'escape', 'Yes'], ['wake', 'companions', 'No'],
    ['companions', 'patrol', 'Yes'], ['companions', 'search', 'No'], ['patrol', 'check'],
    ['check', 'room', 'Yes'], ['check', 'quiet', 'No'], ['quiet', 'wake'],
  ];
  const routing = makeRouter(nodes);
  const links = paths.map(([from, to, branch = 'Next'], index) => ({ id: id(`path_${index + 1}`), source: id(from), target: id(to), branch, name: branch, waypoints: routing(id(from), id(to)) }));
  return { species: { id: 'sw_species_lantern_colony', name: 'Lantern Colony', description: 'Scout for company, join a colony, make room when it crowds, travel and rest together. A disturbance interrupts the cycle: burst away, check the threat again, recover, then search for companions. Eight decisions govern regrouping, crowd avoidance and repeated escapes.', population: 300, speed: 2.1, perception: 70, cohesion: 2.1, alignment: 1.5, separation: 1.8, seed: 57139 }, habitat: { ...habitat }, nodes, links };
}

function makeRouter(nodes) {
  const padding = 18;
  const boxes = nodes.map(n => ({ ...n, ...size(n.kind) }));
  const ports = n => [
    { point: { x: n.x, y: n.y + n.height / 2 }, outer: { x: n.x - padding, y: n.y + n.height / 2 } },
    { point: { x: n.x + n.width, y: n.y + n.height / 2 }, outer: { x: n.x + n.width + padding, y: n.y + n.height / 2 } },
    { point: { x: n.x + n.width / 2, y: n.y }, outer: { x: n.x + n.width / 2, y: n.y - padding } },
    { point: { x: n.x + n.width / 2, y: n.y + n.height }, outer: { x: n.x + n.width / 2, y: n.y + n.height + padding } },
  ];
  const all = boxes.flatMap(ports).map(p => p.outer);
  const xs = [...new Set([-60, 1320, ...all.map(p => p.x)])].sort((a,b) => a-b);
  const ys = [...new Set([-60, 710, ...all.map(p => p.y)])].sort((a,b) => a-b);
  const point = i => ({ x: xs[i % xs.length], y: ys[Math.floor(i / xs.length)] });
  const index = p => ys.indexOf(p.y) * xs.length + xs.indexOf(p.x);
  const intersects = (a,b,n) => a.x === b.x ? a.x > n.x-8 && a.x < n.x+n.width+8 && Math.max(a.y,b.y)>n.y-8 && Math.min(a.y,b.y)<n.y+n.height+8
    : a.y > n.y-8 && a.y < n.y+n.height+8 && Math.max(a.x,b.x)>n.x-8 && Math.min(a.x,b.x)<n.x+n.width+8;
  const neighbours = Array.from({ length: xs.length * ys.length }, (_,i) => {
    const x=i%xs.length,y=Math.floor(i/xs.length), candidates=[...(x?[i-1]:[]),...(x+1<xs.length?[i+1]:[]),...(y?[i-xs.length]:[]),...(y+1<ys.length?[i+xs.length]:[])];
    return candidates.filter(j => !boxes.some(n => intersects(point(i),point(j),n)));
  });
  const distance = (a,b) => Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
  return (source,target) => {
    const a=boxes.find(n=>n.id===source),b=boxes.find(n=>n.id===target);
    const pairs=ports(a).flatMap(p=>ports(b).map(q=>({p,q,d:distance(p.outer,q.outer)}))).sort((x,y)=>x.d-y.d);
    for(const {p,q} of pairs){
      if(boxes.some(n=>n.id!==source&&intersects(p.point,p.outer,n))||boxes.some(n=>n.id!==target&&intersects(q.point,q.outer,n)))continue;
      const start=index(p.outer),end=index(q.outer), cost=new Map([[start,0]]), parent=new Map(), queue=[{i:start,f:distance(p.outer,q.outer)}], closed=new Set();
      while(queue.length){
        queue.sort((a,b)=>b.f-a.f);const {i}=queue.pop();if(closed.has(i))continue;closed.add(i);
        if(i===end){const path=[q.point];let at=end;while(at!==start){path.unshift(point(at));at=parent.get(at);}path.unshift(p.point,p.outer);
          return path.filter((v,k)=>k===0||k===path.length-1||!((path[k-1].x===v.x&&v.x===path[k+1].x)||(path[k-1].y===v.y&&v.y===path[k+1].y)));
        }
        for(const j of neighbours[i]){const next=cost.get(i)+distance(point(i),point(j));if(next<(cost.get(j)??Infinity)){cost.set(j,next);parent.set(j,i);queue.push({i:j,f:next+distance(point(j),q.outer)});}}
      }
    }
    throw Error(`No clear route: ${source} → ${target}`);
  };
}
