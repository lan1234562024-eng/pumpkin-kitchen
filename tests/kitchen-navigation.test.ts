import {describe,it,expect} from 'vitest';
import {KITCHEN_LAYOUT,TARGET_IDS} from '../src/game/kitchen-layout';
import {approachFor,canReachTarget,isWalkable,routeTo,segmentClear,stopAlongRay} from '../src/game/navigation';

describe('kitchen navigation',()=>{
  it('keeps feet outside furniture and inside world bounds',()=>{
    expect(isWalkable({x:400,y:200})).toBe(false);
    expect(isWalkable({x:100,y:200})).toBe(false);
    expect(isWalkable({x:300,y:220})).toBe(true);
    expect(isWalkable({x:0,y:0})).toBe(false);
    expect(isWalkable({x:NaN,y:200})).toBe(false);
  });
  it('routes around the island without crossing any counter',()=>{
    const origin={x:300,y:220},target={x:500,y:220};
    const path=routeTo(origin,target)!;
    expect(path.length).toBeGreaterThan(1);
    expect(path.at(-1)).toEqual(target);
    let previous=origin;
    for(const p of path){expect(isWalkable(p)).toBe(true);expect(segmentClear(previous,p)).toBe(true);previous=p;}
    expect(segmentClear(origin,target)).toBe(false);
  });
  it('keeps top and bottom island passages open',()=>{
    expect(segmentClear({x:300,y:100},{x:500,y:100})).toBe(true);
    expect(segmentClear({x:300,y:350},{x:500,y:350})).toBe(true);
    expect(routeTo({x:300,y:350},{x:500,y:350})).toEqual([{x:500,y:350}]);
  });
  it.each([
    {target:'handoff_a',other:'handoff_b',edge:{x:400,y:116},inside:{x:400,y:140},far:{x:400,y:83}},
    {target:'handoff_b',other:'handoff_a',edge:{x:400,y:324},inside:{x:400,y:300},far:{x:400,y:357}},
  ] as const)('reaches only $target from its outer island edge without crossing furniture',({target,other,edge,inside,far})=>{
    expect(isWalkable(edge)).toBe(true);
    expect(canReachTarget(edge,target)).toBe(true);
    expect(approachFor(edge,target)).toEqual(edge);
    expect(canReachTarget(edge,other)).toBe(false);
    expect(canReachTarget(inside,target)).toBe(false);
    expect(canReachTarget(far,target)).toBe(false);
    expect(segmentClear(edge,inside)).toBe(false);
  });
  it.each([
    {target:'handoff_a',other:'handoff_b',point:{x:328,y:180}},
    {target:'handoff_a',other:'handoff_b',point:{x:472,y:180}},
    {target:'handoff_b',other:'handoff_a',point:{x:328,y:260}},
    {target:'handoff_b',other:'handoff_a',point:{x:472,y:260}},
  ] as const)('keeps the existing side approach $point usable for $target',({target,other,point})=>{
    expect(canReachTarget(point,target)).toBe(true);
    expect(canReachTarget(point,other)).toBe(false);
  });
  it('stops directional input at the first collision without bending',()=>{
    const stop=stopAlongRay({x:300,y:220},{x:1,y:0});
    expect(stop.x).toBeLessThanOrEqual(336);expect(stop.x).toBeGreaterThan(335);
    expect(stop.y).toBe(220);
    expect(isWalkable(stop)).toBe(true);
    expect(stopAlongRay(stop,{x:1,y:0}).x).toBeCloseTo(stop.x,2);
    expect(stopAlongRay({x:300,y:220},{x:0,y:0})).toEqual({x:300,y:220});
  });
  it('provides reachable interaction points for every fixed target',()=>{
    expect(TARGET_IDS).toHaveLength(14);
    for(const id of TARGET_IDS){
      const p=approachFor({x:260,y:320},id)!;
      expect(p,id).not.toBeNull();expect(isWalkable(p),id).toBe(true);
      expect(canReachTarget(p,id),id).toBe(true);
      expect(KITCHEN_LAYOUT.targets[id].approach_points.length).toBeGreaterThan(0);
    }
    expect(canReachTarget({x:470,y:180},'handoff_a')).toBe(true);
    expect(canReachTarget({x:16,y:190},'source_pumpkin')).toBe(false);
  });
  it('rejects furniture and non-finite endpoints and handles no movement',()=>{
    expect(routeTo({x:300,y:220},{x:400,y:200})).toBeNull();
    expect(routeTo({x:300,y:220},{x:Infinity,y:200})).toBeNull();
    expect(routeTo({x:300,y:220},{x:300,y:220})).toEqual([]);
  });
});
