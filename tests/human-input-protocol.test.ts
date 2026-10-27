import {RULESET_ID} from '../src/shared/ruleset';
import { describe, expect, it } from 'vitest';
import { isClientMessage } from '../src/shared/protocol';

const input = {type:'human_input',ruleset_id:RULESET_ID,seat_id:'human',seat_generation:1,round_id:1,sequence:1,direction:{x:1,y:0}};

describe('human keyboard input messages',()=>{
  it('accepts direction changes and explicit release for either human-controlled seat',()=>{
    expect(isClientMessage(input)).toBe(true);
    expect(isClientMessage({...input,seat_id:'ai',direction:{x:0,y:0}})).toBe(true);
  });

  it('rejects malformed, extra, unbounded and invalid sequence values',()=>{
    for(const candidate of [
      {...input,sequence:-1},{...input,sequence:1.5},{...input,sequence:Infinity},
      {...input,round_id:-1},{...input,seat_generation:-1},{...input,seat_id:'other'},
      {...input,direction:{x:2,y:0}},{...input,direction:{x:0.5,y:0}},
      {...input,direction:{x:NaN,y:0}},{...input,direction:{x:0,y:0,z:1}},
      {...input,extra:true},{...input,direction:null},
    ]) expect(isClientMessage(candidate)).toBe(false);
  });
});
