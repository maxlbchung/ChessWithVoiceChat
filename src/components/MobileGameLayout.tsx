import type { ReactNode } from 'react';

type Props = {
  // Forfeit/disconnect banner, shown full-width at the very top.
  banner?: ReactNode;
  // Opponent player block — sits above the board.
  topCard: ReactNode;
  // The board (a `.board-wrap` element with its overlays).
  board: ReactNode;
  // Local player block — sits below the board.
  bottomCard: ReactNode;
  // Optional shop / ability menu, shown directly under the board.
  menu?: ReactNode;
  // Footer slot that should stay visible (e.g. the end-of-game result strip).
  footer?: ReactNode;
  // Secondary info (move list, chat, connection, controls) — tucked into a
  // collapsible drawer so the board stays the focus on small screens.
  drawerLabel?: string;
  children?: ReactNode;
};

/**
 * Single-column game layout for phones: opponent on top, board in the middle,
 * you on the bottom, an optional menu under that, and everything else folded
 * into a drawer. Each game page composes the same building blocks it already
 * renders for desktop, just arranged vertically.
 */
export function MobileGameLayout({
  banner,
  topCard,
  board,
  bottomCard,
  menu,
  footer,
  drawerLabel = 'Game info & controls',
  children,
}: Props) {
  return (
    <div className="mobile-game">
      {banner}
      {topCard}
      <div className="mobile-board-slot">{board}</div>
      {bottomCard}
      {menu && <div className="mobile-menu-slot">{menu}</div>}
      {footer}
      {children && (
        <details className="mobile-drawer">
          <summary className="mobile-drawer-summary">{drawerLabel}</summary>
          <div className="mobile-drawer-body">{children}</div>
        </details>
      )}
    </div>
  );
}
