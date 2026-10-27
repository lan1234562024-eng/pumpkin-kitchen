// Game host functions. Importing or printing this module never joins a game.
import {pathToFileURL} from 'node:url';

async function run(target,operation,guard){
 let v=load("playState");const c=load("playContext"),selectedKey=v.task_keys?.[target];
 if(typeof guard!=="function")throw Error("selected_guard_required");
 let received=load("playReceivedAt"),elapsed=Date.now()-received,serverTime=v.observation.server_time_ms;
 if(!Number.isFinite(received)||!Number.isFinite(serverTime)||!Number.isFinite(elapsed)||elapsed<0)throw Error("observation_time_invalid");
 if(elapsed>1500){
  const reply=await tools.game_observe({control_token:load("playToken"),compact:true});
  const at=Date.now();let q=reply.structuredContent;
  for(const x of reply.content??[])if(!q&&x.type==="text"){try{q=JSON.parse(x.text)}catch{}}
  if(reply.isError||!q?.observation?.snapshot||!q.task_keys){if(q?.code==="FORBIDDEN")store("playToken",null);throw Error(q?.code==="FORBIDDEN"?"control_lost":"tool_response_unavailable");}
  store("playState",q);store("playReceivedAt",at);v=q;received=at;
 }
 const s=v.observation.snapshot;elapsed=Date.now()-received;serverTime=v.observation.server_time_ms;
 if(!Number.isFinite(received)||!Number.isFinite(serverTime)||!Number.isFinite(s.round_ends_at_ms)||!Number.isFinite(elapsed)||elapsed<0)throw Error("observation_time_invalid");
 // Host elapsed time can conservatively check deadlines, never mint command time.
 const now=serverTime+elapsed;
 if(!Number.isFinite(now))throw Error("observation_time_invalid");
 if(now>=s.round_ends_at_ms)throw Error("round_ended");
 if(typeof selectedKey!=="string"||v.task_keys?.[target]!==selectedKey||s.phase!=="playing"||s.round_id!==c.round||s.seats.ai.generation!==c.generation||s.seats.ai.controller!=="external"||!guard(s,now)||
  (target==="plates"&&operation==="take_plate"&&!eval("("+load("playChecks")+")")().plate(s,now)))throw Error("selected_intent_changed");
 const started=Date.now();
 const r=await tools.game_task({ruleset_id:"pumpkin-kitchen-v1",control_token:load("playToken"),target,operation,expected_key:selectedKey,round_id:c.round,seat_generation:c.generation,state_version:s.state_version,issued_at_ms:serverTime,ttl_ms:10000});
 const at=Date.now();let q=r.structuredContent;for(const x of r.content??[])if(!q&&x.type==="text"){try{q=JSON.parse(x.text)}catch{}}
 if(!q?.observation){if(q?.code==="FORBIDDEN")store("playToken",null);throw Error(q?.code==="FORBIDDEN"?"control_lost":"tool_response_unavailable");}
 store("playState",q);store("playReceivedAt",at);const log=load("playLog")??[];log.push({target,operation,reason:q.reason,ms:at-started,started_at_ms:started,returned_at_ms:at,server_time:q.observation.server_time_ms});store("playLog",log);
 if(r.isError||q.reason!=="completed")throw Error(q.reason??"tool_failed");
 return q.observation.snapshot;
}

function playSummary(){
 const q=load("playState"),s=q?.observation?.snapshot;
 if(!s)return {phase:"unknown"};
 const now=q.observation.server_time_ms+Math.max(0,Date.now()-(load("playReceivedAt")??Date.now()));
 const seat=id=>({position:s.seats[id].position,held_item_id:s.seats[id].held_item_id,
  action:s.seats[id].active_action?{type:s.seats[id].active_action.type,target:s.seats[id].active_action.target}:null});
 return {round:s.round_id,phase:s.phase,snapshot_age_ms:Math.max(0,Date.now()-(load("playReceivedAt")??Date.now())),remaining_ms:Math.max(0,(s.round_ends_at_ms??now)-now),
  ai:seat("ai"),human:seat("human"),items:s.items,slots:s.slots,
  orders:s.orders.map(o=>({id:o.id,recipe:o.recipe_id,phase:o.phase,remaining_ms:Math.max(0,(o.delivery_deadline_ms??o.pending_deadline_ms)-now)})),
  score:s.score,revenue:s.revenue,last_task_reason:q.reason??null};
}

