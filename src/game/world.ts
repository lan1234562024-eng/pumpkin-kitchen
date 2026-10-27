import type {Point,RecipeId} from '../shared/contracts';
import {KITCHEN_LAYOUT,TARGET_IDS} from './kitchen-layout';
export const ROUND_DURATION_MS=90_000;
export const MOVEMENT_SPEED=160;
export const INTERACT_RADIUS=32;
export const RECEIPT_LIMIT=4096;
export const EVENT_LIMIT=256;
export const WORLD={width:800,height:500,stations:KITCHEN_LAYOUT.targets};
export const STATION_IDS=TARGET_IDS;
export const KITCHEN_RULES={chop_pumpkin_ms:2000,chop_cucumber_ms:1500,cook_pumpkin_ms:6000,simmer_soup_ms:3000,pending_ms:18000,spawn_ms:12000,order_cap:2};
export const RECIPES:Record<RecipeId,{label:string;delivery_ms:number;reward:number;penalty:number;minimum_ms:number}>={
 pumpkin_salad:{label:'贝贝南瓜沙拉',delivery_ms:40000,reward:30,penalty:6,minimum_ms:20000},
 pumpkin_soup:{label:'奶油南瓜汤',delivery_ms:50000,reward:40,penalty:8,minimum_ms:26000},
};
export function distance(a:Point,b:Point){return Math.hypot(a.x-b.x,a.y-b.y);}

