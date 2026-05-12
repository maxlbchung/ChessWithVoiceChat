import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { PlayerCard, type VoiceState } from '../components/PlayerCard';
import { VoiceControls } from '../components/VoiceControls';
import { FinishAvatar, ResultAvatar } from '../components/EndScreenAvatars';
import { useSettingsStore } from '../store/settingsStore';
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
import { useVolume } from '../lib/voiceMeter';
import * as sfx from '../lib/sfx';

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
  const endRef = useRef<EndState | null>(null);
  const [endHandled, setEndHandled] = useState(false);
  const [drawOfferedByMe, setDrawOfferedByMe] = useState(false);
  const [drawOfferedByOpp, setDrawOfferedByOpp] = useState(false);
  const [chatLog, setChatLog] = useState<{ from: 'me' | 'opp'; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [partnerReady, setPartnerReady] = useState(false);
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connDetail, setConnDetail] = useState<string>('');
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  // Move-history viewer: viewPly counts plies from the start. When it equals
  // chess.history().length, we're "at the present" — input is allowed and
  // the board shows live state. Arrow keys scrub through past positions.
  const [viewPly, setViewPly] = useState(0);
  const viewPlyRef = useRef(0);
  useEffect(() => { viewPlyRef.current = viewPly; }, [viewPly]);
  const [disconnectMs, setDisconnectMs] = useState<number | null>(null);
  const disconnectDeadlineRef = useRef<number | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);
  const disconnectCountRef = useRef<number>(0);
  const [disconnectCount, setDisconnectCount] = useState(0);
  const FORFEIT_DELAY_MS = 5000;
  const MAX_GRACE_DISCONNECTS = 2; // 3rd disconnect → immediate forfeit
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

  // Live volume measurement from each side's audio stream (0..1)
  const myVolume = useVolume(localStream);
  const oppVolume = useVolume(remoteStream);

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

  // Privacy toggles — hide the real opponent handle/avatar when the user has
  // turned them off in settings. The real values still travel over the wire
  // and are persisted in the game record; this only affects display.
  const { showOpponentNames, showOpponentAvatars, chatEnabled } = useSettingsStore();
  const oppDisplayHandle = showOpponentNames ? opp.handle : 'Opponent';
  const oppDisplayAvatar = showOpponentAvatars ? oppAvatar : null;

  // ----------------------------------------------------------------------
  // Wire up peer session for *this* page (handoff.session was started by Home)
  // ----------------------------------------------------------------------
  const sessionRef = useRef<PeerSession>(handoff.session);
  const startedAtRef = useRef<number>(Date.now());
  const lastTickRef = useRef<number>(performance.now());

  const cancelDisconnectCountdown = () => {
    if (disconnectTimerRef.current != null) {
      clearInterval(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    disconnectDeadlineRef.current = null;
    setDisconnectMs(null);
  };

  const startDisconnectCountdown = () => {
    if (endRef.current) return;
    if (disconnectDeadlineRef.current != null) return; // already counting
    const deadline = Date.now() + FORFEIT_DELAY_MS;
    disconnectDeadlineRef.current = deadline;
    setDisconnectMs(FORFEIT_DELAY_MS);
    const tick = () => {
      if (endRef.current) {
        cancelDisconnectCountdown();
        return;
      }
      const remaining = (disconnectDeadlineRef.current ?? 0) - Date.now();
      if (remaining <= 0) {
        cancelDisconnectCountdown();
        if (!endRef.current) finalize({ outcome: myColor, reason: 'disconnect' });
        return;
      }
      setDisconnectMs(remaining);
    };
    disconnectTimerRef.current = window.setInterval(tick, 100);
  };

  // Keep endRef synced and cancel any in-flight forfeit countdown the moment
  // the match ends. The peer-session handlers were bound at mount with a
  // stale `end` closure, so they must read endRef.current instead.
  useEffect(() => {
    endRef.current = end;
    if (end) cancelDisconnectCountdown();
  }, [end]);

  useEffect(() => {
    const session = sessionRef.current;

    const handleMessage = async (msg: WireMessage) => {
      // Any message from the partner means the conn is alive — cancel pending forfeit.
      cancelDisconnectCountdown();
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
        sfx.playChat();
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
      console.log('[game] sendIntro: data channel open, sending hello/ready');
      setConnState('connected');
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
      onConnect: () => {
        cancelDisconnectCountdown();
        sendIntro();
      },
      onMessage: handleMessage,
      onIncomingCall: handleIncomingCall,
      onError: (err) => {
        console.error('[game] peer error', err);
        setConnState('failed');
        setConnDetail(err.message || String(err));
      },
      onClose: () => {
        if (endRef.current) return;
        const next = disconnectCountRef.current + 1;
        disconnectCountRef.current = next;
        setDisconnectCount(next);
        console.warn(`[game] peer/conn closed (disconnect #${next})`);
        setConnState('connecting');
        setConnDetail('opponent disconnected');
        if (next > MAX_GRACE_DISCONNECTS) {
          // No grace period — forfeit immediately on the 3rd+ disconnect.
          if (!endRef.current) finalize({ outcome: myColor, reason: 'disconnect' });
          return;
        }
        startDisconnectCountdown();
      },
    });

    // Matchmaking pairs two open peers but doesn't link them. White initiates
    // the data connection; black waits for the incoming 'connection' event
    // (handled in PeerSession's constructor). Friend-flow already has a conn
    // open from Home/Join — sendIntro directly in that case.
    if (session.conn?.open) {
      console.log('[game] handoff already has open conn → sendIntro');
      sendIntro();
    } else if (handoff.iAmWhite && !session.conn) {
      console.log('[game] white: initiating connectTo', handoff.partnerPeerId);
      setConnDetail('initiating');
      session.connectTo(handoff.partnerPeerId);
    } else {
      console.log('[game] black: waiting for incoming conn from', handoff.partnerPeerId);
      setConnDetail('waiting');
    }

    return () => {
      // teardown handled when leaving the page
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Page unmount cleanup. Also listen for 'pagehide': React's unmount doesn't
  // fire reliably when the tab is closed (vs SPA navigation), so without this
  // the opponent only sees iceConnectionState=disconnected and waits ~30s for
  // the browser to time out the connection before any close event reaches.
  useEffect(() => {
    const onPageHide = () => {
      try {
        sessionRef.current.destroy();
      } catch {}
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      if (disconnectTimerRef.current != null) {
        clearInterval(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
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
    if (viewPlyRef.current !== chess.history().length) return false;
    const beforeTurn = chess.turn();
    let move;
    try {
      move = chess.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      return false;
    }
    if (!move) return false;

    const castled = move.flags && (move.flags.includes('k') || move.flags.includes('q'));
    if (castled) sfx.playCastle();
    else if (move.captured) sfx.playCapture();
    else sfx.playMove();
    // Skip the check sound on checkmate — finalize will fire the airhorn or
    // (for the loser) leave the move/capture sound as the final cue.
    if (chess.isCheck() && !chess.isCheckmate()) sfx.playCheck();

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
    setViewPly(chess.history().length);
    sessionRef.current.send({ type: 'move', move: signed });
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);

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
    const wasAtPresent = viewPlyRef.current === chess.history().length;
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
    const castled = r.flags && (r.flags.includes('k') || r.flags.includes('q'));
    if (castled) sfx.playCastle();
    else if (r.captured) sfx.playCapture();
    else sfx.playMove();
    if (chess.isCheck() && !chess.isCheckmate()) sfx.playCheck();
    setFen(chess.fen());
    if (wasAtPresent) setViewPly(chess.history().length);
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
    setSelectedSquare(null);

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
    if (state.outcome === myColor) sfx.playWin();

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

  // Faint TV-static when either volume bar is pinned at max.
  useEffect(() => {
    const maxed = myVolume >= 0.99 || oppVolume >= 0.99;
    sfx.setStaticActive(maxed);
  }, [myVolume, oppVolume]);
  useEffect(() => () => sfx.setStaticActive(false), []);

  // Tell the opponent whenever our voice state changes (skip until conn is up;
  // the initial state ships as part of sendIntro on connect).
  useEffect(() => {
    const session = sessionRef.current;
    if (!session.conn?.open) return;
    try {
      session.send({ type: 'voice-state', voiceActive, micOn });
    } catch {}
  }, [voiceActive, micOn]);

  // Resolve voice indicator states for both sides
  const myVoiceState: VoiceState = !voiceActive ? 'off' : !micOn ? 'muted' : 'active';
  const oppVoiceState: VoiceState = !oppVoice.voiceActive
    ? 'off'
    : !oppVoice.micOn
      ? 'muted'
      : 'active';

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
    setSelectedSquare(null);
    return true;
  };

  const myPieceColor = handoff.iAmWhite ? 'w' : 'b';

  const legalTargets = useMemo<string[]>(() => {
    if (!selectedSquare) return [];
    try {
      const moves = chess.moves({ square: selectedSquare as any, verbose: true }) as Array<{ to: string }>;
      return moves.map((m) => m.to);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_e) {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSquare, fen]);

  const onSquareClick = (square: string) => {
    if (end) return;
    if (!atPresent) return;
    if (!isMyTurn()) {
      setSelectedSquare(null);
      return;
    }
    const piece = chess.get(square as any);
    // Already-selected square clicked → deselect
    if (selectedSquare === square) {
      setSelectedSquare(null);
      return;
    }
    // A piece is selected and the click is a legal target → move
    if (selectedSquare && legalTargets.includes(square)) {
      void applyLocalMove(selectedSquare, square);
      setSelectedSquare(null);
      return;
    }
    // Click on own piece → switch selection to it
    if (piece && piece.color === myPieceColor) {
      setSelectedSquare(square);
      return;
    }
    // Click anywhere else → clear selection
    setSelectedSquare(null);
  };

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (selectedSquare) {
      styles[selectedSquare] = {
        background:
          'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.45) 56%, rgba(0,0,0,0.45) 65%, transparent 66%)',
      };
      for (const t of legalTargets) {
        const isCapture = !!chess.get(t as any);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSquare, legalTargets, fen]);

  const atPresent = viewPly === chess.history().length;

  const displayFen = useMemo(() => {
    if (atPresent) return fen;
    const tmp = new Chess();
    const all = chess.history();
    for (let i = 0; i < viewPly; i++) tmp.move(all[i]);
    return tmp.fen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPly, fen, atPresent]);

  // Scrub one ply forward or backward. Plays piece SFX (forward or reversed)
  // when invoked from the keyboard; the Undo/Redo buttons pass playSfx=false
  // so they rely on the global button-click SFX instead.
  const navigateGameView = (forward: boolean, playSfx = true) => {
    setViewPly((p) => {
      const verbose = chess.history({ verbose: true }) as Array<{ captured?: string; san: string }>;
      const total = verbose.length;
      const next = forward ? Math.min(total, p + 1) : Math.max(0, p - 1);
      if (next === p) return p;
      if (playSfx) {
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
      }
      return next;
    });
  };

  const canUndoGame = viewPly > 0;
  const canRedoGame = viewPly < chess.history().length;

  // Arrow keys scrub history. Forward plays the move's normal SFX, backward
  // plays the reversed SFX. Each scrub cuts off any in-flight scrub SFX so
  // rapid arrows don't stack.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      navigateGameView(e.key === 'ArrowRight');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the present clears any stale piece selection.
  useEffect(() => {
    if (!atPresent) setSelectedSquare(null);
  }, [atPresent]);

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
      {disconnectMs != null && (
        <div className="disconnect-banner">
          Opponent disconnected — forfeit in {Math.ceil(disconnectMs / 1000)}s…
          {' '}
          <span className="small">
            (disconnect {disconnectCount} of {MAX_GRACE_DISCONNECTS + 1}
            {disconnectCount === MAX_GRACE_DISCONNECTS ? ' — next one is instant' : ''})
          </span>
        </div>
      )}
      <div className="board-column">
        <PlayerCard
          avatarDataUrl={oppDisplayAvatar}
          handle={oppDisplayHandle}
          rating={opp.rating}
          voiceState={oppVoiceState}
          volume={oppVolume}
          ms={oppColor === 'white' ? whiteMs : blackMs}
          active={isActiveSide(oppColor)}
        />
        <div className={`board-wrap ${!atPresent ? 'viewing-history' : ''}`}>
          <Chessboard
            position={displayFen}
            onPieceDrop={onPieceDrop}
            onSquareClick={onSquareClick}
            boardOrientation={handoff.iAmWhite ? 'white' : 'black'}
            arePiecesDraggable={!end && isMyTurn() && atPresent}
            customBoardStyle={{ borderRadius: 8 }}
            customDarkSquareStyle={{ backgroundColor: '#5d6c89' }}
            customLightSquareStyle={{ backgroundColor: '#dfe5f0' }}
            customSquareStyles={atPresent ? squareStyles : {}}
          />
          {end && (
            <div className="board-finish-overlay" key={`${end.outcome}-${end.reason}`}>
              <div className="finish-avatars">
                {end.outcome === 'draw' ? (
                  <>
                    <FinishAvatar src={avatar} handle={me.handle} />
                    <FinishAvatar src={oppDisplayAvatar} handle={oppDisplayHandle} />
                  </>
                ) : (
                  <FinishAvatar
                    src={end.outcome === myColor ? avatar : oppDisplayAvatar}
                    handle={end.outcome === myColor ? me.handle : oppDisplayHandle}
                  />
                )}
              </div>
              <div className="victor">
                {end.outcome === 'draw'
                  ? 'Draw'
                  : `${end.outcome === myColor ? me.handle : oppDisplayHandle} wins`}
              </div>
              <div className="reason">{labelFor(end.reason)}</div>
            </div>
          )}
        </div>
        <PlayerCard
          avatarDataUrl={avatar}
          handle={`${me.handle} (you)`}
          rating={me.rating}
          voiceState={myVoiceState}
          volume={myVolume}
          ms={myColor === 'white' ? whiteMs : blackMs}
          active={isActiveSide(myColor)}
        />
      </div>

      <aside className="side-panel">
        <div className="game-meta">
          <div className="game-meta-title">{tc.label}</div>
          <div className="muted small">
            peer: {handoff.partnerPeerId.slice(-6)} {partnerReady ? '✓' : '…'}
            {' · '}
            {connState === 'connected' && <span className="pos">connected</span>}
            {connState === 'connecting' && <span>connecting{connDetail ? ` (${connDetail})` : '…'}</span>}
            {connState === 'failed' && <span className="neg">failed: {connDetail}</span>}
          </div>
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

        <div className="history-nav-row">
          <button
            className="free-play-btn"
            onClick={() => navigateGameView(false, false)}
            type="button"
            disabled={!canUndoGame}
          >
            Undo
          </button>
          <button
            className="free-play-btn"
            onClick={() => navigateGameView(true, false)}
            type="button"
            disabled={!canRedoGame}
          >
            Redo
          </button>
        </div>

        <div className="moves-panel">
          {movesPgn.length === 0 ? (
            <div className="muted small">No moves yet.</div>
          ) : (
            movesPgn.map((line, i) => (
              <div key={i} className="moves-line">{line}</div>
            ))
          )}
        </div>

        {end && (
          <div className="game-result-strip">
            <div className="result-line">
              <span className="title-group">
                <ResultAvatar
                  src={
                    end.outcome === 'draw'
                      ? avatar
                      : end.outcome === myColor ? avatar : oppDisplayAvatar
                  }
                  handle={
                    end.outcome === 'draw'
                      ? me.handle
                      : end.outcome === myColor ? me.handle : oppDisplayHandle
                  }
                />
                <span className="title">
                  {end.outcome === 'draw'
                    ? 'Draw'
                    : end.outcome === myColor ? 'You won' : 'You lost'}
                </span>
              </span>
              <span className="reason">{labelFor(end.reason)}</span>
            </div>
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
        )}

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

        {chatEnabled && (
          <div className="chat-panel">
            <div className="chat-log">
              {chatLog.map((m, i) => (
                <div key={i} className={`chat-msg ${m.from}`}>
                  <span className="chat-from">{m.from === 'me' ? me.handle : oppDisplayHandle}:</span> {m.text}
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
                sfx.playChat();
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
              <button className="secondary-btn" data-no-sfx type="submit">Send</button>
            </form>
          </div>
        )}
      </aside>

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
