import {describe,it,expect} from 'vitest';
import type {GameState,SeatId,StationId,PotItem,PlateItem} from '../src/shared/contracts';
import {createKitchen,applyKitchenInteraction,advanceKitchen,pauseChop,inspectKitchenInteraction} from '../src/game/kitchen';
import {RULESET_ID} from '../src/shared/ruleset';

function fresh():GameState{return {ruleset_id:RULESET_ID,phase:'playing',round_id:1,state_version:1,server_time_ms:0,round_started_at_ms:0,round_ends_at_ms:90000,score:0,revenue:0,orders:[],order_sequence:0,next_spawn_at_ms:12000,next_recipe:'pumpkin_salad',...createKitchen(1),events:[],events_cursor:0,receipts:{},seats:{human:{id:'human',position:{x:260,y:320},held_item_id:null,active_action:null,generation:1,controller:'human'},ai:{id:'ai',position:{x:540,y:320},held_item_id:null,active_action:null,generation:1,controller:'external'}}};}
let sequence=0;
function use(s:GameState,target:StationId,seat:SeatId='human'){const result=applyKitchenInteraction(s,seat,target,`test-${++sequence}`);expect(result,`${seat}:${target}`).toMatchObject({ok:true});}
function tick(s:GameState,ms:number){advanceKitchen(s,s.server_time_ms,s.server_time_ms+ms);s.server_time_ms+=ms;}
function cut(s:GameState,ingredient:'pumpkin'|'cucumber',seat:SeatId='human'){
  use(s,`source_${ingredient}`,seat);use(s,'chop',seat);tick(s,ingredient==='pumpkin'?2000:1500);use(s,'chop',seat);
}
function cooked():GameState{const s=fresh();cut(s,'pumpkin');use(s,'burner_a');tick(s,6000);return s;}
function plateOnCounter(s:GameState){use(s,'plates');use(s,'counter_left');}
function ids(s:GameState){const refs=[...Object.values(s.slots),...Object.values(s.seats).map(p=>p.held_item_id),...Object.values(s.items).flatMap(i=>i.kind==='ingredient'?[]:i.contents)].filter((x):x is string=>x!==null);expect(new Set(refs).size).toBe(refs.length);expect([...refs].sort()).toEqual(Object.keys(s.items).sort());}

