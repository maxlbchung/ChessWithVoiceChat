import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayerCard, type VoiceState } from '../components/PlayerCard';
import { VoiceControls } from '../components/VoiceControls';
import { ChatComposer } from '../components/ChatComposer';
import { FinishAvatar, ResultAvatar } from '../components/EndScreenAvatars';
import { useSettingsStore } from '../store/settingsStore';
import { MergeBoard } from '../components/MergeBoard';
import { computeCaptures } from '../lib/captures';
import { PromotionPicker, type PromotionLetter } from '../components/PromotionPicker';
import { HeroPicker } from '../components/HeroPicker';
import { HeroAbilities } from '../components/HeroAbilities';
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
import { isQuickEmoji, kingSquaresForBoard, useEmojiBubble } from '../lib/inGameEmojis';
import { buildGameExport, downloadGameExport } from '../lib/gameExport';
import {
  abilityTargets,
  abilityUci,
  applyMove,
  backRanksForGame,
  goofballLegalDestinations,
  twinJutsuLegalDestinations,
  flightLegalDestinations,
  slimeLegalDestinations,
  slimeShiftOptions,
  resolveSlimeShiftClick,
  type SlimeShiftOption,
  jugTierOf,
  normalizeHeroKind,
  HERO_INFO,
  heroPoolForGame,
  idxToSq,
  sqToIdx,
  initialState,
  isCheckmate,
  isFiftyMoveRule,
  isInCheck,
  isInsufficientMaterial,
  isStalemate,
  isThreefoldRepetition,
  kingSquareOf,
  legalMovesFrom,
  pieceAtImpactBeforeBlast,
  toFen,
  turnsUntilReady,
  type GameState,
  type HeroKind,
  type MoveResult,
  type Square,
} from '../lib/heroChess';
import type { AbilityAnim } from '../components/MergeBoard';
import type { Piece as MergePieceShape } from '../lib/mergeChess';

type EndState = { outcome: GameOutcome; reason: GameEndReason };

