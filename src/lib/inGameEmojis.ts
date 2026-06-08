import { useCallback, useEffect, useRef, useState } from 'react';
import type { Square } from './mergeChess';

export const QUICK_EMOJIS = ['👍', '😂', '😅', '🔥', '👏', '😮', '🤔', '😎', '❤️', '♟️'];

type EmojiSide = 'me' | 'opp';

export type EmojiBubbleEvent = {
  side: EmojiSide;
  emoji: string;
  key: number;
};

type BoardPieceLike = {
  color: 'w' | 'b';
  letter: string;
};

export function isQuickEmoji(value: string): boolean {
  return QUICK_EMOJIS.includes(value);
}

export function useEmojiBubble(enabled: boolean) {
  const enabledRef = useRef(enabled);
  const keyRef = useRef(0);
  const [event, setEvent] = useState<EmojiBubbleEvent | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) setEvent(null);
  }, [enabled]);

  useEffect(() => {
    if (!event) return;
    const t = window.setTimeout(() => setEvent(null), 1000);
    return () => window.clearTimeout(t);
  }, [event]);

  const showEmojiBubble = useCallback((side: EmojiSide, emoji: string) => {
    if (!enabledRef.current || !isQuickEmoji(emoji)) return;
    keyRef.current += 1;
    setEvent({ side, emoji, key: keyRef.current });
  }, []);

  return {
    emojiBubbleEvent: enabled ? event : null,
    showEmojiBubble,
  };
}

export function kingSquaresForBoard(
  board: (BoardPieceLike | null)[],
  color: 'w' | 'b',
): Square[] {
  const out: Square[] = [];
  for (let idx = 0; idx < board.length; idx++) {
    const piece = board[idx];
    if (!piece || piece.color !== color) continue;
    const upper = piece.letter.toUpperCase();
    if (upper !== 'K' && upper !== 'S') continue;
    const file = idx % 8;
    const row = Math.floor(idx / 8);
    out.push(`${String.fromCharCode(97 + file)}${8 - row}` as Square);
  }
  return out;
}
