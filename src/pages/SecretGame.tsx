import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayerCard, type VoiceState } from '../components/PlayerCard';
import { VoiceControls } from '../components/VoiceControls';
import { ChatComposer } from '../components/ChatComposer';
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
import { formatClock, getTimeControl, lowTimeThresholdMs } from '../lib/timeControls';
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
import { isQuickEmoji, kingSquaresForBoard, useEmojiBubble } from '../lib/inGameEmojis';
import { buildGameExport, downloadGameExport } from '../lib/gameExport';
import {
  SECRET_PHASE_MS,
  applyMove,
  initialState,
  isCheckmate,
  isFiftyMoveRule,
  isInCheck,
  isInsufficientMaterial,
  isStalemate,
  isThreefoldRepetition,
  isValidPickSquare,
  legalMovesFrom,
  pawnSquaresFor,
  randomPickSquare,
  sqToIdx,
  startingBoard,
  type GameState,
  type MoveResult,
  type Piece,
  type Square,
} from '../lib/secretChess';

type EndState = { outcome: GameOutcome; reason: GameEndReason };

// The two page phases. 'pick' spans from mount until both secret-queen picks
// are exchanged; 'play' is a normal game of chess with the two fakes live.
type Phase = 'pick' | 'play';

// Duration of the StartOverlay's CSS animation (board-start-fade in
// styles.css). Used to anchor the pick deadline to the wall clock without
// depending on animationend, which never fires in a backgrounded tab.
const START_OVERLAY_MS = 3500;
// Slack past the shared pick deadline before a silent opponent forfeits.
const STALL_GRACE_MS = 30_000;

