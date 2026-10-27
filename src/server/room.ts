import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRoom as createRoomCore, type Room } from '../game/room-core';
export type * from '../game/room-core';

/** The full local game keeps its authoritative room and cryptographic leases on the server. */
export function createRoom(now: () => number): Room {
  return createRoomCore(now, {
    randomUUID,
    createToken: () => randomBytes(32).toString('base64url'),
    tokenEquals: (token, expectedToken) => {
      const supplied = Buffer.from(token), expected = Buffer.from(expectedToken);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
  });
}