export function HeroGame() {
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

  // Hero picks. Local play can't start until BOTH sides have committed a
  // hero — at that point we initialise the engine.
  const [myHero, setMyHero] = useState<HeroKind | null>(null);
  const [oppHero, setOppHero] = useState<HeroKind | null>(null);
  // Ref-mirror of myHero so the once-mounted peer message handler can read
  // the latest value without re-binding. Used to re-broadcast our pick when
  // the partner signals 'ready' (covers the race where we pick before their
  // HeroGame has its handler attached).
  const myHeroRef = useRef<HeroKind | null>(null);
  useEffect(() => { myHeroRef.current = myHero; }, [myHero]);
  const [game, setGame] = useState<GameState | null>(null);
  // History snapshots (initial + after each move).
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
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'failed'>('connecting');
  const [connDetail, setConnDetail] = useState<string>('');
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  // Promotion-picker overlay state. While set, the board is non-interactive
  // and the picker awaits the player's choice. Slides (drag animations) are
  // captured up-front so the eventual move still animates properly.
  const [pendingPromo, setPendingPromo] = useState<{
    from: Square; to: Square; slides?: { from: Square; to: Square }[];
  } | null>(null);
  // Ability-driven promotions: Twin-Jutsu swap or Flight teleport that lands
  // a pawn on its back rank, or Goofball forcing an opponent pawn to promote.
  // The picker square is the square where the pawn ends up; `color` is the
  // side being promoted (own pawn for Twin-Jutsu/Flight, opponent's pawn for
  // Goofball).
  const [pendingAbilityPromo, setPendingAbilityPromo] = useState<{
    hero: 'twin-jutsu' | 'goofball' | 'flight';
    from: Square;
    to: Square;
    pickerSquare: Square;
    color: 'w' | 'b';
  } | null>(null);
  const [slideAnim, setSlideAnim] = useState<{ moves: { from: Square; to: Square }[]; key: number } | null>(null);
  const [popAnim, setPopAnim] = useState<{ squares: Square[]; key: number } | null>(null);
  useEffect(() => {
    if (!slideAnim) return;
    const t = window.setTimeout(() => setSlideAnim(null), 760);
    return () => clearTimeout(t);
  }, [slideAnim]);
  useEffect(() => {
    if (!popAnim) return;
    const t = window.setTimeout(() => setPopAnim(null), 420);
    return () => clearTimeout(t);
  }, [popAnim]);
  // True when the ability is "armed" — next board click selects the target.
  const [abilityArmed, setAbilityArmed] = useState(false);
  // Goofball is a two-click ability: first click picks the opponent piece
  // being puppeted, second click picks where it goes. Cleared whenever
  // armed flips off or after firing.
  const [goofballFrom, setGoofballFrom] = useState<Square | null>(null);
  // Twin-Jutsu is the other two-click ability: first click picks one of your
  // own pieces, second click picks a swap partner.
  const [twinJutsuFrom, setTwinJutsuFrom] = useState<Square | null>(null);
  // Flight is also two-click: first click picks one of your own pieces,
  // second click picks the (empty) square it flies to.
  const [flightFrom, setFlightFrom] = useState<Square | null>(null);
  // Slime too: first click picks a mini king, second click picks the diagonal
  // corner of the 2×2 quadrant it expands into.
  const [slimeFrom, setSlimeFrom] = useState<Square | null>(null);
  useEffect(() => {
    if (!abilityArmed) { setGoofballFrom(null); setTwinJutsuFrom(null); setFlightFrom(null); setSlimeFrom(null); }
  }, [abilityArmed]);
  // Transient ability animation overlay state. Bumped to a fresh key every
  // time we want the animation to re-fire (CSS keyframes restart on remount).
  const [abilityAnim, setAbilityAnim] = useState<AbilityAnim | null>(null);
  // Auto-clear shortly after the visible effect ends so the value can't
  // outlive its animation and accidentally replay later.
  useEffect(() => {
    if (!abilityAnim) return;
    const t = window.setTimeout(() => setAbilityAnim(null), 1200);
    return () => clearTimeout(t);
  }, [abilityAnim]);
  // Pieces destroyed by an ICBM that we render through the whistle window so
  // they're still visible until the explosion fires.
  const [doomedPieces, setDoomedPieces] = useState<{ sq: Square; letter: string }[]>([]);
  const [disconnectMs, setDisconnectMs] = useState<number | null>(null);
  const disconnectDeadlineRef = useRef<number | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);
  const disconnectCountRef = useRef<number>(0);
  const [disconnectCount, setDisconnectCount] = useState(0);
  const FORFEIT_DELAY_MS = 5000;
  const MAX_GRACE_DISCONNECTS = 2;
  const [_, forceTick] = useState(0);

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

  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

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

  // Initialise the engine once both heroes are known.
  useEffect(() => {
    if (game || myHero == null || oppHero == null) return;
    const heroW = handoff.iAmWhite ? myHero : oppHero;
    const heroB = handoff.iAmWhite ? oppHero : myHero;
    // Twin-Jutsu back ranks are shuffled deterministically from the shared
    // gameId, so both peers build the identical board without negotiation.
    const init = initialState(heroW, heroB, backRanksForGame(heroW, heroB, gameId!));
    setGame(init);
    setStates([init]);
    setResults([]);
    setViewPly(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myHero, oppHero, game, handoff.iAmWhite]);

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
      if (endRef.current) { cancelDisconnectCountdown(); return; }
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

  useEffect(() => {
    const session = sessionRef.current;
    const handleMessage = async (msg: WireMessage) => {
      cancelDisconnectCountdown();
      if (rematch.handleRematchMessage(msg)) return;
      if (msg.type === 'hello') return;
      if (msg.type === 'ready') {
        setPartnerReady(true);
        // Partner just attached their handlers — if we picked before that
        // happened, re-broadcast so the pick isn't lost in the race.
        if (myHeroRef.current != null) {
          try { session.send({ type: 'hero-pick', hero: myHeroRef.current }); } catch {}
        }
        return;
      }
      // normalizeHeroKind: a peer on a pre-rename build still sends the old
      // 'twin-jitsu' id.
      if (msg.type === 'hero-pick') { setOppHero(normalizeHeroKind(msg.hero) ?? msg.hero); return; }
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
        if (!stream) { stream = await getMicStream(); setLocalStream(stream); }
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
      } catch (e) { console.warn('failed to accept voice', e); }
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
      // (Re-)send our hero pick on every intro. If our pick was sent before
      // the partner's handlers were ready, it would have been silently
      // dropped — broadcasting again here is idempotent on the receiver
      // (setOppHero with the same value is a no-op).
      if (myHeroRef.current != null) {
        try { session.send({ type: 'hero-pick', hero: myHeroRef.current }); } catch {}
      }
    };

    session.setEvents({
      ...session.events,
      onConnect: () => { cancelDisconnectCountdown(); sendIntro(); },
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

  // Clocks only run after the game has started (both heroes picked, engine inited).
  useEffect(() => {
    if (end || !game) return;
    let raf = 0;
    const loop = (t: number) => {
      const dt = t - lastTickRef.current;
      lastTickRef.current = t;
      if (movesCountRef.current > 0) {
        const turn = gameRef.current?.turn;
        if (turn === 'w') {
          setWhiteMs((ms) => {
            const next = Math.max(0, ms - dt);
            if (ms >= lowMs && next < lowMs && next > 0) sfx.playLowTimeWarning();
            return next;
          });
        } else if (turn === 'b') {
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
  }, [end, game]);

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

  // ----------------------------------------------------------------
  // Move handling
  // ----------------------------------------------------------------
  const isMyTurn = () => !!game && game.turn === myEngineColor;

  const handlePickHero = (h: HeroKind) => {
    if (myHero != null) return;
    setMyHero(h);
    sessionRef.current.send({ type: 'hero-pick', hero: h });
  };

  // Build an animation descriptor for the just-played ability move. Uses the
  // *previous* state to find the king for Flight (since the king moves) and
  // the new state for Knight (king didn't move). Returns null for non-ability
  // moves so callers can `setAbilityAnim(triggerAbilityAnim(...))` blindly.
  // Frost shatter: when one or more freezes expire (entry present in prev
  // but not in next), fire a shatter animation + SFX at each previously-
  // frozen square. Multiple simultaneous shatters share the same SFX hit.
  const triggerFrostShatter = (prev: GameState, next: GameState) => {
    if (prev.frozen.length === 0) return;
    const nextIdxs = new Set(next.frozen.map((f) => f.idx));
    const expired = prev.frozen.filter((f) => !nextIdxs.has(f.idx));
    if (expired.length === 0) return;
    sfx.playFrostShatter();
    if (animationsEnabled) {
      // Animate the most recently set freeze entry (last one expired) — only
      // one shatter overlay can be on screen at a time via abilityAnim, so
      // we pick one rather than queueing.
      const f = expired[expired.length - 1];
      setAbilityAnim({
        kind: 'frost-shatter',
        toSq: idxToSq(f.idx),
        color: 'w',
        key: `frost-shatter-${prev.ply}-${f.idx}-${Date.now()}`,
      });
    }
  };

  // Slime split: a big-king tile was captured / crushed / blasted this move
  // and the blob burst into mini kings. Squelch SFX + goo splatter at the
  // destroyed tile, with the minis popping in via the pop channel.
  const triggerSlimeSplit = (prev: GameState, result: MoveResult) => {
    const splits = result.slimeSplits;
    if (!splits || splits.length === 0) return;
    sfx.playSlimeSplit();
    if (animationsEnabled) {
      // One splatter overlay slot — splash the first destroyed tile.
      const tile = splits[0].tiles[0];
      if (tile) {
        setAbilityAnim({
          kind: 'slime-split',
          toSq: tile,
          color: 'w',
          key: `slime-split-${prev.ply}-${tile}-${Date.now()}`,
        });
      }
      const minis = splits.flatMap((s) => s.minis);
      if (minis.length > 0) setPopAnim({ squares: minis, key: Date.now() });
    }
  };

  // Juggernaut tier-up: an enemy capture attempt (or a missile) fed the
  // Juggernaut this move — the attacker died and the boss powered up. For a
  // board-move capture, the doomed attacker slides onto the (unmoving)
  // Juggernaut and explodes there; the deep quake lands at the impact beat.
  // Missile feeds get the plain immediate quake.
  const triggerJugTierShift = (prev: GameState, next: GameState, uci: string) => {
    for (const c of ['w', 'b'] as const) {
      if (jugTierOf(next, c) > jugTierOf(prev, c)) {
        const jugSq = kingSquareOf(next.board, c);
        const isBoardMove = /^[a-h][1-8][a-h][1-8]/.test(uci);
        const fromSq = isBoardMove ? (uci.slice(0, 2) as Square) : null;
        const attacker = fromSq ? prev.board[sqToIdx(fromSq)] : null;
        const isAbsorb = !!jugSq && isBoardMove && uci.slice(2, 4) === jugSq && !!attacker;
        if (isAbsorb) {
          window.setTimeout(() => sfx.playJugQuake(), 320);
          if (animationsEnabled) {
            setAbilityAnim({
              kind: 'jug-absorb',
              fromSq: fromSq!,
              toSq: jugSq!,
              color: c,
              flyerLetter: attacker!.letter,
              key: `jug-absorb-${prev.ply}-${c}-${Date.now()}`,
            });
          }
        } else {
          sfx.playJugQuake();
          if (animationsEnabled && jugSq) {
            setAbilityAnim({
              kind: 'juggernaut',
              toSq: jugSq,
              color: c,
              key: `jug-tier-${prev.ply}-${c}-${Date.now()}`,
            });
          }
        }
      }
    }
  };

  // True when this just-applied board move was a capture attempt absorbed by
  // a Juggernaut (attacker died on its square). Used to suppress the normal
  // slide — otherwise the slide channel animates the JUGGERNAUT (the piece
  // now on the target square) gliding in from the attacker's origin.
  const wasJugAbsorb = (prev: GameState, next: GameState, uci: string): boolean =>
    /^[a-h][1-8][a-h][1-8]/.test(uci) &&
    (['w', 'b'] as const).some((c) =>
      jugTierOf(next, c) > jugTierOf(prev, c) &&
      kingSquareOf(next.board, c) === uci.slice(2, 4),
    );

  // Warlord ability: the engine clears the target piece on move commit, but
  // we keep it visible as a doomed-piece overlay through the wind-up of the
  // sword swing and only let it disappear at the swing midpoint (when the
  // blade collides). Same overlay channel as ICBM doomedPieces.
  const WARLORD_SWING_IMPACT_MS = 450;
  const triggerWarlordDoom = (prev: GameState, result: MoveResult) => {
    if (result.abilityUsed !== 'warlord') return;
    const targetSq = result.uci.slice(2) as Square;
    const targetIdx = sqToIdx(targetSq);
    const victim = prev.board[targetIdx];
    if (!victim) return;
    const entry = { sq: targetSq, letter: victim.letter };
    setDoomedPieces((prevD) => [...prevD, entry]);
    window.setTimeout(() => {
      setDoomedPieces((prevD) => prevD.filter((d) => d.sq !== targetSq));
    }, WARLORD_SWING_IMPACT_MS);
  };

  // Drive the ICBM-landing sequence for any missiles whose landing ply has
  // just arrived. Whistle plays immediately; explosion + the doomed sprite
  // clearing follow after a half-second pause. Multiple simultaneous
  // landings share the single abilityAnim slot — staggered so each still
  // gets its own key bump.
  const triggerMissileDetonations = (prev: GameState, next: GameState, uci: string) => {
    const landings = prev.missiles.filter((m) => m.landsAtPly <= next.ply);
    if (landings.length === 0) return;
    sfx.playMissileWhistle();
    // Determine what piece will get blown up. If a piece moved INTO the
    // impact square this ply, the doomed sprite is the just-moved piece —
    // not whatever was on the square before the move applied.
    const doomed: { sq: Square; letter: string }[] = [];
    for (const m of landings) {
      const p = pieceAtImpactBeforeBlast(prev, uci, m.idx);
      if (p) doomed.push({ sq: idxToSq(m.idx), letter: p.letter });
    }
    if (doomed.length > 0) setDoomedPieces(doomed);
    landings.forEach((m, i) => {
      const at = 500 + i * 220;
      const sq = idxToSq(m.idx);
      window.setTimeout(() => {
        if (animationsEnabled) {
          setAbilityAnim({
            kind: 'icbm',
            toSq: sq,
            color: m.firedBy,
            key: `icbm-${prev.ply}-${m.idx}-${Date.now()}`,
          });
        }
        sfx.playExplosion();
        setDoomedPieces((prevD) => prevD.filter((d) => d.sq !== sq));
      }, at);
    });
  };

  const triggerAbilityAnim = (
    prev: GameState,
    next: GameState,
    result: MoveResult,
  ): AbilityAnim | null => {
    const ab = result.abilityUsed;
    // Only kinds with a rendered overlay; harem is passive and icbm has its
    // own missile-marker UI, so they don't drive abilityAnim.
    if (ab !== 'frost' && ab !== 'warlord' && ab !== 'necromancer' && ab !== 'flight' && ab !== 'mutation' && ab !== 'slime' && ab !== 'juggernaut') {
      return null;
    }
    const moverColor = prev.turn;
    if (ab === 'flight') {
      // !L<from><to>[<promo>] — fly the selected piece from → to.
      const fromSq = result.uci.slice(2, 4) as Square;
      const toSq = result.uci.slice(4, 6) as Square;
      const flyer = prev.board[sqToIdx(fromSq)];
      return {
        kind: ab,
        fromSq,
        toSq,
        color: moverColor,
        flyerLetter: flyer?.letter,
        key: `${prev.ply}-${result.uci}-${Date.now()}`,
      };
    }
    if (ab === 'slime') {
      // !S<from><to> — the mini king at from grows toward the corner at to.
      return {
        kind: 'slime-expand',
        fromSq: result.uci.slice(2, 4) as Square,
        toSq: result.uci.slice(4, 6) as Square,
        color: moverColor,
        key: `${prev.ply}-${result.uci}-${Date.now()}`,
      };
    }
    const targetSq = result.uci.slice(2) as Square;
    let fromSq: Square | undefined;
    if (ab === 'warlord') {
      fromSq = kingSquareOf(next.board, moverColor) ?? undefined;
    }
    // Tier-2 edge charge uses the regular slide animation. Tier-3 slam
    // routes through 'jug-slam' so the jug leaps in place + amplified
    // ground impact. Tier-1 earthquake stays on the standard quake.
    const isJugSlam = ab === 'juggernaut' && jugTierOf(prev, moverColor) === 3;
    return {
      kind: isJugSlam ? 'jug-slam' : ab,
      fromSq,
      toSq: targetSq,
      color: moverColor,
      key: `${prev.ply}-${result.uci}-${Date.now()}`,
    };
  };

  const commitMove = async (uci: string, beforeTurn: 'w' | 'b', slides?: { from: Square; to: Square }[]): Promise<boolean> => {
    if (!game) return false;
    const res = applyMove(game, uci);
    if (!res) return false;

    if (res.result.abilityUsed === 'frost') sfx.playFreeze();
    // Slice fires at swing-start; its internal climax is timed to land at the
    // swing midpoint so the whistle leads INTO the blade's apex strike.
    else if (res.result.abilityUsed === 'warlord') sfx.playSlice();
    else if (res.result.abilityUsed === 'necromancer') sfx.playSpawn();
    else if (res.result.abilityUsed === 'flight') sfx.playFly();
    else if (res.result.abilityUsed === 'mutation') sfx.playMutate();
    else if (res.result.abilityUsed === 'icbm') sfx.playMissileLaunch();
    else if (res.result.abilityUsed === 'goofball') sfx.playGoofball();
    else if (res.result.abilityUsed === 'twin-jutsu') sfx.playTwinJutsu();
    else if (res.result.abilityUsed === 'slime') sfx.playSlimeExpand();
    else if (res.result.abilityUsed === 'juggernaut') sfx.playJugQuake();
    else if (res.result.castled) sfx.playCastle();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    // Suppress check feedback when the side now to move is the opponent and
    // they are Twin-Jutsu — leaking "Check!" would tell them which decoy is
    // their actual king. Their own client still announces it.
    // jugPhantomCheck: a sub-tier-3 Juggernaut can't actually be checked but
    // the design calls for the check sound to play anyway as a flavor cue.
    {
      const nextTurn = res.state.turn;
      const oppIsHidden = nextTurn !== myEngineColor && res.state.heroes[nextTurn].hero === 'twin-jutsu';
      if ((res.result.check || res.result.jugPhantomCheck) && !res.result.checkmate && !oppIsHidden) sfx.playCheck();
    }
    if (animationsEnabled) setAbilityAnim(triggerAbilityAnim(game, res.state, res.result));
    triggerMissileDetonations(game, res.state, uci);
    triggerWarlordDoom(game, res.result);
    triggerFrostShatter(game, res.state);
    triggerSlimeSplit(game, res.result);
    triggerJugTierShift(game, res.state, uci);

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
    // Skip the slide if an ability fired — abilityAnim already provides the
    // movement effect for Flight (and the others don't move pieces at all).
    // Twin-Jutsu is the exception: the two endpoints swap, so we drive a
    // pair of slides from each square into the other's spot. A Juggernaut
    // absorb also skips it — the jug-absorb overlay carries the attacker's
    // motion, and the Juggernaut itself must not appear to move.
    if (slides && slides.length > 0 && !res.result.abilityUsed && !wasJugAbsorb(game, res.state, uci)) {
      setSlideAnim({ moves: slides, key: Date.now() });
    } else if (res.result.abilityUsed === 'twin-jutsu' && animationsEnabled) {
      const a = uci.slice(2, 4) as Square;
      const b = uci.slice(4, 6) as Square;
      setSlideAnim({ moves: [{ from: a, to: b }, { from: b, to: a }], key: Date.now() });
    } else if (res.result.abilityUsed === 'goofball' && animationsEnabled) {
      // !G<from><to>[<promo>] — the puppeted piece moves from→to. Slide it
      // like a normal board move so the forced motion is readable.
      const from = uci.slice(2, 4) as Square;
      const to = uci.slice(4, 6) as Square;
      setSlideAnim({ moves: [{ from, to }], key: Date.now() });
    } else if (res.result.abilityUsed === 'juggernaut' && animationsEnabled) {
      // Diagonal charge (tier 2) moves the Juggernaut itself — slide it from
      // its pre-move square. Earthquake (tier 1) and Slam (tier 3) keep the
      // jug in place: pop the target square instead. Tier comes from the
      // PRE-move state.
      const from = kingSquareOf(game.board, beforeTurn);
      const to = uci.slice(2, 4) as Square;
      const tier = jugTierOf(game, beforeTurn);
      if (tier === 2 && from && from !== to) setSlideAnim({ moves: [{ from, to }], key: Date.now() });
      else if (tier !== 3) setPopAnim({ squares: [to], key: Date.now() });
    }
    // Pop the destination on promotions and on Necromancer spawns (a new
    // piece materialises). The uci's 5th char marks a promotion.
    if (animationsEnabled) {
      const popSquares: Square[] = [];
      if (uci.length >= 5 && /^[a-h][1-8][a-h][1-8]/.test(uci)) popSquares.push(uci.slice(2, 4) as Square);
      if (res.result.abilityUsed === 'necromancer') popSquares.push(uci.slice(2, 4) as Square);
      // Mutation transforms the piece into its merged form — pop it to sell
      // the change.
      if (res.result.abilityUsed === 'mutation') popSquares.push(uci.slice(2, 4) as Square);
      if (popSquares.length > 0) {
        setPopAnim({ squares: popSquares, key: Date.now() });
      }
    }
    sessionRef.current.send({ type: 'move', move: signed });
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);
    setAbilityArmed(false);

    checkBoardEnd(res.state);
    return true;
  };

  const applyLocalMove = async (
    from: Square, to: Square,
    // Standard Q/R/B/N + Mutation-hero merged Z (Q+N), C (R+N), A (B+N).
    promotion?: 'Q' | 'R' | 'B' | 'N' | 'Z' | 'C' | 'A',
    slides?: { from: Square; to: Square }[],
  ): Promise<boolean> => {
    if (!game || end) return false;
    if (!isMyTurn()) return false;
    if (viewPlyRef.current !== movesCountRef.current) return false;
    const beforeTurn = game.turn;
    let uci = from + to;
    if (promotion) uci += promotion.toLowerCase();
    return commitMove(uci, beforeTurn, slides);
  };

  const applyLocalAbility = async (
    hero: HeroKind, to: Square, from?: Square, promo?: string,
  ): Promise<boolean> => {
    if (!game || end) return false;
    if (!isMyTurn()) return false;
    if (viewPlyRef.current !== movesCountRef.current) return false;
    const beforeTurn = game.turn;
    return commitMove(abilityUci(hero, to, from, promo), beforeTurn);
  };

  const applyRemoteMove = async (move: Move) => {
    if (end) return;
    if (move.ply !== movesCountRef.current + 1) {
      console.warn('out of order move', move.ply, 'expected', movesCountRef.current + 1);
      return;
    }
    if (!gameRef.current) return;
    const prev = gameRef.current;
    const res = applyMove(prev, move.uci);
    if (!res) { console.warn('illegal remote move', move); return; }
    if (res.result.fenAfter !== move.fenAfter) {
      console.warn('FEN mismatch from peer', { ours: res.result.fenAfter, theirs: move.fenAfter });
    }
    if (res.result.abilityUsed === 'frost') sfx.playFreeze();
    // Slice fires at swing-start; its internal climax is timed to land at the
    // swing midpoint so the whistle leads INTO the blade's apex strike.
    else if (res.result.abilityUsed === 'warlord') sfx.playSlice();
    else if (res.result.abilityUsed === 'necromancer') sfx.playSpawn();
    else if (res.result.abilityUsed === 'flight') sfx.playFly();
    else if (res.result.abilityUsed === 'mutation') sfx.playMutate();
    else if (res.result.abilityUsed === 'icbm') sfx.playMissileLaunch();
    else if (res.result.abilityUsed === 'goofball') sfx.playGoofball();
    else if (res.result.abilityUsed === 'twin-jutsu') sfx.playTwinJutsu();
    else if (res.result.abilityUsed === 'slime') sfx.playSlimeExpand();
    else if (res.result.abilityUsed === 'juggernaut') sfx.playJugQuake();
    else if (res.result.castled) sfx.playCastle();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if ((res.result.check || res.result.jugPhantomCheck) && !res.result.checkmate) sfx.playCheck();
    if (animationsEnabled) setAbilityAnim(triggerAbilityAnim(prev, res.state, res.result));
    triggerMissileDetonations(prev, res.state, move.uci);
    triggerWarlordDoom(prev, res.result);
    triggerFrostShatter(prev, res.state);
    triggerSlimeSplit(prev, res.result);
    triggerJugTierShift(prev, res.state, move.uci);
    // Twin-Jutsu: deliberately skip the slide animation on the OPPONENT'S
    // screen. The swap re-masks both endpoints, so showing two pieces
    // sliding into each other's squares would leak which two squares
    // changed (and reveal at least one endpoint mid-slide). The mover
    // still sees their own slide in commitMove.
    if (res.result.abilityUsed === 'goofball' && animationsEnabled) {
      const from = move.uci.slice(2, 4) as Square;
      const to = move.uci.slice(4, 6) as Square;
      setSlideAnim({ moves: [{ from, to }], key: Date.now() });
    } else if (res.result.abilityUsed === 'juggernaut' && animationsEnabled) {
      // Mirror the mover's edge charge slide on this screen too. The
      // Earthquake (tier 1) and Slam (tier 3) abilities keep the jug put.
      const from = kingSquareOf(prev.board, prev.turn);
      const to = move.uci.slice(2, 4) as Square;
      const tier = jugTierOf(prev, prev.turn);
      if (tier === 2 && from && from !== to) setSlideAnim({ moves: [{ from, to }], key: Date.now() });
      else if (tier !== 3) setPopAnim({ squares: [to], key: Date.now() });
    }
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
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);
    setAbilityArmed(false);
    checkBoardEnd(res.state);
  };

  const checkBoardEnd = (s: GameState) => {
    // ICBM may have destroyed a king on this move — whichever side is missing
    // its king is the loser. Check this before isCheckmate (which assumes
    // both kings still exist).
    const whiteKing = kingSquareOf(s.board, 'w');
    const blackKing = kingSquareOf(s.board, 'b');
    if (!whiteKing) { finalize({ outcome: 'black', reason: 'checkmate' }); return; }
    if (!blackKing) { finalize({ outcome: 'white', reason: 'checkmate' }); return; }
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
    // Persist the hero picks so the match can be replayed/exported from
    // local history later. myHero/oppHero mirror the engine's W/B setup
    // (see the initialState call above); both are set once a game is live.
    const heroW = handoff.iAmWhite ? myHero : oppHero;
    const heroB = handoff.iAmWhite ? oppHero : myHero;
    // Re-derive the shuffled Twin-Jutsu back ranks (deterministic from
    // gameId) so replays of this record rebuild the same starting board.
    const backRanks = heroW && heroB ? backRanksForGame(heroW, heroB, gameId!) : undefined;
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
      ...(heroW && heroB ? { heroes: { w: heroW, b: heroB } } : {}),
      ...(backRanks && (backRanks.w || backRanks.b) ? { heroBackRanks: backRanks } : {}),
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

  // ----------------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------------
  const viewedState: GameState | null = game ? (states[viewPly] ?? states[0]) : null;
  const atPresent = !!game && viewPly === moves.length;

  const abilityTargetSet = useMemo<Set<Square>>(() => {
    if (!game || !atPresent || !abilityArmed) return new Set();
    // Goofball is two-click: while a from-square is pending, surface the
    // destination squares for that picked piece instead of the from-squares.
    if (game.heroes[myEngineColor].hero === 'goofball' && goofballFrom) {
      return new Set(goofballLegalDestinations(game, sqToIdx(goofballFrom)).map(idxToSq));
    }
    // Twin-Jutsu is also two-click — same pattern.
    if (game.heroes[myEngineColor].hero === 'twin-jutsu' && twinJutsuFrom) {
      return new Set(twinJutsuLegalDestinations(game, sqToIdx(twinJutsuFrom)).map(idxToSq));
    }
    // Flight too: once a piece is picked, surface its destination squares.
    if (game.heroes[myEngineColor].hero === 'flight' && flightFrom) {
      return new Set(flightLegalDestinations(game, sqToIdx(flightFrom)).map(idxToSq));
    }
    // Slime: once a mini king is picked, surface the expansion corners.
    if (game.heroes[myEngineColor].hero === 'slime' && slimeFrom) {
      return new Set(slimeLegalDestinations(game, sqToIdx(slimeFrom)).map(idxToSq));
    }
    return new Set(abilityTargets(game).map(idxToSq));
  }, [game, atPresent, abilityArmed, goofballFrom, twinJutsuFrom, flightFrom, slimeFrom, myEngineColor]);

  // Whole-blob shift options when a Slime big-king tile is selected. Drives
  // the direction-arrow UI on the board and click/drop resolution below.
  const slimeShiftOpts = useMemo<SlimeShiftOption[]>(() => {
    if (!game || !atPresent || abilityArmed || !selectedSquare) return [];
    const p = game.board[sqToIdx(selectedSquare)];
    if (!p || p.color !== myEngineColor || p.letter.toUpperCase() !== 'S') return [];
    return slimeShiftOptions(game, sqToIdx(selectedSquare));
  }, [game, atPresent, abilityArmed, selectedSquare, myEngineColor]);

  const legalTargets = useMemo(() => {
    if (!game || !atPresent) return [];
    if (abilityArmed) {
      // ICBM targets every square — drawing 64 green rings is noise. The
      // ghost crosshair on hover is the affordance instead.
      if (game.heroes[myEngineColor].hero === 'icbm') return [];
      // Ability target rings (green "special") — every legal ability target.
      return Array.from(abilityTargetSet).map((sq) => ({
        to: sq, isCapture: false, isMerge: true,
      }));
    }
    if (!selectedSquare) return [];
    // Selected blob tile: every square the blob can slide onto is clickable.
    // MergeBoard suppresses the dots for these and draws direction arrows.
    if (slimeShiftOpts.length > 0) {
      return slimeShiftOpts.flatMap((o) => o.entered.map((i) => ({
        to: idxToSq(i), isCapture: o.isCapture, isMerge: false,
      })));
    }
    return legalMovesFrom(game, selectedSquare).map((m) => ({
      to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial,
    }));
  }, [selectedSquare, game, abilityArmed, abilityTargetSet, atPresent, myEngineColor, slimeShiftOpts]);

  const lastMove = useMemo(() => {
    if (viewPly <= 0) return null;
    const uci = moves[viewPly - 1]?.uci;
    if (!uci) return null;
    if (uci.startsWith('!')) {
      const hero = uci[1];
      if (hero === 'T') {
        // Twin-Jutsu: tinting a hidden piece's square would leak which decoys
        // swapped. Only tint an endpoint whose piece was already revealed
        // (unmasked) before the swap — the opponent knew what stood there.
        // Two hidden pieces swapping shows no tint at all.
        const a = uci.slice(2, 4) as Square;
        const b = uci.slice(4, 6) as Square;
        const prev = states[viewPly - 1];
        if (!prev) return null;
        const aRevealed = !!prev.board[sqToIdx(a)] && !prev.masked[sqToIdx(a)];
        const bRevealed = !!prev.board[sqToIdx(b)] && !prev.masked[sqToIdx(b)];
        if (aRevealed && bRevealed) return { from: a, to: b };
        if (aRevealed) return { from: a, to: a };
        if (bRevealed) return { from: b, to: b };
        return null;
      }
      if (hero === 'G' || hero === 'L' || hero === 'S') {
        // Goofball / Flight move a visible piece from → to; Slime grows a
        // mini king (from) toward an empty corner (to) — tint both ends.
        const from = uci.slice(2, 4) as Square;
        const to = uci.slice(4, 6) as Square;
        return { from, to };
      }
      const sq = uci.slice(2, 4) as Square;
      return { from: sq, to: sq };
    }
    if (!/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
    return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square };
  }, [viewPly, moves, states]);

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
            if (r.abilityUsed === 'frost') sfx.playFreeze();
            else if (r.abilityUsed === 'warlord') sfx.playSlice();
            else if (r.abilityUsed === 'necromancer') sfx.playSpawn();
            else if (r.abilityUsed === 'flight') sfx.playFly();
            else if (r.abilityUsed === 'mutation') sfx.playMutate();
            else if (r.abilityUsed === 'icbm') sfx.playMissileLaunch();
            else if (r.abilityUsed === 'goofball') sfx.playGoofball();
            else if (r.abilityUsed === 'twin-jutsu') sfx.playTwinJutsu();
            else if (r.abilityUsed === 'slime') sfx.playSlimeExpand();
            else if (r.abilityUsed === 'juggernaut') sfx.playJugQuake();
            else if (r.castled) sfx.playCastle();
            else if (r.captured) sfx.playCapture();
            else sfx.playMove();
            if ((r.check || r.jugPhantomCheck) && !r.checkmate) sfx.playCheck();
          } else {
            if (r.captured) sfx.playCaptureReversed(); else sfx.playMoveReversed();
            if (r.check) sfx.playCheckReversed();
          }
        }
      }
      // Replay the ability animation when scrubbing *forward* into an
      // ability move; backward scrubs don't get a special effect.
      if (forward) {
        const r = results[p];
        const prevState = states[p];
        const nextState = states[p + 1];
        if (r && prevState && nextState) {
          if (animationsEnabled) {
            const anim = triggerAbilityAnim(prevState, nextState, r);
            setAbilityAnim(anim);
            if (anim?.kind === 'juggernaut-leap' && anim.fromSq) {
              setSlideAnim({ moves: [{ from: anim.fromSq, to: anim.toSq }], key: Date.now() });
            }
          }
          triggerMissileDetonations(prevState, nextState, r.uci);
          triggerWarlordDoom(prevState, r);
          triggerFrostShatter(prevState, nextState);
          triggerSlimeSplit(prevState, r);
          triggerJugTierShift(prevState, nextState, r.uci);
        }
      }
      return next;
    });
  };

  const canUndoView = viewPly > 0;
  const canRedoView = viewPly < results.length;

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

  useEffect(() => {
    if (!atPresent) { setSelectedSquare(null); setAbilityArmed(false); }
  }, [atPresent]);

  const isActiveSide = (c: Color): boolean => {
    if (end || !game) return false;
    if (moves.length === 0) return false;
    return (game.turn === 'w') === (c === 'white');
  };

  const attemptMove = (from: Square, to: Square, viaClick = false): boolean => {
    if (!game) return false;
    const piece = game.board[sqIdx(from)];
    const isPawn = piece && piece.letter.toUpperCase() === 'P';
    const targetRank = parseInt(to[1], 10);
    const isPromoting = !!isPawn && (targetRank === 8 || targetRank === 1);
    const slides = viaClick && animationsEnabled ? [{ from, to }] : undefined;
    if (isPromoting) {
      setPendingPromo({ from, to, slides });
    } else {
      void applyLocalMove(from, to, undefined, slides);
    }
    return true;
  };

  const resolvePromotion = (letter: PromotionLetter) => {
    if (!game || !pendingPromo) return;
    // Mutation hero side accepts the +knight fused options (Z/C/A); all
    // other heroes are limited to the standard four.
    const myHero = game.heroes[myEngineColor].hero;
    const allowed: PromotionLetter[] = myHero === 'mutation'
      ? ['Q', 'R', 'B', 'N', 'Z', 'C', 'A']
      : ['Q', 'R', 'B', 'N'];
    const valid = allowed.includes(letter) ? letter : 'Q';
    const { from, to, slides } = pendingPromo;
    setPendingPromo(null);
    void applyLocalMove(from, to, valid, slides);
  };

  const resolveAbilityPromotion = (letter: PromotionLetter) => {
    if (!pendingAbilityPromo) return;
    const { hero, from, to } = pendingAbilityPromo;
    const valid: PromotionLetter = (['Q', 'R', 'B', 'N'] as PromotionLetter[]).includes(letter)
      ? letter
      : 'Q';
    setPendingAbilityPromo(null);
    void applyLocalAbility(hero, to, from, valid);
  };

  const onSquareClick = (square: Square) => {
    if (end || !game) return;
    if (!atPresent) return;
    if (!isMyTurn()) { setSelectedSquare(null); setAbilityArmed(false); return; }
    if (abilityArmed) {
      const armedHero = game.heroes[myEngineColor].hero;
      if (armedHero === 'goofball') {
        // Goofball is two-click: first click picks an opponent piece,
        // second click picks where to send it.
        if (!goofballFrom) {
          if (abilityTargetSet.has(square)) {
            setGoofballFrom(square);
          } else {
            // Click on a non-target cancels the arming.
            setAbilityArmed(false);
          }
          return;
        }
        if (abilityTargetSet.has(square)) {
          // If the forced move would promote a pawn, ask the Goofball user
          // which piece to promote into; otherwise fire immediately.
          const piece = game.board[sqIdx(goofballFrom)];
          const isPawn = piece && piece.letter.toUpperCase() === 'P';
          const rank = parseInt(square[1], 10);
          const promoting = !!isPawn && (rank === 8 || rank === 1);
          if (promoting) {
            setPendingAbilityPromo({
              hero: 'goofball',
              from: goofballFrom,
              to: square,
              pickerSquare: square,
              color: piece!.color,
            });
          } else {
            void applyLocalAbility('goofball', square, goofballFrom);
          }
          setGoofballFrom(null);
          return;
        }
        // Click off a legal destination resets the pick (back to picking a piece).
        setGoofballFrom(null);
        return;
      }
      if (armedHero === 'twin-jutsu') {
        // Two-click swap: first click picks one of your own pieces, second
        // click picks the partner. The order is symmetric in the engine but
        // we surface from→to in the UCI to drive the slide animation.
        if (!twinJutsuFrom) {
          if (abilityTargetSet.has(square)) {
            setTwinJutsuFrom(square);
          } else {
            setAbilityArmed(false);
          }
          return;
        }
        if (abilityTargetSet.has(square)) {
          // If either swapped piece is a pawn landing on its promotion rank,
          // prompt the player for which piece to promote into.
          const aPiece = game.board[sqIdx(twinJutsuFrom)];
          const bPiece = game.board[sqIdx(square)];
          // After swap, aPiece sits on `square` and bPiece sits on `twinJutsuFrom`.
          const promoRankFor = (p: { color: 'w' | 'b' } | null | undefined) =>
            p?.color === 'w' ? 8 : 1;
          const aLandsRank = parseInt(square[1], 10);
          const bLandsRank = parseInt(twinJutsuFrom[1], 10);
          let promoSq: Square | null = null;
          let promoColor: 'w' | 'b' | null = null;
          if (aPiece && aPiece.letter.toUpperCase() === 'P' && aLandsRank === promoRankFor(aPiece)) {
            promoSq = square; promoColor = aPiece.color;
          } else if (bPiece && bPiece.letter.toUpperCase() === 'P' && bLandsRank === promoRankFor(bPiece)) {
            promoSq = twinJutsuFrom; promoColor = bPiece.color;
          }
          if (promoSq && promoColor) {
            setPendingAbilityPromo({
              hero: 'twin-jutsu',
              from: twinJutsuFrom,
              to: square,
              pickerSquare: promoSq,
              color: promoColor,
            });
          } else {
            void applyLocalAbility('twin-jutsu', square, twinJutsuFrom);
          }
          setTwinJutsuFrom(null);
          return;
        }
        setTwinJutsuFrom(null);
        return;
      }
      if (armedHero === 'flight') {
        // Two-click teleport: first click picks one of your own pieces,
        // second click picks the empty square it flies to.
        if (!flightFrom) {
          if (abilityTargetSet.has(square)) {
            setFlightFrom(square);
          } else {
            setAbilityArmed(false);
          }
          return;
        }
        if (abilityTargetSet.has(square)) {
          // A pawn flying onto its promotion rank promotes — ask which piece.
          const piece = game.board[sqIdx(flightFrom)];
          const isPawn = piece && piece.letter.toUpperCase() === 'P';
          const rank = parseInt(square[1], 10);
          const promoting = !!isPawn && (piece!.color === 'w' ? rank === 8 : rank === 1);
          if (promoting) {
            setPendingAbilityPromo({
              hero: 'flight',
              from: flightFrom,
              to: square,
              pickerSquare: square,
              color: piece!.color,
            });
          } else {
            void applyLocalAbility('flight', square, flightFrom);
          }
          setFlightFrom(null);
          return;
        }
        // Click off a legal destination resets the pick (back to picking a piece).
        setFlightFrom(null);
        return;
      }
      if (armedHero === 'slime') {
        // Two-click expansion: first click picks a mini king, second click
        // picks the diagonal corner of the quadrant it grows into.
        if (!slimeFrom) {
          if (abilityTargetSet.has(square)) {
            setSlimeFrom(square);
          } else {
            setAbilityArmed(false);
          }
          return;
        }
        if (abilityTargetSet.has(square)) {
          void applyLocalAbility('slime', square, slimeFrom);
          setSlimeFrom(null);
          return;
        }
        // Click off a legal corner resets the pick (back to picking a king).
        setSlimeFrom(null);
        return;
      }
      if (abilityTargetSet.has(square)) {
        void applyLocalAbility(armedHero, square);
        return;
      }
      // Click on a non-target square cancels the ability arming.
      setAbilityArmed(false);
      return;
    }
    const target = legalTargets.find((t) => t.to === square);
    if (selectedSquare === square) { setSelectedSquare(null); return; }
    // Selected blob: resolve the click to a whole-blob slide and fire its
    // canonical uci — the raw selected→clicked pair isn't necessarily a move
    // the engine recognises (shared entered squares resolve orthogonal-first).
    if (selectedSquare && slimeShiftOpts.length > 0) {
      const opt = resolveSlimeShiftClick(slimeShiftOpts, sqIdx(square));
      if (opt) {
        void applyLocalMove(opt.uci.slice(0, 2) as Square, opt.uci.slice(2, 4) as Square);
        return;
      }
    }
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

  const onDragStartSquare = (from: Square) => {
    if (end || !game || !atPresent || !isMyTurn()) return;
    if (abilityArmed) setAbilityArmed(false);
    const piece = game.board[sqIdx(from)];
    if (!piece || piece.color !== myEngineColor) return;
    if (selectedSquare !== from) setSelectedSquare(from);
  };

  const onPieceDrop = (from: Square, to: Square): boolean => {
    if (end || !game || !atPresent || !isMyTurn()) return false;
    const piece = game.board[sqIdx(from)];
    if (!piece || piece.color !== myEngineColor) return false;
    // Dragging the big king: the grabbed tile's travel gives the slide
    // direction; drops further out resolve like a click on an entered square.
    if (piece.letter.toUpperCase() === 'S') {
      const opts = slimeShiftOptions(game, sqIdx(from));
      const df = to.charCodeAt(0) - from.charCodeAt(0);
      const dr = parseInt(to[1], 10) - parseInt(from[1], 10);
      const opt = (Math.abs(df) <= 1 && Math.abs(dr) <= 1
        ? opts.find((o) => o.df === df && o.dr === dr)
        : undefined) ?? resolveSlimeShiftClick(opts, sqIdx(to));
      if (!opt) return false;
      void applyLocalMove(opt.uci.slice(0, 2) as Square, opt.uci.slice(2, 4) as Square);
      return true;
    }
    const legal = legalMovesFrom(game, from).some((m) => m.to === to);
    if (!legal) return false;
    return attemptMove(from, to);
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

  const inCheck = !end && !!game
    && !(game.turn !== myEngineColor && game.heroes[game.turn].hero === 'twin-jutsu')
    && isInCheck(game, game.turn);

  // King glows from the heroes picked. Slime suppresses the halo — its
  // animated goo bubble already reads as the slime king.
  const kingGlows = useMemo(() => {
    if (!viewedState) return undefined;
    const w = viewedState.heroes.w.hero;
    const b = viewedState.heroes.b.hero;
    return {
      w: w === 'slime' ? undefined : HERO_INFO[w].glowColor,
      b: b === 'slime' ? undefined : HERO_INFO[b].glowColor,
    };
  }, [viewedState]);

  const boardForRender = viewedState
    ? (viewedState.board as unknown as (MergePieceShape | null)[])
    : (new Array(64).fill(null) as (MergePieceShape | null)[]);

  const captures = useMemo(() => {
    // Replay the engine's starting army for this matchup so the diff lines
    // up with whatever variants the heroes inject (different back ranks,
    // hero-specific letter variations, etc).
    const wHero = handoff.iAmWhite ? myHero : oppHero;
    const bHero = handoff.iAmWhite ? oppHero : myHero;
    if (!viewedState || !wHero || !bHero) {
      return { byWhite: { P: 0, N: 0, B: 0, R: 0, Q: 0 }, byBlack: { P: 0, N: 0, B: 0, R: 0, Q: 0 }, advantage: 0 };
    }
    const initBoard = initialState(wHero, bHero, backRanksForGame(wHero, bHero, gameId!)).board as unknown as (MergePieceShape | null)[];
    return computeCaptures(boardForRender, initBoard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardForRender, myHero, oppHero, handoff.iAmWhite, gameId]);
  const emojiBubble = emojiBubbleEvent
    ? {
        emoji: emojiBubbleEvent.emoji,
        key: emojiBubbleEvent.key,
        squares: kingSquaresForBoard(
          boardForRender,
          emojiBubbleEvent.side === 'me' ? myEngineColor : myEngineColor === 'w' ? 'b' : 'w',
        ),
      }
    : null;

  // Cooldown turn counts (for the abilities panel).
  const myCooldownTurns = game ? turnsUntilReady(game, myEngineColor) : 0;
  const oppCooldownTurns = game ? turnsUntilReady(game, myEngineColor === 'w' ? 'b' : 'w') : 0;

  // Twin-Jutsu mask split. Squares carrying my own masked pieces get the
  // ghosted-king overlay (self-perspective); opponent's masked pieces render
  // as solid king icons in their color (king-shaped decoys hiding the truth).
  const { maskedSelfSqs, maskedAsKingSqs } = useMemo(() => {
    const selfSqs: Square[] = [];
    const oppSqs: Square[] = [];
    if (viewedState) {
      for (let i = 0; i < 64; i++) {
        if (!viewedState.masked[i]) continue;
        const p = viewedState.board[i];
        if (!p) continue;
        const sq = idxToSq(i);
        if (p.color === myEngineColor) selfSqs.push(sq);
        else oppSqs.push(sq);
      }
    }
    return { maskedSelfSqs: selfSqs, maskedAsKingSqs: oppSqs };
  }, [viewedState, myEngineColor]);

  // Slime rendering: big-king blobs (stretched sprite spanning 2×2 tiles)
  // plus the squares of any mini kings (goo overlay).
  const { slimeBigKings, slimeKingSqs } = useMemo(() => {
    const bigs: { tiles: Square[]; color: 'w' | 'b' }[] = [];
    const minis: Square[] = [];
    if (viewedState) {
      for (const g of viewedState.slimes) {
        const ref = viewedState.board[g.tiles[0]];
        if (!ref) continue;
        bigs.push({ tiles: g.tiles.map(idxToSq), color: ref.color });
      }
      for (let i = 0; i < 64; i++) {
        const p = viewedState.board[i];
        if (!p || p.letter.toUpperCase() !== 'K') continue;
        if (viewedState.heroes[p.color].hero === 'slime') minis.push(idxToSq(i));
      }
    }
    return { slimeBigKings: bigs, slimeKingSqs: minis };
  }, [viewedState]);

  // Juggernaut rendering: the colorless king + tier pips, plus stun overlays
  // on slammed squares and the live earthquake waves.
  const { juggernauts, stunnedSqs, earthquakeOverlays } = useMemo(() => {
    const jugs: { sq: Square; tier: number }[] = [];
    const stuns: Square[] = [];
    const eqs: { sq: Square; df: number; dr: number; color: 'w' | 'b' }[] = [];
    if (viewedState) {
      for (const c of ['w', 'b'] as const) {
        if (viewedState.heroes[c].hero !== 'juggernaut') continue;
        const sq = kingSquareOf(viewedState.board, c);
        if (sq) jugs.push({ sq, tier: viewedState.jugTier[c] });
      }
      for (const s of viewedState.stunned) {
        if (viewedState.ply < s.expiresAtPly) stuns.push(idxToSq(s.idx));
      }
      for (const eq of viewedState.earthquakes ?? []) {
        eqs.push({ sq: idxToSq(eq.idx), df: eq.df, dr: eq.dr, color: eq.color });
      }
    }
    return { juggernauts: jugs, stunnedSqs: stuns, earthquakeOverlays: eqs };
  }, [viewedState]);

  const bothPicked = myHero != null && oppHero != null;

  return (
    <div className="game-layout hero-game-layout">
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

      <div className="hero-side-column">
        {bothPicked && myHero && oppHero ? (
          <HeroAbilities
            perspective={handoff.iAmWhite ? 'white' : 'black'}
            myHero={myHero}
            oppHero={oppHero}
            myCooldownTurns={myCooldownTurns}
            oppCooldownTurns={oppCooldownTurns}
            myTurn={isMyTurn() && !end && atPresent}
            hasTargets={!!game && atPresent && abilityTargets(game).length > 0}
            armed={abilityArmed}
            onArm={() => { setSelectedSquare(null); setAbilityArmed(true); }}
            onCancel={() => setAbilityArmed(false)}
            myJugTier={game ? jugTierOf(game, myEngineColor) : 0}
            oppJugTier={game ? jugTierOf(game, myEngineColor === 'w' ? 'b' : 'w') : 0}
          />
        ) : (
          <div className="hero-side-placeholder muted small">
            Pick your hero to begin.
          </div>
        )}
      </div>

      <div className="board-column">
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
        <div className={`board-wrap${!atPresent ? ' viewing-history' : ''}`}>
          <MergeBoard
            board={boardForRender}
            orientation={handoff.iAmWhite ? 'white' : 'black'}
            selectedSquare={atPresent ? (goofballFrom ?? twinJutsuFrom ?? flightFrom ?? slimeFrom ?? selectedSquare) : null}
            legalTargets={atPresent ? legalTargets : []}
            onSquareClick={onSquareClick}
            onPieceDrop={onPieceDrop}
            onDragStartSquare={onDragStartSquare}
            interactive={!end && isMyTurn() && atPresent && !pendingPromo}
            draggable={!end && isMyTurn() && atPresent && !abilityArmed && !pendingPromo}
            kingGlows={kingGlows}
            frozenSquares={
              viewedState
                ? viewedState.frozen
                    .filter((f) => viewedState.ply < f.expiresAtPly)
                    .map((f) => idxToSq(f.idx))
                : null
            }
            frozenCrackingSquares={
              viewedState
                ? viewedState.frozen
                    .filter((f) => f.expiresAtPly - viewedState.ply === 1)
                    .map((f) => idxToSq(f.idx))
                : null
            }
            missiles={
              viewedState
                ? viewedState.missiles.map((m) => ({
                    sq: idxToSq(m.idx),
                    pliesLeft: Math.max(0, m.landsAtPly - viewedState.ply),
                    firedBy: m.firedBy,
                  }))
                : undefined
            }
            ghostCrosshair={
              abilityArmed && game && game.heroes[myEngineColor].hero === 'icbm'
                ? { firedBy: myEngineColor }
                : null
            }
            doomedPieces={doomedPieces.map((d) => ({
              sq: d.sq,
              letter: d.letter as any,
            }))}
            abilityAnim={abilityAnim}
            lastMove={lastMove}
            slideMoves={slideAnim?.moves}
            slideKey={slideAnim?.key}
            popSquares={popAnim?.squares}
            popKey={popAnim?.key}
            maskedSelfSquares={maskedSelfSqs}
            maskedAsKingSquares={maskedAsKingSqs}
            slimeBigKings={slimeBigKings}
            slimeShiftArrows={slimeShiftOpts.map((o) => ({ df: o.df, dr: o.dr, isCapture: o.isCapture }))}
            slimeKingSquares={slimeKingSqs}
            juggernauts={juggernauts}
            stunnedSquares={stunnedSqs}
            earthquakes={earthquakeOverlays}
            emojiBubble={emojiBubble}
          />
          {pendingPromo && game && (
            <PromotionPicker
              square={pendingPromo.to}
              color={game.turn}
              orientation={handoff.iAmWhite ? 'white' : 'black'}
              options={
                game.heroes[myEngineColor].hero === 'mutation'
                  ? ['Q', 'R', 'B', 'N', 'Z', 'C', 'A']
                  : ['Q', 'R', 'B', 'N']
              }
              onPick={resolvePromotion}
              onCancel={() => setPendingPromo(null)}
            />
          )}
          {pendingAbilityPromo && (
            <PromotionPicker
              square={pendingAbilityPromo.pickerSquare}
              color={pendingAbilityPromo.color}
              orientation={handoff.iAmWhite ? 'white' : 'black'}
              options={['Q', 'R', 'B', 'N']}
              onPick={resolveAbilityPromotion}
              onCancel={() => setPendingAbilityPromo(null)}
            />
          )}
          {!bothPicked && (
            <div className="hero-picker-overlay">
              <HeroPicker
                side={handoff.iAmWhite ? 'white' : 'black'}
                myPick={myHero}
                oppPick={oppHero}
                pool={heroPoolForGame(gameId)}
                onPick={handlePickHero}
              />
            </div>
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
      </div>

      <aside className="side-panel">
        <div className="game-meta">
          <div className="game-meta-title">Hero · {tc.label}</div>
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
            disabled={moves.length === 0 || !bothPicked}
            onClick={() => {
              if (!bothPicked || !myHero || !oppHero) return;
              const heroW: HeroKind = handoff.iAmWhite ? myHero : oppHero;
              const heroB: HeroKind = handoff.iAmWhite ? oppHero : myHero;
              const exp = buildGameExport({
                variant: 'hero',
                gameId: gameId!,
                timeControlId: tc.id,
                white: handoff.iAmWhite ? me : opp,
                black: handoff.iAmWhite ? opp : me,
                startedAt: startedAtRef.current,
                endedAt: end ? Date.now() : null,
                outcome: end?.outcome ?? null,
                reason: end?.reason ?? null,
                moves,
                heroes: { w: heroW, b: heroB },
                heroBackRanks: backRanksForGame(heroW, heroB, gameId!),
              });
              downloadGameExport(exp);
            }}
            title="Download this game as JSON for the Review page"
          >
            Export
          </button>
          {!end && bothPicked && (
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
            <ChatComposer
              value={chatInput}
              onChange={setChatInput}
              onSend={sendChatMessage}
              emojiEnabled={inGameEmojisEnabled}
            />
          </div>
        )}
      </aside>

      {game && <span style={{ display: 'none' }}>{toFen(game)}</span>}
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
  }
}
