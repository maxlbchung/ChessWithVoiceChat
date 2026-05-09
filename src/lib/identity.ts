import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { get, set } from 'idb-keyval';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const KEY_STORE = 'chess.identity.v1';

export type Identity = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
  handle: string;
};

type StoredIdentity = {
  privateKeyHex: string;
  handle: string;
};

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function createIdentity(handle: string): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const id: Identity = {
    privateKey,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
    handle,
  };
  await persistIdentity(id);
  return id;
}

export async function loadIdentity(): Promise<Identity | null> {
  const stored = await get<StoredIdentity>(KEY_STORE);
  if (!stored) return null;
  const privateKey = hexToBytes(stored.privateKeyHex);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
    handle: stored.handle,
  };
}

export async function persistIdentity(id: Identity): Promise<void> {
  const stored: StoredIdentity = {
    privateKeyHex: bytesToHex(id.privateKey),
    handle: id.handle,
  };
  await set(KEY_STORE, stored);
}

export async function updateHandle(id: Identity, handle: string): Promise<Identity> {
  const next = { ...id, handle };
  await persistIdentity(next);
  return next;
}

export function exportIdentity(id: Identity): string {
  return bytesToHex(id.privateKey) + ':' + id.handle;
}

export async function importIdentity(serialized: string): Promise<Identity> {
  const [privHex, handle] = serialized.split(':');
  if (!privHex || !handle) throw new Error('invalid identity export string');
  const privateKey = hexToBytes(privHex.trim());
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const id: Identity = {
    privateKey,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
    handle: handle.trim(),
  };
  await persistIdentity(id);
  return id;
}

export async function signMessage(id: Identity, message: Uint8Array): Promise<Uint8Array> {
  return ed.signAsync(message, id.privateKey);
}

export async function verifySignature(
  publicKeyHex: string,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, message, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export const hex = { bytesToHex, hexToBytes };
