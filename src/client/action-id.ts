export interface ActionIdCrypto {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
}

const fallbackSessionNonce = Math.random().toString(36).slice(2) || 'session';
let fallbackCounter = 0;

/** Creates a correlation ID for a command; IDs provide no authentication or secrecy. */
export function createActionId(
  platform: ActionIdCrypto | undefined = globalThis.crypto,
  now: () => number = Date.now,
  sessionNonce = fallbackSessionNonce,
): string {
  try {
    const id = platform?.randomUUID?.();
    if (id) return id;
  } catch { /* Fall through to secure bytes or a local correlation ID. */ }

  if (platform?.getRandomValues) {
    try {
      const bytes = platform.getRandomValues(new Uint8Array(16));
      const hex = Array.from(bytes,byte => byte.toString(16).padStart(2,'0')).join('');
      return `action-${hex}`;
    } catch { /* Some browser contexts expose an API that cannot be used here. */ }
  }

  fallbackCounter++;
  return `action-${Math.trunc(now()).toString(36)}-${sessionNonce}-${fallbackCounter.toString(36)}`;
}

