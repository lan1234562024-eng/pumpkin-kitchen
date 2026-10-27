import type { GameSnapshot, SeatId } from '../../shared/contracts';

export const SNAPSHOT_FRESH_MS = 1_500;
export type SnapshotFeedback = {type:'item_taken';seatId:SeatId} | {type:'handoff';target:'handoff_a'|'handoff_b'} | {type:'delivered';delta:number};
export type FeedbackObservation = {accepted:boolean;reset:boolean;effects:SnapshotFeedback[]};

/** One-shot feedback follows fresh confirmed changes, never command attempts. */
export class SnapshotFeedbackTracker {
  private previous?: GameSnapshot;
  private receivedAt = 0;

  observe(snapshot: GameSnapshot,receivedAt: number): FeedbackObservation {
    const previous = this.previous;
    if (previous && (snapshot.round_id < previous.round_id ||
      (snapshot.round_id === previous.round_id && (snapshot.state_version < previous.state_version ||
        snapshot.server_time_ms < previous.server_time_ms)))) {
      return {accepted:false,reset:false,effects:[]};
    }
    if (previous && snapshot.round_id === previous.round_id && snapshot.state_version === previous.state_version &&
      snapshot.server_time_ms === previous.server_time_ms) {
      return {accepted:true,reset:false,effects:[]};
    }
    const reset = !previous || snapshot.round_id !== previous.round_id || snapshot.phase !== previous.phase ||
      receivedAt-this.receivedAt > SNAPSHOT_FRESH_MS || snapshot.server_time_ms-previous.server_time_ms > SNAPSHOT_FRESH_MS ||
      (['human','ai'] as SeatId[]).some(id => snapshot.seats[id].generation !== previous.seats[id].generation);
    this.previous = snapshot;this.receivedAt = receivedAt;
    const effects: SnapshotFeedback[] = [];
    if (!reset && previous && previous.phase === 'playing' && snapshot.phase === 'playing' &&
      snapshot.state_version > previous.state_version) {
      for (const seatId of ['human','ai'] as SeatId[]) {
        if (previous.seats[seatId].held_item_id !== snapshot.seats[seatId].held_item_id && snapshot.seats[seatId].held_item_id !== null) {
          effects.push({type:'item_taken',seatId});
        }
      }
      const contents=(s:GameSnapshot,id:string|null)=>{const item=id?s.items[id]:undefined;return item&&item.kind!=='ingredient'?JSON.stringify([item.contents,item.kind==='pot'?item.phase:item.recipe_id]):item?.kind==='ingredient'?item.preparation:null;};
      for(const target of ['handoff_a','handoff_b'] as const)if(previous.slots[target]!==snapshot.slots[target]||contents(previous,previous.slots[target])!==contents(snapshot,snapshot.slots[target]))effects.push({type:'handoff',target});
      const delta = snapshot.score-previous.score;
      if (delta > 0) effects.push({type:'delivered',delta});
    }
    return {accepted:true,reset,effects};
  }

  reset() { this.previous = undefined;this.receivedAt = 0; }
}