async function joinPrepared(){
 if(!load("playRun")||!load("playSummary")||!load("playChecks")||!load("playGroup"))throw Error("prepare_before_join");
 const r=await tools.game_join({ruleset_id:"pumpkin-kitchen-v1"});
 const at=Date.now();let q=r.structuredContent;
 for(const x of r.content??[])if(!q&&x.type==="text"){try{q=JSON.parse(x.text)}catch{}}
 if(r.isError||typeof q?.control_token!=="string"||!q.observation?.snapshot||!q.task_keys)
  throw Error(q?.code??"join_response_unavailable");
 const s=q.observation.snapshot;
 store("playToken",q.control_token);store("playState",q);store("playReceivedAt",at);
 store("playContext",{round:s.round_id,generation:s.seats.ai.generation});store("playLog",[]);
 return eval("("+load("playSummary")+")")();
}

function playChecks(){
 const humanPlate=(s,recipe)=>{
  const held=s.items[s.seats.human.held_item_id];
  if(held?.kind!=="plate")return false;
  if(held.recipe_id!==null)return held.recipe_id===recipe;
  if(held.contents.length===0)return true;
  return recipe==="pumpkin_salad"&&held.contents.every(id=>{
   const food=s.items[id];
   return food?.kind==="ingredient"&&((food.ingredient==="pumpkin"&&food.preparation==="cooked")||
    (food.ingredient==="cucumber"&&food.preparation==="chopped"));
  });
 };
 return {
  humanPlate,
  plate:(s,now)=>s.phase==="playing"&&s.seats.ai.held_item_id===null&&Number.isFinite(now)&&now<s.round_ends_at_ms&&
   s.orders.some(o=>o.phase==="accepted"&&now<o.delivery_deadline_ms&&!humanPlate(s,o.recipe_id)&&
    (o.recipe_id==="pumpkin_soup"?["burner_a","burner_b"].some(t=>s.items[s.slots[t]]?.kind==="pot"&&s.items[s.slots[t]].phase==="soup_ready"):
     o.recipe_id==="pumpkin_salad"&&["handoff_a","handoff_b","counter_left","counter_right","chop"].some(t=>{
      const food=s.items[s.slots[t]];
      return food?.kind==="ingredient"&&food.ingredient==="cucumber"&&food.preparation==="chopped"&&
       (t!=="chop"||!Object.values(s.seats).some(p=>p.active_action?.type==="chop"));
     }))),
  chop:(s,id)=>s.phase==="playing"&&s.seats.ai.held_item_id===id&&
   s.slots.chop===null&&!Object.values(s.seats).some(p=>p.active_action?.type==="chop"),
  cream:(s,p,now)=>{
   const pot=s.items[p.pot],food=s.items[p.pumpkin];
   const order=s.orders.find(o=>o.id===p.order);
   const assigned=p.humanCream&&s.seats.human.held_item_id===p.humanCream&&
    s.items[p.humanCream]?.ingredient==="cream";
   return s.phase==="playing"&&Number.isFinite(now)&&now<s.round_ends_at_ms&&
    s.slots[p.burner]===p.pot&&pot?.kind==="pot"&&pot.phase==="cooked_pumpkin"&&
    pot.contents.length===1&&pot.contents[0]===p.pumpkin&&
    food?.kind==="ingredient"&&food.ingredient==="pumpkin"&&food.preparation==="cooked"&&
    order?.phase==="accepted"&&order.recipe_id==="pumpkin_soup"&&now<order.delivery_deadline_ms&&!assigned;
  }
 };
}

