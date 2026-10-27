import type {Point} from '../shared/contracts';

export const TARGET_IDS=['orders','source_pumpkin','source_cucumber','source_cream','chop','burner_a','burner_b','handoff_a','handoff_b','counter_left','counter_right','plates','delivery','cleanup'] as const;
export type TargetId=typeof TARGET_IDS[number];
export interface Rect {x:number;y:number;width:number;height:number}
export type TargetKind='orders'|'source'|'chop'|'burner'|'counter'|'plates'|'delivery'|'cleanup';
export interface TargetDefinition {id:TargetId;kind:TargetKind;label:string;position:Point;approach_points:Point[]}
function target(id:TargetId,kind:TargetKind,label:string,x:number,y:number,points:Point[]):TargetDefinition{return {id,kind,label,position:{x,y},approach_points:points};}
export const KITCHEN_LAYOUT={
  width:800,height:500,foot_radius:14,interact_radius:32,
  furniture:[{x:40,y:60,width:112,height:420},{x:648,y:60,width:112,height:420},{x:152,y:400,width:496,height:80},{x:350,y:140,width:100,height:160}] as Rect[],
  targets:{
    orders:target('orders','orders','接单',96,100,[{x:176,y:100}]),
    source_pumpkin:target('source_pumpkin','source','贝贝南瓜',96,190,[{x:176,y:190}]),
    source_cucumber:target('source_cucumber','source','黄瓜',96,270,[{x:176,y:270}]),
    source_cream:target('source_cream','source','奶油',96,350,[{x:176,y:350}]),
    chop:target('chop','chop','砧板',194,438,[{x:194,y:366}]),
    burner_a:target('burner_a','burner','上灶',704,220,[{x:624,y:220}]),
    burner_b:target('burner_b','burner','下灶',704,330,[{x:624,y:330}]),
    handoff_a:target('handoff_a','counter','交接上格',400,180,[{x:328,y:180},{x:472,y:180},{x:400,y:116}]),
    handoff_b:target('handoff_b','counter','交接下格',400,260,[{x:328,y:260},{x:472,y:260},{x:400,y:324}]),
    counter_left:target('counter_left','counter','左空台',274,438,[{x:274,y:366}]),
    plates:target('plates','plates','净盘',354,438,[{x:354,y:366}]),
    counter_right:target('counter_right','counter','右空台',454,438,[{x:454,y:366}]),
    delivery:target('delivery','delivery','交付',704,100,[{x:624,y:100}]),
    cleanup:target('cleanup','cleanup','清理',604,438,[{x:604,y:366}]),
  } satisfies Record<TargetId,TargetDefinition>,
};