export function SecretGame() {
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

  const myColor: Color = handoff.iAmWhite ? 'white' : 'black';
  const oppColor: Color = handoff.iAmWhite ? 'black' : 'white';
  const myEngineColor: 'w' | 'b' = handoff.iAmWhite ? 'w' : 'b';
  const oppEngineColor: 'w' | 'b' = handoff.iAmWhite ? 'b' : 'w';

  // --------------------------------------------------------------------
  // Pick-phase state
  // --------------------------------------------------------------------
  const [phase, setPhase] = useState<Phase>('pick');
  const phaseRef = useRef<Phase>('pick');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // The pawn currently selected as my secret queen (not yet confirmed).
  const [myPick, setMyPick] = useState<Square | null>(null);
  const myPickRef = useRef<Square | null>(null);
  useEffect(() => { myPickRef.current = myPick; }, [myPick]);
  // Finalized picks (mine / opponent's). Both non-null => play begins.
  const myFinalRef = useRef<Square | null>(null);
  const oppFinalRef = useRef<Square | null>(null);
  const [myReadyPick, setMyReadyPick] = useState(false);
  const [oppReadyPick, setOppReadyPick] = useState(false);
  // Countdown. Armed when the start overlay finishes so both sides start
  // their 30 seconds at (nearly) the same moment; each side auto-picks on
  // its own local expiry, so a second of skew only delays the exchange,
  // never desyncs it.
  const pickDeadlineRef = useRef<number | null>(null);
  const [pickMsLeft, setPickMsLeft] = useState(SECRET_PHASE_MS);

  // --------------------------------------------------------------------
  // Play-phase state (null / empty until both picks are in)
  // --------------------------------------------------------------------
  const [game, setGame] = useState<GameState | null>(null);
  const [states, setStates] = useState<GameState[]>([]);
  const [results, setResults] = useState<MoveResult[]>([]);
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
  // The intro overlay gates the pick countdown: picking is allowed only
  // after it fades (~3.5s after both connect).
  const [gameStarted, setGameStarted] = useState(false);
  const gameStartedRef = useRef(false);
  useEffect(() => { gameStartedRef.current = gameStarted; }, [gameStarted]);
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connDetail, setConnDetail] = useState<string>('');
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [pendingPromo, setPendingPromo] = useState<{ from: Square; to: Square; viaClick: boolean } | null>(null);
  const [slideAnim, setSlideAnim] = useState<{ moves: { from: Square; to: Square }[]; key: number } | null>(null);
  const [popAnim, setPopAnim] = useState<{ squares: Square[]; key: number } | null>(null);
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

  const me: PlayerInfo = {
    handle: identity.handle,
    rating,
  };
  const opp: PlayerInfo = {
    handle: handoff.partnerHandle,
    rating: handoff.partnerRating,
  };

  const { showOpponentNames, showOpponentAvatars, chatEnabled, inGameEmojisEnabled, animationsEnabled } = useSettingsStore();
  const { emojiBubbleEvent, showEmojiBubble } = useEmojiBubble(inGameEmojisEnabled);
  const oppDisplayHandle = showOpponentNames ? opp.handle : 'Opponent';
  const oppDisplayAvatar = showOpponentAvatars ? oppAvatar : null;

  const sessionRef = useRef<PeerSession>(handoff.session);
  const startedAtRef = useRef<number>(Date.now());
  const lastTickRef = useRef<number>(performance.now());
  const rematch = useRematch(handoff, sessionRef.current);
  const gameRef = useRef<GameState | null>(game);
  useEffect(() => { gameRef.current = game; }, [game]);
  const movesCountRef = useRef(0);
  useEffect(() => { movesCountRef.current = moves.length; }, [moves.length]);
  const animationsEnabledRef = useRef(animationsEnabled);
  useEffect(() => { animationsEnabledRef.current = animationsEnabled; }, [animationsEnabled]);

  const sendChatMessage = (text: string, options: { clearInput?: boolean; emoji?: boolean } = {}) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let playedEmojiSfx = false;
    sessionRef.current.send({ type: 'chat', text: trimmed });
    if (options.emoji && inGameEmojisEnabled) {
      sessionRef.current.send({ type: 'emoji', emoji: trimmed });
      playedEmojiSfx = showEmojiBubble('me', trimmed);
      if (playedEmojiSfx) sfx.playEmojiReaction(trimmed);
    }
    setChatLog((l) => [...l, { from: 'me', text: trimmed }]);
    if (!playedEmojiSfx) sfx.playChat();
    if (options.clearInput ?? true) setChatInput('');
  };

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

  useEffect(() => {
    endRef.current = end;
    if (end) cancelDisconnectCountdown();
  }, [end]);

  // --------------------------------------------------------------------
  // Pick-phase logic
  // --------------------------------------------------------------------

  // Finalize my pick: take the selected pawn (or a random one if none is
  // selected), freeze it, and send it. Called by the Confirm button and by
  // the local countdown expiry — whichever comes first. Idempotent.
  const finalizeMyPick = () => {
    if (myFinalRef.current != null) return;
    if (phaseRef.current !== 'pick') return;
    const pick = myPickRef.current ?? randomPickSquare(myEngineColor);
    myFinalRef.current = pick;
    setMyPick(pick);
    setMyReadyPick(true);
    try { sessionRef.current.send({ type: 'secret-pick', square: pick }); } catch {}
    maybeBeginPlay();
  };

  // Both picks in hand → build the identical starting position on both
  // peers and start the game. Deterministic — no extra confirmation round.
  const maybeBeginPlay = () => {
    if (phaseRef.current !== 'pick') return;
    const mine = myFinalRef.current;
    const theirs = oppFinalRef.current;
    if (mine == null || theirs == null) return;
    const whitePick = handoff.iAmWhite ? mine : theirs;
    const blackPick = handoff.iAmWhite ? theirs : mine;
    let init: GameState;
    try {
      init = initialState(whitePick, blackPick);
    } catch (e) {
      console.warn('failed to build secret-queen start', e);
      return;
    }
    setPhase('play');
    phaseRef.current = 'play';
    setGame(init);
    gameRef.current = init;
    setStates([init]);
    setViewPly(0);
    sfx.playQueue();
  };

  // The StartOverlay's animationend never fires in a backgrounded tab (CSS
  // animations pause), which would leave gameStarted stuck false — the same
  // race the established pages rescue (see SweeperGame). Opponent progress
  // (their pick arriving, or play having begun) proves the game is underway;
  // a timeout covers a foregrounded tab whose event was lost.
  useEffect(() => {
    if (gameStarted || !partnerReady) return;
    if (oppReadyPick || phase === 'play') { setGameStarted(true); return; }
    const t = window.setTimeout(() => setGameStarted(true), START_OVERLAY_MS + 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameStarted, partnerReady, oppReadyPick, phase]);

  // Countdown ticker. The deadline is anchored to the wall clock as soon as
  // the peer link is up (partnerReady): overlay duration + phase budget.
  // That way a throttled background tab still auto-picks roughly on time
  // even if the overlay's animationend never fires; gameStarted arming is
  // kept as a fallback for edge cases where partnerReady lagged.
  useEffect(() => {
    if ((!gameStarted && !partnerReady) || phase !== 'pick' || myReadyPick) return;
    if (pickDeadlineRef.current == null) {
      pickDeadlineRef.current =
        Date.now() + (gameStarted ? 0 : START_OVERLAY_MS) + SECRET_PHASE_MS;
    }
    const id = window.setInterval(() => {
      const left = (pickDeadlineRef.current ?? 0) - Date.now();
      if (left <= 0) {
        setPickMsLeft(0);
        clearInterval(id);
        finalizeMyPick();
        return;
      }
      setPickMsLeft(Math.min(left, SECRET_PHASE_MS));
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameStarted, partnerReady, phase, myReadyPick]);

  // Anti-stall backstop: my pick is in, the shared deadline plus a grace
  // period has passed, and the opponent still hasn't sent theirs — a
  // stalled/killed tab that never disconnected cleanly, or a peer whose
  // pick failed validation and was dropped. End it through the same forfeit
  // path a disconnect uses. The stalled client normally auto-sends once its
  // own (throttled) timer fires, so this is a rare last resort.
  useEffect(() => {
    if (!myReadyPick || oppReadyPick || phase !== 'pick' || end) return;
    const deadline = pickDeadlineRef.current ?? Date.now() + SECRET_PHASE_MS;
    const fireAt = Math.max(deadline, Date.now()) + STALL_GRACE_MS;
    const id = window.setInterval(() => {
      if (endRef.current || phaseRef.current !== 'pick' || oppFinalRef.current != null) {
        clearInterval(id);
        return;
      }
      if (Date.now() >= fireAt) {
        clearInterval(id);
        finalize({ outcome: myColor, reason: 'disconnect' });
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myReadyPick, oppReadyPick, phase, end]);

  // The board shown during the pick phase: the ordinary starting position.
  const pickBoard = useMemo<(Piece | null)[]>(() => startingBoard(), []);

  // My 8 pawns, highlighted as pick candidates until I confirm. isCapture
  // deliberately: occupied squares draw the ring marker (the plain dot would
  // hide behind the pawn sprite).
  const pickTargets = useMemo<{ to: Square; isCapture: boolean; isMerge: boolean }[]>(() => {
    if (phase !== 'pick' || myReadyPick) return [];
    return pawnSquaresFor(myEngineColor).map((sq) => ({ to: sq, isCapture: true, isMerge: false }));
  }, [phase, myReadyPick, myEngineColor]);

  const onPickSquareClick = (sq: Square) => {
    if (!gameStarted || myReadyPick) return;
    if (isValidPickSquare(myEngineColor, sq)) {
      setMyPick((cur) => (cur === sq ? null : sq));
      sfx.playSelect();
    }
  };

  // --------------------------------------------------------------------
  // Networking
  // --------------------------------------------------------------------
  useEffect(() => {
    const session = sessionRef.current;

    const handleMessage = async (msg: WireMessage) => {
      cancelDisconnectCountdown();
      if (rematch.handleRematchMessage(msg)) return;
      if (msg.type === 'hello') return;
      if (msg.type === 'ready') { setPartnerReady(true); return; }
      if (msg.type === 'secret-pick') {
        // Validate before trusting: the pick must be one of the sender's 8
        // starting pawns — anything else is a protocol violation.
        if (oppFinalRef.current != null) return;
        if (!isValidPickSquare(oppEngineColor, msg.square)) {
          console.warn('invalid secret pick from peer', msg.square);
          return;
        }
        oppFinalRef.current = msg.square;
        setOppReadyPick(true);
        maybeBeginPlay();
        return;
      }
      if (msg.type === 'move') { await applyRemoteMove(msg.move); return; }
      if (msg.type === 'resign') { finalize({ outcome: myColor, reason: 'resignation' }); return; }
      // Draw traffic is only meaningful during play — the local buttons are
      // disabled during the pick phase, so an offer/accept arriving then is
      // a hostile or buggy peer angling for a 0-move rated draw. Drop it.
      if (msg.type === 'draw-offer') {
        if (phaseRef.current === 'play') setDrawOfferedByOpp(true);
        return;
      }
      if (msg.type === 'draw-accept') {
        if (phaseRef.current === 'play') finalize({ outcome: 'draw', reason: 'draw-agreed' });
        return;
      }
      if (msg.type === 'draw-decline') { setDrawOfferedByMe(false); return; }
      if (msg.type === 'timeout-claim') {
        const loser = msg.loserColor;
        const ms = loser === 'white' ? whiteMs : blackMs;
        if (ms <= 0) finalize({ outcome: loser === 'white' ? 'black' : 'white', reason: 'timeout' });
        return;
      }
      if (msg.type === 'chat') {
        setChatLog((l) => [...l, { from: 'opp', text: msg.text }]);
        if (!isQuickEmoji(msg.text)) sfx.playChat();
        return;
      }
      if (msg.type === 'emoji') {
        if (showEmojiBubble('opp', msg.emoji)) sfx.playEmojiReaction(msg.emoji);
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
      // Re-send my finalized pick on reconnect — the opponent may have
      // missed it while the link was down.
      if (myFinalRef.current != null) {
        session.send({ type: 'secret-pick', square: myFinalRef.current });
      }
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

  // Main-game clocks. Tick only during the play phase — the pick phase has
  // its own countdown and doesn't consume game time.
  useEffect(() => {
    if (end) return;
    let raf = 0;
    const loop = (t: number) => {
      const dt = t - lastTickRef.current;
      lastTickRef.current = t;
      if (phaseRef.current === 'play' && gameRef.current) {
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

  useEffect(() => {
    if (end) return;
    if (phase !== 'play') return;
    if (whiteMs <= 0) claimTimeout('white');
    else if (blackMs <= 0) claimTimeout('black');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whiteMs, blackMs]);

  const claimTimeout = (loser: Color) => {
    sessionRef.current.send({ type: 'timeout-claim', loserColor: loser });
    finalize({ outcome: loser === 'white' ? 'black' : 'white', reason: 'timeout' });
  };

  // --------------------------------------------------------------------
  // Move handling (play phase)
  // --------------------------------------------------------------------
  const isMyTurn = () => phase === 'play' && !!game && game.turn === myEngineColor;

  const playMoveFeedback = (res: MoveResult) => {
    if (res.captured) sfx.playCapture();
    else sfx.playMove();
    // The unmask moment: a fake queen dropping its pawn disguise, either by
    // moving or by delivering a check it can no longer hide. Same smoke-bomb
    // cue as Twin-Jutsu's unmask. A capture-reveal keeps the plain capture
    // sound — the capture strip does the talking there. One move can carry
    // two reveals (hidden fake takes hidden fake), hence the array.
    if (res.reveals.some((r) => r.cause !== 'captured')) sfx.playTwinJutsu();
    if (res.check && !res.checkmate) sfx.playCheck();
  };

  // Pop the revealed square so the pawn→queen swap reads as a moment, not a
  // silent sprite change. For 'moved' the queen pops on its destination; for
  // 'check' it pops where it stands.
  const triggerRevealAnim = (res: MoveResult, state: GameState) => {
    if (!animationsEnabledRef.current) return;
    const squares = res.reveals
      .filter((r) => r.cause !== 'captured')
      .map((r) => state.fakes[r.side].sq)
      .filter((sq): sq is Square => !!sq);
    if (squares.length > 0) setPopAnim({ squares, key: Date.now() });
  };

  const applyLocalMove = async (
    from: Square,
    to: Square,
    promotion?: 'Q' | 'R' | 'B' | 'N',
    viaClick = false,
  ): Promise<boolean> => {
    if (end) return false;
    if (!isMyTurn() || !game) return false;
    if (viewPlyRef.current !== movesCountRef.current) return false;
    const beforeTurn = game.turn;
    let uci = from + to;
    if (promotion) uci += promotion.toLowerCase();
    const res = applyMove(game, uci);
    if (!res) return false;

    const ply = moves.length + 1;
    const sliding = viaClick && animationsEnabled;
    playMoveFeedback(res.result);

    if (tc.perMoveMs != null) {
      setWhiteMs(tc.perMoveMs);
      setBlackMs(tc.perMoveMs);
    } else if (beforeTurn === 'w') {
      setWhiteMs((ms) => ms + tc.incrementMs);
    } else {
      setBlackMs((ms) => ms + tc.incrementMs);
    }

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
    if (sliding) {
      setSlideAnim({ moves: [{ from, to }], key: Date.now() });
    }
    if (animationsEnabled && !!promotion) {
      setPopAnim({ squares: [to], key: Date.now() });
    }
    triggerRevealAnim(res.result, res.state);
    sessionRef.current.send({ type: 'move', move: signed });
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);

    checkBoardEnd(res.state);
    return true;
  };

  const applyRemoteMove = async (move: Move) => {
    if (end) return;
    if (phaseRef.current !== 'play' || !gameRef.current) {
      console.warn('remote move before play phase', move);
      return;
    }
    if (move.ply !== movesCountRef.current + 1) {
      console.warn('out of order move', move.ply, 'expected', movesCountRef.current + 1);
      return;
    }
    const res = applyMove(gameRef.current, move.uci);
    if (!res) {
      console.warn('illegal remote move', move);
      return;
    }
    // Defense in depth: a fenAfter mismatch means the two sides disagree
    // about the position (or the fake bookkeeping).
    if (res.result.fenAfter !== move.fenAfter) {
      console.warn('FEN mismatch from peer', { ours: res.result.fenAfter, theirs: move.fenAfter });
    }
    playMoveFeedback(res.result);
    const wasAtPresent = viewPlyRef.current === movesCountRef.current;
    setGame(res.state);
    setStates((s) => [...s, res.state]);
    setResults((r) => [...r, res.result]);
    setMoves((m) => [...m, move]);
    if (wasAtPresent) setViewPly((p) => p + 1);
    if (tc.perMoveMs != null) {
      setWhiteMs(tc.perMoveMs);
      setBlackMs(tc.perMoveMs);
    } else {
      setWhiteMs(move.whiteClockMs);
      setBlackMs(move.blackClockMs);
    }
    triggerRevealAnim(res.result, res.state);
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

  const secretQueensForRecord = (): { w: string; b: string } | undefined => {
    const mine = myFinalRef.current;
    const theirs = oppFinalRef.current;
    if (mine == null || theirs == null) return undefined;
    return handoff.iAmWhite ? { w: mine, b: theirs } : { w: theirs, b: mine };
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

    const picks = secretQueensForRecord();
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
      ...(picks ? { secretQueens: picks } : {}),
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
  const inPick = phase === 'pick';
  const viewedState: GameState | null = inPick ? null : (states[viewPly] ?? states[0] ?? null);
  const atPresent = viewPly === moves.length;

  const displayBoard: (Piece | null)[] = inPick
    ? pickBoard
    : (viewedState?.board ?? pickBoard);

  // The masking split, derived from the VIEWED state so history scrubbing
  // shows the disguise as it was at that ply:
  //   - the opponent's unrevealed fake renders as a plain pawn (their board
  //     square actually holds a queen — same trust model as Twin-Jutsu:
  //     shared state, hidden by the UI);
  //   - my own unrevealed fake renders as the queen it is, with a ghost-pawn
  //     marker showing the disguise the opponent sees.
  // During the pick phase there are no masks yet — the selection ring marks
  // the chosen pawn.
  const { maskedAsPawnSqs, maskedSelfPawnSqs } = useMemo(() => {
    if (inPick) {
      return { maskedAsPawnSqs: [] as Square[], maskedSelfPawnSqs: [] as Square[] };
    }
    const asPawn: Square[] = [];
    const selfPawn: Square[] = [];
    if (viewedState) {
      const oppFake = viewedState.fakes[oppEngineColor];
      if (oppFake.sq && !oppFake.revealed) asPawn.push(oppFake.sq);
      const myFake = viewedState.fakes[myEngineColor];
      if (myFake.sq && !myFake.revealed) selfPawn.push(myFake.sq);
    }
    return { maskedAsPawnSqs: asPawn, maskedSelfPawnSqs: selfPawn };
  }, [inPick, viewedState, myEngineColor, oppEngineColor]);

  const captures = useMemo(
    () => (viewedState && states[0] ? computeCaptures(viewedState.board, states[0].board) : null),
    [viewedState, states],
  );
  const emojiBubble = emojiBubbleEvent
    ? {
        emoji: emojiBubbleEvent.emoji,
        key: emojiBubbleEvent.key,
        squares: kingSquaresForBoard(
          displayBoard,
          emojiBubbleEvent.side === 'me' ? myEngineColor : oppEngineColor,
        ),
      }
    : null;

  const legalTargets = useMemo(() => {
    if (inPick) return pickTargets;
    if (!atPresent || !selectedSquare || !game) return [];
    return legalMovesFrom(game, selectedSquare);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPick, pickTargets, selectedSquare, game, atPresent]);

  const lastMove = useMemo(() => {
    if (inPick || viewPly <= 0) return null;
    const uci = moves[viewPly - 1]?.uci;
    if (!uci || !/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
    return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square };
  }, [inPick, viewPly, moves]);

  const navigateGameView = (forward: boolean, playSfx = true) => {
    if (inPick) return;
    setViewPly((p) => {
      const total = results.length;
      const next = forward ? Math.min(total, p + 1) : Math.max(0, p - 1);
      if (next === p) return p;
      const r = results[forward ? p : next];
      if (playSfx && r) {
        sfx.cutoffChessSfx();
        if (forward) {
          if (r.captured) sfx.playCapture();
          else sfx.playMove();
          if (r.check && !r.checkmate) sfx.playCheck();
        } else {
          if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
          if (r.check) sfx.playCheckReversed();
        }
      }
      return next;
    });
  };

  const canUndoView = !inPick && viewPly > 0;
  const canRedoView = !inPick && viewPly < results.length;

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
  }, [results, inPick]);

  useEffect(() => {
    if (!atPresent) setSelectedSquare(null);
  }, [atPresent]);

  const isActiveSide = (c: Color): boolean => {
    if (end || inPick || !game) return false;
    return (game.turn === 'w') === (c === 'white');
  };

  const attemptMove = (from: Square, to: Square, viaClick = false): boolean => {
    if (!game) return false;
    const piece = game.board[sqToIdx(from)];
    // The fake queen carries letter 'Q', so this never offers it a
    // promotion — it reaches the last rank and simply stays a queen.
    const isPawn = piece && piece.letter.toUpperCase() === 'P';
    const targetRank = parseInt(to[1], 10);
    const isPromoting = !!isPawn && (targetRank === 8 || targetRank === 1);
    if (isPromoting) {
      setPendingPromo({ from, to, viaClick });
    } else {
      void applyLocalMove(from, to, undefined, viaClick);
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
    if (inPick) { onPickSquareClick(square); return; }
    if (!atPresent || !game) return;
    if (!isMyTurn()) { setSelectedSquare(null); return; }
    const target = legalTargets.find((t) => t.to === square);
    if (selectedSquare === square) { setSelectedSquare(null); return; }
    if (selectedSquare && target) {
      attemptMove(selectedSquare, square, true);
      return;
    }
    const piece = game.board[sqToIdx(square)];
    if (piece && piece.color === myEngineColor) {
      setSelectedSquare(square);
      return;
    }
    setSelectedSquare(null);
  };

  const onDragStartSquare = (from: Square) => {
    if (end || inPick) return;
    if (!atPresent || !game) return;
    if (!isMyTurn()) return;
    const piece = game.board[sqToIdx(from)];
    if (!piece || piece.color !== myEngineColor) return;
    if (selectedSquare !== from) setSelectedSquare(from);
  };

  const onPieceDrop = (from: Square, to: Square): boolean => {
    if (end || inPick) return false;
    if (!atPresent || !game) return false;
    if (!isMyTurn()) return false;
    const piece = game.board[sqToIdx(from)];
    if (!piece || piece.color !== myEngineColor) return false;
    const legal = legalMovesFrom(game, from).some((m) => m.to === to);
    if (!legal) return false;
    return attemptMove(from, to, false);
  };

  const movesDisplay = useMemo(() => {
    return results.reduce<string[]>((acc, r, i) => {
      if (i % 2 === 0) acc.push(`${i / 2 + 1}. ${r.san}`);
      else acc[acc.length - 1] += ` ${r.san}`;
      return acc;
    }, []);
  }, [results]);

  const myDelta = end
    ? eloDelta(rating, opp.rating, end.outcome === 'draw' ? 0.5 : end.outcome === myColor ? 1 : 0, 0)
    : 0;

  const inCheck = !end && !inPick && !!game && isInCheck(game);

  const pickInteractive = inPick && gameStarted && !myReadyPick && !end;
  const playInteractive = !inPick && !end && isMyTurn() && atPresent && !pendingPromo;

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
      <div className={`board-column${inPick ? ' with-setup-tray' : ''}`}>
        {inPick && (
          <div className="setup-side-rail">
            <div className="setup-tray">
              <div className="setup-tray-title">Pick your secret queen</div>
              <div className="setup-tray-clock" aria-label="Selection time remaining">
                {gameStarted ? formatClock(pickMsLeft) : formatClock(SECRET_PHASE_MS)}
              </div>
              <div className="secret-pick-line">
                {myReadyPick
                  ? 'Locked in.'
                  : myPick
                    ? <>Secret queen: <span className="secret-pick-sq">{myPick}</span></>
                    : 'Click one of your pawns.'}
              </div>
              <button
                type="button"
                className="primary-btn"
                disabled={!gameStarted || myReadyPick}
                onClick={() => { finalizeMyPick(); }}
              >
                {myReadyPick ? 'Ready ✓' : myPick ? 'Confirm' : 'Confirm (random)'}
              </button>
              <div className="setup-tray-status muted small">
                {myReadyPick
                  ? (oppReadyPick ? 'Both ready — starting…' : 'Waiting for opponent…')
                  : oppReadyPick ? 'Opponent is ready.' : 'Opponent is choosing…'}
              </div>
              <div className="setup-tray-hint muted small">
                One of your 8 pawns secretly becomes a queen. It moves like a
                queen from the first move, but your opponent sees an ordinary
                pawn — until it moves (or gives check), when the disguise
                drops for good. If the clock runs out, a random pawn is
                picked for you.
              </div>
            </div>
          </div>
        )}
        <div className={`board-wrap${!inPick && !atPresent ? ' viewing-history' : ''}`}>
          <MergeBoard
            board={displayBoard}
            orientation={handoff.iAmWhite ? 'white' : 'black'}
            selectedSquare={inPick ? myPick : (atPresent ? selectedSquare : null)}
            legalTargets={legalTargets}
            onSquareClick={onSquareClick}
            onPieceDrop={onPieceDrop}
            onDragStartSquare={onDragStartSquare}
            interactive={pickInteractive || playInteractive}
            draggable={playInteractive}
            lastMove={lastMove}
            slideMoves={slideAnim?.moves}
            slideKey={slideAnim?.key}
            popSquares={popAnim?.squares}
            popKey={popAnim?.key}
            maskedAsPawnSquares={maskedAsPawnSqs}
            maskedSelfPawnSquares={maskedSelfPawnSqs}
            emojiBubble={emojiBubble}
          />
          {pendingPromo && game && (
            <PromotionPicker
              square={pendingPromo.to}
              color={game.turn}
              orientation={handoff.iAmWhite ? 'white' : 'black'}
              onPick={resolvePromotion}
              onCancel={() => setPendingPromo(null)}
            />
          )}
          {partnerReady && !gameStarted && (
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
          <div className="game-meta-title">Secret Queen · {tc.label}</div>
          <div className="muted small">
            peer: {handoff.partnerPeerId.slice(-6)} {partnerReady ? '✓' : '…'}
            {' · '}
            {connState === 'connected' && <span className="pos">connected</span>}
            {connState === 'connecting' && <span>connecting{connDetail ? ` (${connDetail})` : '…'}</span>}
            {connState === 'failed' && <span className="neg">failed: {connDetail}</span>}
          </div>
          {inPick && (
            <div className="small muted">
              Selection phase — {gameStarted ? formatClock(pickMsLeft) : formatClock(SECRET_PHASE_MS)} to choose.
            </div>
          )}
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
            // Enabled only once the game has ENDED: the export JSON contains
            // both secret picks, so a mid-game export would leak the
            // opponent's hidden queen.
            disabled={!end || moves.length === 0 || !secretQueensForRecord()}
            onClick={() => {
              if (!end) return;
              const picks = secretQueensForRecord();
              if (!picks) return;
              const exp = buildGameExport({
                variant: 'secret',
                gameId: gameId!,
                timeControlId: tc.id,
                white: handoff.iAmWhite ? me : opp,
                black: handoff.iAmWhite ? opp : me,
                startedAt: startedAtRef.current,
                endedAt: end ? Date.now() : null,
                outcome: end?.outcome ?? null,
                reason: end?.reason ?? null,
                moves,
                secretQueens: picks,
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
                  disabled={drawOfferedByMe || inPick}
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
            <div className="muted small">
              {inPick ? 'Game starts after the picks.' : 'No moves yet.'}
            </div>
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
            <ChatComposer
              value={chatInput}
              onChange={setChatInput}
              onSend={sendChatMessage}
              emojiEnabled={inGameEmojisEnabled}
            />
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
    case 'mine': return 'the king stepped on a mine';
    case 'king-capture': return 'the exposed king was captured';
  }
}
