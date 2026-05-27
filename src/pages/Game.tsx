import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { MergeBoard } from '../components/MergeBoard';
import { PromotionPicker, type PromotionLetter } from '../components/PromotionPicker';
import type { Piece as MergePiece } from '../lib/mergeChess';
import { PlayerCard, type VoiceState } from '../components/PlayerCard';
import { VoiceControls } from '../components/VoiceControls';
import { FinishAvatar, ResultAvatar } from '../components/EndScreenAvatars';
import { StartOverlay } from '../components/StartOverlay';
import { useSettingsStore } from '../store/settingsStore';
import { takeLobbyHandoff } from '../store/lobbyHandoff';
import { useRematch, shouldKeepSessionForRematch } from '../lib/useRematch';
import type { PeerSession } from '../lib/peer';
import { useIdentityStore } from '../store/identityStore';
import { getTimeControl, lowTimeThresholdMs } from '../lib/timeControls';
import type {
  Color,
  GameEndReason,
  GameOutcome,
  GameRecord,
  Move,
  PlayerInfo,
  WireMessage,
} from '../lib/types';
import { eloDelta, newRating } from '../lib/elo';
import { appendSummary, loadAggregateStats, saveGameRecord } from '../lib/storage';
import { getMicStream, setStreamMuted, stopStream } from '../lib/voice';
import { useVolume } from '../lib/voiceMeter';
import * as sfx from '../lib/sfx';
import { renderChatText } from '../lib/linkify';
import { buildGameExport, downloadGameExport } from '../lib/gameExport';

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
  const lowMs = lowTimeThresholdMs(tc);

  const [chess] = useState(() => new Chess());
  const [fen, setFen] = useState(chess.fen());
  const [whiteMs, setWhiteMs] = useState(tc.initialMs);
  const [blackMs, setBlackMs] = useState(tc.initialMs);
  const [moves, setMoves] = useState<Move[]>([]);
  const [end, setEnd] = useState<EndState | null>(null);
  const endRef = useRef<EndState | null>(null);
  const [endHandled, setEndHandled] = useState(false);
  const [drawOfferedByMe, setDrawOfferedByMe] = useState(false);
  const [drawOfferedByOpp, setDrawOfferedByOpp] = useState(false);
  const [chatLog, setChatLog] = useState<{ from: 'me' | 'opp'; text: string }[]>([]);
  const [chatInput, setChatInput] = useState('');
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatLog]);
  const [partnerReady, setPartnerReady] = useState(false);
  // Start animation gates real game time: clock doesn't tick and moves are
  // blocked until the intro overlay fades out (~3.5s after both sides connect).
  const [gameStarted, setGameStarted] = useState(false);
  const gameStartedRef = useRef(false);
  useEffect(() => { gameStartedRef.current = gameStarted; }, [gameStarted]);
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connDetail, setConnDetail] = useState<string>('');
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  // Promotion picker state. Set when a pawn move reaches rank 1/8 so the
  // user can pick Q/R/B/N rather than getting an auto-queened move.
  const [pendingPromo, setPendingPromo] = useState<{ from: string; to: string; viaClick: boolean } | null>(null);
  const [slideAnim, setSlideAnim] = useState<{ moves: { from: string; to: string }[]; key: number } | null>(null);
  const [popAnim, setPopAnim] = useState<{ squares: string[]; key: number } | null>(null);
  // Auto-clear shortly after the animations finish so they can't outlive
  // themselves and replay on an unrelated re-render.
  useEffect(() => {
    if (!slideAnim) return;
    const t = window.setTimeout(() => setSlideAnim(null), 320);
    return () => clearTimeout(t);
  }, [slideAnim]);
  useEffect(() => {
    if (!popAnim) return;
    const t = window.setTimeout(() => setPopAnim(null), 420);
    return () => clearTimeout(t);
  }, [popAnim]);
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
    handle: identity.handle,
    rating,
  };
  const opp: PlayerInfo = {
    handle: handoff.partnerHandle,
    rating: handoff.partnerRating,
  };

  // Privacy toggles — hide the real opponent handle/avatar when the user has
  // turned them off in settings. The real values still travel over the wire
  // and are persisted in the game record; this only affects display.
  const { showOpponentNames, showOpponentAvatars, chatEnabled, animationsEnabled } = useSettingsStore();
  const oppDisplayHandle = showOpponentNames ? opp.handle : 'Opponent';
  const oppDisplayAvatar = showOpponentAvatars ? oppAvatar : null;

  // ----------------------------------------------------------------------
  // Wire up peer session for *this* page (handoff.session was started by Home)
  // ----------------------------------------------------------------------
  const sessionRef = useRef<PeerSession>(handoff.session);
  const startedAtRef = useRef<number>(Date.now());
  const lastTickRef = useRef<number>(performance.now());

  // Rematch handshake — also clears the cross-route "keep session" flag.
  const rematch = useRematch(handoff, sessionRef.current);

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
      if (rematch.handleRematchMessage(msg)) return;
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
        setConnState('connecting');
        setConnDetail('opponent disconnected');
        if (endRef.current) {
          console.warn('[game] peer/conn closed after game end');
          return;
        }
        const next = disconnectCountRef.current + 1;
        disconnectCountRef.current = next;
        setDisconnectCount(next);
        console.warn(`[game] peer/conn closed (disconnect #${next})`);
        if (next > MAX_GRACE_DISCONNECTS) {
          // No grace period — forfeit immediately on the 3rd+ disconnect.
          finalize({ outcome: myColor, reason: 'disconnect' });
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
      // On rematch we want the same PeerSession to carry over to the new
      // game route, so skip the destroy + stream stop in that case.
      if (!shouldKeepSessionForRematch()) {
        try {
          sessionRef.current.destroy();
        } catch {}
        stopStream(localStreamRef.current);
      }
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
      // Tick once the start animation has finished. White's clock starts
      // automatically at this point even before the first move is made.
      if (gameStartedRef.current) {
        if (chess.turn() === 'w') {
          setWhiteMs((ms) => {
            const next = Math.max(0, ms - dt);
            if (ms >= lowMs && next < lowMs && next > 0) sfx.playLowTimeWarning();
            return next;
          });
        } else {
          setBlackMs((ms) => {
            const next = Math.max(0, ms - dt);
            if (ms >= lowMs && next < lowMs && next > 0) sfx.playLowTimeWarning();
            return next;
          });
        }
      }
      forceTick((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end]);

  // Also catches the race where the opponent's first move lands before our
  // own StartOverlay onDone fires: the overlay's mount condition keys on
  // chess.history().length === 0, so an incoming move unmounts the overlay
  // mid-animation and its setTimeout never runs. Without `fen` in the deps,
  // this effect wouldn't re-run after the remote move and gameStarted would
  // be stuck false → board stays non-interactive forever.
  useEffect(() => {
    if (gameStarted) return;
    if (!partnerReady) return;
    if (chess.history().length > 0) setGameStarted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerReady, gameStarted, fen]);

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

  const applyLocalMove = async (from: string, to: string, promotion?: string, viaClick = false): Promise<boolean> => {
    if (end) return false;
    if (!gameStarted) return false;
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
    const signed: Move = {
      uci,
      fenAfter: chess.fen(),
      ply,
      whiteClockMs: wMs,
      blackClockMs: bMs,
    };
    setMoves((m) => [...m, signed]);
    setFen(chess.fen());
    setViewPly(chess.history().length);
    // Trigger slide/pop AFTER the fen/board state updates so they batch in
    // one render — otherwise the animations would mount briefly against the
    // stale pre-move board and show the wrong piece.
    if (viaClick && animationsEnabled) {
      const slides: { from: string; to: string }[] = [{ from, to }];
      if (move.flags?.includes('k')) {
        const rank = to[1];
        slides.push({ from: `h${rank}`, to: `f${rank}` });
      } else if (move.flags?.includes('q')) {
        const rank = to[1];
        slides.push({ from: `a${rank}`, to: `d${rank}` });
      }
      setSlideAnim({ moves: slides, key: Date.now() });
    }
    // Promotion always pops, even on drag — the transformed piece is new.
    if (animationsEnabled && move.flags?.includes('p')) {
      setPopAnim({ squares: [to], key: Date.now() });
    }
    sessionRef.current.send({ type: 'move', move: signed });
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);

    checkBoardEnd();
    return true;
  };

  const applyRemoteMove = async (move: Move) => {
    if (end) return;
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
    const { total: gamesPlayed } = await loadAggregateStats();
    const before = rating;
    const after = newRating(before, opp.rating, myResult, gamesPlayed);
    await setRating(after);

    const record: GameRecord = {
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
    await saveGameRecord(record);
    await appendSummary({
      gameId: gameId!,
      timeControlId: tc.id,
      opponentHandle: opp.handle,
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

  const isPromotionMove = (from: string, to: string): boolean => {
    const piece = chess.get(from as any);
    if (!piece || piece.type !== 'p') return false;
    const targetRank = parseInt(to[1], 10);
    return targetRank === 8 || targetRank === 1;
  };

  const onPieceDrop = (sourceSquare: string, targetSquare: string): boolean => {
    // MergeBoard returns boolean; the async apply runs fire-and-forget.
    if (isPromotionMove(sourceSquare, targetSquare)) {
      setPendingPromo({ from: sourceSquare, to: targetSquare, viaClick: false });
      setSelectedSquare(null);
      return true;
    }
    void applyLocalMove(sourceSquare, targetSquare);
    setSelectedSquare(null);
    return true;
  };

  const resolvePromotion = (letter: PromotionLetter) => {
    if (!pendingPromo) return;
    const valid = ['Q', 'R', 'B', 'N'].includes(letter) ? letter : 'Q';
    const { from, to, viaClick } = pendingPromo;
    setPendingPromo(null);
    void applyLocalMove(from, to, valid.toLowerCase(), viaClick);
  };

  // Drag start mirrors a click — sets the selected square so the legal-target
  // rings appear while dragging, just like the Merge/2.0/Cash boards do.
  const onDragStartSquare = (from: string) => {
    if (end || !gameStarted || !atPresent || !isMyTurn()) return;
    const piece = chess.get(from as any);
    if (!piece || piece.color !== myPieceColor) return;
    if (selectedSquare !== from) setSelectedSquare(from);
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
    if (!gameStarted) return;
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
      if (isPromotionMove(selectedSquare, square)) {
        setPendingPromo({ from: selectedSquare, to: square, viaClick: true });
        setSelectedSquare(null);
        return;
      }
      void applyLocalMove(selectedSquare, square, undefined, true);
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

  const atPresent = viewPly === chess.history().length;

  // The chess.js instance reflecting the position currently being viewed
  // (live at the present, replayed for past plies). All board queries that
  // power the UI — board snapshot, legal targets, capture detection —
  // should read from this instead of the mutable `chess`.
  const viewedChess = useMemo(() => {
    if (atPresent) return chess;
    const tmp = new Chess();
    const all = chess.history();
    for (let i = 0; i < viewPly; i++) tmp.move(all[i]);
    return tmp;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPly, fen, atPresent]);

  // Flat 64-square board for MergeBoard: idx 0 = a8 ... idx 63 = h1, matching
  // chess.js's row-major `board()` traversal.
  //
  // `fen` is in deps because `viewedChess` reuses the mutable `chess` instance
  // at the present ply — its reference never changes across moves, so React's
  // Object.is dep check would otherwise skip recomputation after every move.
  const displayBoard = useMemo<(MergePiece | null)[]>(() => {
    const out: (MergePiece | null)[] = [];
    for (const row of viewedChess.board()) {
      for (const cell of row) {
        if (cell == null) { out.push(null); continue; }
        const letter = cell.color === 'w' ? cell.type.toUpperCase() : cell.type;
        out.push({ color: cell.color, letter: letter as MergePiece['letter'] });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewedChess, fen]);

  // Legal targets in MergeBoard's shape — `isMerge` is unused for Normal play
  // (no merge / push interactions), so it's always false.
  const legalTargetsForBoard = useMemo(() => {
    if (!atPresent || !selectedSquare) return [];
    return legalTargets.map((to) => ({
      to,
      isCapture: !!chess.get(to as any),
      isMerge: false,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legalTargets, selectedSquare, atPresent, fen]);

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

  const lastMove = useMemo(() => {
    if (viewPly <= 0) return null;
    const v = chess.history({ verbose: true }) as Array<{ from: string; to: string }>;
    const m = v[viewPly - 1];
    if (!m) return null;
    return { from: m.from, to: m.to };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPly, fen]);

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
        <div className={`board-wrap ${!atPresent ? 'viewing-history' : ''}`}>
          <MergeBoard
            board={displayBoard}
            orientation={handoff.iAmWhite ? 'white' : 'black'}
            selectedSquare={atPresent ? selectedSquare : null}
            legalTargets={legalTargetsForBoard}
            onSquareClick={onSquareClick}
            onPieceDrop={onPieceDrop}
            onDragStartSquare={onDragStartSquare}
            interactive={!end && gameStarted && isMyTurn() && atPresent && !pendingPromo}
            draggable={!end && gameStarted && isMyTurn() && atPresent && !pendingPromo}
            lastMove={lastMove}
            slideMoves={slideAnim?.moves}
            slideKey={slideAnim?.key}
            popSquares={popAnim?.squares}
            popKey={popAnim?.key}
          />
          {pendingPromo && (
            <PromotionPicker
              square={pendingPromo.to}
              color={chess.turn()}
              orientation={handoff.iAmWhite ? 'white' : 'black'}
              onPick={resolvePromotion}
              onCancel={() => setPendingPromo(null)}
            />
          )}
          {partnerReady && !gameStarted && chess.history().length === 0 && (
            <StartOverlay
              whiteAvatar={handoff.iAmWhite ? avatar : oppDisplayAvatar}
              whiteHandle={handoff.iAmWhite ? me.handle : oppDisplayHandle}
              whiteRating={handoff.iAmWhite ? me.rating : opp.rating}
              blackAvatar={handoff.iAmWhite ? oppDisplayAvatar : avatar}
              blackHandle={handoff.iAmWhite ? oppDisplayHandle : me.handle}
              blackRating={handoff.iAmWhite ? opp.rating : me.rating}
              onDone={() => setGameStarted(true)}
            />
          )}
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
      </div>

      <aside className="side-panel">
        <PlayerCard
          avatarDataUrl={oppDisplayAvatar}
          handle={oppDisplayHandle}
          rating={opp.rating}
          voiceState={oppVoiceState}
          volume={oppVolume}
          ms={oppColor === 'white' ? whiteMs : blackMs}
          lowMs={lowMs}
          active={isActiveSide(oppColor)}
        />
        <PlayerCard
          avatarDataUrl={avatar}
          handle={`${me.handle} (you)`}
          rating={me.rating}
          voiceState={myVoiceState}
          volume={myVolume}
          ms={myColor === 'white' ? whiteMs : blackMs}
          lowMs={lowMs}
          active={isActiveSide(myColor)}
        />
        <div className="game-meta">
          <div className="game-meta-title">{tc.label}</div>
          <div className="muted small">
            peer: {handoff.partnerPeerId.slice(-6)} {partnerReady ? '✓' : '…'}
            {' · '}
            {connState === 'connected' && <span className="pos">connected</span>}
            {connState === 'connecting' && <span>connecting{connDetail ? ` (${connDetail})` : '…'}</span>}
            {connState === 'failed' && <span className="neg">failed: {connDetail}</span>}
          </div>
          <VoiceControls
            inline
            remoteStream={remoteStream}
            micOn={micOn}
            speakerOn={speakerOn}
            onToggleMic={toggleMic}
            onToggleSpeaker={toggleSpeaker}
            onStartVoice={startVoice}
            voiceActive={voiceActive}
          />
        </div>

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
          <button
            className="free-play-btn"
            type="button"
            disabled={moves.length === 0}
            onClick={() => {
              const exp = buildGameExport({
                variant: 'normal',
                gameId: gameId!,
                timeControlId: tc.id,
                white: handoff.iAmWhite ? me : opp,
                black: handoff.iAmWhite ? opp : me,
                startedAt: startedAtRef.current,
                endedAt: end ? Date.now() : null,
                outcome: end?.outcome ?? null,
                reason: end?.reason ?? null,
                moves,
              });
              downloadGameExport(exp);
            }}
            title="Download this game as JSON for the Review page"
          >
            Export
          </button>
          {!end && (
            <>
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
            </>
          )}
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
            <div className="game-result-info">
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
            </div>
            <div className="game-result-buttons">
              {rematch.rematchOfferedByOpp ? (
                <>
                  <button className="primary-btn" onClick={rematch.acceptRematch}>
                    Accept rematch
                  </button>
                  <button className="secondary-btn" onClick={rematch.declineRematch}>
                    Decline
                  </button>
                </>
              ) : (
                <button
                  className="primary-btn"
                  onClick={rematch.offerRematch}
                  disabled={rematch.rematchOfferedByMe}
                >
                  {rematch.rematchOfferedByMe ? 'Rematch offered…' : 'Rematch'}
                </button>
              )}
              <button className="secondary-btn" onClick={() => navigate('/')}>
                Back to lobby
              </button>
            </div>
          </div>
        )}

        {chatEnabled && (
          <div className="chat-panel">
            <div className="chat-log" ref={chatLogRef}>
              {chatLog.map((m, i) => (
                <div key={i} className={`chat-msg ${m.from}`}>
                  <span className="chat-from">{m.from === 'me' ? me.handle : oppDisplayHandle}:</span> {renderChatText(m.text)}
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
