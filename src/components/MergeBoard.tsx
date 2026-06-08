import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  CSSProperties,
  DragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { Piece, PieceLetter, Square } from '../lib/mergeChess';
import { sqToIdx } from '../lib/mergeChess';
import { lettersToPieceKeys, renderNeutralKing, renderPiece, type PieceKey } from '../lib/pieceSvgs';

type Props = {
  board: (Piece | null)[];
  orientation: 'white' | 'black';
  selectedSquare?: Square | null;
  legalTargets?: { to: Square; isCapture: boolean; isMerge: boolean }[];
  onSquareClick?: (sq: Square) => void;
  // releasePx, when supplied, is the cursor's board-local position at the
  // moment of release — pages thread it through into a merge animation so
  // the mover's phantom slides in from the cursor instead of from the abstract
  // source square (which would otherwise look like a teleport-back).
  onPieceDrop?: (from: Square, to: Square, opts?: { releasePx?: { x: number; y: number } }) => boolean;
  onDragStartSquare?: (from: Square) => void;
  // Sandbox: drop from an external draggable (palette button) where
  // dataTransfer text/plain is "spawn:<letter>" — letter casing encodes color.
  onSpawn?: (letter: PieceLetter, to: Square) => void;
  // Sandbox: right-click on a square is repurposed as "delete piece here"
  // (the arrow / highlight gesture is suppressed when this is set).
  onRightClickSquare?: (sq: Square) => void;
  // Sandbox: scrolling the mouse wheel down on a square fires this.
  // Attached as a non-passive listener so we can preventDefault and stop
  // the page from scrolling along with the gesture.
  onWheelDownSquare?: (sq: Square) => void;
  interactive?: boolean;
  draggable?: boolean;
  // When set, the board is a fixed pixel size. When omitted, the board fills
  // its container width (1:1 aspect ratio) and measures itself so pieces and
  // arrows scale to the actual rendered size.
  boardWidth?: number;
  // Optional coloured glow around each side's king square, e.g. for Hero
  // mode where each king has a hero-specific aura. CSS colour per side.
  kingGlows?: { w?: string; b?: string };
  // Square holding a currently-frozen piece (Hero / Frost). Renders an icy
  // overlay + snowflake so the player can see what's locked.
  // Squares currently holding a frozen piece. Each renders the ice overlay
  // independently so multiple simultaneous freezes can coexist.
  frozenSquares?: Square[] | null;
  // Subset of `frozenSquares` whose freeze melts on the next ply — those
  // cells draw cracks across the ice as a heads-up that the piece is about
  // to be released.
  frozenCrackingSquares?: Square[] | null;
  // Pending ICBM strikes (Hero / ICBM). Each renders a crosshair + countdown
  // (plies until impact). Both players see them.
  missiles?: { sq: Square; pliesLeft: number; firedBy: 'w' | 'b' }[];
  // When set, a translucent crosshair previews where the local player's ICBM
  // would land if they clicked the square under their cursor. firedBy drives
  // the colour so the preview matches the eventual real crosshair.
  ghostCrosshair?: { firedBy: 'w' | 'b' } | null;
  // When set, a translucent piece previews where a sandbox spawn would land
  // if the user clicked the hovered square. Letter is cased
  // (uppercase = white, lowercase = black) so colour comes from the letter
  // itself, matching the rest of the merge piece pipeline.
  ghostSpawn?: { letter: string } | null;
  // Pieces that were just destroyed by an ICBM strike but should still be
  // visible during the brief whistle-before-boom pause. The board state has
  // already cleared the square; this prop draws the piece sprite back on top
  // until the explosion fires (caller clears the list at that point).
  doomedPieces?: { sq: Square; letter: PieceLetter }[];
  // Transient ability animation. Mounted with a fresh `key` each time the
  // parent wants the animation to play; CSS keyframes do the rest.
  abilityAnim?: AbilityAnim | null;
  // Squares involved in the most recent move (from + to). Rendered as a
  // subtle dark tint so the eye can quickly find the last play.
  lastMove?: { from: Square; to: Square } | null;
  // Optional slide-in animation for pieces. Each entry says "the piece now
  // at `to` should appear to slide in from `from`". The `key` bumps on every
  // new animation event so React remounts the piece wrapper and the CSS
  // animation re-fires from 0%.
  slideMoves?: { from: Square; to: Square }[] | null;
  slideKey?: string | number;
  // Squares whose piece should pop in (scale-bounce). Used for pawn
  // promotions. Combines with `slideMoves` so a promotion can both slide
  // and pop simultaneously.
  popSquares?: Square[] | null;
  popKey?: string | number;
  // Merge-mode fusion animation. The two source pieces shrink together at
  // the target square while the merged sprite grows in.
  mergeAnim?: MergeAnim | null;
  // Bump this value to clear all right-click annotation arrows + highlights.
  // Parent uses it on board-shape changes (variant switch, reset, clear)
  // where prior annotations would refer to stale squares.
  clearAnnotationsKey?: string | number;
  // Twin-Jutsu: squares whose true piece should be rendered as a king icon
  // in the piece's color (the opponent doesn't know what's there). The hero
  // king glow is suppressed on these squares so a decoy can't be told apart
  // from the real king by aura alone.
  maskedAsKingSquares?: Square[] | null;
  // Twin-Jutsu: squares where the local player owns the masked piece. The
  // real piece renders normally and a translucent king sits on top so the
  // owner can see which of their pieces are still hidden from the opponent.
  maskedSelfSquares?: Square[] | null;
  // Slime: big-king blobs. Each renders as a single stretched king sprite
  // spanning its four tiles (with a goo overlay) instead of four per-square
  // sprites — the cell sprites for these squares are suppressed.
  slimeBigKings?: { tiles: Square[]; color: 'w' | 'b' }[] | null;
  // Slime: squares holding mini kings. Drawn with a goo overlay so the slime
  // identity stays readable after a split.
  slimeKingSquares?: Square[] | null;
  // Slime: when the selected square is a blob tile, the blob's legal shifts
  // render as direction arrows from the blob's centre instead of per-square
  // target dots (which are suppressed). Directions are in board coordinates
  // (file delta / rank delta, each -1 | 0 | 1); capture shifts tint red.
  slimeShiftArrows?: { df: number; dr: number; isCapture: boolean }[] | null;
  // Juggernaut: the colorless boss king. The piece on `sq` renders as a
  // neutral stone king with `tier` pips (1-3) under it. The hero glow still
  // flows through kingGlows like any other hero king.
  juggernauts?: { sq: Square; tier: number }[] | null;
  // Squares holding pieces stunned by the Juggernaut's slam — dizzy stars
  // overlay. Stunned pieces can still be captured (unlike frozen).
  stunnedSquares?: Square[] | null;
  // Live earthquakes (Juggernaut tier-1). Each renders a shaking ground
  // crack on its current square plus a small arrow indicating direction.
  earthquakes?: { sq: Square; df: number; dr: number; color: 'w' | 'b' }[] | null;
  // Transient emoji reactions shown beside the emitting side's king(s).
  emojiBubble?: { emoji: string; squares: Square[]; key: string | number } | null;
};

export type MergeAnim = {
  from: Square;
  to: Square;
  // Mover's pre-merge letter (may itself already be a merged-piece letter).
  fromLetter: string;
  // Receiver's pre-merge letter.
  toLetter: string;
  // Result letter — needed to compute exact slot positions so the phantoms
  // can land where the merged sprite shows them.
  mergedLetter: string;
  // Unique per-event key so the CSS animation re-fires from 0%.
  key: string | number;
  // When the merge was initiated by a pointer drag, this is the board-local
  // cursor position at the moment of release. The mover's phantom slides in
  // from this point instead of from `from`'s centre, so the visual continues
  // smoothly from where the user actually dropped the piece.
  releasePx?: { x: number; y: number };
};

export type AbilityAnim = {
  kind: 'frost' | 'frost-shatter' | 'warlord' | 'necromancer' | 'flight' | 'mutation' | 'icbm' | 'slime-expand' | 'slime-split' | 'juggernaut' | 'juggernaut-leap' | 'jug-absorb' | 'jug-slam';
  // Flight: flyer's old square. Warlord: king's square (pivot for swing).
  // Slime-expand: the mini king's square (the corner the blob grows out of).
  // Juggernaut-leap: the tier-2 king's takeoff square.
  // Necromancer / Frost / Mutation: unused.
  fromSq?: Square;
  // Flight: flyer's new square. Knight: destroyed piece's square.
  // Necromancer: spawn square. Frost: frozen piece's square.
  // Mutation: mutated piece's square (centre of the radiation burst).
  // Slime-expand: the expansion quadrant's far corner.
  // Slime-split: the destroyed blob tile (goo splatter origin).
  toSq: Square;
  // Side that used the ability — drives the rendered sprite's color for Flight.
  color: 'w' | 'b';
  // Flight: board letter of the flyer (e.g. 'Q' / 'q' / 'a'). Falls back to
  // the side's king when absent (legacy king-only flight).
  flyerLetter?: string;
  // Unique per ability event so React remounts the overlay (CSS animation
  // re-fires from 0%). Typically a `${ply}-${uci}` string.
  key: string;
};

type Arrow = { from: Square; to: Square };

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
// Warm amber for the right-click annotation arrows and square highlights.
const ARROW_COLOR = 'rgb(255,170,0)';
const HIGHLIGHT_COLOR = 'rgba(255,170,0,0.45)';

