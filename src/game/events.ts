import type {GameEvent,GameState} from '../shared/contracts';
import {EVENT_LIMIT} from './world';
export function emitEvent(s:GameState,value:Omit<GameEvent,'id'|'at_ms'>,atMs=s.server_time_ms):void{
 s.events_cursor++;s.events.push({...value,id:s.events_cursor,at_ms:atMs});
 if(s.events.length>EVENT_LIMIT)s.events.splice(0,s.events.length-EVENT_LIMIT);
}

