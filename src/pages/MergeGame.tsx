import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayerCard, type VoiceState } from '../components/PlayerCard';
import { VoiceControls } from '../components/VoiceControls';
import { FinishAvatar, ResultAvatar } from '../components/EndScreenAvatars';
import { StartOverlay } from '../components/StartOverlay';
import { useSettingsStore } from '../store/settingsStore';
import { MergeBoard } from '../components/MergeBoard';
import { computeCaptures } from '../lib/captures';
import { PromotionPicker, type PromotionLetter } from '../components/PromotionPicker';
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
import {
  applyMove,
  initialState,
  isCheckmate,
  isFiftyMoveRule,
  isInCheck,
  isInsufficientMaterial,
  isStalemate,
  isThreefoldRepetition,
  legalMovesFrom,
  toFen,
  type GameState,
  type MoveResult,
  type Square,
} from '../lib/mergeChess';

type EndState = { outcome: GameOutcome; reason: GameEndReason };

export function MergeGame() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { identity, rating, avatar, setRating } = useIdentityStore();

  const handoffRef = useRef(gameId ? takeLobbyHandoff(gameId) : null);
  const handoff = handoffRef.current;

  useEffect(() => {
    if (!handoff || !identity) navigate('/');
  }, [handoff, identity, navigate]);

  if (!handoff || !identity || !gameId) {
    return <div className="page-narrow muted">Returning to lobby…</div>;
  }

  const tc = getTimeControl(handoff.timeControlId)!;
  const lowMs = lowTimeThresholdMs(tc);

  const [game, setGame] = useState<GameState>(() => initialState());
  // History snapshots aligned with the moves array: states[0] is the start
  // position; after N played moves, states[N] is the current position.
  // Replayable past positions live in here so the user can scrub without
  // re-running the engine.
  const [states, setStates] = useState<GameState[]>(() => [initialState()]);
  const [results, setResults] = useState<MoveResult[]>([]);
  // viewPly indexes into states / results. When viewPly === moves.length we
  // are "at the present" — only then is input allowed.
  const [viewPly, setViewPly] = useState(0);
  const viewPlyRef = useRef(0);
  useEffect(() => { viewPlyRef.current = viewPly; }, [viewPly]);
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
  // blocked until the intro overlay fades out (~3.5s after both connect).
  const [gameStarted, setGameStarted] = useState(false);
  const gameStartedRef = useRef(false);
  useEffect(() => { gameStartedRef.current = gameStarted; }, [gameStarted]);
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connDetail, setConnDetail] = useState<string>('');
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  // Set when a pawn move requires a promotion choice. While non-null the
  // promotion picker overlay is shown and board interaction is gated.
  const [pendingPromo, setPendingPromo] = useState<{ from: Square; to: Square; viaClick: boolean } | null>(null);
  const [slideAnim, setSlideAnim] = useState<{ moves: { from: Square; to: Square }[]; key: number } | null>(null);
  const [popAnim, setPopAnim] = useState<{ squares: Square[]; key: number } | null>(null);
  const [mergeAnim, setMergeAnim] = useState<{ from: Square; to: Square; fromLetter: string; toLetter: string; mergedLetter: string; key: number; releasePx?: { x: number; y: number } } | null>(null);
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
  useEffect(() => {
    if (!mergeAnim) return;
    const t = window.setTimeout(() => setMergeAnim(null), 520);
    return () => clearTimeout(t);
  }, [mergeAnim]);
  const [disconnectMs, setDisconnectMs] = useState<number | null>(null);
  const disconnectDeadlineRef = useRef<number | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);
  const disconnectCountRef = useRef<number>(0);
  const [disconnectCount, setDisconnectCount] = useState(0);
  const FORFEIT_DELAY_MS = 5000;
  const MAX_GRACE_DISCONNECTS = 2;
  const [_, forceTick] = useState(0);

  // Voice
  const [voiceActive, setVoiceActive] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const [oppAvatar, setOppAvatar] = useState<string | null>(null);
  const [oppVoice, setOppVoice] = useState<{ voiceActive: boolean; micOn: boolean }>({
    voiceActive: false,
    micOn: false,
  });

  const myVolume = useVolume(localStream);
  const oppVolume = useVolume(remoteStream);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const myColor: Color = handoff.iAmWhite ? 'white' : 'black';
  const oppColor: Color = handoff.iAmWhite ? 'black' : 'white';
  const myEngineColor: 'w' | 'b' = handoff.iAmWhite ? 'w' : 'b';

  const me: PlayerInfo = {
    handle: identity.handle,
    rating,
  };
  const opp: PlayerInfo = {
    handle: handoff.partnerHandle,
    rating: handoff.partnerRating,
  };

  const { showOpponentNames, showOpponentAvatars, chatEnabled, animationsEnabled } = useSettingsStore();
  const oppDisplayHandle = showOpponentNames ? opp.handle : 'Opponent';
  const oppDisplayAvatar = showOpponentAvatars ? oppAvatar : null;

  const sessionRef = useRef<PeerSession>(handoff.session);
  const startedAtRef = useRef<number>(Date.now());
  const lastTickRef = useRef<number>(performance.now());
  const rematch = useRematch(handoff, sessionRef.current);
  const gameRef = useRef<GameState>(game);
  useEffect(() => { gameRef.current = game; }, [game]);
  const movesCountRef = useRef(0);
  useEffect(() => { movesCountRef.current = moves.length; }, [moves.length]);

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
    if (disconnectDeadlineRef.current != null) return;
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
  // the match ends — peer-session handlers were bound at mount with a stale
  // `end` closure and must read endRef.current instead.
  useEffect(() => {
    endRef.current = end;
    if (end) cancelDisconnectCountdown();
  }, [end]);

  useEffect(() => {
    const session = sessionRef.current;

    const handleMessage = async (msg: WireMessage) => {
      cancelDisconnectCountdown();
      if (rematch.handleRematchMessage(msg)) return;
      if (msg.type === 'hello') return;
      if (msg.type === 'ready') { setPartnerReady(true); return; }
      if (msg.type === 'move') { await applyRemoteMove(msg.move); return; }
      if (msg.type === 'resign') { finalize({ outcome: myColor, reason: 'resignation' }); return; }
      if (msg.type === 'draw-offer') { setDrawOfferedByOpp(true); return; }
      if (msg.type === 'draw-accept') { finalize({ outcome: 'draw', reason: 'draw-agreed' }); return; }
      if (msg.type === 'draw-decline') { setDrawOfferedByMe(false); return; }
      if (msg.type === 'timeout-claim') {
        const loser = msg.loserColor;
        const ms = loser === 'white' ? whiteMs : blackMs;
        if (ms <= 0) finalize({ outcome: loser === 'white' ? 'black' : 'white', reason: 'timeout' });
        return;
      }
      if (msg.type === 'chat') {
        setChatLog((l) => [...l, { from: 'opp', text: msg.text }]);
        sfx.playChat();
        return;
      }
      if (msg.type === 'avatar') { setOppAvatar(msg.dataUrl); return; }
      if (msg.type === 'voice-state') { setOppVoice({ voiceActive: msg.voiceActive, micOn: msg.micOn }); return; }
    };

    const handleIncomingCall = async (call: any) => {
      try {
        let stream = localStreamRef.current;
        if (!stream) {
          stream = await getMicStream();
          setLocalStream(stream);
        }
        session.answerCall(call, stream);
        setVoiceActive(true);
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
      setConnState('connected');
      session.send({
        type: 'hello',
        handle: identity.handle,
        rating,
      });
      if (avatar) session.send({ type: 'avatar', dataUrl: avatar });
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
        setConnState('failed');
        setConnDetail(err.message || String(err));
      },
      onClose: () => {
        setConnState('connecting');
        setConnDetail('opponent disconnected');
        if (endRef.current) return;
        const next = disconnectCountRef.current + 1;
        disconnectCountRef.current = next;
        setDisconnectCount(next);
        if (next > MAX_GRACE_DISCONNECTS) {
          finalize({ outcome: myColor, reason: 'disconnect' });
          return;
        }
        startDisconnectCountdown();
      },
    });

    if (session.conn?.open) {
      sendIntro();
    } else if (handoff.iAmWhite && !session.conn) {
      setConnDetail('initiating');
      session.connectTo(handoff.partnerPeerId);
    } else {
      setConnDetail('waiting');
    }

    return () => { /* teardown on unmount handled below */ };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPageHide = () => { try { sessionRef.current.destroy(); } catch {} };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      if (disconnectTimerRef.current != null) {
        clearInterval(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      // Keep the session alive across rematch route changes.
      if (!shouldKeepSessionForRematch()) {
        try { sessionRef.current.destroy(); } catch {}
        stopStream(localStreamRef.current);
      }
    };
  }, []);

  // Clocks
  useEffect(() => {
    if (end) return;
    let raf = 0;
    const loop = (t: number) => {
      const dt = t - lastTickRef.current;
      lastTickRef.current = t;
      // Tick once the start animation has finished. White's clock starts
      // automatically at this point even before the first move is made.
      if (gameStartedRef.current) {
        const turn = gameRef.current.turn;
        if (turn === 'w') {
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

  // moves.length in the deps catches the race where the opponent's first
  // move lands before our StartOverlay onDone fires — without it, the
  // overlay unmounts mid-animation and gameStarted is stuck false forever.
  useEffect(() => {
    if (gameStarted) return;
    if (!partnerReady) return;
    if (movesCountRef.current > 0) setGameStarted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerReady, gameStarted, moves.length]);

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

  // --------------------------------------------------------------------
  // Move handling
  // --------------------------------------------------------------------
  const isMyTurn = () => game.turn === myEngineColor;

  const applyLocalMove = async (
    from: Square,
    to: Square,
    promotion?: 'Q' | 'R' | 'B' | 'N',
    viaClick = false,
    releasePx?: { x: number; y: number },
  ): Promise<boolean> => {
    if (end) return false;
    if (!gameStarted) return false;
    if (!isMyTurn()) return false;
    // Can only move at the present; scrubbing back disables input.
    if (viewPlyRef.current !== movesCountRef.current) return false;
    const beforeTurn = game.turn;
    let uci = from + to;
    if (promotion) uci += promotion.toLowerCase();
    // Snapshot the pre-move letters at from/to for the merge animation —
    // applyMove returns a fresh state, so we'd otherwise lose them.
    const moverLetterBefore = game.board[sqIdx(from)]?.letter;
    const receiverLetterBefore = game.board[sqIdx(to)]?.letter;
    const res = applyMove(game, uci);
    if (!res) return false;

    if (res.result.castled) sfx.playCastle();
    else if (res.result.merged) sfx.playMerge();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.check && !res.result.checkmate) sfx.playCheck();

    // Update clocks
    if (tc.perMoveMs != null) {
      setWhiteMs(tc.perMoveMs);
      setBlackMs(tc.perMoveMs);
    } else if (beforeTurn === 'w') {
      setWhiteMs((ms) => ms + tc.incrementMs);
    } else {
      setBlackMs((ms) => ms + tc.incrementMs);
    }

    const ply = moves.length + 1;
    const wMs = tc.perMoveMs != null
      ? tc.perMoveMs
      : (beforeTurn === 'w' ? whiteMs + tc.incrementMs : whiteMs);
    const bMs = tc.perMoveMs != null
      ? tc.perMoveMs
      : (beforeTurn === 'b' ? blackMs + tc.incrementMs : blackMs);

    const signed: Move = {
      uci,
      fenAfter: res.result.fenAfter,
      ply,
      whiteClockMs: wMs,
      blackClockMs: bMs,
    };
    setMoves((m) => [...m, signed]);
    setGame(res.state);
    setStates((s) => [...s, res.state]);
    setResults((r) => [...r, res.result]);
    setViewPly((p) => p + 1);
    // Merge overrides slide+pop with its own flow animation. Slide for a
    // regular click move; pop for promotions.
    const mergedLetterAfter = res.state.board[sqIdx(to)]?.letter;
    if (animationsEnabled && res.result.merged && moverLetterBefore && receiverLetterBefore && mergedLetterAfter) {
      setMergeAnim({
        from,
        to,
        fromLetter: moverLetterBefore,
        toLetter: receiverLetterBefore,
        mergedLetter: mergedLetterAfter,
        key: Date.now(),
        releasePx,
      });
    } else {
      if (viaClick && animationsEnabled) {
        setSlideAnim({ moves: [{ from, to }], key: Date.now() });
      }
      if (animationsEnabled && !!promotion) {
        setPopAnim({ squares: [to], key: Date.now() });
      }
    }
    sessionRef.current.send({ type: 'move', move: signed });
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);

    checkBoardEnd(res.state);
    return true;
  };

  const applyRemoteMove = async (move: Move) => {
    if (end) return;
    if (move.ply !== movesCountRef.current + 1) {
      console.warn('out of order move', move.ply, 'expected', movesCountRef.current + 1);
      return;
    }
    const res = applyMove(gameRef.current, move.uci);
    if (!res) {
      console.warn('illegal remote move', move);
      return;
    }
    // Defense in depth: ensure fenAfter matches
    if (res.result.fenAfter !== move.fenAfter) {
      console.warn('FEN mismatch from peer', { ours: res.result.fenAfter, theirs: move.fenAfter });
    }
    if (res.result.castled) sfx.playCastle();
    else if (res.result.merged) sfx.playMerge();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.check && !res.result.checkmate) sfx.playCheck();
    const wasAtPresent = viewPlyRef.current === movesCountRef.current;
    setGame(res.state);
    setStates((s) => [...s, res.state]);
    setResults((r) => [...r, res.result]);
    setMoves((m) => [...m, move]);
    // Auto-advance the viewer only if they were watching the live position;
    // otherwise leave them where they were so they can keep reviewing.
    if (wasAtPresent) setViewPly((p) => p + 1);
    if (tc.perMoveMs != null) {
      setWhiteMs(tc.perMoveMs);
      setBlackMs(tc.perMoveMs);
    } else {
      setWhiteMs(move.whiteClockMs);
      setBlackMs(move.blackClockMs);
    }
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);
    checkBoardEnd(res.state);
  };

  const checkBoardEnd = (s: GameState) => {
    if (isCheckmate(s)) {
      const loser = s.turn === 'w' ? 'white' : 'black';
      finalize({ outcome: loser === 'white' ? 'black' : 'white', reason: 'checkmate' });
      return;
    }
    if (isStalemate(s)) { finalize({ outcome: 'draw', reason: 'stalemate' }); return; }
    if (isThreefoldRepetition(s)) { finalize({ outcome: 'draw', reason: 'threefold' }); return; }
    if (isInsufficientMaterial(s)) { finalize({ outcome: 'draw', reason: 'insufficient' }); return; }
    if (isFiftyMoveRule(s)) { finalize({ outcome: 'draw', reason: 'fifty-move' }); return; }
  };

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

  // Voice
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
  const toggleSpeaker = () => setSpeakerOn((v) => !v);


  useEffect(() => {
    const session = sessionRef.current;
    if (!session.conn?.open) return;
    try { session.send({ type: 'voice-state', voiceActive, micOn }); } catch {}
  }, [voiceActive, micOn]);

  const myVoiceState: VoiceState = !voiceActive ? 'off' : !micOn ? 'muted' : 'active';
  const oppVoiceState: VoiceState = !oppVoice.voiceActive
    ? 'off'
    : !oppVoice.micOn
      ? 'muted'
      : 'active';

  // --------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------
  const viewedState: GameState = states[viewPly] ?? states[0];
  const atPresent = viewPly === moves.length;

  const captures = useMemo(
    () => computeCaptures(viewedState.board, initialState().board),
    [viewedState.board],
  );

  const legalTargets = useMemo(() => {
    if (!atPresent) return [];
    if (!selectedSquare) return [];
    return legalMovesFrom(game, selectedSquare).map((m) => ({
      to: m.to, isCapture: m.isCapture, isMerge: m.isMerge,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSquare, game, atPresent]);

  const lastMove = useMemo(() => {
    if (viewPly <= 0) return null;
    const uci = moves[viewPly - 1]?.uci;
    if (!uci || !/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
    return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square };
  }, [viewPly, moves]);

  // Scrub one ply. Plays the move's normal SFX going forward, reversed going
  // back. The Undo/Redo buttons pass playSfx=false so they rely on the global
  // button-click SFX instead.
  const navigateGameView = (forward: boolean, playSfx = true) => {
    setViewPly((p) => {
      const total = results.length;
      const next = forward ? Math.min(total, p + 1) : Math.max(0, p - 1);
      if (next === p) return p;
      if (playSfx) {
        sfx.cutoffChessSfx();
        const r = results[forward ? p : next];
        if (r) {
          if (forward) {
            if (r.castled) sfx.playCastle();
            else if (r.merged) sfx.playMerge();
            else if (r.captured) sfx.playCapture();
            else sfx.playMove();
            if (r.check && !r.checkmate) sfx.playCheck();
          } else {
            if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
            if (r.check) sfx.playCheckReversed();
          }
        }
      }
      return next;
    });
  };

  const canUndoView = viewPly > 0;
  const canRedoView = viewPly < results.length;

  // Arrow keys scrub through played positions. Skipped while typing in chat.
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
  }, [results]);

  // Leaving the present clears any stale piece selection.
  useEffect(() => {
    if (!atPresent) setSelectedSquare(null);
  }, [atPresent]);

  const isActiveSide = (c: Color): boolean => {
    if (end) return false;
    if (moves.length === 0) return false;
    return (game.turn === 'w') === (c === 'white');
  };

  // Try to play `from`→`to`. Pawn promotions defer to the picker overlay
  // (resolved by `resolvePromotion` once the user clicks a piece).
  // Returns true if a move was attempted (caller can clear selection).
  const attemptMove = (
    from: Square,
    to: Square,
    viaClick = false,
    releasePx?: { x: number; y: number },
  ): boolean => {
    const piece = game.board[sqIdx(from)];
    const isPawn = piece && piece.letter.toUpperCase() === 'P';
    const targetRank = parseInt(to[1], 10);
    const isPromoting = !!isPawn && (targetRank === 8 || targetRank === 1);
    if (isPromoting) {
      setPendingPromo({ from, to, viaClick });
    } else {
      void applyLocalMove(from, to, undefined, viaClick, releasePx);
    }
    return true;
  };

  const resolvePromotion = (letter: PromotionLetter) => {
    if (!pendingPromo) return;
    const valid: 'Q' | 'R' | 'B' | 'N' = ['Q', 'R', 'B', 'N'].includes(letter)
      ? (letter as 'Q' | 'R' | 'B' | 'N') : 'Q';
    const { from, to, viaClick } = pendingPromo;
    setPendingPromo(null);
    void applyLocalMove(from, to, valid, viaClick);
  };

  const onSquareClick = (square: Square) => {
    if (end) return;
    if (!gameStarted) return;
    if (!atPresent) return;
    if (!isMyTurn()) { setSelectedSquare(null); return; }
    const target = legalTargets.find((t) => t.to === square);
    if (selectedSquare === square) { setSelectedSquare(null); return; }
    if (selectedSquare && target) {
      attemptMove(selectedSquare, square, true);
      return;
    }
    const piece = game.board[sqIdx(square)];
    if (piece && piece.color === myEngineColor) {
      setSelectedSquare(square);
      return;
    }
    setSelectedSquare(null);
  };

  // Drag start on an own piece — same effect as clicking it, so the legal
  // target rings show up while the user drags.
  const onDragStartSquare = (from: Square) => {
    if (end) return;
    if (!gameStarted) return;
    if (!atPresent) return;
    if (!isMyTurn()) return;
    const piece = game.board[sqIdx(from)];
    if (!piece || piece.color !== myEngineColor) return;
    if (selectedSquare !== from) setSelectedSquare(from);
  };

  // Drop on a target — apply if legal, otherwise leave selection as-is so
  // the user can still click-to-move.
  const onPieceDrop = (
    from: Square,
    to: Square,
    opts?: { releasePx?: { x: number; y: number } },
  ): boolean => {
    if (end) return false;
    if (!gameStarted) return false;
    if (!atPresent) return false;
    if (!isMyTurn()) return false;
    const piece = game.board[sqIdx(from)];
    if (!piece || piece.color !== myEngineColor) return false;
    const legal = legalMovesFrom(game, from).some((m) => m.to === to);
    if (!legal) return false;
    return attemptMove(from, to, false, opts?.releasePx);
  };

  const movesDisplay = useMemo(() => {
    return moves.reduce<string[]>((acc, mv, i) => {
      const label = mv.uci;
      if (i % 2 === 0) acc.push(`${i / 2 + 1}. ${label}`);
      else acc[acc.length - 1] += ` ${label}`;
      return acc;
    }, []);
  }, [moves]);

  const myDelta = end
    ? eloDelta(rating, opp.rating, end.outcome === 'draw' ? 0.5 : end.outcome === myColor ? 1 : 0, 0)
    : 0;

  const inCheck = !end && isInCheck(game, game.turn);

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
        <div className={`board-wrap${!atPresent ? ' viewing-history' : ''}`}>
          <MergeBoard
            board={viewedState.board}
            orientation={handoff.iAmWhite ? 'white' : 'black'}
            selectedSquare={atPresent ? selectedSquare : null}
            legalTargets={atPresent ? legalTargets : []}
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
            mergeAnim={mergeAnim}
          />
          {pendingPromo && (
            <PromotionPicker
              square={pendingPromo.to}
              color={game.turn}
              orientation={handoff.iAmWhite ? 'white' : 'black'}
              onPick={resolvePromotion}
              onCancel={() => setPendingPromo(null)}
            />
          )}
          {partnerReady && !gameStarted && movesCountRef.current === 0 && (
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
          captures={captures}
          captureSide={oppColor === 'white' ? 'w' : 'b'}
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
          captures={captures}
          captureSide={myColor === 'white' ? 'w' : 'b'}
        />
        <div className="game-meta">
          <div className="game-meta-title">Merge · {tc.label}</div>
          <div className="muted small">
            peer: {handoff.partnerPeerId.slice(-6)} {partnerReady ? '✓' : '…'}
            {' · '}
            {connState === 'connected' && <span className="pos">connected</span>}
            {connState === 'connecting' && <span>connecting{connDetail ? ` (${connDetail})` : '…'}</span>}
            {connState === 'failed' && <span className="neg">failed: {connDetail}</span>}
          </div>
          {inCheck && <div className="small neg">Check.</div>}
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
            disabled={!canUndoView}
          >
            Undo
          </button>
          <button
            className="free-play-btn"
            onClick={() => navigateGameView(true, false)}
            type="button"
            disabled={!canRedoView}
          >
            Redo
          </button>
          <button
            className="free-play-btn"
            type="button"
            disabled={moves.length === 0}
            onClick={() => {
              const exp = buildGameExport({
                variant: 'merge',
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
          {movesDisplay.length === 0 ? (
            <div className="muted small">No moves yet.</div>
          ) : (
            movesDisplay.map((line, i) => (
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

      {/* tiny dev hook to keep toFen referenced */}
      <span style={{ display: 'none' }}>{toFen(game)}</span>
    </div>
  );
}

function sqIdx(sq: Square): number {
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49;
  return (7 - rank) * 8 + file;
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
    case 'promotion': return 'by pawn promotion';
    case 'pawns-cleared': return 'all pawns captured';
    case 'queen-captured': return 'queen captured';
  }
}
