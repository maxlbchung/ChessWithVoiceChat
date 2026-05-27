import type { ReactElement, ReactNode } from 'react';
import { SHOP_LETTERS, SHOP_PRICES, type ShopLetter } from '../lib/cashChess';
import { renderPiece } from '../lib/pieceSvgs';

type Props = {
  whiteGold: number;
  blackGold: number;
  // Whose perspective is being shown — i.e. who the local player is. Affects
  // labels ("You" vs "Opponent") and which side the shop is enabled for.
  perspective: 'white' | 'black';
  // Whether it's the local player's turn AND the game is in progress; controls
  // whether shop buttons are enabled.
  canBuy: boolean;
  // The currently selected shop piece, or null. Selecting a piece highlights
  // legal placement squares on the board.
  selectedLetter: ShopLetter | null;
  // Per-letter availability (affordable + at least one legal placement
  // square). Letters not in this set render as disabled.
  affordable: Set<ShopLetter>;
  onSelect: (letter: ShopLetter | null) => void;
  // Compact mode for free-play (tighter layout, no opponent column).
  compact?: boolean;
};

export function CashShop({
  whiteGold,
  blackGold,
  perspective,
  canBuy,
  selectedLetter,
  affordable,
  onSelect,
  compact,
}: Props): ReactElement {
  const myGold = perspective === 'white' ? whiteGold : blackGold;
  const oppGold = perspective === 'white' ? blackGold : whiteGold;
  const myColor: 'w' | 'b' = perspective === 'white' ? 'w' : 'b';

  return (
    <div className={`cash-shop${compact ? ' compact' : ''}`}>
      <div className="cash-shop-header">
        <div className="cash-shop-title">Shop</div>
        <div className="cash-gold-row">
          <GoldDisplay
            label={compact ? renderPiece('wK', 18) : 'You'}
            ariaLabel={compact ? 'White' : undefined}
            amount={myGold}
            highlight
          />
          <GoldDisplay
            label={compact ? renderPiece('bK', 18) : 'Opp'}
            ariaLabel={compact ? 'Black' : undefined}
            amount={oppGold}
          />
        </div>
      </div>

      <div className="cash-shop-grid">
        {SHOP_LETTERS.map((L) => {
          const enabled = canBuy && affordable.has(L);
          const isSelected = selectedLetter === L;
          const price = SHOP_PRICES[L];
          const pieceKey = (myColor === 'w' ? 'w' : 'b') + L as
            'wN' | 'wB' | 'wR' | 'wQ' | 'bN' | 'bB' | 'bR' | 'bQ';
          return (
            <button
              key={L}
              type="button"
              className={`cash-shop-item${isSelected ? ' selected' : ''}`}
              disabled={!enabled}
              data-no-sfx
              onClick={() => {
                if (!enabled) return;
                onSelect(isSelected ? null : L);
              }}
              title={`${pieceName(L)} — ${price} gold`}
            >
              <div className="cash-shop-piece">{renderPiece(pieceKey, 38)}</div>
              <div className="cash-shop-price">{price}g</div>
            </button>
          );
        })}
      </div>

      <div className="cash-shop-hint muted small">
        {selectedLetter
          ? 'Pick a pawn to upgrade.'
          : canBuy
            ? 'Pick a piece to upgrade a pawn into.'
            : 'Wait for your turn to buy.'}
      </div>
    </div>
  );
}

function GoldDisplay({
  label,
  ariaLabel,
  amount,
  highlight,
}: {
  // String label for game pages ("You" / "Opp") or a king SVG for free play.
  label: ReactNode;
  // Provided when label is a graphic so screen readers still get the side name.
  ariaLabel?: string;
  amount: number;
  highlight?: boolean;
}) {
  return (
    <div className={`cash-gold${highlight ? ' highlight' : ''}`}>
      <span className="cash-gold-label" aria-label={ariaLabel}>{label}</span>
      <span className="cash-gold-amount">
        <span className="cash-gold-coin" aria-hidden />
        {amount}
      </span>
    </div>
  );
}

function pieceName(L: ShopLetter): string {
  switch (L) {
    case 'N': return 'Knight';
    case 'B': return 'Bishop';
    case 'R': return 'Rook';
    case 'Q': return 'Queen';
  }
}
