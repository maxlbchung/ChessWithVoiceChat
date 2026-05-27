import { get, set } from 'idb-keyval';

const KEY_STORE = 'chess.identity.v1';

export type Identity = {
  handle: string;
};

// Legacy records may also carry a privateKeyHex from older versions — it's
// ignored on load. Only the handle persists going forward.
type StoredIdentity = {
  handle: string;
};

export async function createIdentity(handle: string): Promise<Identity> {
  const id: Identity = { handle };
  await persistIdentity(id);
  return id;
}

export async function loadIdentity(): Promise<Identity | null> {
  const stored = await get<StoredIdentity>(KEY_STORE);
  if (!stored || !stored.handle) return null;
  return { handle: stored.handle };
}

export async function persistIdentity(id: Identity): Promise<void> {
  const stored: StoredIdentity = { handle: id.handle };
  await set(KEY_STORE, stored);
}

export async function updateHandle(id: Identity, handle: string): Promise<Identity> {
  const next = { ...id, handle };
  await persistIdentity(next);
  return next;
}