async function playGroup(input){
 const summary=()=>eval("("+load("playSummary")+")")();
 let stopped=null;
 const work=(async()=>{
  try{
   const p=JSON.parse(JSON.stringify(input));
   const c=load("playContext"),s0=load("playState")?.observation?.snapshot;
   if(!c||!s0||p.round!==c.round||p.generation!==c.generation||
    s0.round_id!==p.round||s0.seats.ai.generation!==p.generation)
    throw Error("selected_intent_changed");
   const run=eval("("+load("playRun")+")"),checks=eval("("+load("playChecks")+")")();
   const bound=(s,now)=>s.round_id===p.round&&s.seats.ai.generation===p.generation&&
    s.phase==="playing"&&now<s.round_ends_at_ms;
   const live=(s,now,recipe)=>s.orders.some(o=>o.id===p.order&&o.phase==="accepted"&&
    now<o.delivery_deadline_ms&&(!recipe||o.recipe_id===recipe));
   const table=t=>["handoff_a","handoff_b","counter_left","counter_right"].includes(t);
   const step=async(target,operation,guard)=>{
    const s=await run(target,operation,(s,now)=>bound(s,now)&&guard(s,now));
    const v=summary();
    notify({event:"step_done",kind:p.kind,target,operation,round:s.round_id,
     remaining_ms:v.remaining_ms,ai_held:s.items[s.seats.ai.held_item_id]??null,
     human_held:s.items[s.seats.human.held_item_id]??null,board:s.slots.chop,
     burners:[s.items[s.slots.burner_a]??null,s.items[s.slots.burner_b]??null],orders:v.orders});
    return s;
   };
   const orderPolicy=(a,initial,order0)=>{
    const recipe=order0?.recipe_id;
    if(!["pumpkin_salad","pumpkin_soup"].includes(recipe))throw Error("selected_intent_changed");
    const fallback=a.fallbackOrders===undefined?[]:a.fallbackOrders;
    if(!Array.isArray(fallback)||fallback.length>1||!fallback.every(id=>typeof id==="string"&&id.length>0&&id!==a.order))
     throw Error("selected_parameters_invalid");
    const orders=[order0,...fallback.map(id=>initial.orders.find(o=>o.id===id))].map(o=>o&&JSON.parse(JSON.stringify(o)));
    const q0=load("playState"),elapsed0=Date.now()-load("playReceivedAt"),now0=q0.observation.server_time_ms+elapsed0;
    if(!Number.isFinite(elapsed0)||elapsed0<0||!Number.isFinite(now0))throw Error("observation_time_invalid");
    if(orders.some(o=>!o||o.phase!=="accepted"||o.recipe_id!==recipe||!Number.isFinite(o.delivery_deadline_ms)||now0>=o.delivery_deadline_ms))
     throw Error("selected_intent_changed");
    const orderKeys=orders.map(o=>JSON.stringify(o));
    const earliest=(s,now)=>s.orders.filter(o=>o.phase==="accepted"&&o.recipe_id===recipe&&now<o.delivery_deadline_ms)
     .sort((a,b)=>a.delivery_deadline_ms-b.delivery_deadline_ms||a.id.localeCompare(b.id))[0]?.id;
    const selected=(s,now)=>{
     const index=now<orders[0].delivery_deadline_ms?0:1,chosen=orders[index];
     return !!chosen&&now<chosen.delivery_deadline_ms&&JSON.stringify(s.orders.find(o=>o.id===chosen.id))===orderKeys[index]&&
      earliest(s,now)===chosen.id;
    };
    if(earliest(initial,now0)!==a.order||!selected(initial,now0))throw Error("selected_intent_changed");
    return {recipe,selected,lastDeadline:Math.max(...orders.map(o=>o.delivery_deadline_ms))};
   };
   const serve=async(a,initial,order0,previousPolicy)=>{
    if(!["burner_a","burner_b"].includes(a.burner)||![a.pot,a.pumpkin,a.order].every(x=>typeof x==="string")||
     !(a.plate===null||typeof a.plate==="string"))throw Error("selected_parameters_invalid");
    const {recipe,selected,lastDeadline}=previousPolicy??orderPolicy(a,initial,order0);
    const signature=(s,id)=>{const item=s.items[id];return JSON.stringify([item,item?.contents?.map(child=>s.items[child])]);};
    if(a.waitForSoup!==undefined){
     const cream=a.waitForSoup?.cream;
     if(recipe!=="pumpkin_soup"||typeof cream!=="string"||!cream)throw Error("selected_parameters_invalid");
     const q0=load("playState"),elapsed0=Date.now()-load("playReceivedAt"),now0=q0.observation.server_time_ms+elapsed0;
     if(!Number.isFinite(elapsed0)||elapsed0<0||!Number.isFinite(now0))throw Error("observation_time_invalid");
     const heldKey=signature(initial,a.plate),hostEnd=Date.now()+10000;
     const serverEnd=Math.min(now0+10000,initial.round_ends_at_ms,lastDeadline);
     let previousStage=-1;
     for(let waits=0;;waits++){
      const q=load("playState"),s=q.observation.snapshot,elapsed=Date.now()-load("playReceivedAt"),now=q.observation.server_time_ms+elapsed;
      if(!Number.isFinite(elapsed)||elapsed<0||!Number.isFinite(now)||!Number.isFinite(serverEnd))throw Error("observation_time_invalid");
      if(!bound(s,now)||s.seats.ai.controller!=="external"||s.seats.ai.active_action!==null||
       !selected(s,now)||s.seats.ai.held_item_id!==a.plate||checks.humanPlate(s,recipe))throw Error("selected_intent_changed");
      if(a.plate!==null&&(s.items[a.plate]?.kind!=="plate"||s.items[a.plate].recipe_id!==null||
       s.items[a.plate].contents.length!==0||signature(s,a.plate)!==heldKey))throw Error("selected_intent_changed");
      const pot=s.items[a.pot],pumpkin=s.items[a.pumpkin],dairy=s.items[cream];
      const stage=["cooking_pumpkin","cooked_pumpkin","cooking_soup","soup_ready"].indexOf(pot?.phase);
      if(s.slots[a.burner]!==a.pot||pot?.kind!=="pot"||stage<0||stage<previousStage||
       pumpkin?.kind!=="ingredient"||pumpkin.ingredient!=="pumpkin"||
       pumpkin.preparation!==(stage===0?"chopped":"cooked")||
       dairy?.kind!=="ingredient"||dairy.ingredient!=="cream"||dairy.preparation!=="raw"||
       JSON.stringify(pot.contents)!==JSON.stringify(stage<2?[a.pumpkin]:[a.pumpkin,cream])||
       (stage<2&&s.seats.human.held_item_id!==cream))throw Error("selected_intent_changed");
      previousStage=stage;
      const remaining=Math.min(hostEnd-Date.now(),serverEnd-now);
      if(remaining<=0)throw Error("soup_ready_timeout");
      if(stage===3){initial=s;break;}
      if(waits>=8)throw Error("soup_ready_wait_limit");
      const reply=await tools.game_wait({control_token:load("playToken"),round_id:p.round,
       generation:p.generation,after_cursor:q.observation.events_cursor,timeout_ms:remaining});
      const at=Date.now();let next=reply.structuredContent;
      for(const x of reply.content??[])if(!next&&x.type==="text"){try{next=JSON.parse(x.text)}catch{}}
      if(next?.code==="FORBIDDEN"){store("playToken",null);throw Error("control_lost");}
      if(!next?.observation?.snapshot||!next.task_keys)throw Error("tool_response_unavailable");
      store("playState",next);store("playReceivedAt",at);
      if(reply.isError||!["changed","timeout","action_completed","action_cancelled","action_rejected"].includes(next.reason))
       throw Error(next.reason??"tool_failed");
     }
    }
    const potKey=signature(initial,a.pot),pot0=initial.items[a.pot];
    const ready=(s,now)=>{
     const pot=s.items[a.pot],pumpkin=s.items[a.pumpkin];
     return selected(s,now)&&s.slots[a.burner]===a.pot&&signature(s,a.pot)===potKey&&pot?.kind==="pot"&&
      pumpkin?.ingredient==="pumpkin"&&pumpkin.preparation==="cooked"&&pot.contents.includes(a.pumpkin)&&
      (recipe==="pumpkin_salad"?pot.phase==="cooked_pumpkin"&&pot.contents.length===1:
       pot.phase==="soup_ready"&&pot.contents.length===2&&pot.contents.some(id=>s.items[id]?.ingredient==="cream"));
    };
    let plate=a.plate,plateKey=plate===null?null:signature(initial,plate);
    const bowl=s=>{
     const item=s.items[plate],food=item?.contents?.map(id=>s.items[id]);
     return s.seats.ai.held_item_id===plate&&item?.kind==="plate"&&item.recipe_id===null&&signature(s,plate)===plateKey&&
      (recipe==="pumpkin_soup"?item.contents.length===0:item.contents.length===1&&food[0]?.ingredient==="cucumber"&&food[0].preparation==="chopped");
    };
    if(plate===null){
     const first=await step("plates","take_plate",(s,now)=>recipe==="pumpkin_soup"&&s.seats.ai.held_item_id===null&&!checks.humanPlate(s,recipe)&&ready(s,now));
     plate=first.seats.ai.held_item_id;plateKey=signature(first,plate);
    }
    const expectedContents=[...(initial.items[a.plate]?.contents??[]),...(pot0?.contents??[])];
    const poured=await step(a.burner,"pour",(s,now)=>ready(s,now)&&bowl(s));
    const dish=poured.items[plate],dishKey=signature(poured,plate);
    if(dish?.kind!=="plate"||dish.recipe_id!==recipe||JSON.stringify(dish.contents)!==JSON.stringify(expectedContents))throw Error("selected_intent_changed");
    await step("delivery","deliver",(s,now)=>selected(s,now)&&s.seats.ai.held_item_id===plate&&signature(s,plate)===dishKey);
   };
   const completeCream=p.kind==="cream"&&p.finish?.kind==="serve";
   if((p.kind!=="serve"&&p.waitForSoup!==undefined)||
    (p.kind!=="serve"&&!completeCream&&p.fallbackOrders!==undefined))throw Error("selected_parameters_invalid");
   if(p.kind==="cut"){
    if(!["pumpkin","cucumber"].includes(p.ingredient)||typeof p.order!=="string")
     throw Error("selected_parameters_invalid");
    const start=p.start;
    if((start!==undefined&&(!start||!["hand","board"].includes(start.from)||typeof start.item!=="string"||!start.item||p.existingIngredients!==undefined))||
     (p.waitForBoard!==undefined&&typeof p.waitForBoard!=="boolean")||
     (p.waitForBoard===true&&p.boardRelease!==undefined)||
     (start?.from==="board"&&(p.waitForBoard===true||p.boardRelease!==undefined)))throw Error("selected_parameters_invalid");
    const existing=p.existingIngredients===undefined?[]:p.existingIngredients;
    const bowlFinish=p.finish?.kind==="plate"&&p.ingredient==="cucumber";
    const continuation=p.finish?.serve;
    const potFinish=p.finish&&p.finish.kind===undefined&&p.ingredient==="pumpkin"&&
     ["burner_a","burner_b"].includes(p.finish.target)&&typeof p.finish.pot==="string"&&p.finish.pot.length>0;
    if(!Array.isArray(existing)||!existing.every(id=>typeof id==="string"&&id.length>0)||new Set(existing).size!==existing.length||
     (p.finish!==undefined&&!bowlFinish&&!potFinish)||
     (continuation!==undefined&&(!bowlFinish||!continuation||typeof continuation.pumpkin!=="string"||!continuation.pumpkin)))
     throw Error("selected_parameters_invalid");
    if(continuation!==undefined&&(s0.items[continuation.pumpkin]?.kind!=="ingredient"||
     s0.items[continuation.pumpkin].ingredient!=="pumpkin"))throw Error("selected_intent_changed");
    let release=p.boardRelease,board0=s0.items[release?.item];
    const human0=s0.seats.human.active_action;
    if(release!==undefined&&(!release||![release.item,release.action].every(x=>typeof x==="string"&&x.length>0)))
     throw Error("selected_parameters_invalid");
    if(release!==undefined&&(s0.slots.chop!==release.item||human0?.type!=="chop"||human0.action_id!==release.action||human0.item_id!==release.item||
     board0?.kind!=="ingredient"||!["pumpkin","cucumber"].includes(board0.ingredient)||board0.ingredient===p.ingredient||board0.preparation!=="raw"))
     throw Error("selected_intent_changed");
    const bindBoard=s=>{
     if(!p.waitForBoard||release||s.slots.chop===null)return;
     const food=s.items[s.slots.chop],human=s.seats.human.active_action;
     const chopping=Object.values(s.seats).some(seat=>seat.active_action?.type==="chop");
     if(food?.kind!=="ingredient"||!["pumpkin","cucumber"].includes(food.ingredient)||food.ingredient===p.ingredient||
      !(food.preparation==="chopped"?!chopping:food.preparation==="raw"&&human?.type==="chop"&&human.item_id===food.id&&
       s.seats.ai.active_action?.type!=="chop"))throw Error("selected_intent_changed");
     release={item:food.id,action:human?.type==="chop"?human.action_id:null};board0=food;
    };
    bindBoard(s0);
    const boardAvailable=s=>{
     const chopping=Object.values(s.seats).some(seat=>seat.active_action?.type==="chop");
     if(s.slots.chop===null)return !chopping;
     if(!release||s.slots.chop!==release.item)return false;
     const food=s.items[release.item],human=s.seats.human.active_action;
     return food?.kind==="ingredient"&&food.ingredient===board0.ingredient&&
      (food.preparation==="chopped"?!chopping:food.preparation==="raw"&&human?.type==="chop"&&
       human.action_id===release.action&&human.item_id===release.item&&s.seats.ai.active_action?.type!=="chop");
    };
    const known=JSON.stringify([...existing].sort());
    const sameIngredients=s=>JSON.stringify(Object.values(s.items).filter(item=>item.kind==="ingredient"&&item.ingredient===p.ingredient).map(item=>item.id).sort())===known;
    const finishReady=s=>!potFinish||(s.slots[p.finish.target]===p.finish.pot&&s.items[p.finish.pot]?.kind==="pot"&&
     s.items[p.finish.pot].phase==="empty"&&s.items[p.finish.pot].contents.length===0);
    const orderKey=JSON.stringify(s0.orders.find(o=>o.id===p.order));
    const order=(s,now)=>live(s,now,p.ingredient==="cucumber"?"pumpkin_salad":undefined)&&finishReady(s)&&
     JSON.stringify(s.orders.find(o=>o.id===p.order))===orderKey;
    let first=s0,item=start?.item;
    if(start===undefined){
     first=await step("source_"+p.ingredient,"source",(s,now)=>s.seats.ai.held_item_id===null&&boardAvailable(s)&&sameIngredients(s)&&order(s,now));
     item=first.seats.ai.held_item_id;
    }else{
     const food=s0.items[item],idle=!Object.values(s0.seats).some(seat=>seat.active_action?.type==="chop");
     if(food?.kind!=="ingredient"||food.ingredient!==p.ingredient||
      (start.from==="hand"?s0.seats.ai.held_item_id!==item||food.preparation!=="raw":
       s0.seats.ai.held_item_id!==null||s0.slots.chop!==item||food.preparation!=="chopped"||!idle))throw Error("selected_intent_changed");
    }
    const raw=s=>s.seats.ai.held_item_id===item&&s.items[item]?.kind==="ingredient"&&
     s.items[item].ingredient===p.ingredient&&s.items[item].preparation==="raw";
    bindBoard(first);
    if(release&&first.slots.chop!==null){
     const hostEnd=Date.now()+3000,q0=load("playState"),elapsed0=Date.now()-load("playReceivedAt");
     const serverEnd=Math.min(q0.observation.server_time_ms+elapsed0+3000,first.round_ends_at_ms,
      first.orders.find(o=>o.id===p.order)?.delivery_deadline_ms??-Infinity);
     for(let waits=0;;waits++){
      const q=load("playState"),s=q.observation.snapshot,elapsed=Date.now()-load("playReceivedAt"),now=q.observation.server_time_ms+elapsed;
      if(!Number.isFinite(elapsed)||elapsed<0||!Number.isFinite(now)||!Number.isFinite(serverEnd))throw Error("observation_time_invalid");
      if(!bound(s,now)||s.seats.ai.controller!=="external"||!raw(s)||!order(s,now)||!boardAvailable(s))throw Error("selected_intent_changed");
      const remaining=Math.min(hostEnd-Date.now(),serverEnd-now);
      if(remaining<=0)throw Error("board_release_timeout");
      if(s.slots.chop===null)break;
      if(waits>=6)throw Error("board_release_wait_limit");
      const reply=await tools.game_wait({control_token:load("playToken"),round_id:p.round,
       generation:p.generation,after_cursor:q.observation.events_cursor,timeout_ms:remaining});
      const at=Date.now();let next=reply.structuredContent;
      for(const x of reply.content??[])if(!next&&x.type==="text"){try{next=JSON.parse(x.text)}catch{}}
      if(next?.code==="FORBIDDEN"){store("playToken",null);throw Error("control_lost");}
      if(!next?.observation?.snapshot||!next.task_keys)throw Error("tool_response_unavailable");
      store("playState",next);store("playReceivedAt",at);
      if(reply.isError||!["changed","timeout","action_completed","action_cancelled","action_rejected"].includes(next.reason))
       throw Error(next.reason??"tool_failed");
     }
    }
    if(start?.from!=="board")await step("chop","chop",(s,now)=>checks.chop(s,item)&&order(s,now)&&raw(s));
    const chopped=(s,now)=>order(s,now)&&s.slots.chop===item&&s.items[item]?.kind==="ingredient"&&
     s.items[item].ingredient===p.ingredient&&s.items[item].preparation==="chopped"&&
     !Object.values(s.seats).some(seat=>seat.active_action?.type==="chop");
    if(bowlFinish){
     const taken=await step("plates","take_plate",(s,now)=>chopped(s,now)&&s.seats.ai.held_item_id===null&&!checks.humanPlate(s,"pumpkin_salad"));
     const plate=taken.seats.ai.held_item_id;
     const collected=await step("chop","add_ingredient",(s,now)=>chopped(s,now)&&s.seats.ai.held_item_id===plate&&
      s.items[plate]?.kind==="plate"&&s.items[plate].recipe_id===null&&s.items[plate].contents.length===0);
     if(continuation!==undefined){
      const burners=["burner_a","burner_b"].filter(target=>{
       const pot=collected.items[collected.slots[target]];
       return pot?.kind==="pot"&&pot.contents.includes(continuation.pumpkin);
      });
      if(burners.length!==1)throw Error("selected_intent_changed");
      const burner=burners[0],pot=collected.slots[burner];
      await serve({burner,pot,pumpkin:continuation.pumpkin,order:p.order,plate},collected,s0.orders.find(o=>o.id===p.order));
     }
    }else{
     await step("chop","take",(s,now)=>chopped(s,now)&&s.seats.ai.held_item_id===null);
     if(potFinish)await step(p.finish.target,"add_ingredient",(s,now)=>order(s,now)&&s.seats.ai.held_item_id===item&&
      s.items[item]?.kind==="ingredient"&&s.items[item].ingredient==="pumpkin"&&s.items[item].preparation==="chopped");
    }
   }else if(p.kind==="place"){
    if(!table(p.target)||typeof p.item!=="string")throw Error("selected_parameters_invalid");
    await step(p.target,"place",s=>s.seats.ai.held_item_id===p.item&&!!s.items[p.item]&&s.slots[p.target]===null);
   }else if(p.kind==="cream"){
    if(p.finish!==undefined&&!completeCream)throw Error("selected_parameters_invalid");
    if(!completeCream){
     if(!["burner_a","burner_b"].includes(p.burner)||
      ![p.pot,p.pumpkin,p.order].every(x=>typeof x==="string"))throw Error("selected_parameters_invalid");
     const first=await step("source_cream","source",(s,now)=>s.seats.ai.held_item_id===null&&checks.cream(s,p,now));
     const cream=first.seats.ai.held_item_id;
     await step(p.burner,"add_ingredient",(s,now)=>s.seats.ai.held_item_id===cream&&
      s.items[cream]?.ingredient==="cream"&&checks.cream(s,p,now));
    }else{
     if(![p.pumpkin,p.order].every(x=>typeof x==="string"&&x.length>0)||
      ((p.burner===undefined)!==(p.pot===undefined))||
      (p.burner!==undefined&&(!["burner_a","burner_b"].includes(p.burner)||typeof p.pot!=="string"||!p.pot)))
      throw Error("selected_parameters_invalid");
     const policy=orderPolicy(p,s0,s0.orders.find(o=>o.id===p.order));
     if(policy.recipe!=="pumpkin_soup")throw Error("selected_intent_changed");
     let burner=p.burner,potId=p.pot,previousStage=-1;
     const pumpkinStage=s=>{
      const food=s.items[p.pumpkin];
      if(food?.kind!=="ingredient"||food.ingredient!=="pumpkin")return -1;
      if(burner!==undefined&&s.slots[burner]!==potId)return -1;
      if(s.seats.human.held_item_id===p.pumpkin&&food.preparation==="chopped"){
       if(previousStage>0)return -1;
       const pot=s.items[potId];
       if(burner!==undefined&&(pot?.kind!=="pot"||pot.phase!=="empty"||pot.contents.length!==0))return -1;
       previousStage=0;return 0;
      }
      const matches=["burner_a","burner_b"].filter(t=>s.items[s.slots[t]]?.kind==="pot"&&s.items[s.slots[t]].contents.includes(p.pumpkin));
      if(matches.length!==1)return -1;
      const actual=matches[0],id=s.slots[actual],pot=s.items[id];
      const stage=pot.phase==="cooking_pumpkin"?1:pot.phase==="cooked_pumpkin"?2:-1;
      if(stage<0||stage<previousStage||pot.contents.length!==1||food.preparation!==(stage===1?"chopped":"cooked")||
       (burner!==undefined&&(burner!==actual||potId!==id)))return -1;
      burner=actual;potId=id;previousStage=stage;return stage;
     };
     const freeCream=s=>{
      const contained=new Set(Object.values(s.items).filter(i=>i.kind==="pot"||i.kind==="plate").flatMap(i=>i.contents));
      return Object.values(s.items).filter(i=>i.kind==="ingredient"&&i.ingredient==="cream"&&!contained.has(i.id)).map(i=>i.id);
     };
     if(pumpkinStage(s0)<0)throw Error("selected_intent_changed");
     const available=(s,now)=>policy.selected(s,now)&&!checks.humanPlate(s,"pumpkin_soup")&&pumpkinStage(s)>=0;
     const first=await step("source_cream","source",(s,now)=>s.seats.ai.held_item_id===null&&s.slots.source_cream===null&&
      freeCream(s).length===0&&available(s,now));
     const cream=first.seats.ai.held_item_id;
     const holding=s=>s.seats.ai.held_item_id===cream&&s.items[cream]?.kind==="ingredient"&&
      s.items[cream].ingredient==="cream"&&s.items[cream].preparation==="raw"&&freeCream(s).every(id=>id===cream);
     const q0=load("playState"),elapsed0=Date.now()-load("playReceivedAt"),now0=q0.observation.server_time_ms+elapsed0;
     if(!Number.isFinite(elapsed0)||elapsed0<0||!Number.isFinite(now0))throw Error("observation_time_invalid");
     const hostEnd=Date.now()+8000,serverEnd=Math.min(now0+8000,first.round_ends_at_ms,policy.lastDeadline);
     for(let waits=0;;waits++){
      const q=load("playState"),s=q.observation.snapshot,elapsed=Date.now()-load("playReceivedAt"),now=q.observation.server_time_ms+elapsed;
      if(!Number.isFinite(elapsed)||elapsed<0||!Number.isFinite(now)||!Number.isFinite(serverEnd))throw Error("observation_time_invalid");
      if(!bound(s,now)||s.seats.ai.controller!=="external"||s.seats.ai.active_action!==null||!holding(s)||!available(s,now))
       throw Error("selected_intent_changed");
      const remaining=Math.min(hostEnd-Date.now(),serverEnd-now);
      if(remaining<=0)throw Error("pumpkin_ready_timeout");
      if(previousStage===2)break;
      if(waits>=6)throw Error("pumpkin_ready_wait_limit");
      const reply=await tools.game_wait({control_token:load("playToken"),round_id:p.round,
       generation:p.generation,after_cursor:q.observation.events_cursor,timeout_ms:remaining});
      const at=Date.now();let next=reply.structuredContent;
      for(const x of reply.content??[])if(!next&&x.type==="text"){try{next=JSON.parse(x.text)}catch{}}
      if(next?.code==="FORBIDDEN"){store("playToken",null);throw Error("control_lost");}
      if(!next?.observation?.snapshot||!next.task_keys)throw Error("tool_response_unavailable");
      store("playState",next);store("playReceivedAt",at);
      if(reply.isError||!["changed","timeout","action_completed","action_cancelled","action_rejected"].includes(next.reason))
       throw Error(next.reason??"tool_failed");
     }
     const added=await step(burner,"add_ingredient",(s,now)=>holding(s)&&available(s,now)&&previousStage===2);
     await serve({burner,pot:potId,pumpkin:p.pumpkin,order:p.order,plate:null,waitForSoup:{cream}},added,null,policy);
    }
   }else if(p.kind==="collect"){
    if(!table(p.target)||![p.item,p.order].every(x=>typeof x==="string")||
     (p.place!==undefined&&(!table(p.place)||p.place===p.target)))throw Error("selected_parameters_invalid");
    const ready=(s,now)=>live(s,now,"pumpkin_salad")&&s.slots[p.target]===p.item&&
     s.items[p.item]?.kind==="ingredient"&&s.items[p.item].ingredient==="cucumber"&&
     s.items[p.item].preparation==="chopped"&&
     (p.place===undefined||s.slots[p.place]===null);
    const first=await step("plates","take_plate",(s,now)=>s.seats.ai.held_item_id===null&&!checks.humanPlate(s,"pumpkin_salad")&&ready(s,now));
    const plate=first.seats.ai.held_item_id;
    await step(p.target,"add_ingredient",(s,now)=>ready(s,now)&&s.seats.ai.held_item_id===plate&&
     s.items[plate]?.kind==="plate"&&s.items[plate].contents.length===0);
    if(p.place!==undefined)await step(p.place,"place",(s,now)=>live(s,now,"pumpkin_salad")&&
     s.seats.ai.held_item_id===plate&&s.items[plate]?.kind==="plate"&&
     s.items[plate].contents.length===1&&s.items[plate].contents[0]===p.item&&s.slots[p.place]===null);
   }else if(p.kind==="serve"){
    await serve(p,s0,s0.orders.find(o=>o.id===p.order));
   }else throw Error("selected_parameters_invalid");
  }catch(e){stopped=e.message;}
  finally{notify({event:"group_done",stopped,...summary()});}
 })();
 try{await yield_control();}finally{await work;}
}

async function playStartup(){
let stopped=null;
try{
 await eval("("+load("playJoin")+")")();
 const q=load("playState"),s=q.observation.snapshot;
 const now=q.observation.server_time_ms+Math.max(0,Date.now()-load("playReceivedAt"));
 if(s.orders.some(o=>o.phase==="accepted"&&o.delivery_deadline_ms>now))return;
 const order=s.orders.find(o=>o.phase==="pending"&&o.pending_deadline_ms>now);
 if(!order)throw Error("selected_order_unavailable");
 const orderId=order.id;
 await eval("("+load("playRun")+")")("orders","accept_order",(state,time)=>{
  const first=state.orders.find(o=>o.phase==="pending"&&o.pending_deadline_ms>time);
  return first?.id===orderId&&first.pending_deadline_ms>time;
 });
}catch(e){stopped=String(e?.message??"startup_stopped");}
finally{text({stopped,state:eval("("+load("playSummary")+")")()});}
}

export {run as playRun,playSummary,joinPrepared as playJoin,playChecks,playGroup,playStartup};

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const functions={playRun:run,playSummary,playJoin:joinPrepared,playChecks,playGroup,playStartup};
 process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(functions).map(([key,fn])=>[key,fn.toString()]))));
}