export function MergeBoard({
  board,
  orientation,
  selectedSquare,
  legalTargets,
  onSquareClick,
  onPieceDrop,
  onDragStartSquare,
  onSpawn,
  onRightClickSquare,
  onWheelDownSquare,
  interactive = true,
  draggable = true,
  boardWidth,
  kingGlows,
  frozenSquares,
  frozenCrackingSquares,
  missiles,
  ghostCrosshair,
  ghostSpawn,
  doomedPieces,
  abilityAnim,
  lastMove,
  slideMoves,
  slideKey,
  popSquares,
  popKey,
  mergeAnim,
  clearAnnotationsKey,
  maskedAsKingSquares,
  maskedSelfSquares,
  slimeBigKings,
  slimeKingSquares,
  slimeShiftArrows,
  juggernauts,
  stunnedSquares,
  earthquakes,
  emojiBubble,
}: Props) {
  // Indexed map for O(1) per-square missile lookup during render.
  const missilesBySq = useMemo(() => {
    const m = new Map<Square, { pliesLeft: number; firedBy: 'w' | 'b' }>();
    for (const x of missiles ?? []) m.set(x.sq, { pliesLeft: x.pliesLeft, firedBy: x.firedBy });
    return m;
  }, [missiles]);
  // Indexed map for the doomed-piece overlay (pieces blasted by an ICBM but
  // still drawn until the explosion fires).
  const doomedBySq = useMemo(() => {
    const m = new Map<Square, PieceLetter>();
    for (const d of doomedPieces ?? []) m.set(d.sq, d.letter);
    return m;
  }, [doomedPieces]);
  // Tracked locally so we can render the ICBM ghost crosshair on whichever
  // square the cursor is currently over (cleared on mouse leave).
  const [hoverSq, setHoverSq] = useState<Square | null>(null);
  // Measure the container when boardWidth isn't fixed, so pieces and arrows
  // can scale to whatever the parent gives us. Initial measurement uses
  // useLayoutEffect so it lands BEFORE the first paint — otherwise the
  // board paints once at the 480px default and then snaps to the real size,
  // which the user sees as a flicker on load.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number>(boardWidth ?? 480);
  useLayoutEffect(() => {
    if (boardWidth != null) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) setMeasured(rect.width);
  }, [boardWidth]);
  useEffect(() => {
    if (boardWidth != null) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setMeasured(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [boardWidth]);

  // Non-passive wheel listener so preventDefault actually stops the page
  // from scrolling along with the gesture. Only attached when a wheel
  // handler is wired up (sandbox delete-by-scroll); detaches on unmount or
  // when the handler reference changes.
  useEffect(() => {
    if (!onWheelDownSquare) return;
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.deltaY <= 0) return;
      let t: HTMLElement | null = e.target as HTMLElement | null;
      while (t && !t.hasAttribute?.('data-sq')) t = t.parentElement;
      const sq = t?.getAttribute('data-sq');
      if (!sq) return;
      e.preventDefault();
      onWheelDownSquare(sq as Square);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [onWheelDownSquare]);
  const effectiveSize = boardWidth ?? measured;
  const squarePx = effectiveSize / 8;
  // Pointer-driven drag for on-board pieces. dragOver also tracks the square
  // currently under the cursor while a piece is in flight so cells can paint
  // the same target-hover ring used for the (still-supported) external
  // HTML5 drag from the sandbox palette.
  const [dragOver, setDragOver] = useState<Square | null>(null);
  // Active in-flight drag for an on-board piece. Re-renders whenever the
  // cursor moves so the floating sprite tracks the pointer.
  const [drag, setDrag] = useState<{
    from: Square;
    piece: Piece;
    // Viewport coords of the cursor. Sprite is centered on this point.
    x: number;
    y: number;
    hoveredSq: Square | null;
  } | null>(null);
  // Pending pointer-down on a piece. We defer "drag started" until the cursor
  // moves past a small threshold so a quick click still selects via onClick.
  const pointerDownRef = useRef<{
    sq: Square;
    piece: Piece;
    startX: number;
    startY: number;
    pointerId: number;
    dragging: boolean;
  } | null>(null);
  // Stamp pointer-up after a drag so the synthesized click that follows
  // doesn't also fire onSquareClick on the drop target.
  const dragEndedAtRef = useRef<number>(0);

  // Annotation state — orange arrows and highlighted squares are purely visual,
  // not persisted, and shared across both players is intentionally out of scope.
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [highlights, setHighlights] = useState<Set<Square>>(new Set());
  const [previewArrow, setPreviewArrow] = useState<Arrow | null>(null);
  const rightDownSqRef = useRef<Square | null>(null);

  // Parent-driven wipe — bumping clearAnnotationsKey drops every committed
  // arrow / highlight / in-progress preview so annotations don't outlive the
  // position they were drawn against (variant switch, reset, clear).
  useEffect(() => {
    if (clearAnnotationsKey === undefined) return;
    setArrows([]);
    setHighlights(new Set());
    setPreviewArrow(null);
  }, [clearAnnotationsKey]);

  const targetMap = useMemo(() => {
    const m = new Map<Square, { isCapture: boolean; isMerge: boolean }>();
    for (const t of legalTargets ?? []) m.set(t.to, { isCapture: t.isCapture, isMerge: t.isMerge });
    return m;
  }, [legalTargets]);

  // For each piece that should slide in, compute the pixel offset (start - end)
  // so the CSS keyframe can translate it from the old square back to the new
  // one. Keyed by the destination square. squarePx is in deps so the offsets
  // recompute when the board is resized mid-animation (rare but harmless).
  const popSet = useMemo(() => new Set(popSquares ?? []), [popSquares]);
  const maskedAsKingSet = useMemo(() => new Set(maskedAsKingSquares ?? []), [maskedAsKingSquares]);
  const maskedSelfSet = useMemo(() => new Set(maskedSelfSquares ?? []), [maskedSelfSquares]);
  // Squares occupied by a Slime big-king tile — their per-square sprites are
  // suppressed; the stretched blob layer below draws the king instead.
  const slimeTileSet = useMemo(() => {
    const s = new Set<Square>();
    for (const g of slimeBigKings ?? []) for (const t of g.tiles) s.add(t);
    return s;
  }, [slimeBigKings]);
  // Blob arrow mode: the selected square is a blob tile and the page handed
  // us its shift directions — replace the target dots with arrows.
  const slimeArrowsActive =
    !!slimeShiftArrows && slimeShiftArrows.length > 0 &&
    !!selectedSquare && slimeTileSet.has(selectedSquare);
  const slimeMiniSet = useMemo(() => new Set(slimeKingSquares ?? []), [slimeKingSquares]);
  // Juggernaut square → tier, for the neutral sprite + tier pips.
  const jugBySq = useMemo(() => {
    const m = new Map<Square, number>();
    for (const j of juggernauts ?? []) m.set(j.sq, j.tier);
    return m;
  }, [juggernauts]);
  const stunnedSet = useMemo(() => new Set(stunnedSquares ?? []), [stunnedSquares]);
  const earthquakesBySq = useMemo(() => {
    const m = new Map<Square, { df: number; dr: number; color: 'w' | 'b' }>();
    for (const eq of earthquakes ?? []) m.set(eq.sq, { df: eq.df, dr: eq.dr, color: eq.color });
    return m;
  }, [earthquakes]);

  const slideMap = useMemo(() => {
    const m = new Map<Square, { dx: number; dy: number }>();
    if (!slideMoves) return m;
    for (const mv of slideMoves) {
      if (mv.from === mv.to) continue;
      const fromFile = mv.from.charCodeAt(0) - 97;
      const fromRank = parseInt(mv.from[1], 10) - 1;
      const toFile = mv.to.charCodeAt(0) - 97;
      const toRank = parseInt(mv.to[1], 10) - 1;
      const fromCol = orientation === 'white' ? fromFile : 7 - fromFile;
      const fromRow = orientation === 'white' ? 7 - fromRank : fromRank;
      const toCol = orientation === 'white' ? toFile : 7 - toFile;
      const toRow = orientation === 'white' ? 7 - toRank : toRank;
      m.set(mv.to, {
        dx: (fromCol - toCol) * squarePx,
        dy: (fromRow - toRow) * squarePx,
      });
    }
    return m;
  }, [slideMoves, squarePx, orientation]);

  const ranksTopDown = orientation === 'white' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const filesLeftRight = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  // ------------------------------------------------------------------
  // Pointer drag for on-board pieces (left button)
  //
  // The native HTML5 drag image rendered the piece offset from the cursor and
  // felt laggy, so we drive the visual ourselves: pointerdown captures the
  // piece, pointermove redraws a portalled sprite at the cursor every frame,
  // pointerup resolves the target square under the cursor and fires
  // onPieceDrop. Native dragover/drop is still wired up below so the sandbox
  // palette (external HTML5 drag) can still spawn pieces onto the board.
  // ------------------------------------------------------------------
  const squareFromClient = (clientX: number, clientY: number): Square | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (px < 0 || py < 0 || px >= rect.width || py >= rect.height) return null;
    const col = Math.min(7, Math.max(0, Math.floor((px / rect.width) * 8)));
    const row = Math.min(7, Math.max(0, Math.floor((py / rect.height) * 8)));
    const file = orientation === 'white' ? col : 7 - col;
    const rank = orientation === 'white' ? 7 - row : row;
    return `${FILES[file]}${rank + 1}` as Square;
  };

  const handlePiecePointerDown = (
    e: ReactPointerEvent<HTMLDivElement>,
    sq: Square,
    piece: Piece,
  ) => {
    if (e.button !== 0) return;
    if (!draggable || !interactive) return;
    // Don't compete with the right-click arrow gesture.
    if (rightDownSqRef.current) return;
    pointerDownRef.current = {
      sq,
      piece,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      dragging: false,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch {}
  };

  const handlePiecePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pd = pointerDownRef.current;
    if (!pd) return;
    if (e.pointerId !== pd.pointerId) return;
    const dx = e.clientX - pd.startX;
    const dy = e.clientY - pd.startY;
    if (!pd.dragging) {
      // 4px threshold — anything below is treated as a click, not a drag.
      if (Math.hypot(dx, dy) < 4) return;
      pd.dragging = true;
      onDragStartSquare?.(pd.sq);
    }
    const hoveredSq = squareFromClient(e.clientX, e.clientY);
    setDrag({
      from: pd.sq,
      piece: pd.piece,
      x: e.clientX,
      y: e.clientY,
      hoveredSq,
    });
    setDragOver(hoveredSq);
  };

  const handlePiecePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pd = pointerDownRef.current;
    pointerDownRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
    if (!pd) return;
    if (!pd.dragging) return;
    dragEndedAtRef.current = performance.now();
    setDrag(null);
    setDragOver(null);
    const to = squareFromClient(e.clientX, e.clientY);
    if (!to) {
      // Released outside the board — sandbox interprets this as a delete.
      if (onWheelDownSquare) onWheelDownSquare(pd.sq);
      return;
    }
    if (to === pd.sq) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const releasePx = rect
      ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
      : undefined;
    onPieceDrop?.(pd.sq, to, { releasePx });
  };

  const handlePiecePointerCancel = () => {
    pointerDownRef.current = null;
    setDrag(null);
    setDragOver(null);
  };

  // External HTML5 drag (sandbox palette → board). Pointer drag for on-board
  // pieces no longer goes through dataTransfer; the only payload we accept
  // here is the "spawn:<letter>" string emitted by the palette buttons.
  const handleDragOver = (e: DragEvent<HTMLDivElement>, sq: Square) => {
    if (!onSpawn) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOver !== sq) setDragOver(sq);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, to: Square) => {
    e.preventDefault();
    setDragOver(null);
    if (!onSpawn) return;
    let payload = '';
    try { payload = e.dataTransfer.getData('text/plain'); } catch {}
    if (payload.startsWith('spawn:')) {
      const letter = payload.slice(6) as PieceLetter;
      if (letter.length > 0) onSpawn(letter, to);
    }
  };

  // ------------------------------------------------------------------
  // Arrow drawing & square highlighting (right button)
  // ------------------------------------------------------------------
  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>, sq: Square) => {
    if (e.button === 2) {
      e.preventDefault();
      // Sandbox repurposes right-click as "delete piece here" — skip the
      // arrow / highlight gesture entirely when that handler is wired up.
      if (onRightClickSquare) {
        onRightClickSquare(sq);
        return;
      }
      rightDownSqRef.current = sq;
      setPreviewArrow({ from: sq, to: sq });
    } else if (e.button === 0) {
      // Any left-click clears annotations, mirroring chess.com / lichess.
      if (arrows.length > 0) setArrows([]);
      if (highlights.size > 0) setHighlights(new Set());
    }
  };

  const handleMouseEnter = (sq: Square) => {
    setHoverSq(sq);
    if (rightDownSqRef.current) {
      setPreviewArrow({ from: rightDownSqRef.current, to: sq });
    }
  };

  // Track right-button release globally so releasing outside the board still
  // cancels the in-progress arrow.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const from = rightDownSqRef.current;
      rightDownSqRef.current = null;
      if (!from) { setPreviewArrow(null); return; }
      // The target the user released on (find a [data-sq] ancestor).
      let el: HTMLElement | null = e.target as HTMLElement | null;
      let to: Square | null = null;
      while (el && !to) {
        const attr = el.getAttribute?.('data-sq');
        if (attr) to = attr as Square;
        el = el.parentElement;
      }
      setPreviewArrow(null);
      if (!to) return;
      if (from === to) {
        // Single right-click → toggle highlight
        setHighlights((prev) => {
          const next = new Set(prev);
          if (next.has(to as Square)) next.delete(to as Square);
          else next.add(to as Square);
          return next;
        });
      } else {
        // Drag → toggle arrow
        setArrows((prev) => {
          const exists = prev.some((a) => a.from === from && a.to === to);
          if (exists) return prev.filter((a) => !(a.from === from && a.to === to));
          return [...prev, { from, to: to as Square }];
        });
      }
    };
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, []);

  // Suppress the browser context menu over the board so right-click is free
  // for arrow/highlight gestures.
  const suppressContext = (e: ReactMouseEvent<HTMLDivElement>) => e.preventDefault();

  // Pixel coords of a square center, given current orientation.
  const center = (sq: Square): { x: number; y: number } => {
    const file = sq.charCodeAt(0) - 97;          // 0..7
    const rank = parseInt(sq[1], 10) - 1;        // 0..7
    const col = orientation === 'white' ? file : 7 - file;
    const row = orientation === 'white' ? 7 - rank : rank;
    return { x: col * squarePx + squarePx / 2, y: row * squarePx + squarePx / 2 };
  };

  // All arrows to render — committed + the in-progress preview at half opacity.
  const renderedArrows = useMemo<Array<Arrow & { preview?: boolean }>>(
    () => {
      const list: Array<Arrow & { preview?: boolean }> = arrows.map((a) => ({ ...a }));
      if (previewArrow && previewArrow.from !== previewArrow.to) {
        list.push({ ...previewArrow, preview: true });
      }
      return list;
    },
    [arrows, previewArrow],
  );

  return (
    <div
      ref={containerRef}
      className="merge-board"
      onContextMenu={suppressContext}
      onMouseLeave={() => setHoverSq(null)}
      style={{
        width: boardWidth ?? '100%',
        height: boardWidth,
        aspectRatio: boardWidth == null ? '1 / 1' : undefined,
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'repeat(8, 1fr)',
        gridTemplateRows: 'repeat(8, 1fr)',
        borderRadius: 8,
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {ranksTopDown.map((r) =>
        filesLeftRight.map((f) => {
          const isLight = (f + r) % 2 === 1;
          const sq: Square = `${FILES[f]}${r + 1}`;
          const idx = sqToIdx(sq);
          const piece = board[idx];
          const isSelected = selectedSquare === sq;
          const target = targetMap.get(sq);
          const isDragOver = dragOver === sq;
          const isHighlighted = highlights.has(sq);
          const isLastMove = !!lastMove && (lastMove.from === sq || lastMove.to === sq);
          // Twin-Jutsu masking. Opponent-perspective masks render the piece as
          // a king icon in its color; self-perspective masks render normally
          // with a translucent king overlay so the owner sees what's hidden.
          const isMaskedAsKing = maskedAsKingSet.has(sq);
          const isMaskedSelf = maskedSelfSet.has(sq);
          // Hero-mode king glow: colour ring drawn behind the king SVG.
          // Suppressed on masked-as-king squares — otherwise the real king's
          // aura would leak through every decoy and defeat the disguise.
          const kingGlowColor = !isMaskedAsKing && piece && piece.letter.toUpperCase() === 'K'
            ? (piece.color === 'w' ? kingGlows?.w : kingGlows?.b)
            : undefined;
          const isFrozen = !!frozenSquares && frozenSquares.includes(sq);
          const isFrozenCracking = isFrozen && !!frozenCrackingSquares && frozenCrackingSquares.includes(sq);

          const style: CSSProperties = {
            background: isLight ? '#dfe5f0' : '#5d6c89',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 0,
            minHeight: 0,
            // Chess-board cells always show the grab/circle cursor — the
            // board is the "pick-up zone", so any cell (piece or empty) reads
            // as such. UI elements outside the board keep the pointer/X.
            cursor: 'var(--cursor-grab)',
            boxShadow: isDragOver
              ? 'inset 0 0 1px 6px rgba(255,255,255,0.75)'
              : undefined,
          };

          let overlay: CSSProperties | null = null;
          // While the blob's direction arrows are up, the per-square target
          // dots and the selection ring are pure noise — the arrows carry
          // both signals. (Clicks on the entered squares still work.)
          if (slimeArrowsActive) {
            overlay = null;
          } else if (isSelected) {
            overlay = {
              background:
                'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
            };
          } else if (target) {
            if (target.isMerge) {
              overlay = {
                background:
                  'radial-gradient(circle, transparent 55%, rgba(80,200,120,0.55) 56%, rgba(80,200,120,0.55) 65%, transparent 66%)',
              };
            } else if (target.isCapture) {
              overlay = {
                background:
                  'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
              };
            } else {
              overlay = {
                background:
                  'radial-gradient(circle, rgba(0,0,0,0.35) 22%, transparent 24%)',
              };
            }
          }

          return (
            <div
              key={sq}
              data-sq={sq}
              onClick={() => {
                // Suppress the click that browsers synthesize at the end of a
                // pointer drag so the drop target doesn't also get selected.
                if (performance.now() - dragEndedAtRef.current < 50) return;
                if (interactive) onSquareClick?.(sq);
              }}
              onMouseDown={(e) => handleMouseDown(e, sq)}
              onMouseEnter={() => handleMouseEnter(sq)}
              onDragOver={(e) => handleDragOver(e, sq)}
              onDragLeave={() => { if (dragOver === sq) setDragOver(null); }}
              onDrop={(e) => handleDrop(e, sq)}
              style={style}
            >
              {isLastMove && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(140,220,150,0.45)',
                    pointerEvents: 'none',
                  }}
                />
              )}
              {isHighlighted && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: HIGHLIGHT_COLOR,
                    pointerEvents: 'none',
                  }}
                />
              )}
              {kingGlowColor && (() => {
                // During Flight, the static king on the destination square
                // is hidden until the flying overlay lands — the glow needs
                // the same delayed reveal so it doesn't teleport ahead of
                // the king.
                const isFlightDestSq = abilityAnim?.kind === 'flight' && abilityAnim.toSq === sq;
                return (
                  <div
                    key={isFlightDestSq ? `flight-glow-${abilityAnim.key}-${sq}` : `glow-${sq}`}
                    style={{
                      position: 'absolute',
                      // Fill the whole square so the radial fade has room to
                      // breathe past the piece silhouette.
                      inset: 0,
                      borderRadius: '50%',
                      background: `radial-gradient(circle, ${kingGlowColor}cc 0%, ${kingGlowColor}88 28%, ${kingGlowColor}44 52%, transparent 78%)`,
                      boxShadow: `
                        0 0 ${squarePx * 0.18}px ${squarePx * 0.04}px ${kingGlowColor},
                        0 0 ${squarePx * 0.45}px ${squarePx * 0.12}px ${kingGlowColor}aa
                      `,
                      pointerEvents: 'none',
                      zIndex: 0,
                      animation: isFlightDestSq
                        ? 'piece-flight-arrival 950ms cubic-bezier(0.34, 1.56, 0.64, 1) both'
                        : undefined,
                    }}
                  />
                );
              })()}
              {overlay && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    ...overlay,
                  }}
                />
              )}
              {piece && (() => {
                // Slime big-king tiles render via the stretched blob layer
                // below, not as four per-square king sprites — but each tile
                // still mounts an invisible pointer target so the blob can be
                // picked up and dragged like any other piece.
                if (slimeTileSet.has(sq)) {
                  return (
                    <div
                      draggable={false}
                      onPointerDown={(e) => handlePiecePointerDown(e, sq, piece)}
                      onPointerMove={handlePiecePointerMove}
                      onPointerUp={handlePiecePointerUp}
                      onPointerCancel={handlePiecePointerCancel}
                      style={{
                        width: '100%',
                        height: '100%',
                        cursor: draggable && interactive ? 'var(--cursor-grab)' : 'inherit',
                        touchAction: 'none',
                        zIndex: 3,
                      }}
                    />
                  );
                }
                const isFlightDest = abilityAnim?.kind === 'flight' && abilityAnim.toSq === sq;
                const isNecroSpawn = abilityAnim?.kind === 'necromancer' && abilityAnim.toSq === sq;
                // Both the (legacy) tier-2 leap and the tier-3 in-place slam
                // ride the same body-jump animation on the Jug sprite.
                const isJugLeapDest =
                  (abilityAnim?.kind === 'juggernaut-leap' || abilityAnim?.kind === 'jug-slam')
                  && abilityAnim.toSq === sq;
                const isMergeDest = !!(mergeAnim && mergeAnim.to === sq);
                const fadeInSlots = isMergeDest
                  ? computeMergeFadeInSlots(mergeAnim!.toLetter, mergeAnim!.mergedLetter)
                  : undefined;
                const spriteKey = isFlightDest
                  ? `flight-${abilityAnim.key}-${sq}`
                  : isNecroSpawn
                  ? `necro-${abilityAnim.key}-${sq}`
                  : isJugLeapDest
                  ? `jug-leap-${abilityAnim.key}-${sq}`
                  : isMergeDest
                  ? `merge-${mergeAnim!.key}-${sq}`
                  : slideMap.has(sq)
                  ? `slide-${slideKey}-${sq}`
                  : popSet.has(sq)
                  ? `pop-${popKey}-${sq}`
                  : `piece-${sq}`;
                // Twin-Jutsu masked-as-king: swap the real piece's letter for
                // a king of the same color before handing it to PieceSprite.
                // Slides / pops still fire because animation drivers key off
                // sq, not the letter. Glow is already suppressed above.
                const renderedPiece: Piece = isMaskedAsKing
                  ? { color: piece.color, letter: (piece.color === 'w' ? 'K' : 'k') as PieceLetter }
                  : piece;
                // Source piece is hidden while the pointer drag is in flight —
                // the floating sprite (rendered into a portal at the bottom of
                // this component) takes over the visual.
                const isDragSource = drag?.from === sq;
                return (
                  <PieceSprite
                    // Unique key per slide/pop/merge/flight/necro event forces
                    // React to unmount/remount the sprite, which restarts
                    // the CSS animation from 0%. Stable key when idle.
                    key={spriteKey}
                    piece={renderedPiece}
                    squarePx={squarePx}
                    pickable={draggable && interactive}
                    onPointerDown={(e) => handlePiecePointerDown(e, sq, piece)}
                    onPointerMove={handlePiecePointerMove}
                    onPointerUp={handlePiecePointerUp}
                    onPointerCancel={handlePiecePointerCancel}
                    hidden={isDragSource}
                    glowColor={kingGlowColor}
                    slideFrom={isFlightDest || isNecroSpawn ? undefined : slideMap.get(sq)}
                    pop={!isFlightDest && !isNecroSpawn && !isMergeDest && popSet.has(sq)}
                    mergeFadeInSlots={fadeInSlots}
                    flightArrival={isFlightDest}
                    necromancerSpawn={isNecroSpawn}
                    neutralKing={jugBySq.has(sq)}
                    neutralKingTier={jugBySq.get(sq)}
                    juggernautLeap={isJugLeapDest}
                    slimeGoo={slimeMiniSet.has(sq) && !slimeTileSet.has(sq)}
                  />
                );
              })()}
              {piece && stunnedSet.has(sq) && (() => {
                // During Quake Leap, state updates immediately when the move
                // commits. Hold the stun overlay until the landing impact so
                // the pieces look stunned by the quake, not by takeoff.
                const delayForLeap =
                  (abilityAnim?.kind === 'juggernaut-leap' || abilityAnim?.kind === 'jug-slam') &&
                  Math.max(
                    Math.abs(sq.charCodeAt(0) - abilityAnim.toSq.charCodeAt(0)),
                    Math.abs(parseInt(sq[1], 10) - parseInt(abilityAnim.toSq[1], 10)),
                  ) <= 2;
                return (
                  <div
                    className={`stunned-overlay${delayForLeap ? ' delayed' : ''}`}
                    style={delayForLeap ? { ['--stun-delay' as any]: '520ms' } : undefined}
                    aria-hidden
                  >
                    <span className="stun-star s1">✶</span>
                    <span className="stun-star s2">✶</span>
                    <span className="stun-star s3">✶</span>
                  </div>
                );
              })()}
              {piece && isMaskedSelf && (() => {
                // Ghosted king sitting on top of the player's own masked
                // piece, tinted with the side's hero glow colour so the mask
                // visually pairs with the same-colour halo around the real
                // king. Stroke is a translucent dark to keep the silhouette
                // legible against any fill. Pointer-events:none so drag/click
                // still go to the underlying sprite.
                const size = squarePx * 0.95;
                const fill = (piece.color === 'w' ? kingGlows?.w : kingGlows?.b) ?? '#bda0ff';
                const stroke = 'rgba(0,0,0,0.5)';
                return (
                  <div
                    aria-hidden
                    className="masked-self-overlay"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                      zIndex: 2,
                      ['--mask-glow' as any]: fill,
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      version="1.1"
                      width={size}
                      height={size}
                      viewBox="0 0 45 45"
                    >
                      <g style={{ fill: 'none', stroke, strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', strokeMiterlimit: 4 }}>
                        <path d="M 22.5,11.63 L 22.5,6" style={{ fill: 'none', stroke, strokeLinejoin: 'miter' }} />
                        <path d="M 20,8 L 25,8" style={{ fill: 'none', stroke, strokeLinejoin: 'miter' }} />
                        <path d="M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25" style={{ fill, stroke, strokeLinecap: 'butt', strokeLinejoin: 'miter' }} />
                        <path d="M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 L 12.5,37" style={{ fill, stroke }} />
                        <path d="M 12.5,30 C 18,27 27,27 32.5,30" style={{ fill: 'none', stroke }} />
                        <path d="M 12.5,33.5 C 18,30.5 27,30.5 32.5,33.5" style={{ fill: 'none', stroke }} />
                        <path d="M 12.5,37 C 18,34 27,34 32.5,37" style={{ fill: 'none', stroke }} />
                      </g>
                    </svg>
                  </div>
                );
              })()}
              {/* Slime mini-king goo bubble lives inside PieceSprite now,
                  so it slides + drags + hides with the piece instead of
                  popping back to the cell at rest. */}
              {isFrozen && (
                <div className={`frozen-overlay${isFrozenCracking ? ' cracking' : ''}`} aria-hidden>
                  {isFrozenCracking && (
                    <svg
                      className="frozen-cracks"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden
                    >
                      {/* Fissures growing INWARD from the edges. Six main
                          cracks enter from different points along the
                          perimeter and jag toward the centre, each stopping
                          well short of (50, 50) so the middle of the tile
                          remains an unbroken sheet of ice. Sub-branches
                          and twigs fork off as cracks propagate. */}
                      {/* From top edge (left-of-centre entry) */}
                      <polyline className="crack-main" points="32,0 35,10 38,20 41,30 40,40" />
                      <polyline className="crack-sub"  points="35,10 28,14 22,12" />
                      <polyline className="crack-twig" points="38,20 42,24 44,28" />
                      {/* From top edge (right-of-centre entry) */}
                      <polyline className="crack-main" points="68,0 62,8 60,18 62,28 58,38" />
                      <polyline className="crack-sub"  points="62,8 70,12 74,10" />
                      <polyline className="crack-twig" points="62,28 68,30 72,34" />
                      {/* From bottom-left */}
                      <polyline className="crack-main" points="20,100 24,88 28,78 32,68 38,60" />
                      <polyline className="crack-sub"  points="24,88 18,82 14,84" />
                      <polyline className="crack-twig" points="28,78 24,72 20,70" />
                      {/* From bottom-right */}
                      <polyline className="crack-main" points="78,100 72,88 68,78 62,68 60,60" />
                      <polyline className="crack-sub"  points="72,88 80,82 84,84" />
                      <polyline className="crack-twig" points="68,78 74,74 78,72" />
                      {/* From left edge */}
                      <polyline className="crack-main" points="0,42 12,44 22,46 32,48 40,50" />
                      <polyline className="crack-sub"  points="12,44 14,36 10,30" />
                      <polyline className="crack-twig" points="22,46 20,52 22,58" />
                      {/* From right edge */}
                      <polyline className="crack-main" points="100,62 88,60 76,58 66,56 60,54" />
                      <polyline className="crack-sub"  points="88,60 86,68 90,74" />
                      <polyline className="crack-twig" points="76,58 78,52 76,46" />
                      {/* A couple of short, isolated edge-only fractures
                          that don't propagate far at all. */}
                      <polyline className="crack-twig" points="50,0 52,6 50,12" />
                      <polyline className="crack-twig" points="92,30 94,36 90,42" />
                      <polyline className="crack-twig" points="6,72 12,74 14,80" />
                      {/* Chip splotches: at the entry points and a couple of
                          branch joints. No central chip — the centre is intact. */}
                      <circle className="crack-chip" cx="32" cy="0"  r="1.4" />
                      <circle className="crack-chip" cx="68" cy="0"  r="1.4" />
                      <circle className="crack-chip" cx="20" cy="100" r="1.4" />
                      <circle className="crack-chip" cx="78" cy="100" r="1.4" />
                      <circle className="crack-chip" cx="0"  cy="42" r="1.4" />
                      <circle className="crack-chip" cx="100" cy="62" r="1.4" />
                      <circle className="crack-chip" cx="35" cy="10" r="0.7" />
                      <circle className="crack-chip" cx="62" cy="8"  r="0.7" />
                      {/* White highlight slivers along a few main cracks */}
                      <polyline className="crack-highlight" points="33,0 36,11 39,20" />
                      <polyline className="crack-highlight" points="22,100 25,89 28,79" />
                      <polyline className="crack-highlight" points="1,42 13,44 22,46" />
                    </svg>
                  )}
                  <span
                    className="frozen-flake"
                    style={{ fontSize: Math.max(12, squarePx * 0.32) }}
                  >❄</span>
                </div>
              )}
              {(() => {
                // Doomed piece overlay — the engine has already cleared this
                // square, but we draw the destroyed piece for the whistle
                // window so it's still visible right up until the explosion.
                const letter = doomedBySq.get(sq);
                if (!letter) return null;
                const keys = lettersToPieceKeys(letter as PieceLetter);
                const fullSize = squarePx * 0.95;
                const pairSize = squarePx * 0.7;
                return (
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                      zIndex: 4,
                    }}
                  >
                    {keys.length === 1
                      ? renderPiece(keys[0], fullSize)
                      : (
                        <div style={{ position: 'relative', width: squarePx, height: squarePx }}>
                          {keys.map((k, i) => (
                            <div
                              key={i}
                              style={{
                                position: 'absolute',
                                left: i === 0 ? 0 : squarePx - pairSize,
                                top: i === 0 ? 0 : squarePx - pairSize,
                                width: pairSize,
                                height: pairSize,
                              }}
                            >
                              {renderPiece(k, pairSize)}
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                );
              })()}
              {(() => {
                const m = missilesBySq.get(sq);
                if (!m) return null;
                // Crosshair = four short ticks around a central countdown
                // number. Same colour for both sides (the red); shape
                // distinguishes them — white fires a + (cardinal ticks),
                // black fires an X (the wrapper is rotated 45°). Number is
                // outside the rotated wrapper so it stays upright. Black's
                // ticks are longer so the X reaches the tile corners
                // (~sqrt(2)/2·size - ring radius from the ring's edge).
                const ringColor = '#ff5a5a';
                const size = squarePx;
                const isBlack = m.firedBy === 'b';
                const tick = isBlack ? Math.max(8, size * 0.36) : Math.max(4, size * 0.18);
                return (
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      inset: 0,
                      pointerEvents: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 5,
                    }}
                  >
                    <div
                      style={{
                        position: 'relative',
                        width: size * 0.7,
                        height: size * 0.7,
                        borderRadius: '50%',
                        border: `2px solid ${ringColor}`,
                        boxShadow: `0 0 ${Math.max(2, size * 0.06)}px ${ringColor}aa`,
                        background: 'rgba(0,0,0,0.25)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transform: isBlack ? 'rotate(45deg)' : undefined,
                        }}
                      >
                        <span style={{ position: 'absolute', top: -tick, width: 2, height: tick, background: ringColor }} />
                        <span style={{ position: 'absolute', bottom: -tick, width: 2, height: tick, background: ringColor }} />
                        <span style={{ position: 'absolute', left: -tick, width: tick, height: 2, background: ringColor }} />
                        <span style={{ position: 'absolute', right: -tick, width: tick, height: 2, background: ringColor }} />
                      </div>
                      <span
                        style={{
                          color: '#fff',
                          fontWeight: 700,
                          fontSize: Math.max(11, size * 0.34),
                          lineHeight: 1,
                          textShadow: '0 0 3px rgba(0,0,0,0.85)',
                        }}
                      >
                        {m.pliesLeft}
                      </span>
                    </div>
                  </div>
                );
              })()}
              {(() => {
                // Earthquake overlay — jagged cracks across the floor with
                // a piled-rock wall along the leading edge so the player can
                // see at a glance which way the wave is rolling.
                //
                // df is a file delta (+ = right), dr is a rank delta
                // (+ = up the board). Screen y grows downward, so the visual
                // angle uses -dr.
                //
                // Two base layouts, each rotated to the actual heading:
                //   • cardinal: rock wall on the east edge, cracks running
                //     left → right. canonical heading = east (0°).
                //   • diagonal: rocks pile along the top + right edges so
                //     both faces of the leading corner show stone. cracks
                //     run from the trailing corner up to the leading one.
                //     canonical heading = northeast (-45° in atan2 terms).
                const eq = earthquakesBySq.get(sq);
                if (!eq) return null;
                const isDiagonal = eq.df !== 0 && eq.dr !== 0;
                const heading = Math.atan2(-eq.dr, eq.df) * 180 / Math.PI;
                const canonical = isDiagonal ? -45 : 0;
                const rotation = heading - canonical;
                return (
                  <div
                    className="earthquake-marker"
                    aria-hidden
                    style={{
                      position: 'absolute',
                      inset: 0,
                      pointerEvents: 'none',
                      zIndex: 4,
                    }}
                  >
                    <svg
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      width="100%"
                      height="100%"
                      style={{ display: 'block', transform: `rotate(${rotation}deg)` }}
                    >
                      {/* Dust haze under the cracks so the cell reads as
                          disturbed earth even before any pieces are nearby. */}
                      <rect
                        x="2" y="2" width="96" height="96" rx="6"
                        fill="rgba(80, 50, 22, 0.28)"
                      />
                      {isDiagonal ? (
                        <>
                          {/* Diagonal crack network — a tree-root /
                              ice-shatter pattern: a few jagged main
                              fissures grow from the trailing edge toward
                              the leading corner, with sub-cracks and
                              twigs forking off. Twig tips dangle free,
                              like the way ice fractures branch outward.
                              Joints share coordinates with the parent
                              fissure so the network reads as continuous
                              growth instead of disjoint strokes. */}
                          <g
                            stroke="#2a1808"
                            strokeWidth="3.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          >
                            {/* Main fissures growing SW → NE. */}
                            <polyline points="4,92 14,84 22,78 30,68 40,60 50,50 60,40 70,30" />
                            <polyline points="12,86 22,76 32,64 42,52 52,42 64,30 74,20" />
                            <polyline points="30,94 40,86 50,76 60,64 70,52 78,40" />
                            {/* Sub-fissures forking off — each starts on a
                                main fissure's joint, then jags off in its
                                own direction with a free tip. */}
                            <polyline points="22,78 16,74 8,72" />
                            <polyline points="40,60 32,54 24,52 18,46" />
                            <polyline points="50,50 44,42 40,32" />
                            <polyline points="60,40 56,30 60,22" />
                            <polyline points="32,64 26,68 20,66" />
                            <polyline points="52,42 48,32 52,22 50,12" />
                            <polyline points="64,30 70,24 70,14" />
                            <polyline points="50,76 56,82 64,86" />
                            <polyline points="60,64 68,68 74,76" />
                            <polyline points="70,52 78,56 82,62" />
                            {/* Twigs — short forks off the sub-fissures,
                                ends hanging free. */}
                            <polyline points="44,42 38,38 36,30" />
                            <polyline points="56,30 50,26 46,22" />
                            <polyline points="26,68 22,74 24,80" />
                            <polyline points="48,32 42,28" />
                            <polyline points="32,54 30,46" />
                            <polyline points="68,68 72,74 78,76" />
                            <polyline points="56,82 60,90" />
                            {/* Splinters at the leading tips of the mains,
                                spraying into the rock wall. */}
                            <polyline points="70,30 78,28 82,22" />
                            <polyline points="74,20 82,16 86,10" />
                            <polyline points="78,40 84,38 88,32" />
                          </g>
                          {/* Rock wall along the TOP edge (one face of the
                              leading corner). */}
                          <g>
                            <polygon
                              points="2,2 18,0 30,8 28,20 14,22 4,16"
                              fill="#6a4a26" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <polygon
                              points="28,4 46,2 60,10 56,22 38,24 28,16"
                              fill="#7d5a30" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <polygon
                              points="56,2 74,0 88,8 84,22 64,22 56,14"
                              fill="#6a4828" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                          </g>
                          {/* Rock wall along the RIGHT edge (other face of
                              the leading corner). */}
                          <g>
                            <polygon
                              points="80,12 96,4 100,22 96,38 82,36 78,22"
                              fill="#574023" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <polygon
                              points="78,36 96,38 100,52 94,64 80,62 76,48"
                              fill="#7d5a30" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <polygon
                              points="76,62 94,64 100,80 92,92 78,88 72,76"
                              fill="#6a4828" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                          </g>
                          {/* Top-right keystone — anchors the two walls into
                              a single pile at the leading corner. */}
                          <polygon
                            points="84,2 100,0 100,20 86,18 80,8"
                            fill="#46331c" stroke="#2a1808" strokeWidth="2"
                            strokeLinejoin="round"
                          />
                          {/* Highlight strokes on the tops of the rocks. */}
                          <g stroke="#cfa874" strokeWidth="1.1" fill="none" strokeLinecap="round">
                            <polyline points="4,4 18,2 28,8" />
                            <polyline points="30,6 46,4 58,10" />
                            <polyline points="58,4 74,2 86,8" />
                            <polyline points="84,14 96,8 100,22" />
                            <polyline points="82,40 96,42 100,52" />
                            <polyline points="80,66 94,68 100,80" />
                          </g>
                        </>
                      ) : (
                        <>
                          {/* Cardinal crack network — same tree-root
                              treatment as the diagonal layout. Main
                              fissures grow from the trailing edge toward
                              the rock wall, with sub-cracks and twigs
                              forking off; tips can dangle free. */}
                          <g
                            stroke="#2a1808"
                            strokeWidth="3.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                          >
                            {/* Main fissures walking left → right (toward
                                the leading rock wall on the east edge). */}
                            <polyline points="4,28 14,32 22,26 32,32 42,28 52,34 62,28 72,32" />
                            <polyline points="4,58 14,54 24,60 34,56 44,62 54,58 64,62 74,58" />
                            <polyline points="6,84 16,80 26,86 36,80 46,86 56,80 66,84 76,80" />
                            {/* Sub-fissures off the top main. */}
                            <polyline points="22,26 20,16 26,8" />
                            <polyline points="42,28 38,18 42,10" />
                            <polyline points="62,28 60,18 66,12" />
                            <polyline points="32,32 34,42 30,52" />
                            <polyline points="52,34 54,44 50,54" />
                            {/* Sub-fissures off the middle main. */}
                            <polyline points="24,60 18,68 22,76" />
                            <polyline points="44,62 40,70 44,80" />
                            <polyline points="64,62 60,72 64,82" />
                            <polyline points="14,54 12,44 18,38" />
                            <polyline points="34,56 30,46 34,38" />
                            {/* Sub-fissures off the bottom main. */}
                            <polyline points="26,86 28,94" />
                            <polyline points="46,86 50,94" />
                            <polyline points="66,84 64,94" />
                            <polyline points="36,80 32,72 36,64" />
                            <polyline points="56,80 60,72 58,64" />
                            {/* Twigs — short forks off the sub-fissures
                                with free tips. */}
                            <polyline points="20,16 14,12" />
                            <polyline points="38,18 32,14" />
                            <polyline points="60,18 56,10" />
                            <polyline points="34,42 40,44" />
                            <polyline points="54,44 60,42" />
                            <polyline points="18,68 12,72" />
                            <polyline points="40,70 36,74" />
                            <polyline points="60,72 66,76" />
                            <polyline points="28,94 24,90" />
                            <polyline points="50,94 56,92" />
                            {/* Splinters at the leading tips of the mains,
                                spraying into the rock wall. */}
                            <polyline points="72,32 80,30 84,24" />
                            <polyline points="74,58 82,56 86,52" />
                            <polyline points="76,80 84,82 88,76" />
                          </g>
                          {/* Rock wall on the leading edge. */}
                          <g>
                            <polygon
                              points="74,8 90,4 98,14 96,26 84,30 76,22"
                              fill="#6a4a26" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <polygon
                              points="80,28 96,24 100,38 94,50 82,48 76,38"
                              fill="#7d5a30" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <polygon
                              points="76,48 92,46 100,58 96,72 82,70 74,60"
                              fill="#6a4828" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <polygon
                              points="78,68 94,66 100,80 92,94 80,92 74,80"
                              fill="#574023" stroke="#2a1808" strokeWidth="2"
                              strokeLinejoin="round"
                            />
                            <g stroke="#cfa874" strokeWidth="1.1" fill="none" strokeLinecap="round">
                              <polyline points="76,10 84,6 92,8" />
                              <polyline points="82,30 90,27 96,30" />
                              <polyline points="78,50 86,48 94,50" />
                              <polyline points="80,70 88,68 96,70" />
                            </g>
                          </g>
                        </>
                      )}
                    </svg>
                  </div>
                );
              })()}
              {(() => {
                // Ghost spawn preview — translucent piece on the hovered
                // square showing what would land there if the user clicked
                // (sandbox palette / cash shop arming).
                if (!ghostSpawn) return null;
                if (hoverSq !== sq) return null;
                const keys = lettersToPieceKeys(ghostSpawn.letter as PieceLetter);
                if (keys.length === 0) return null;
                const fullSize = squarePx * 0.95;
                const pairSize = squarePx * 0.7;
                return (
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                      opacity: 0.5,
                      zIndex: 4,
                    }}
                  >
                    {keys.length === 1
                      ? renderPiece(keys[0], fullSize)
                      : (
                        <div style={{ position: 'relative', width: squarePx, height: squarePx }}>
                          {keys.map((k, i) => (
                            <div
                              key={i}
                              style={{
                                position: 'absolute',
                                left: i === 0 ? 0 : squarePx - pairSize,
                                top: i === 0 ? 0 : squarePx - pairSize,
                                width: pairSize,
                                height: pairSize,
                              }}
                            >
                              {renderPiece(k, pairSize)}
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                );
              })()}
              {(() => {
                // Ghost crosshair preview — only on the hovered square, only
                // when the local player has ICBM armed, and only if no real
                // missile already marks that square (avoids double-render).
                // Same shape rules as the real crosshair: white = + (cardinal
                // ticks), black = X (wrapper rotated 45°). Both sides share
                // the red ring colour.
                if (!ghostCrosshair) return null;
                if (hoverSq !== sq) return null;
                if (missilesBySq.has(sq)) return null;
                const ringColor = '#ff5a5a';
                const size = squarePx;
                const isBlack = ghostCrosshair.firedBy === 'b';
                const tick = isBlack ? Math.max(8, size * 0.36) : Math.max(4, size * 0.18);
                return (
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      inset: 0,
                      pointerEvents: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 5,
                    }}
                  >
                    <div
                      style={{
                        position: 'relative',
                        width: size * 0.7,
                        height: size * 0.7,
                        borderRadius: '50%',
                        border: `2px solid ${ringColor}`,
                        boxShadow: `0 0 ${Math.max(2, size * 0.06)}px ${ringColor}aa`,
                        background: 'rgba(0,0,0,0.25)',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transform: isBlack ? 'rotate(45deg)' : undefined,
                        }}
                      >
                        <span style={{ position: 'absolute', top: -tick, width: 2, height: tick, background: ringColor }} />
                        <span style={{ position: 'absolute', bottom: -tick, width: 2, height: tick, background: ringColor }} />
                        <span style={{ position: 'absolute', left: -tick, width: tick, height: 2, background: ringColor }} />
                        <span style={{ position: 'absolute', right: -tick, width: tick, height: 2, background: ringColor }} />
                      </div>
                    </div>
                  </div>
                );
              })()}
              {f === filesLeftRight[0] && (
                <span
                  style={{
                    position: 'absolute',
                    left: 3,
                    top: 1,
                    fontSize: Math.max(9, squarePx * 0.18),
                    color: isLight ? '#5d6c89' : '#dfe5f0',
                    fontWeight: 600,
                    pointerEvents: 'none',
                  }}
                >
                  {r + 1}
                </span>
              )}
              {r === ranksTopDown[ranksTopDown.length - 1] && (
                <span
                  style={{
                    position: 'absolute',
                    right: 3,
                    bottom: 0,
                    fontSize: Math.max(9, squarePx * 0.18),
                    color: isLight ? '#5d6c89' : '#dfe5f0',
                    fontWeight: 600,
                    pointerEvents: 'none',
                  }}
                >
                  {FILES[f]}
                </span>
              )}
            </div>
          );
        }),
      )}

      {/* Slime big kings — one stretched king sprite per 2×2 blob, sitting on
          a goo pad. The per-square sprites for these tiles are suppressed in
          the cell renderer. left/top transition makes the blob slide smoothly
          when it shifts; the grow animation fires when an expansion lands. */}
      {(slimeBigKings ?? []).map((g, i) => {
        if (g.tiles.length === 0) return null;
        const xs = g.tiles.map((t) => center(t).x);
        const ys = g.tiles.map((t) => center(t).y);
        const left = Math.min(...xs) - squarePx / 2;
        const top = Math.min(...ys) - squarePx / 2;
        const size = squarePx * 2;
        const glow = g.color === 'w' ? kingGlows?.w : kingGlows?.b;
        const growing = abilityAnim?.kind === 'slime-expand' && g.tiles.includes(abilityAnim.toSq);
        // The grow animation scales the blob out of the mini king's corner.
        let originX = `${size / 2}px`;
        let originY = `${size / 2}px`;
        if (growing && abilityAnim?.fromSq) {
          const o = center(abilityAnim.fromSq);
          originX = `${o.x - left}px`;
          originY = `${o.y - top}px`;
        }
        const glowFilter = glow
          ? `drop-shadow(0 0 ${squarePx * 0.08}px ${glow}) drop-shadow(0 0 ${squarePx * 0.22}px ${glow})`
          : undefined;
        return (
          <div
            key={growing ? `slime-big-${i}-${abilityAnim!.key}` : `slime-big-${i}`}
            className={`slime-big-king${growing ? ' growing' : ''}`}
            aria-hidden
            style={{
              position: 'absolute',
              left,
              top,
              width: size,
              height: size,
              pointerEvents: 'none',
              zIndex: 2,
              transition: 'left 220ms cubic-bezier(0.33, 1, 0.68, 1), top 220ms cubic-bezier(0.33, 1, 0.68, 1)',
              ['--grow-ox' as any]: originX,
              ['--grow-oy' as any]: originY,
            }}
          >
            <div
              className="slime-big-king-body"
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                filter: glowFilter,
              }}
            >
              <span className="slime-goo slime-goo-big" aria-hidden />
              {renderPiece(g.color === 'w' ? 'wK' : 'bK', size * 0.92)}
            </div>
          </div>
        );
      })}

      {/* Slime shift arrows — when a blob tile is selected, its legal slides
          render as arrows radiating from the blob's centre (replacing the
          per-square target dots). Green = slide, red = crushing slide. */}
      {slimeArrowsActive && (() => {
        const group = (slimeBigKings ?? []).find((g) => g.tiles.includes(selectedSquare!));
        if (!group || group.tiles.length === 0) return null;
        const cs = group.tiles.map((t) => center(t));
        const cx = cs.reduce((a, c) => a + c.x, 0) / cs.length;
        const cy = cs.reduce((a, c) => a + c.y, 0) / cs.length;
        const stroke = effectiveSize / 44;
        return (
          <svg
            width={effectiveSize}
            height={effectiveSize}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              pointerEvents: 'none',
              zIndex: 9,
            }}
          >
            {slimeShiftArrows!.map((a, i) => {
              // Board direction → screen direction (black orientation flips
              // both axes; +rank is up the screen for white).
              const sx = orientation === 'white' ? a.df : -a.df;
              const sy = orientation === 'white' ? -a.dr : a.dr;
              const from = { x: cx + sx * squarePx * 0.55, y: cy + sy * squarePx * 0.55 };
              const to = { x: cx + sx * squarePx * 1.45, y: cy + sy * squarePx * 1.45 };
              const color = a.isCapture ? '#ff5a5a' : '#7ed957';
              const markerId = `slime-shift-arrow-${i}`;
              return (
                <g key={`${a.df}:${a.dr}`}>
                  <marker
                    id={markerId}
                    markerWidth="2"
                    markerHeight="2.5"
                    refX="1.25"
                    refY="1.25"
                    orient="auto"
                  >
                    <polygon points="0.3 0, 2 1.25, 0.3 2.5" fill={color} />
                  </marker>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={color}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    opacity={0.85}
                    markerEnd={`url(#${markerId})`}
                    style={{ filter: `drop-shadow(0 0 3px ${color}aa)` }}
                  />
                </g>
              );
            })}
          </svg>
        );
      })()}

      {/* Arrow overlay — drawn on top of pieces, ignored by mouse. */}
      {renderedArrows.length > 0 && (
        <svg
          width={effectiveSize}
          height={effectiveSize}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
            zIndex: 10,
          }}
        >
          {renderedArrows.map((a, i) => {
            const from = center(a.from);
            const to = center(a.to);
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const r = Math.hypot(dx, dy);
            if (r === 0) return null;
            const reducer = effectiveSize / 32;
            const markerId = `mb-arrow-${i}`;
            const startMarkerId = `mb-arrow-start-${i}`;
            const stroke = a.preview ? (0.9 * effectiveSize) / 40 : effectiveSize / 40;
            const opacity = a.preview ? 0.5 : 0.65;
            const marker = (
              <marker
                id={markerId}
                markerWidth="2"
                markerHeight="2.5"
                refX="1.25"
                refY="1.25"
                orient="auto"
              >
                <polygon points="0.3 0, 2 1.25, 0.3 2.5" fill={ARROW_COLOR} />
              </marker>
            );
            // Rounded start cap drawn as a circle marker rather than via
            // strokeLinecap="round" — a round linecap also rounds the END,
            // which bulges out past the arrowhead. markerUnits defaults to
            // strokeWidth, so r=0.5 gives a dot exactly the line's width.
            const startMarker = (
              <marker
                id={startMarkerId}
                markerWidth="2"
                markerHeight="2"
                refX="1"
                refY="1"
                orient="auto"
              >
                <circle cx="1" cy="1" r="0.5" fill={ARROW_COLOR} />
              </marker>
            );

            // L-shaped arrow for knight jumps (1×2 or 2×1 squares). Bend at
            // the corner formed by traversing the LONG axis first, then the
            // short axis — so a g1→f3 jump heads two squares forward, then
            // one square sideways.
            const fromFile = a.from.charCodeAt(0) - 97;
            const fromRank = parseInt(a.from[1], 10) - 1;
            const toFile = a.to.charCodeAt(0) - 97;
            const toRank = parseInt(a.to[1], 10) - 1;
            const absDf = Math.abs(toFile - fromFile);
            const absDr = Math.abs(toRank - fromRank);
            const isKnightJump = (absDf === 2 && absDr === 1) || (absDf === 1 && absDr === 2);

            if (isKnightJump) {
              const corner = absDf === 2
                ? { x: to.x, y: from.y }   // long horizontal first
                : { x: from.x, y: to.y };  // long vertical first
              const sdx = to.x - corner.x;
              const sdy = to.y - corner.y;
              const slen = Math.hypot(sdx, sdy);
              const end = slen > reducer
                ? {
                    x: corner.x + (sdx * (slen - reducer)) / slen,
                    y: corner.y + (sdy * (slen - reducer)) / slen,
                  }
                : corner;
              const points = `${from.x},${from.y} ${corner.x},${corner.y} ${end.x},${end.y}`;
              return (
                <g key={`${a.from}-${a.to}-${a.preview ? 'p' : 'c'}`}>
                  {marker}
                  {startMarker}
                  <polyline
                    points={points}
                    fill="none"
                    opacity={opacity}
                    stroke={ARROW_COLOR}
                    strokeWidth={stroke}
                    strokeLinejoin="round"
                    markerStart={`url(#${startMarkerId})`}
                    markerEnd={`url(#${markerId})`}
                  />
                </g>
              );
            }

            const end = {
              x: from.x + (dx * (r - reducer)) / r,
              y: from.y + (dy * (r - reducer)) / r,
            };
            return (
              <g key={`${a.from}-${a.to}-${a.preview ? 'p' : 'c'}`}>
                {marker}
                {startMarker}
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={end.x}
                  y2={end.y}
                  opacity={opacity}
                  stroke={ARROW_COLOR}
                  strokeWidth={stroke}
                  markerStart={`url(#${startMarkerId})`}
                  markerEnd={`url(#${markerId})`}
                />
              </g>
            );
          })}
        </svg>
      )}

      {abilityAnim && (
        <AbilityOverlay
          key={abilityAnim.key}
          anim={abilityAnim}
          squarePx={squarePx}
          centerOf={center}
        />
      )}
      {mergeAnim && (
        <MergeOverlay
          key={mergeAnim.key}
          anim={mergeAnim}
          squarePx={squarePx}
          centerOf={center}
        />
      )}
      {emojiBubble && emojiBubble.squares.map((sq, i) => {
        const c = center(sq);
        const side = c.x <= effectiveSize / 2 ? 'right' : 'left';
        const x = side === 'right' ? c.x + squarePx * 0.42 : c.x - squarePx * 0.42;
        const y = Math.max(squarePx * 0.32, Math.min(effectiveSize - squarePx * 0.32, c.y - squarePx * 0.45));
        return (
          <div
            key={`${emojiBubble.key}-${sq}-${i}`}
            className={`king-emoji-bubble ${side}`}
            style={{
              ['--bubble-x' as any]: `${x}px`,
              ['--bubble-y' as any]: `${y}px`,
              ['--bubble-size' as any]: `${squarePx}px`,
            }}
            aria-hidden
          >
            {emojiBubble.emoji}
          </div>
        );
      })}
      {drag && typeof document !== 'undefined' && createPortal(
        <DragFloater
          piece={drag.piece}
          squarePx={squarePx}
          x={drag.x}
          y={drag.y}
          neutralKing={jugBySq.has(drag.from)}
          slimeGoo={slimeMiniSet.has(drag.from) && !slimeTileSet.has(drag.from)}
        />,
        document.body,
      )}
    </div>
  );
}

