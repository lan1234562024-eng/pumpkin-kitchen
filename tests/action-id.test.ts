import { describe, expect, it, vi } from 'vitest';
import { createActionId, type ActionIdCrypto } from '../src/client/action-id';

describe('action ID generation', () => {
  it('uses secure random bytes and stays unique when randomUUID is unavailable', () => {
    let seed = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(++seed);
      return bytes;
    });
    const platform: ActionIdCrypto = {getRandomValues};
    const id = createActionId(platform,() => 1234,'test-session');
    const nextId = createActionId(platform,() => 1234,'test-session');

    expect(id).not.toBe(nextId);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(id).toMatch(/^action-[0-9a-f]{32}$/);
  });

  it('uses a unique non-secret correlation ID when secure random APIs are absent', () => {
    const platform: ActionIdCrypto = {};
    let time = 100;
    const create = () => createActionId(platform,() => time++,'fallback-session');

    expect(create()).not.toBe(create());
  });
});