describe('portable kitchen items',()=>{
  it('starts with exactly two unique reusable pots',()=>{
    const s=fresh();expect(Object.values(s.items).map(i=>i.kind)).toEqual(['pot','pot']);
    expect(new Set([s.slots.burner_a,s.slots.burner_b]).size).toBe(2);ids(s);
  });
  it('uses crate lids as slots and retrieves the lid item before taking stock',()=>{
    const s=fresh();use(s,'source_pumpkin');const id=s.seats.human.held_item_id;
    use(s,'source_cream');expect(s.slots.source_cream).toBe(id);
    use(s,'source_cream');expect(s.seats.human.held_item_id).toBe(id);
    use(s,'counter_left');use(s,'source_cream');
    expect(s.items[s.seats.human.held_item_id!]).toMatchObject({ingredient:'cream'});ids(s);
  });
  it('refuses occupied and incompatible targets without dropping held items',()=>{
    const s=fresh();use(s,'source_pumpkin');use(s,'counter_left');use(s,'source_cream');const before=structuredClone(s);
    expect(applyKitchenInteraction(s,'human','counter_left','bad')).toMatchObject({ok:false});expect(s).toEqual(before);
    expect(applyKitchenInteraction(s,'human','burner_a','early-cream')).toMatchObject({ok:false});expect(s).toEqual(before);ids(s);
  });
  it('keeps chopping progress and frees the board for the teammate after cancel',()=>{
    const s=fresh();use(s,'source_pumpkin');use(s,'chop');tick(s,1000);const id=s.slots.chop!;
    expect(s.items[id]).toMatchObject({chop_remaining_ms:1000});
    expect(inspectKitchenInteraction(s,'ai','chop')).toMatchObject({allowed:false});
    pauseChop(s,'human');tick(s,5000);expect(s.items[id]).toMatchObject({chop_remaining_ms:1000});
    use(s,'chop','ai');tick(s,1000);use(s,'chop','ai');expect(s.seats.ai.held_item_id).toBe(id);expect(s.items[id]).toMatchObject({preparation:'chopped'});ids(s);
  });
  it('cooks without occupying a person and does not burn after it finishes',()=>{
    const s=fresh();cut(s,'pumpkin');use(s,'burner_a');
    expect(s.seats.human.active_action).toBeNull();expect(s.seats.human.held_item_id).toBeNull();
    tick(s,5999);expect(s.items[s.slots.burner_a!]).toMatchObject({phase:'cooking_pumpkin',remaining_ms:1});
    tick(s,1);expect(s.items[s.slots.burner_a!]).toMatchObject({phase:'cooked_pumpkin',remaining_ms:0});
    tick(s,30000);expect(s.items[s.slots.burner_a!]).toMatchObject({phase:'cooked_pumpkin'});ids(s);
  });
  it('pauses a carried pot and resumes its exact remaining time on the other burner',()=>{
    const s=fresh();cut(s,'pumpkin');use(s,'burner_a');tick(s,2000);const id=s.slots.burner_a!;
    use(s,'burner_a');expect(s.items[id]).toMatchObject({phase:'loaded_pumpkin',remaining_ms:4000});
    tick(s,10000);expect(s.items[id]).toMatchObject({remaining_ms:4000});
    use(s,'burner_b','ai');use(s,'counter_right','ai');use(s,'burner_b');tick(s,3999);
    expect(s.items[id]).toMatchObject({phase:'cooking_pumpkin'});tick(s,1);expect(s.items[id]).toMatchObject({phase:'cooked_pumpkin'});ids(s);
  });
  it('pours a held pot into a plate and keeps the same empty pot in hand',()=>{
    const s=cooked();plateOnCounter(s);const pot=s.slots.burner_a!;use(s,'burner_a');use(s,'counter_left');
    expect(s.seats.human.held_item_id).toBe(pot);expect(s.items[pot]).toMatchObject({phase:'empty',contents:[]});
    expect((s.items[s.slots.counter_left!] as PlateItem).contents).toHaveLength(1);
    use(s,'burner_a');cut(s,'cucumber');use(s,'counter_left');
    expect(s.items[s.slots.counter_left!]).toMatchObject({recipe_id:'pumpkin_salad'});ids(s);
  });
  it('allows cucumber-first salad and taking food into a held plate',()=>{
    const s=cooked();plateOnCounter(s);cut(s,'cucumber');use(s,'counter_left');use(s,'counter_left');
    const pot=s.slots.burner_a!,plate=s.seats.human.held_item_id!;use(s,'burner_a');
    expect(s.items[plate]).toMatchObject({recipe_id:'pumpkin_salad'});expect(s.slots.burner_a).toBe(pot);expect(s.items[pot]).toMatchObject({phase:'empty'});ids(s);
  });
  it('simmers cream only after cooking pumpkin and refuses premature plating',()=>{
    const s=cooked();use(s,'source_cream');use(s,'burner_a');const pot=s.slots.burner_a!;
    use(s,'plates');const before=structuredClone(s);expect(applyKitchenInteraction(s,'human','burner_a','too-soon')).toMatchObject({ok:false});expect(s).toEqual(before);
    tick(s,3000);use(s,'burner_a');expect(s.items[s.seats.human.held_item_id!]).toMatchObject({recipe_id:'pumpkin_soup'});expect(s.items[pot]).toMatchObject({phase:'empty'});ids(s);
  });
  it('rejects raw pumpkin in a plate and cucumber in a pot',()=>{
    const s=fresh();plateOnCounter(s);use(s,'source_pumpkin');let before=structuredClone(s);
    expect(applyKitchenInteraction(s,'human','counter_left','raw-plate')).toMatchObject({ok:false});expect(s).toEqual(before);
    use(s,'counter_right');cut(s,'cucumber');before=structuredClone(s);
    expect(applyKitchenInteraction(s,'human','burner_a','cucumber-pot')).toMatchObject({ok:false});expect(s).toEqual(before);ids(s);
  });
  it('cleans contents without deleting pots and returns empty plates to the rack',()=>{
    const s=cooked();const pot=s.slots.burner_a!;use(s,'burner_a');use(s,'cleanup');expect(s.items[pot]).toMatchObject({phase:'empty',contents:[]});
    use(s,'burner_a');use(s,'plates');const plate=s.seats.human.held_item_id!;use(s,'plates');
    expect(s.items[plate]).toBeUndefined();expect(s.seats.human.held_item_id).toBeNull();expect(Object.values(s.items).filter(i=>i.kind==='pot')).toHaveLength(2);ids(s);
  });
  it.each(['counter_left','handoff_a','chop','source_pumpkin'] as const)('collects chopped cucumber from %s into the same held plate',target=>{
    const s=cooked();cut(s,'cucumber');const cucumber=s.seats.human.held_item_id!;use(s,target);use(s,'plates');
    const plate=s.seats.human.held_item_id!,pot=s.slots.burner_a!;
    expect(inspectKitchenInteraction(s,'human',target)).toMatchObject({allowed:true,operation:'add_ingredient'});
    use(s,target);expect(s.seats.human.held_item_id).toBe(plate);expect(s.slots[target]).toBeNull();
    expect(s.items[plate]).toMatchObject({contents:[cucumber],recipe_id:null});ids(s);
    use(s,'burner_a');expect(s.items[plate]).toMatchObject({recipe_id:'pumpkin_salad'});
    expect(s.slots.burner_a).toBe(pot);expect(s.items[pot]).toMatchObject({phase:'empty',contents:[]});ids(s);
  });
  it('finishes a pumpkin-first held plate directly from a loose cucumber',()=>{
    const s=cooked();cut(s,'cucumber');const cucumber=s.seats.human.held_item_id!;use(s,'handoff_b');use(s,'plates');
    const plate=s.seats.human.held_item_id!;use(s,'burner_a');use(s,'handoff_b');
    expect(s.seats.human.held_item_id).toBe(plate);expect(s.slots.handoff_b).toBeNull();
    expect(s.items[plate]).toMatchObject({recipe_id:'pumpkin_salad'});
    expect((s.items[plate] as PlateItem).contents).toContain(cucumber);ids(s);
  });
  it('collects prepared pumpkin and cream into the same held pot while heat stays paused',()=>{
    const s=fresh();cut(s,'pumpkin');const pumpkin=s.seats.human.held_item_id!;use(s,'chop');
    const pot=s.slots.burner_a!;use(s,'burner_a');use(s,'chop');
    expect(s.slots.chop).toBeNull();expect(s.seats.human.held_item_id).toBe(pot);
    expect(s.items[pot]).toMatchObject({contents:[pumpkin],phase:'loaded_pumpkin',remaining_ms:6000});
    tick(s,1000);expect(s.items[pot]).toMatchObject({remaining_ms:6000});
    use(s,'burner_a');tick(s,6000);use(s,'source_cream');const cream=s.seats.human.held_item_id!;use(s,'handoff_a');
    use(s,'burner_a');use(s,'handoff_a');
    expect(s.slots.handoff_a).toBeNull();expect(s.seats.human.held_item_id).toBe(pot);
    expect(s.items[pot]).toMatchObject({contents:[pumpkin,cream],phase:'loaded_soup',remaining_ms:3000});
    tick(s,1000);expect(s.items[pot]).toMatchObject({remaining_ms:3000});
    use(s,'burner_a');tick(s,3000);use(s,'plates');use(s,'burner_a');
    expect(s.items[s.seats.human.held_item_id!]).toMatchObject({recipe_id:'pumpkin_soup'});ids(s);
  });
  it('blocks collecting from the board while the teammate is chopping',()=>{
    const s=fresh();use(s,'source_cucumber','ai');use(s,'chop','ai');use(s,'plates');
    const plate=s.seats.human.held_item_id!,cucumber=s.slots.chop!,before=structuredClone(s);
    expect(inspectKitchenInteraction(s,'human','chop')).toMatchObject({allowed:false,error:'SEAT_BUSY'});
    expect(applyKitchenInteraction(s,'human','chop','busy-plate')).toMatchObject({ok:false,error:'SEAT_BUSY'});
    expect(s).toEqual(before);tick(s,1500);use(s,'chop');
    expect(s.seats.human.held_item_id).toBe(plate);expect(s.slots.chop).toBeNull();
    expect(s.items[plate]).toMatchObject({contents:[cucumber]});ids(s);
  });
  it.each(['raw_cucumber','chopped_pumpkin','cream'] as const)('does not collect %s into a held plate',food=>{
    const s=fresh();if(food==='chopped_pumpkin')cut(s,'pumpkin');else use(s,food==='cream'?'source_cream':'source_cucumber');
    use(s,'counter_left');use(s,'plates');const before=structuredClone(s);
    expect(inspectKitchenInteraction(s,'human','counter_left')).toMatchObject({allowed:false});
    expect(applyKitchenInteraction(s,'human','counter_left','bad-plate')).toMatchObject({ok:false});
    expect(s).toEqual(before);ids(s);
  });
  it('rejects duplicate cucumber and extra food in a completed held plate without losing items',()=>{
    const s=cooked();plateOnCounter(s);cut(s,'cucumber');use(s,'counter_left');
    cut(s,'cucumber');use(s,'counter_right');use(s,'counter_left');let before=structuredClone(s);
    expect(applyKitchenInteraction(s,'human','counter_right','duplicate-cucumber')).toMatchObject({ok:false});expect(s).toEqual(before);
    use(s,'burner_a');expect(s.items[s.seats.human.held_item_id!]).toMatchObject({recipe_id:'pumpkin_salad'});before=structuredClone(s);
    expect(applyKitchenInteraction(s,'human','counter_right','full-plate')).toMatchObject({ok:false});expect(s).toEqual(before);ids(s);
  });
  it.each(['raw_pumpkin','chopped_cucumber','cream'] as const)('does not collect %s into an empty held pot',food=>{
    const s=fresh();if(food==='chopped_cucumber')cut(s,'cucumber');else use(s,food==='cream'?'source_cream':'source_pumpkin');
    use(s,'counter_right');use(s,'burner_a');const before=structuredClone(s);
    expect(inspectKitchenInteraction(s,'human','counter_right')).toMatchObject({allowed:false});
    expect(applyKitchenInteraction(s,'human','counter_right','bad-pot')).toMatchObject({ok:false});
    expect(s).toEqual(before);ids(s);
  });
});