// Sprite that follows the cursor during a custom pointer drag. Portalled to
// <body> so it isn't clipped by the board's overflow:hidden and renders above
// every other piece of UI. pointer-events:none so it doesn't intercept the
// pointermove events the captured cell is still receiving.
function DragFloater({
  piece,
  squarePx,
  x,
  y,
  neutralKing,
  slimeGoo,
}: {
  piece: Piece;
  squarePx: number;
  x: number;
  y: number;
  // Juggernaut in flight — keep the colorless stone king under the cursor.
  neutralKing?: boolean;
  // Slime mini-king in flight — wrap the king glyph in the goo bubble so the
  // blob travels with the cursor instead of staying behind on the source.
  slimeGoo?: boolean;
}) {
  const keys = lettersToPieceKeys(piece.letter);
  const isMerged = keys.length > 1;
  // Slightly larger than a board piece for "picked up" feel.
  const fullSize = squarePx * 1.05;
  const pairSize = squarePx * 0.78;
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: 10000,
        width: fullSize,
        height: fullSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        filter: 'drop-shadow(0 6px 10px rgba(0,0,0,0.4))',
      }}
    >
      {slimeGoo && <span className="slime-goo slime-goo-mini" aria-hidden />}
      {neutralKing ? (
        renderNeutralKing(fullSize)
      ) : !isMerged ? (
        renderPiece(keys[0], fullSize)
      ) : (
        <div style={{ position: 'relative', width: fullSize, height: fullSize }}>
          {keys.map((k, i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: i === 0 ? 0 : fullSize - pairSize,
                top: i === 0 ? 0 : fullSize - pairSize,
                width: pairSize,
                height: pairSize,
              }}
            >
              {renderPiece(k, pairSize)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Slots in the merged piece whose glyph isn't already at that exact slot
// position in the receiver — those need to fade in at the end of the
// merge animation. The remaining slots stay static (rendered at full
// opacity throughout) because a source glyph already lives there.
function computeMergeFadeInSlots(toLetter: string, mergedLetter: string): number[] {
  const receiverKeys = lettersToPieceKeys(toLetter);
  const mergedKeys = lettersToPieceKeys(mergedLetter);
  const out: number[] = [];
  for (let slot = 0; slot < mergedKeys.length; slot++) {
    const slotKey = mergedKeys[slot];
    let isStatic = false;
    // Receiver was already a merged piece with matching glyph at the
    // same slot — that glyph survives, no animation needed.
    if (receiverKeys.length === mergedKeys.length && receiverKeys[slot] === slotKey) {
      isStatic = true;
    }
    if (!isStatic) out.push(slot);
  }
  return out;
}

function MergeOverlay({
  anim,
  squarePx,
  centerOf,
}: {
  anim: MergeAnim;
  squarePx: number;
  centerOf: (sq: Square) => { x: number; y: number };
}) {
  // Drag-initiated merges hand us the cursor's board-local release point.
  // The mover's phantom starts there instead of at `from`'s centre so the
  // visual continues smoothly from the drop spot rather than teleporting
  // back to the source square.
  const moverOrigin = anim.releasePx ?? centerOf(anim.from);
  const to = centerOf(anim.to);
  const fullSize = squarePx * 0.95;
  const pairSize = squarePx * 0.7;
  const pairScale = pairSize / fullSize;
  const moverKeys = lettersToPieceKeys(anim.fromLetter);
  const receiverKeys = lettersToPieceKeys(anim.toLetter);
  const mergedKeys = lettersToPieceKeys(anim.mergedLetter);
  const fadeInSlots = computeMergeFadeInSlots(anim.toLetter, anim.mergedLetter);

  // Position of slot `s` (0 or 1) relative to a square's centre. Matches
  // the hard-coded offsets used by PieceSprite for the two-glyph layout.
  // For a single-glyph result there are no slots — everything centres.
  const slotPos = (c: { x: number; y: number }, s: number, mergedLen: number) => {
    if (mergedLen < 2) return c;
    return s === 0
      ? { x: c.x - 0.12 * squarePx, y: c.y + 0.03 * squarePx }
      : { x: c.x + 0.12 * squarePx, y: c.y + 0.13 * squarePx };
  };

  // Starting position of a glyph at a given source: centre for a single
  // piece, the matching slot for an already-merged source.
  const glyphStart = (
    sourceCenter: { x: number; y: number },
    sourceKeys: PieceKey[],
    glyphIdx: number,
  ) => {
    if (sourceKeys.length === 1) return { pos: sourceCenter, scale: 1 };
    return { pos: slotPos(sourceCenter, glyphIdx, sourceKeys.length), scale: pairScale };
  };

  // Ending position of a glyph: its slot in mergedKeys if it survives,
  // otherwise the first fade-in slot it should fuse into. Receivers
  // already at their own slot prefer to "fade in place" at that slot.
  const glyphEnd = (
    key: PieceKey,
    isMover: boolean,
    glyphIdx: number,
  ): { pos: { x: number; y: number }; scale: number; staticHere: boolean } => {
    const matchSlot = mergedKeys.indexOf(key);
    if (matchSlot >= 0) {
      // Source glyph survives in the merged result.
      const staticHere = !isMover
        && receiverKeys.length === mergedKeys.length
        && glyphIdx === matchSlot;
      return {
        pos: slotPos(to, matchSlot, mergedKeys.length),
        scale: mergedKeys.length < 2 ? 1 : pairScale,
        staticHere,
      };
    }
    // Source glyph fuses into a brand-new merged-slot glyph. Pick a
    // fade-in slot — for receiver glyphs, prefer the slot they're
    // already sitting at if possible so they fade in place.
    if (fadeInSlots.length === 0) {
      // Should not happen for a real merge — fall back to to-centre.
      return { pos: to, scale: 1, staticHere: false };
    }
    let chosen = fadeInSlots[0];
    if (!isMover && receiverKeys.length === mergedKeys.length && fadeInSlots.includes(glyphIdx)) {
      chosen = glyphIdx;
    }
    return {
      pos: slotPos(to, chosen, mergedKeys.length),
      scale: mergedKeys.length < 2 ? 1 : pairScale,
      staticHere: false,
    };
  };

  type Phantom = {
    glyph: PieceKey;
    startX: number; startY: number; startScale: number;
    endX: number; endY: number; endScale: number;
  };
  const phantoms: Phantom[] = [];

  const pushPhantom = (
    key: PieceKey,
    sourceCenter: { x: number; y: number },
    sourceKeys: PieceKey[],
    glyphIdx: number,
    isMover: boolean,
  ) => {
    const end = glyphEnd(key, isMover, glyphIdx);
    // If this receiver glyph IS the static slot, the static merged piece
    // already renders it from t=0 — skip the phantom.
    if (end.staticHere) return;
    const start = glyphStart(sourceCenter, sourceKeys, glyphIdx);
    phantoms.push({
      glyph: key,
      startX: start.pos.x, startY: start.pos.y, startScale: start.scale,
      endX: end.pos.x, endY: end.pos.y, endScale: end.scale,
    });
  };

  // When releasePx is set, treat the mover's source as a single-glyph piece
  // sitting under the cursor — both slots collapse to the cursor position so
  // a merged-source's two glyphs don't visibly tear apart at the start.
  const moverIsAtCursor = !!anim.releasePx;
  moverKeys.forEach((k, i) => pushPhantom(
    k,
    moverOrigin,
    moverIsAtCursor ? ([k] as PieceKey[]) : moverKeys,
    moverIsAtCursor ? 0 : i,
    true,
  ));
  receiverKeys.forEach((k, i) => pushPhantom(k, to, receiverKeys, i, false));

  // Stack the phantoms so their z-order matches the static merged sprite:
  // slot 0 (upper-left) is drawn first, slot 1 (lower-right) on top. Without
  // this, mover-then-receiver DOM order can put the upper-left receiver on
  // top of a lower-right mover (most visible on a drag-initiated merge,
  // where the flying mover is the piece the user just released and ought to
  // sit above the static destination glyph). Sort key is endY — slot 1 has
  // the larger y offset so it naturally lands at the end of the list.
  phantoms.sort((a, b) => a.endY - b.endY);

  return (
    <div
      className="merge-anim"
      style={{
        ['--size' as any]: `${squarePx}px`,
      }}
    >
      {phantoms.map((p, i) => (
        <div
          key={i}
          className="merge-phantom"
          style={{
            ['--from-x' as any]: `${p.startX}px`,
            ['--from-y' as any]: `${p.startY}px`,
            ['--end-x' as any]: `${p.endX}px`,
            ['--end-y' as any]: `${p.endY}px`,
            ['--start-scale' as any]: `${p.startScale}`,
            ['--end-scale' as any]: `${p.endScale}`,
          }}
        >
          {renderPiece(p.glyph, fullSize)}
        </div>
      ))}
    </div>
  );
}

function AbilityOverlay({
  anim,
  squarePx,
  centerOf,
}: {
  anim: AbilityAnim;
  squarePx: number;
  centerOf: (sq: Square) => { x: number; y: number };
}) {
  const to = centerOf(anim.toSq);
  if (anim.kind === 'flight' && anim.fromSq) {
    const from = centerOf(anim.fromSq);
    // Any piece can fly now — render the flyer's sprite (merged letters fall
    // back to their primary key), defaulting to the king for legacy anims.
    const kingKey: PieceKey = anim.flyerLetter
      ? lettersToPieceKeys(anim.flyerLetter as PieceLetter)[0]
      : (anim.color === 'w' ? 'wK' : 'bK');
    return (
      <div
        className="ability-flight"
        style={{
          // CSS uses these vars to translate the king from -> to.
          ['--from-x' as any]: `${from.x}px`,
          ['--from-y' as any]: `${from.y}px`,
          ['--to-x' as any]: `${to.x}px`,
          ['--to-y' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <div className="ability-flight-body">
          <span className="ability-flight-wing left" aria-hidden />
          <span className="ability-flight-wing right" aria-hidden />
          <span className="ability-flight-king">
            {renderPiece(kingKey, squarePx * 0.95)}
          </span>
        </div>
      </div>
    );
  }
  if (anim.kind === 'necromancer') {
    // The rising pawn lives in this overlay (z-index 12, above all cells)
    // so the translateY can drag it below the spawn square without being
    // painted over by the next row's cell background. clip-path on the
    // pawn itself crops it at the ground line (pinned at the bottom of
    // the spawn square's natural area) — no parent mask box needed.
    const pawnKey = anim.color === 'w' ? 'wP' : 'bP';
    return (
      <div
        className="ability-necromancer"
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <span className="ability-necro-glow" aria-hidden />
        {/* Mound renders BEHIND the pawn — the pawn glyph naturally ends at
            the clip cut so there is no exposed cut edge to hide, and the
            pawn now stands on top of the dirt rather than wading through it. */}
        <span className="ability-necro-mound" aria-hidden />
        <span className="ability-necro-pawn">
          {renderPiece(pawnKey, squarePx * 0.95)}
        </span>
        <span className="ability-necro-dust ability-necro-dust-l" aria-hidden />
        <span className="ability-necro-dust ability-necro-dust-r" aria-hidden />
      </div>
    );
  }
  if (anim.kind === 'warlord' && anim.fromSq) {
    // The king holds a sword and swings it in an arc toward the target.
    // Pivot is at the king's square; blade-length matches the king→target
    // distance so the tip lands on the slain piece at the mid-swing impact
    // moment. Bearing is the compass angle from king to target (0° = up,
    // clockwise positive) — the keyframe sweeps ±60° around that bearing.
    const from = centerOf(anim.fromSq);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const bearingDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const bladeLength = Math.max(0, distance - squarePx * 0.085);
    return (
      <div
        className="ability-warlord"
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <span className="ability-warlord-impact" aria-hidden />
        <div
          className="ability-warlord-sword"
          style={{
            ['--from-x' as any]: `${from.x}px`,
            ['--from-y' as any]: `${from.y}px`,
            ['--blade-length' as any]: `${bladeLength}px`,
            ['--bearing' as any]: `${bearingDeg}deg`,
            ['--size' as any]: `${squarePx}px`,
          }}
          aria-hidden
        >
          <span className="ak-blade" />
          <span className="ak-crossguard" />
          <span className="ak-grip" />
          <span className="ak-pommel" />
        </div>
      </div>
    );
  }
  if (anim.kind === 'frost') {
    return (
      <div
        className="ability-frost"
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <span className="ability-frost-burst" aria-hidden />
      </div>
    );
  }
  if (anim.kind === 'frost-shatter') {
    // 8 shards radiating outward from the centre. Each gets its own --shard-dx
    // / --shard-dy / --shard-rot drift via inline style so the same CSS
    // animation produces a different trajectory per shard.
    const shards = Array.from({ length: 8 }, (_, i) => {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 16;
      const dist = squarePx * (0.85 + (i % 3) * 0.15);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const rot = (i % 2 === 0 ? 1 : -1) * (180 + (i * 37) % 180);
      return (
        <span
          key={i}
          className="frost-shard"
          aria-hidden
          style={{
            ['--shard-dx' as any]: `${dx}px`,
            ['--shard-dy' as any]: `${dy}px`,
            ['--shard-rot' as any]: `${rot}deg`,
            animationDelay: `${i * 12}ms`,
          }}
        />
      );
    });
    return (
      <div
        className="ability-frost-shatter"
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <span className="frost-flash" aria-hidden />
        {shards}
      </div>
    );
  }
  if (anim.kind === 'mutation') {
    return (
      <div
        className="ability-mutation"
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <span className="ability-mutation-glow" aria-hidden />
        <span className="ability-mutation-ring r1" aria-hidden />
        <span className="ability-mutation-ring r2" aria-hidden />
        <span className="ability-mutation-ring r3" aria-hidden />
      </div>
    );
  }
  if (anim.kind === 'icbm') {
    return (
      <div
        className="ability-icbm"
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <span className="ability-icbm-flash" aria-hidden />
        <span className="ability-icbm-fireball" aria-hidden />
        <span className="ability-icbm-shock r1" aria-hidden />
        <span className="ability-icbm-shock r2" aria-hidden />
      </div>
    );
  }
  if (anim.kind === 'slime-expand' && anim.fromSq) {
    // Goo burst at the centre of the new 2×2 quadrant (midpoint between the
    // mini king and the far corner) while the blob layer plays its grow.
    const from = centerOf(anim.fromSq);
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2;
    return (
      <div
        className="ability-slime-expand"
        style={{
          ['--cx' as any]: `${cx}px`,
          ['--cy' as any]: `${cy}px`,
          ['--size' as any]: `${squarePx * 2}px`,
        }}
      >
        <span className="slime-burst" aria-hidden />
        <span className="slime-burst r2" aria-hidden />
      </div>
    );
  }
  if (anim.kind === 'slime-split') {
    // Goo splatter at the destroyed blob tile — 7 droplets flung outward,
    // same drift-variable scheme as the frost shards.
    const drops = Array.from({ length: 7 }, (_, i) => {
      const angle = (i / 7) * Math.PI * 2 + Math.PI / 9;
      const dist = squarePx * (0.7 + (i % 3) * 0.22);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const scale = 0.6 + (i % 3) * 0.3;
      return (
        <span
          key={i}
          className="slime-drop"
          aria-hidden
          style={{
            ['--drop-dx' as any]: `${dx}px`,
            ['--drop-dy' as any]: `${dy}px`,
            ['--drop-scale' as any]: `${scale}`,
            animationDelay: `${i * 14}ms`,
          }}
        />
      );
    });
    return (
      <div
        className="ability-slime-split"
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        <span className="slime-splat" aria-hidden />
        {drops}
      </div>
    );
  }
  if (
    anim.kind === 'juggernaut' || anim.kind === 'juggernaut-leap' ||
    anim.kind === 'jug-absorb' || anim.kind === 'jug-slam'
  ) {
    // Earthquake at the Juggernaut's square — expanding ground-shock rings
    // with a scatter of rubble chips flung outward. Pairs with the deep
    // quake SFX. The 'jug-absorb' variant additionally slides the doomed
    // attacker's sprite onto the (unmoving) Juggernaut and explodes it at
    // impact, with the quake parts delayed to fire at the moment it lands.
    // The 'jug-slam' (tier-3) variant amplifies everything: timing matches
    // the leap-body's landing frame, more chips fly farther, and a third
    // shock ring radiates wider for the heavy stomp.
    const isAbsorb = anim.kind === 'jug-absorb' && !!anim.fromSq;
    const isLeap = anim.kind === 'juggernaut-leap';
    const isSlam = anim.kind === 'jug-slam';
    const impactDelay = isSlam ? 520 : isAbsorb ? 320 : isLeap ? 520 : 0;
    const chipCount = isSlam ? 12 : 6;
    const chips = Array.from({ length: chipCount }, (_, i) => {
      const angle = (i / chipCount) * Math.PI * 2 + Math.PI / 7;
      const distMult = isSlam ? 1.1 + (i % 3) * 0.28 : 0.75 + (i % 3) * 0.2;
      const dist = squarePx * distMult;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - squarePx * (isSlam ? 0.35 : 0.25);
      return (
        <span
          key={i}
          className="jug-rubble"
          aria-hidden
          style={{
            ['--rubble-dx' as any]: `${dx}px`,
            ['--rubble-dy' as any]: `${dy}px`,
            animationDelay: `${impactDelay + i * (isSlam ? 8 : 16)}ms`,
          }}
        />
      );
    });
    const attackerKeys = isAbsorb && anim.flyerLetter
      ? lettersToPieceKeys(anim.flyerLetter as PieceLetter)
      : [];
    const from = isAbsorb ? centerOf(anim.fromSq!) : to;
    const className = isAbsorb
      ? 'ability-jug-absorb'
      : isSlam
      ? 'ability-juggernaut ability-jug-slam'
      : isLeap
      ? 'ability-juggernaut ability-juggernaut-leap'
      : 'ability-juggernaut';
    return (
      <div
        className={className}
        style={{
          ['--cx' as any]: `${to.x}px`,
          ['--cy' as any]: `${to.y}px`,
          ['--size' as any]: `${squarePx}px`,
        }}
      >
        {isAbsorb && attackerKeys.length > 0 && (
          <span
            className="jug-absorb-piece"
            aria-hidden
            style={{
              ['--from-x' as any]: `${from.x}px`,
              ['--from-y' as any]: `${from.y}px`,
              ['--dx' as any]: `${to.x - from.x}px`,
              ['--dy' as any]: `${to.y - from.y}px`,
            }}
          >
            {renderPiece(attackerKeys[0], squarePx * 0.95)}
          </span>
        )}
        <span className="jug-shock r1" aria-hidden style={{ animationDelay: `${impactDelay}ms` }} />
        <span className="jug-shock r2" aria-hidden style={{ animationDelay: `${impactDelay + 140}ms` }} />
        {isSlam && (
          <span className="jug-shock r3" aria-hidden style={{ animationDelay: `${impactDelay + 280}ms` }} />
        )}
        <span className="jug-dust" aria-hidden style={{ animationDelay: `${impactDelay}ms` }} />
        {isSlam && (
          <span className="jug-slam-flash" aria-hidden style={{ animationDelay: `${impactDelay}ms` }} />
        )}
        {chips}
      </div>
    );
  }
  return null;
}

function JugTierPips({ tier }: { tier: number }) {
  const pipColors = ['#c9b896', '#e0913f', '#e03f3f'];
  return (
    <div className="jug-tier-pips" aria-hidden>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`jug-pip${n <= tier ? ' filled' : ''}`}
          style={n <= tier ? { background: pipColors[tier - 1] } : undefined}
        />
      ))}
    </div>
  );
}

function PieceSprite({
  piece,
  squarePx,
  pickable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  hidden,
  glowColor,
  slideFrom,
  pop,
  mergeFadeInSlots,
  flightArrival,
  necromancerSpawn,
  neutralKing,
  neutralKingTier,
  juggernautLeap,
  slimeGoo,
}: {
  piece: Piece;
  squarePx: number;
  // Whether the piece is grabbable (turn ownership, interactive, etc.).
  // Drives the cursor and whether the pointer-down handler does anything.
  pickable: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  // True while a pointer drag of this piece is in flight — the floating
  // sprite at the cursor takes over so this static one stays out of view.
  hidden?: boolean;
  glowColor?: string;
  slideFrom?: { dx: number; dy: number };
  pop?: boolean;
  // When set, the listed merged-piece slots fade in over the last 12% of
  // the merge animation; slots not listed render at full opacity from
  // t=0 (the source glyph already occupies that exact position).
  mergeFadeInSlots?: number[];
  flightArrival?: boolean;
  // When set, the static pawn at the necromancer spawn square stays
  // hidden until the rising-pawn overlay has finished crawling up.
  necromancerSpawn?: boolean;
  // Juggernaut: render the colorless stone king instead of the piece's own
  // colour glyph. The underlying piece is still a normal 'K' of its side.
  neutralKing?: boolean;
  neutralKingTier?: number;
  // Tier-2 Juggernaut Quake Leap: keep the normal square-to-square slide on
  // the outer wrapper, then jump the body relative to that path.
  juggernautLeap?: boolean;
  // Slime mini-king: render the green goo bubble inside the sprite wrapper
  // so it slides, drags and hides in lockstep with the piece. (Previously
  // the bubble was a sibling on the cell, which made it disappear during
  // moves / drags and snap back at rest.)
  slimeGoo?: boolean;
}) {
  const keys = lettersToPieceKeys(piece.letter);
  const isMerged = keys.length > 1;
  const fullSize = squarePx * 0.95;
  const pairSize = squarePx * 0.7;
  // Stack two drop-shadows for a tight inner ring + soft outer halo that
  // hugs the actual piece silhouette (not the square).
  const glowFilter = glowColor
    ? `drop-shadow(0 0 ${squarePx * 0.06}px ${glowColor}) drop-shadow(0 0 ${squarePx * 0.18}px ${glowColor})`
    : undefined;

  const slideStyle: CSSProperties = slideFrom
    ? {
        ['--slide-dx' as any]: `${slideFrom.dx}px`,
        ['--slide-dy' as any]: `${slideFrom.dy}px`,
        animation: juggernautLeap
          ? 'piece-jug-leap-slide 680ms cubic-bezier(0.33, 0, 0.2, 1) both'
          : 'piece-slide 260ms cubic-bezier(0.33, 1, 0.68, 1) both',
        // Slide above neighbouring pieces so a moving piece is never visually
        // cut off by a same-rank target square's overlay.
        zIndex: 3,
      }
    : {};
  // Pop animation runs on an inner wrapper so its scale transform composes
  // with the outer slide translate (CSS can't run two animations on the
  // same `transform` simultaneously). Flight-arrival keeps the king
  // hidden until the flying overlay touches down (around 80% of the
  // 950ms flight keyframe), then pops it in. Merge fade-in is handled
  // per-slot below for the isMerged branch and on the inner wrapper for
  // the single-glyph branch.
  const wholeMergeFade = !isMerged && mergeFadeInSlots && mergeFadeInSlots.includes(0);
  const popStyle: CSSProperties = flightArrival
    ? {
        animation: 'piece-flight-arrival 950ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
        zIndex: 3,
      }
    : necromancerSpawn
    ? {
        animation: 'piece-necromancer-arrival 750ms ease-out both',
        zIndex: 3,
      }
    : wholeMergeFade
    ? {
        animation: 'piece-merge-slot-fade-in 480ms ease-out both',
        zIndex: 3,
      }
    : pop
    ? {
        animation: 'piece-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
        zIndex: 3,
      }
    : {};
  const contentStyle: CSSProperties = juggernautLeap
    ? (glowFilter ? { filter: glowFilter } : {})
    : {
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      };

  return (
    <div
      // Disable native drag — pointer events drive the custom drag.
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: pickable ? 'var(--cursor-grab)' : 'inherit',
        // `touch-action: none` keeps mobile/trackpad scroll from cancelling
        // the drag the moment the finger moves.
        touchAction: 'none',
        zIndex: 1,
        filter: juggernautLeap ? undefined : glowFilter,
        visibility: hidden ? 'hidden' : undefined,
        ...slideStyle,
      }}
    >
      {slimeGoo && <span className="slime-goo slime-goo-mini" aria-hidden />}
      <div
        style={{
          ['--size' as any]: `${squarePx}px`,
          width: '100%',
          height: '100%',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'visible',
          ...popStyle,
        }}
      >
        {juggernautLeap && <span className="piece-jug-leap-shadow" aria-hidden />}
        <div
          className={juggernautLeap ? 'piece-jug-leap-body' : undefined}
          style={contentStyle}
        >
          {neutralKing ? (
            <>
              {renderNeutralKing(fullSize)}
              {neutralKingTier ? <JugTierPips tier={neutralKingTier} /> : null}
            </>
          ) : !isMerged ? (
            renderPiece(keys[0], fullSize)
          ) : (
            <>
              <div
                style={{
                  position: 'absolute',
                  left: squarePx * 0.03,
                  top: squarePx * 0.18,
                  filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.35))',
                  pointerEvents: 'none',
                  animation: mergeFadeInSlots && mergeFadeInSlots.includes(0)
                    ? 'piece-merge-slot-fade-in 480ms ease-out both'
                    : undefined,
                }}
              >
                {renderPiece(keys[0], pairSize)}
              </div>
              <div
                style={{
                  position: 'absolute',
                  // Use left/top (mirror of the slot 0 formula via the pair-size
                  // box: 1 - 0.03 - 0.7 = 0.27, 1 - 0.02 - 0.7 = 0.28) instead
                  // of right/bottom so phantom landing coords and static slot
                  // coords are computed by the exact same arithmetic and land
                  // on the same pixel.
                  left: squarePx * 0.27,
                  top: squarePx * 0.28,
                  filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.35))',
                  pointerEvents: 'none',
                  animation: mergeFadeInSlots && mergeFadeInSlots.includes(1)
                    ? 'piece-merge-slot-fade-in 480ms ease-out both'
                    : undefined,
                }}
              >
                {renderPiece(keys[1], pairSize)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
