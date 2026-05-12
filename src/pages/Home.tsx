import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { TimeModeSelector } from '../components/TimeModeSelector';
import { TIME_CONTROLS, type TimeControl } from '../lib/timeControls';
const ACTIVITY_WINDOWS: Record<string, number> = Object.fromEntries(
  TIME_CONTROLS.map((tc) => [tc.id, tc.activityWindowMs]),
);
import { useIdentityStore } from '../store/identityStore';
import { Matchmaker, fetchQueueStats } from '../lib/matchmaking';
import { PeerSession, makePeerId } from '../lib/peer';
import { setLobbyHandoff } from '../store/lobbyHandoff';
import * as sfx from '../lib/sfx';

type Mode = 'idle' | 'searching' | 'hosting';

export function Home() {
  const { identity, rating, loaded, signUp } = useIdentityStore();
  const [handleInput, setHandleInput] = useState('');
  const [selected, setSelected] = useState<TimeControl | null>(TIME_CONTROLS[0] ?? null);
  const [mode, setMode] = useState<Mode>('idle');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [shareUrl, setShareUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [searchingCounts, setSearchingCounts] = useState<Record<string, number>>({});
  const [freeChess] = useState(() => new Chess());
  const [freeFen, setFreeFen] = useState(freeChess.fen());
  const [freeOrientation, setFreeOrientation] = useState<'white' | 'black'>('white');
  const [freeSelected, setFreeSelected] = useState<string | null>(null);
  // Ply we're currently viewing. Equals freeChess.history().length at present.
  // Free play lets the user make moves while in the past — doing so truncates
  // the truth back to viewPly and branches a new line.
  const [freeViewPly, setFreeViewPly] = useState(0);
  const navigate = useNavigate();

  // Chess instance reflecting the viewed position. At present this is the
  // mutable freeChess; in the past it's a freshly-replayed temporary.
  const previewChess = useMemo(() => {
    if (freeViewPly === freeChess.history().length) return freeChess;
    const tmp = new Chess();
    const all = freeChess.history();
    for (let i = 0; i < freeViewPly; i++) tmp.move(all[i]);
    return tmp;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeViewPly, freeFen]);

  const freeDisplayFen = previewChess.fen();
  const freeTurn: 'w' | 'b' = previewChess.turn();
  const canUndoFree = freeViewPly > 0;

  const freeLegalTargets = useMemo<string[]>(() => {
    if (!freeSelected) return [];
    try {
      const moves = previewChess.moves({ square: freeSelected as any, verbose: true }) as Array<{ to: string }>;
      return moves.map((m) => m.to);
    } catch {
      return [];
    }
  }, [freeSelected, previewChess]);

  const freeSquareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (freeSelected) {
      styles[freeSelected] = {
        background:
          'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
      };
      for (const t of freeLegalTargets) {
        const isCapture = !!previewChess.get(t as any);
        styles[t] = isCapture
          ? {
              background:
                'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
            }
          : {
              background:
                'radial-gradient(circle, rgba(0,0,0,0.35) 22%, transparent 24%)',
            };
      }
    }
    return styles;
  }, [freeSelected, freeLegalTargets, previewChess]);

  const applyFreeMove = (from: string, to: string, promotion?: string): boolean => {
    // Moving while in the past branches the history: rewind truth to viewPly,
    // then apply the new move. The viewed position becomes the new present.
    while (freeChess.history().length > freeViewPly) freeChess.undo();
    let m;
    try {
      m = freeChess.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      return false;
    }
    if (!m) return false;
    if (m.captured) sfx.playCapture(); else sfx.playMove();
    if (freeChess.isCheckmate()) sfx.playWin();
    else if (freeChess.isCheck()) sfx.playCheck();
    setFreeFen(freeChess.fen());
    setFreeViewPly(freeChess.history().length);
    setFreeSelected(null);
    return true;
  };

  const handleFreeDrop = (sourceSquare: string, targetSquare: string, piece: string): boolean => {
    const promotion = piece && piece.length === 2 ? piece[1].toLowerCase() : undefined;
    return applyFreeMove(sourceSquare, targetSquare, promotion);
  };

  const onFreeSquareClick = (square: string) => {
    const piece = previewChess.get(square as any);
    if (freeSelected === square) {
      setFreeSelected(null);
      return;
    }
    if (freeSelected && freeLegalTargets.includes(square)) {
      applyFreeMove(freeSelected, square);
      return;
    }
    if (piece && piece.color === previewChess.turn()) {
      setFreeSelected(square);
      return;
    }
    setFreeSelected(null);
  };

  const resetFreePlay = () => {
    freeChess.reset();
    setFreeFen(freeChess.fen());
    setFreeViewPly(0);
    setFreeSelected(null);
  };

  const undoFreePlay = () => navigateFreeView(false);

  const flipFreePlay = () => {
    setFreeOrientation((o) => (o === 'white' ? 'black' : 'white'));
  };

  // Scrub one ply forward or backward, playing the appropriate SFX for the
  // move that we're crossing. Each scrub cuts off any in-flight scrub SFX so
  // rapid presses don't stack overlapping sounds.
  const navigateFreeView = (forward: boolean) => {
    setFreeViewPly((p) => {
      const verbose = freeChess.history({ verbose: true }) as Array<{ captured?: string; san: string }>;
      const total = verbose.length;
      const next = forward ? Math.min(total, p + 1) : Math.max(0, p - 1);
      if (next === p) return p;
      const m = verbose[forward ? p : next];
      if (m) {
        sfx.cutoffChessSfx();
        const isCheck = m.san.includes('+') || m.san.includes('#');
        if (forward) {
          if (m.captured) sfx.playCapture(); else sfx.playMove();
          if (isCheck) sfx.playCheck();
        } else {
          if (m.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
          if (isCheck) sfx.playCheckReversed();
        }
      }
      return next;
    });
  };

  const canRedoFree = freeViewPly < freeChess.history().length;

  // Arrow keys scrub free-play history. Skip when an input/textarea is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      navigateFreeView(e.key === 'ArrowRight');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear any stale selection when the viewed ply changes via arrow keys.
  useEffect(() => {
    setFreeSelected(null);
  }, [freeViewPly]);

  // Poll queue stats so the home page shows how many people are searching per mode.
  useEffect(() => {
    if (!identity) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async () => {
      try {
        const counts = await fetchQueueStats(ACTIVITY_WINDOWS, ctrl.signal);
        if (!stopped) setSearchingCounts(counts);
      } catch {
        // network blip — keep last known counts
      }
      if (!stopped) timer = setTimeout(tick, 5000);
    };
    tick();

    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [identity]);

  // Quickplay: matchmaker queue
  useEffect(() => {
    if (mode !== 'searching') return;
    if (!identity || !selected) return;

    let cancelled = false;
    let handedOff = false;
    const matcher = new Matchmaker();
    let session: PeerSession | null = null;

    const myPeerId = makePeerId();
    setStatusMsg(`Looking for ${selected.label}…`);

    session = new PeerSession(myPeerId, {
      onOpen: async () => {
        if (cancelled) return;
        const result = await matcher.start({
          identity,
          peerId: myPeerId,
          rating,
          timeControlId: selected.id,
        });
        if (cancelled) return;
        if (result.status !== 'matched') {
          setMode('idle');
          setStatusMsg('Search cancelled.');
          return;
        }
        handedOff = true;
        setLobbyHandoff({
          gameId: result.gameId,
          session: session!,
          myPeerId,
          partnerPeerId: result.partnerPeerId,
          partnerPubKey: result.partnerPubKey,
          partnerHandle: result.partnerHandle,
          partnerRating: result.partnerRating,
          iAmWhite: result.iAmWhite,
          timeControlId: selected.id,
        });
        navigate(`/play/${result.gameId}`);
      },
      onError: (err) => {
        console.error('peer error', err);
        if (cancelled) return;
        setStatusMsg(`Connection error: ${err.message}`);
        setMode('idle');
      },
    });

    return () => {
      cancelled = true;
      matcher.cancel();
      if (!handedOff) {
        try { session?.destroy(); } catch {}
      }
    };
  }, [mode, identity, selected, rating, navigate]);

  // Play a friend: host an open peer + shareable join link
  useEffect(() => {
    if (mode !== 'hosting') return;
    if (!identity || !selected) return;

    let cancelled = false;
    let handedOff = false;
    let joinerPeerId: string | null = null;
    const myPeerId = makePeerId();

    setShareUrl('');
    setStatusMsg('Creating lobby…');

    const session: PeerSession = new PeerSession(myPeerId, {
      onOpen: (id) => {
        if (cancelled) return;
        setShareUrl(`${location.origin}${location.pathname}#/join/${id}`);
        setStatusMsg('Share the link with your opponent.');
      },
      onConnect: (conn) => {
        if (cancelled) return;
        joinerPeerId = conn.peer;
        setStatusMsg('Opponent connected, syncing…');
      },
      onMessage: (msg) => {
        if (cancelled) return;
        if (msg.type !== 'hello') return;
        if (!joinerPeerId) return;
        const gameId = randomGameId();
        const hostIsWhite = Math.random() < 0.5;
        session.send({
          type: 'lobby-confirm',
          gameId,
          iAmWhite: !hostIsWhite,
          timeControlId: selected.id,
          hostPubKey: identity.publicKeyHex,
          hostHandle: identity.handle,
          hostRating: rating,
        });
        handedOff = true;
        setLobbyHandoff({
          gameId,
          session,
          myPeerId,
          partnerPeerId: joinerPeerId,
          partnerPubKey: msg.publicKeyHex,
          partnerHandle: msg.handle,
          partnerRating: msg.rating,
          iAmWhite: hostIsWhite,
          timeControlId: selected.id,
        });
        navigate(`/play/${gameId}`);
      },
      onError: (err) => {
        if (cancelled) return;
        setStatusMsg(`Connection error: ${err.message}`);
        setMode('idle');
      },
    });

    return () => {
      cancelled = true;
      if (!handedOff) {
        try { session.destroy(); } catch {}
      }
    };
  }, [mode, identity, selected, rating, navigate]);

  const cancel = () => {
    setMode('idle');
    setStatusMsg('');
    setShareUrl('');
    setCopied(false);
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; the input is still selectable manually
    }
  };

  if (!loaded) {
    return <div className="page-narrow muted">Loading…</div>;
  }

  if (!identity) {
    return (
      <div className="page-narrow">
        <h1 className="page-title">Welcome</h1>
        <p className="muted">
          Pick a handle. We'll generate a keypair in your browser — your identity stays local. No
          server account, no email, no password.
        </p>
        <form
          className="signup-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (handleInput.trim()) signUp(handleInput.trim());
          }}
        >
          <input
            className="text-input"
            placeholder="your handle"
            value={handleInput}
            onChange={(e) => setHandleInput(e.target.value)}
            maxLength={24}
          />
          <button className="primary-btn" type="submit" disabled={!handleInput.trim()}>
            Create identity
          </button>
        </form>
      </div>
    );
  }

  const busy = mode !== 'idle';

  return (
    <div className="page">
      <div className="hero">
        <h1 className="page-title">Find a game</h1>
        <p className="muted">
          Pick a time control — moves go peer-to-peer, voice chat rides along, and your rating
          updates locally from signed game records.
        </p>
      </div>

      <div className="home-play-area">
        <div className="free-play-board">
          <div className="free-play-header">
            <div className="free-play-turn" aria-label={`${freeTurn === 'w' ? 'White' : 'Black'} to move`}>
              <span className={`turn-swatch ${freeTurn === 'w' ? 'white' : 'black'}`} aria-hidden />
              <span className="turn-label">{freeTurn === 'w' ? 'White' : 'Black'} to move</span>
            </div>
            <div className="free-play-header-actions">
              <button
                className="free-play-btn"
                onClick={undoFreePlay}
                type="button"
                disabled={!canUndoFree}
              >
                Undo
              </button>
              <button
                className="free-play-btn"
                onClick={() => navigateFreeView(true)}
                type="button"
                disabled={!canRedoFree}
              >
                Redo
              </button>
              <button className="free-play-btn" onClick={flipFreePlay} type="button">Flip</button>
              <button className="free-play-btn" onClick={resetFreePlay} type="button">Reset</button>
            </div>
          </div>
          <div className="free-play-board-wrap">
            <Chessboard
              position={freeDisplayFen}
              onPieceDrop={handleFreeDrop}
              onSquareClick={onFreeSquareClick}
              boardOrientation={freeOrientation}
              customBoardStyle={{ borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}
              customDarkSquareStyle={{ backgroundColor: '#5d6c89' }}
              customLightSquareStyle={{ backgroundColor: '#dfe5f0' }}
              customSquareStyles={freeSquareStyles}
            />
          </div>
        </div>

        <div className="home-controls">
          <TimeModeSelector
            selectedId={selected?.id ?? null}
            onSelect={(tc) => setSelected(tc)}
            disabled={busy}
            activityCounts={searchingCounts}
          />

          {!busy && (
            <div className="play-row">
              <button
                className="primary-btn big"
                data-no-sfx
                disabled={!selected}
                onClick={() => { sfx.playQueue(); setMode('searching'); }}
              >
                Quickplay {selected?.label}
              </button>
              <button
                className="secondary-btn big"
                data-no-sfx
                disabled={!selected}
                onClick={() => { sfx.playQueue(); setMode('hosting'); }}
              >
                Play a friend
              </button>
            </div>
          )}

          {mode === 'searching' && (
            <div className="play-row">
              <button className="secondary-btn big" onClick={cancel}>Cancel search</button>
              {statusMsg && <div className="status-msg">{statusMsg}</div>}
            </div>
          )}

          {mode === 'hosting' && (
            <div className="lobby-panel">
              {shareUrl ? (
                <>
                  <div className="lobby-label">Send this link to your friend:</div>
                  <div className="share-row">
                    <input
                      className="text-input"
                      readOnly
                      value={shareUrl}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button className="secondary-btn" onClick={copyShareUrl}>
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="muted">Spinning up lobby…</div>
              )}
              <div className="play-row">
                <button className="secondary-btn big" onClick={cancel}>Cancel lobby</button>
                {statusMsg && <div className="status-msg">{statusMsg}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function randomGameId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
