import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { PlayerCard, type MicState } from '../components/PlayerCard';
import { VoiceControls } from '../components/VoiceControls';
import { takeLobbyHandoff } from '../store/lobbyHandoff';
import type { PeerSession } from '../lib/peer';
import { useIdentityStore } from '../store/identityStore';
import { getTimeControl } from '../lib/timeControls';
import { signMove, verifyMove, signRecord } from '../lib/gameRecord';
import type {
  Color,
  GameEndReason,
  GameOutcome,
  GameRecord,
  PlayerInfo,
  SignedMove,
  WireMessage,
} from '../lib/types';
import { eloDelta, newRating } from '../lib/elo';
import { appendSummary, loadSummaries, saveGameRecord } from '../lib/storage';
import { getMicStream, setStreamMuted, stopStream } from '../lib/voice';
import { useSpeaking } from '../lib/voiceMeter';

type EndState = {
  outcome: GameOutcome;
  reason: GameEndReason;
};

export function Game() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { identity, rating, avatar, setRating } = useIdentityStore();

  // Pull live session handed off by Home (or bounce home if missing)
  const handoffRef = useRef(gameId ? takeLobbyHandoff(gameId) : null);
  const handoff = handoffRef.current;

  useEffect(() => {
    if (!handoff || !identity) {
      navigate('/');
    }
  }, [handoff, identity, navigate]);

  if (!handoff || !identity || !gameId) {
    return <div className="page-narrow muted">Returning to lobby…</div>;
  }

  const tc = getTimeControl(handoff.timeControlId)!;

  const [chess] = useState(() => new Chess());
  const [fen, setFen] = useState(chess.fen());
  const [whiteMs, setWhiteMs] = useState(tc.initialMs);
  const [blackMs, setBlackMs] = useState(tc.initialMs);
  const [moves, setMoves] = useState<SignedMove[]>([]);
  const [end, setEnd] = useState<EndState | null>(null);
  const [endHandled, setEndHandled] = useState(false);
  const [drawOfferedByMe, setDrawOfferedByMe] = useState(false);
  const [drawOfferedByOpp, setDrawOfferedByOpp] = useState(false);
  const [chatLog, setChatLog] = useState<{ from: 'me' | 'opp'; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [partnerReady, setPartnerReady] = useState(false);
  const [_, forceTick] = useState(0); // tick for clock animation

  // Voice state
  const [voiceActive, setVoiceActive] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  // Opponent profile + voice telemetry (received over the data channel)
  const [oppAvatar, setOppAvatar] = useState<string | null>(null);
  const [oppVoice, setOppVoice] = useState<{ voiceActive: boolean; micOn: boolean }>({
    voiceActive: false,
    micOn: false,
  });

  // Live "talking" detection from each side's audio stream
  const iAmTalking = useSpeaking(localStream);
  const oppIsTalking = useSpeaking(remoteStream);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const myColor: Color = handoff.iAmWhite ? 'white' : 'black';
  const oppColor: Color = handoff.iAmWhite ? 'black' : 'white';

  const me: PlayerInfo = {
    publicKeyHex: identity.publicKeyHex,
    handle: identity.handle,
    rating,
  };
  const opp: PlayerInfo = {
    publicKeyHex: handoff.partnerPubKey,
    handle: handoff.partnerHandle,
    rating: handoff.partnerRating,
  };

  // ----------------------------------------------------------------------
  // Wire up peer session for *this* page (handoff.session was started by Home)
  // ----------------------------------------------------------------------
  const sessionRef = useRef<PeerSession>(handoff.session);
  const startedAtRef = useRef<number>(Date.now());
  const lastTickRef = useRef<number>(performance.now());

  useEffect(() => {
    const session = sessionRef.current;

    const handleMessage = async (msg: WireMessage) => {
      if (msg.type === 'hello') {
        // exchange hellos
        return;
      }
      if (msg.type === 'ready') {
        setPartnerReady(true);
        return;
      }
      if (msg.type === 'move') {
        await applyRemoteMove(msg.move);
        return;
      }
      if (msg.type === 'resign') {
        finalize({ outcome: myColor, reason: 'resignation' });
        return;
      }
      if (msg.type === 'draw-offer') {
        setDrawOfferedByOpp(true);
        return;
      }
      if (msg.type === 'draw-accept') {
        finalize({ outcome: 'draw', reason: 'draw-agreed' });
        return;
      }
      if (msg.type === 'draw-decline') {
        setDrawOfferedByMe(false);
        return;
      }
      if (msg.type === 'timeout-claim') {
        // Opponent claims someone timed out — verify against our clocks
        const loser = msg.loserColor;
        const ms = loser === 'white' ? whiteMs : blackMs;
        if (ms <= 0) {
          finalize({ outcome: loser === 'white' ? 'black' : 'white', reason: 'timeout' });
        }
        return;
      }
      if (msg.type === 'chat') {
        setChatLog((l) => [...l, { from: 'opp', text: msg.text }]);
        return;
      }
      if (msg.type === 'avatar') {
        setOppAvatar(msg.dataUrl);
        return;
      }
      if (msg.type === 'voice-state') {
        setOppVoice({ voiceActive: msg.voiceActive, micOn: msg.micOn });
        return;
      }
    };

    const handleIncomingCall = async (call: any) => {
      // Auto-accept voice with our local mic if we have one ready
      try {
        let stream = localStreamRef.current;
        if (!stream) {
          stream = await getMicStream();
          setLocalStream(stream);
        }
        session.answerCall(call, stream);
        setVoiceActive(true);
        // poll the session.remoteStream → state
        const id = setInterval(() => {
          if (session.remoteStream && session.remoteStream !== remoteStream) {
            setRemoteStream(session.remoteStream);
          }
        }, 200);
        call.on('close', () => {
          clearInterval(id);
          setRemoteStream(null);
          setVoiceActive(false);
        });
      } catch (e) {
        console.warn('failed to accept voice', e);
      }
    };

    const sendIntro = () => {
      session.send({
        type: 'hello',
        publicKeyHex: identity.publicKeyHex,
        handle: identity.handle,
        rating,
      });
      if (avatar) {
        session.send({ type: 'avatar', dataUrl: avatar });
      }
      session.send({ type: 'voice-state', voiceActive, micOn });
      session.send({ type: 'ready' });
      setPartnerReady(true);
    };

    session.setEvents({
      ...session.events,
      onConnect: () => sendIntro(),
      onMessage: handleMessage,
      onIncomingCall: handleIncomingCall,
      onClose: () => {
        if (!end) finalize({ outcome: myColor, reason: 'disconnect' });
      },
    });

    // Matchmaking pairs two open peers but doesn't link them. White initiates
    // the data connection; black waits for the incoming 'connection' event
    // (handled in PeerSession's constructor). Friend-flow already has a conn
    // open from Home/Join — sendIntro directly in that case.
    if (session.conn?.open) {
      sendIntro();
    } else if (handoff.iAmWhite && !session.conn) {
      session.connectTo(handoff.partnerPeerId);
    }

    return () => {
      // teardown handled when leaving the page
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Page unmount cleanup
  useEffect(() => {
    return () => {
      try {
        sessionRef.current.destroy();
      } catch {}
      stopStream(localStreamRef.current);
    };
  }, []);

  // ----------------------------------------------------------------------
  // Clock ticking
  // ----------------------------------------------------------------------
  useEffect(() => {
    if (end) return;
    let raf = 0;
    const loop = (t: number) => {
      const dt = t - lastTickRef.current;
      lastTickRef.current = t;
      // Only tick after first move has been made (chess.history > 0)
      // and tick the side to move
      if (chess.history().length > 0) {
        if (chess.turn() === 'w') {
          setWhiteMs((ms) => Math.max(0, ms - dt));
        } else {
          setBlackMs((ms) => Math.max(0, ms - dt));
        }
      }
      forceTick((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end]);

  // Detect timeouts
  useEffect(() => {
    if (end) return;
    if (whiteMs <= 0) claimTimeout('white');
    else if (blackMs <= 0) claimTimeout('black');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteMs, blackMs]);

  const claimTimeout = (loser: Color) => {
    sessionRef.current.send({ type: 'timeout-claim', loserColor: loser });
    finalize({ outcome: loser === 'white' ? 'black' : 'white', reason: 'timeout' });
  };

  // ----------------------------------------------------------------------
  // Move handling
  // ----------------------------------------------------------------------
  const isMyTurn = () => (chess.turn() === 'w') === handoff.iAmWhite;

  const applyLocalMove = async (from: string, to: string, promotion?: string): Promise<boolean> => {
    if (end) return false;
    if (!isMyTurn()) return false;
    const beforeTurn = chess.turn();
    let move;
    try {
      move = chess.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      return false;
    }
    if (!move) return false;

    // For per-move mode: every move resets both clocks to perMoveMs so the next
    // mover gets a fresh budget. Otherwise apply Fischer increment to the mover.
    if (tc.perMoveMs != null) {
      setWhiteMs(tc.perMoveMs);
      setBlackMs(tc.perMoveMs);
    } else if (beforeTurn === 'w') {
      setWhiteMs((ms) => ms + tc.incrementMs);
    } else {
      setBlackMs((ms) => ms + tc.incrementMs);
    }

    const ply = chess.history().length;
    const wMs = tc.perMoveMs != null
      ? tc.perMoveMs
      : (beforeTurn === 'w' ? whiteMs + tc.incrementMs : whiteMs);
    const bMs = tc.perMoveMs != null
      ? tc.perMoveMs
      : (beforeTurn === 'b' ? blackMs + tc.incrementMs : blackMs);
    const uci = move.from + move.to + (move.promotion ?? '');
    const signed = await signMove(identity, gameId!, uci, chess.fen(), ply, wMs, bMs);
    setMoves((m) => [...m, signed]);
    setFen(chess.fen());
    sessionRef.current.send({ type: 'move', move: signed });
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);

    checkBoardEnd();
    return true;
  };

  const applyRemoteMove = async (move: SignedMove) => {
    if (end) return;
    // Verify signature
    const ok = await verifyMove(opp.publicKeyHex, gameId!, move);
    if (!ok) {
      console.warn('signature failed for move', move);
      return;
    }
    if (move.ply !== chess.history().length + 1) {
      console.warn('out of order move', move.ply, 'expected', chess.history().length + 1);
      return;
    }
    const beforeTurn = chess.turn();
    const from = move.uci.slice(0, 2);
    const to = move.uci.slice(2, 4);
    const promotion = move.uci.length >= 5 ? move.uci[4] : undefined;
    let r;
    try {
      r = chess.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      console.warn('illegal remote move', move);
      return;
    }
    if (!r) return;
    setFen(chess.fen());
    setMoves((m) => [...m, move]);
    if (tc.perMoveMs != null) {
      // Per-move mode: next mover always starts with a fresh budget.
      setWhiteMs(tc.perMoveMs);
      setBlackMs(tc.perMoveMs);
    } else {
      // Trust the opponent's reported clocks, since they're signed
      setWhiteMs(move.whiteClockMs);
      setBlackMs(move.blackClockMs);
    }
    // re-add increment for mover (already in their reported clock above)
    void beforeTurn;
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);

    checkBoardEnd();
  };

  const checkBoardEnd = () => {
    if (chess.isCheckmate()) {
      const loser: Color = chess.turn() === 'w' ? 'white' : 'black';
      finalize({ outcome: loser === 'white' ? 'black' : 'white', reason: 'checkmate' });
      return;
    }
    if (chess.isStalemate()) {
      finalize({ outcome: 'draw', reason: 'stalemate' });
      return;
    }
    if (chess.isThreefoldRepetition()) {
      finalize({ outcome: 'draw', reason: 'threefold' });
      return;
    }
    if (chess.isInsufficientMaterial()) {
      finalize({ outcome: 'draw', reason: 'insufficient' });
      return;
    }
    if (chess.isDraw()) {
      finalize({ outcome: 'draw', reason: 'fifty-move' });
      return;
    }
  };

  // ----------------------------------------------------------------------
  // End of game
  // ----------------------------------------------------------------------
  const finalize = async (state: EndState) => {
    if (endHandled) return;
    setEndHandled(true);
    setEnd(state);

    const myResult: 1 | 0.5 | 0 =
      state.outcome === 'draw' ? 0.5 : state.outcome === myColor ? 1 : 0;
    const summaries = await loadSummaries();
    const gamesPlayed = summaries.length;
    const before = rating;
    const after = newRating(before, opp.rating, myResult, gamesPlayed);
    await setRating(after);

    // Save signed game record
    const partial: Omit<GameRecord, 'whiteSignature' | 'blackSignature'> = {
      gameId: gameId!,
      timeControlId: tc.id,
      white: handoff.iAmWhite ? me : opp,
      black: handoff.iAmWhite ? opp : me,
      startedAt: startedAtRef.current,
      endedAt: Date.now(),
      outcome: state.outcome,
      reason: state.reason,
      moves,
    };
    const mySig = await signRecord(identity, partial);
    const record: GameRecord = {
      ...partial,
      whiteSignature: handoff.iAmWhite ? mySig : '',
      blackSignature: handoff.iAmWhite ? '' : mySig,
    };
    await saveGameRecord(record);
    await appendSummary({
      gameId: gameId!,
      timeControlId: tc.id,
      opponentHandle: opp.handle,
      opponentPubKey: opp.publicKeyHex,
      myColor,
      outcome: state.outcome,
      reason: state.reason,
      ratingBefore: before,
      ratingAfter: after,
      endedAt: Date.now(),
    });
  };

  // ----------------------------------------------------------------------
  // Voice
  // ----------------------------------------------------------------------
  const startVoice = async () => {
    try {
      const stream = await getMicStream();
      setLocalStream(stream);
      setMicOn(true);
      setSpeakerOn(true);
      const session = sessionRef.current;
      const call = session.startCall(handoff.partnerPeerId, stream);
      setVoiceActive(true);
      const id = setInterval(() => {
        if (session.remoteStream) setRemoteStream(session.remoteStream);
      }, 200);
      call.on('close', () => {
        clearInterval(id);
        setRemoteStream(null);
        setVoiceActive(false);
      });
    } catch (e) {
      console.warn('voice failed', e);
      alert('Could not access mic. Check permissions.');
    }
  };

  const toggleMic = () => {
    setMicOn((v) => {
      const next = !v;
      setStreamMuted(localStreamRef.current, !next);
      return next;
    });
  };
  const toggleSpeaker = () => {
    setSpeakerOn((v) => !v);
  };

  // Tell the opponent whenever our voice state changes (skip until conn is up;
  // the initial state ships as part of sendIntro on connect).
  useEffect(() => {
    const session = sessionRef.current;
    if (!session.conn?.open) return;
    try {
      session.send({ type: 'voice-state', voiceActive, micOn });
    } catch {}
  }, [voiceActive, micOn]);

  // Resolve mic states for both sides
  const myMicState: MicState = !voiceActive ? 'off' : !micOn ? 'muted' : iAmTalking ? 'talking' : 'idle';
  const oppMicState: MicState = !oppVoice.voiceActive
    ? 'off'
    : !oppVoice.micOn
      ? 'muted'
      : oppIsTalking
        ? 'talking'
        : 'idle';

  // ----------------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------------
  const isActiveSide = (c: Color): boolean => {
    if (end) return false;
    if (chess.history().length === 0) return false;
    return (chess.turn() === 'w') === (c === 'white');
  };

  const onPieceDrop = (sourceSquare: string, targetSquare: string, piece: string): boolean => {
    // react-chessboard expects sync return; fire-and-forget the async work.
    const promotion = piece && piece.length === 2 ? piece[1].toLowerCase() : undefined;
    void applyLocalMove(sourceSquare, targetSquare, promotion);
    return true;
  };

  const movesPgn = useMemo(() => {
    return chess.history().reduce<string[]>((acc, mv, i) => {
      if (i % 2 === 0) acc.push(`${i / 2 + 1}. ${mv}`);
      else acc[acc.length - 1] += ` ${mv}`;
      return acc;
    }, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen]);

  const myDelta = end
    ? eloDelta(rating, opp.rating, end.outcome === 'draw' ? 0.5 : end.outcome === myColor ? 1 : 0, 0)
    : 0;

  return (
    <div className="game-layout">
      <div className="board-column">
        <PlayerCard
          avatarDataUrl={oppAvatar}
          handle={opp.handle}
          rating={opp.rating}
          micState={oppMicState}
          ms={oppColor === 'white' ? whiteMs : blackMs}
          active={isActiveSide(oppColor)}
        />
        <div className="board-wrap">
          <Chessboard
            position={fen}
            onPieceDrop={onPieceDrop}
            boardOrientation={handoff.iAmWhite ? 'white' : 'black'}
            arePiecesDraggable={!end && isMyTurn()}
            customBoardStyle={{ borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}
            customDarkSquareStyle={{ backgroundColor: '#5d6c89' }}
            customLightSquareStyle={{ backgroundColor: '#dfe5f0' }}
          />
        </div>
        <PlayerCard
          avatarDataUrl={avatar}
          handle={`${me.handle} (you)`}
          rating={me.rating}
          micState={myMicState}
          ms={myColor === 'white' ? whiteMs : blackMs}
          active={isActiveSide(myColor)}
        />
      </div>

      <aside className="side-panel">
        <div className="game-meta">
          <div className="game-meta-title">{tc.label}</div>
          <div className="muted small">peer: {handoff.partnerPeerId.slice(-6)} {partnerReady ? '✓' : '…'}</div>
        </div>

        <VoiceControls
          remoteStream={remoteStream}
          micOn={micOn}
          speakerOn={speakerOn}
          onToggleMic={toggleMic}
          onToggleSpeaker={toggleSpeaker}
          onStartVoice={startVoice}
          voiceActive={voiceActive}
        />

        <div className="moves-panel">
          {movesPgn.length === 0 ? (
            <div className="muted small">No moves yet.</div>
          ) : (
            movesPgn.map((line, i) => (
              <div key={i} className="moves-line">{line}</div>
            ))
          )}
        </div>

        {!end && (
          <div className="action-row">
            <button
              className="secondary-btn"
              onClick={() => {
                sessionRef.current.send({ type: 'resign' });
                finalize({ outcome: oppColor, reason: 'resignation' });
              }}
            >
              Resign
            </button>
            {drawOfferedByOpp ? (
              <>
                <button
                  className="primary-btn"
                  onClick={() => {
                    sessionRef.current.send({ type: 'draw-accept' });
                    finalize({ outcome: 'draw', reason: 'draw-agreed' });
                  }}
                >
                  Accept draw
                </button>
                <button
                  className="secondary-btn"
                  onClick={() => {
                    sessionRef.current.send({ type: 'draw-decline' });
                    setDrawOfferedByOpp(false);
                  }}
                >
                  Decline
                </button>
              </>
            ) : (
              <button
                className="secondary-btn"
                disabled={drawOfferedByMe}
                onClick={() => {
                  sessionRef.current.send({ type: 'draw-offer' });
                  setDrawOfferedByMe(true);
                }}
              >
                {drawOfferedByMe ? 'Draw offered…' : 'Offer draw'}
              </button>
            )}
          </div>
        )}

        <div className="chat-panel">
          <div className="chat-log">
            {chatLog.map((m, i) => (
              <div key={i} className={`chat-msg ${m.from}`}>
                <span className="chat-from">{m.from === 'me' ? me.handle : opp.handle}:</span> {m.text}
              </div>
            ))}
          </div>
          <form
            className="chat-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!chatInput.trim()) return;
              sessionRef.current.send({ type: 'chat', text: chatInput });
              setChatLog((l) => [...l, { from: 'me', text: chatInput }]);
              setChatInput('');
            }}
          >
            <input
              className="text-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="say something…"
              maxLength={200}
            />
            <button className="secondary-btn" type="submit">Send</button>
          </form>
        </div>
      </aside>

      {end && (
        <div className="modal-overlay" onClick={() => navigate('/')}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              {end.outcome === 'draw'
                ? 'Draw'
                : end.outcome === myColor
                  ? 'You won'
                  : 'You lost'}
            </h2>
            <p className="muted">{labelFor(end.reason)}</p>
            <div className="rating-delta">
              {end.outcome === 'draw'
                ? '½ – ½'
                : end.outcome === myColor
                  ? '1 – 0'
                  : '0 – 1'}
              <span className={`delta ${myDelta >= 0 ? 'pos' : 'neg'}`}>
                {myDelta >= 0 ? '+' : ''}{myDelta}
              </span>
            </div>
            <button className="primary-btn" onClick={() => navigate('/')}>
              Back to lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function labelFor(reason: GameEndReason): string {
  switch (reason) {
    case 'checkmate': return 'by checkmate';
    case 'stalemate': return 'by stalemate';
    case 'threefold': return 'by threefold repetition';
    case 'insufficient': return 'insufficient material';
    case 'fifty-move': return 'fifty-move rule';
    case 'resignation': return 'by resignation';
    case 'timeout': return 'on time';
    case 'draw-agreed': return 'by agreement';
    case 'disconnect': return 'opponent disconnected';
  }
}
