import type { Identity } from './identity';
import { signMessage, verifySignature, hex } from './identity';
import type { GameRecord, SignedMove } from './types';

const enc = new TextEncoder();

function moveDigest(uci: string, fenAfter: string, ply: number, whiteClockMs: number, blackClockMs: number, gameId: string): Uint8Array {
  return enc.encode(`MOVE|${gameId}|${ply}|${uci}|${fenAfter}|${whiteClockMs}|${blackClockMs}`);
}

function recordDigest(record: Omit<GameRecord, 'whiteSignature' | 'blackSignature'>): Uint8Array {
  // Canonical: stable JSON of fields in fixed order
  const canonical = JSON.stringify({
    gameId: record.gameId,
    timeControlId: record.timeControlId,
    white: record.white,
    black: record.black,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    outcome: record.outcome,
    reason: record.reason,
    moveSigs: record.moves.map((m) => m.signature),
  });
  return enc.encode('RECORD|' + canonical);
}

export async function signMove(
  identity: Identity,
  gameId: string,
  uci: string,
  fenAfter: string,
  ply: number,
  whiteClockMs: number,
  blackClockMs: number,
): Promise<SignedMove> {
  const digest = moveDigest(uci, fenAfter, ply, whiteClockMs, blackClockMs, gameId);
  const sig = await signMessage(identity, digest);
  return {
    uci,
    fenAfter,
    ply,
    whiteClockMs,
    blackClockMs,
    signature: hex.bytesToHex(sig),
  };
}

export async function verifyMove(
  signerPublicKeyHex: string,
  gameId: string,
  move: SignedMove,
): Promise<boolean> {
  const digest = moveDigest(move.uci, move.fenAfter, move.ply, move.whiteClockMs, move.blackClockMs, gameId);
  return verifySignature(signerPublicKeyHex, digest, hex.hexToBytes(move.signature));
}

export async function signRecord(
  identity: Identity,
  partial: Omit<GameRecord, 'whiteSignature' | 'blackSignature'>,
): Promise<string> {
  const digest = recordDigest(partial);
  const sig = await signMessage(identity, digest);
  return hex.bytesToHex(sig);
}

export async function verifyRecordSignature(
  signerPublicKeyHex: string,
  partial: Omit<GameRecord, 'whiteSignature' | 'blackSignature'>,
  signature: string,
): Promise<boolean> {
  const digest = recordDigest(partial);
  return verifySignature(signerPublicKeyHex, digest, hex.hexToBytes(signature));
}
