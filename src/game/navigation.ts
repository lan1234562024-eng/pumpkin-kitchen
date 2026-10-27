import type {Point} from '../shared/contracts';
import {KITCHEN_LAYOUT,type Rect,type TargetId} from './kitchen-layout';
const EPS=0.001;
const radius=KITCHEN_LAYOUT.foot_radius;
const obstacles=KITCHEN_LAYOUT.furniture.map(r=>({x:r.x-radius,y:r.y-radius,width:r.width+2*radius,height:r.height+2*radius}));
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
function contains(r:Rect,p:Point){return p.x>=r.x&&p.x<=r.x+r.width&&p.y>=r.y&&p.y<=r.y+r.height;}
export function isWalkable(p:Point):boolean {
  return Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=radius&&p.y>=radius&&p.x<=KITCHEN_LAYOUT.width-radius&&p.y<=KITCHEN_LAYOUT.height-radius&&!obstacles.some(r=>contains(r,p));
}
/** Closed-segment slab intersection; returns the first hit fraction. */
function hit(a:Point,b:Point,r:Rect):number|null {
  let low=0,high=1;
  for(const [start,delta,min,max] of [[a.x,b.x-a.x,r.x,r.x+r.width],[a.y,b.y-a.y,r.y,r.y+r.height]]){
    if(Math.abs(delta)<1e-12){if(start<min||start>max)return null;continue;}
    let p=(min-start)/delta,q=(max-start)/delta;if(p>q)[p,q]=[q,p];
    low=Math.max(low,p);high=Math.min(high,q);if(low>high)return null;
  }
  return low;
}
export function segmentClear(a:Point,b:Point):boolean{return isWalkable(a)&&isWalkable(b)&&!obstacles.some(r=>hit(a,b,r)!==null);}
const corners=obstacles.flatMap(r=>[
  {x:r.x-EPS,y:r.y-EPS},{x:r.x+r.width+EPS,y:r.y-EPS},
  {x:r.x-EPS,y:r.y+r.height+EPS},{x:r.x+r.width+EPS,y:r.y+r.height+EPS},
]).filter(isWalkable);

export function routeTo(from:Point,to:Point):Point[]|null {
  if(!isWalkable(from)||!isWalkable(to))return null;
  if(distance(from,to)<1e-9)return [];
  if(segmentClear(from,to))return [{...to}];
  const nodes=[from,to,...corners],cost=nodes.map(()=>Infinity),parent=nodes.map(()=>-1),visited=new Set<number>();cost[0]=0;
  for(;;){
    let index=-1;
    for(let i=0;i<nodes.length;i++)if(!visited.has(i)&&(index<0||cost[i]<cost[index]))index=i;
    if(index<0||!Number.isFinite(cost[index]))return null;
    if(index===1)break;
    visited.add(index);
    for(let i=0;i<nodes.length;i++)if(!visited.has(i)&&segmentClear(nodes[index],nodes[i])){
      const candidate=cost[index]+distance(nodes[index],nodes[i]);
      if(candidate<cost[i]){cost[i]=candidate;parent[i]=index;}
    }
  }
  const path:Point[]=[];
  for(let index=1;index!==0;index=parent[index])path.unshift({...nodes[index]});
  return path;
}
export function stopAlongRay(from:Point,direction:Point):Point {
  if(!isWalkable(from)||!Number.isFinite(direction.x)||!Number.isFinite(direction.y)||(!direction.x&&!direction.y))return {...from};
  const {x,y}=direction;
  let length=Math.min(x>0?(KITCHEN_LAYOUT.width-radius-from.x)/x:x<0?(radius-from.x)/x:Infinity,y>0?(KITCHEN_LAYOUT.height-radius-from.y)/y:y<0?(radius-from.y)/y:Infinity);
  const end={x:from.x+x*length,y:from.y+y*length};
  for(const obstacle of obstacles){const fraction=hit(from,end,obstacle);if(fraction!==null)length=Math.min(length,Math.max(0,fraction*distance(from,end)/Math.hypot(x,y)-EPS/Math.hypot(x,y)));}
  return {x:from.x+x*length,y:from.y+y*length};
}
export function approachFor(from:Point,target:TargetId):Point|null {
  let best:Point|null=null,cost=Infinity;
  for(const p of KITCHEN_LAYOUT.targets[target].approach_points){
    const path=routeTo(from,p);if(path===null)continue;
    let total=0,previous=from;for(const point of path){total+=distance(previous,point);previous=point;}
    if(total<cost){cost=total;best={...p};}
  }
  return best;
}
export function canReachTarget(from:Point,target:TargetId):boolean {
  return KITCHEN_LAYOUT.targets[target].approach_points.some(p=>distance(from,p)<=KITCHEN_LAYOUT.interact_radius&&segmentClear(from,p));
}

