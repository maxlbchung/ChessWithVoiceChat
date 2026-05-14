import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayerCard, type VoiceState } from '../components/PlayerCard';
import { VoiceControls } from '../components/VoiceControls';
import { FinishAvatar, ResultAvatar } from '../components/EndScreenAvatars';
import { useSettingsStore } from '../store/settingsStore';
import { MergeBoard } from '../components/MergeBoard';
import { HeroPicker } from '../components/HeroPicker';
import { HeroAbilities } from '../components/HeroAbilities';
import { takeLobbyHandoff } from '../store/lobbyHandoff';
import { useRematch, shouldKeepSessionForRematch } from '../lib/useRematch';
import type { PeerSession } from '../lib/peer';
import { useIdentityStore } from '../store/identityStore';
import { getTimeControl, lowTimeThresholdMs } from '../lib/timeControls';
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
import { renderChatText } from '../lib/linkify';
import {
  abilityTargets,
  abilityUci,
  applyMove,
  HERO_INFO,
  idxToSq,
  initialState,
  isCheckmate,
  isFiftyMoveRule,
  isInCheck,
  isInsufficientMaterial,
  isStalemate,
  isThreefoldRepetition,
  kingSquareOf,
  legalMovesFrom,
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
  const [moves, setMoves] = useState<SignedMove[]>([]);
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
  // True when the ability is "armed" — next board click selects the target.
  const [abilityArmed, setAbilityArmed] = useState(false);
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
    publicKeyHex: identity.publicKeyHex,
    handle: identity.handle,
    rating,
  };
  const opp: PlayerInfo = {
    publicKeyHex: handoff.partnerPubKey,
    handle: handoff.partnerHandle,
    rating: handoff.partnerRating,
  };

  const { showOpponentNames, showOpponentAvatars, chatEnabled } = useSettingsStore();
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

  // Initialise the engine once both heroes are known.
  useEffect(() => {
    if (game || myHero == null || oppHero == null) return;
    const heroW = handoff.iAmWhite ? myHero : oppHero;
    const heroB = handoff.iAmWhite ? oppHero : myHero;
    const init = initialState(heroW, heroB);
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
      if (msg.type === 'hero-pick') { setOppHero(msg.hero); return; }
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
        publicKeyHex: identity.publicKeyHex,
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
  const triggerAbilityAnim = (
    prev: GameState,
    next: GameState,
    result: MoveResult,
  ): AbilityAnim | null => {
    if (!result.abilityUsed) return null;
    const targetSq = result.uci.slice(2);
    const moverColor = prev.turn;
    let fromSq: Square | undefined;
    if (result.abilityUsed === 'flight') {
      fromSq = kingSquareOf(prev.board, moverColor) ?? undefined;
    } else if (result.abilityUsed === 'knight') {
      fromSq = kingSquareOf(next.board, moverColor) ?? undefined;
    }
    return {
      kind: result.abilityUsed,
      fromSq,
      toSq: targetSq,
      color: moverColor,
      key: `${prev.ply}-${result.uci}-${Date.now()}`,
    };
  };

  const commitMove = async (uci: string, beforeTurn: 'w' | 'b'): Promise<boolean> => {
    if (!game) return false;
    const res = applyMove(game, uci);
    if (!res) return false;

    if (res.result.abilityUsed === 'frost') sfx.playFreeze();
    else if (res.result.abilityUsed === 'knight') sfx.playSlice();
    else if (res.result.abilityUsed === 'necromancer') sfx.playSpawn();
    else if (res.result.abilityUsed === 'flight') sfx.playFly();
    else if (res.result.castled) sfx.playCastle();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.check && !res.result.checkmate) sfx.playCheck();
    setAbilityAnim(triggerAbilityAnim(game, res.state, res.result));

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

    const signed = await signMove(identity, gameId!, uci, res.result.fenAfter, ply, wMs, bMs);
    setMoves((m) => [...m, signed]);
    setGame(res.state);
    setStates((s) => [...s, res.state]);
    setResults((r) => [...r, res.result]);
    setViewPly((p) => p + 1);
    sessionRef.current.send({ type: 'move', move: signed });
    setDrawOfferedByOpp(false);
    setDrawOfferedByMe(false);
    setSelectedSquare(null);
    setAbilityArmed(false);

    checkBoardEnd(res.state);
    return true;
  };

  const applyLocalMove = async (
    from: Square, to: Square, promotion?: 'Q' | 'R' | 'B' | 'N',
  ): Promise<boolean> => {
    if (!game || end) return false;
    if (!isMyTurn()) return false;
    if (viewPlyRef.current !== movesCountRef.current) return false;
    const beforeTurn = game.turn;
    let uci = from + to;
    if (promotion) uci += promotion.toLowerCase();
    return commitMove(uci, beforeTurn);
  };

  const applyLocalAbility = async (hero: HeroKind, to: Square): Promise<boolean> => {
    if (!game || end) return false;
    if (!isMyTurn()) return false;
    if (viewPlyRef.current !== movesCountRef.current) return false;
    const beforeTurn = game.turn;
    return commitMove(abilityUci(hero, to), beforeTurn);
  };

  const applyRemoteMove = async (move: SignedMove) => {
    if (end) return;
    const ok = await verifyMove(opp.publicKeyHex, gameId!, move);
    if (!ok) { console.warn('signature failed for move', move); return; }
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
    else if (res.result.abilityUsed === 'knight') sfx.playSlice();
    else if (res.result.abilityUsed === 'necromancer') sfx.playSpawn();
    else if (res.result.abilityUsed === 'flight') sfx.playFly();
    else if (res.result.castled) sfx.playCastle();
    else if (res.result.captured) sfx.playCapture();
    else sfx.playMove();
    if (res.result.check && !res.result.checkmate) sfx.playCheck();
    setAbilityAnim(triggerAbilityAnim(prev, res.state, res.result));
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
    const summaries = await loadSummaries();
    const gamesPlayed = summaries.length;
    const before = rating;
    const after = newRating(before, opp.rating, myResult, gamesPlayed);
    await setRating(after);
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
    return new Set(abilityTargets(game).map((idx) => {
      const file = idx % 8;
      const rankFromTop = Math.floor(idx / 8);
      const rank = 7 - rankFromTop;
      return String.fromCharCode(97 + file) + String.fromCharCode(49 + rank);
    }));
  }, [game, atPresent, abilityArmed]);

  const legalTargets = useMemo(() => {
    if (!game || !atPresent) return [];
    if (abilityArmed) {
      // Ability target rings (green "special") — every legal ability target.
      return Array.from(abilityTargetSet).map((sq) => ({
        to: sq, isCapture: false, isMerge: true,
      }));
    }
    if (!selectedSquare) return [];
    return legalMovesFrom(game, selectedSquare).map((m) => ({
      to: m.to, isCapture: m.isCapture, isMerge: m.isSpecial,
    }));
  }, [selectedSquare, game, abilityArmed, abilityTargetSet, atPresent]);

  const lastMove = useMemo(() => {
    if (viewPly <= 0) return null;
    const uci = moves[viewPly - 1]?.uci;
    if (!uci || !/^[a-h][1-8][a-h][1-8]/.test(uci)) return null;
    return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square };
  }, [viewPly, moves]);

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
            else if (r.abilityUsed === 'knight') sfx.playSlice();
            else if (r.abilityUsed === 'necromancer') sfx.playSpawn();
            else if (r.abilityUsed === 'flight') sfx.playFly();
            else if (r.castled) sfx.playCastle();
            else if (r.captured) sfx.playCapture();
            else sfx.playMove();
            if (r.check && !r.checkmate) sfx.playCheck();
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
          setAbilityAnim(triggerAbilityAnim(prevState, nextState, r));
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

  const attemptMove = (from: Square, to: Square): boolean => {
    if (!game) return false;
    const piece = game.board[sqIdx(from)];
    const isPawn = piece && piece.letter.toUpperCase() === 'P';
    const targetRank = parseInt(to[1], 10);
    const isPromoting = !!isPawn && (targetRank === 8 || targetRank === 1);
    if (isPromoting) {
      const choice = window.prompt('Promote to (Q/R/B/N)?', 'Q');
      const promo = (choice ?? 'Q').toUpperCase();
      const valid = ['Q', 'R', 'B', 'N'].includes(promo) ? (promo as 'Q' | 'R' | 'B' | 'N') : 'Q';
      void applyLocalMove(from, to, valid);
    } else {
      void applyLocalMove(from, to);
    }
    return true;
  };

  const onSquareClick = (square: Square) => {
    if (end || !game) return;
    if (!atPresent) return;
    if (!isMyTurn()) { setSelectedSquare(null); setAbilityArmed(false); return; }
    if (abilityArmed) {
      if (abilityTargetSet.has(square)) {
        void applyLocalAbility(game.heroes[myEngineColor].hero, square);
        return;
      }
      // Click on a non-target square cancels the ability arming.
      setAbilityArmed(false);
      return;
    }
    const target = legalTargets.find((t) => t.to === square);
    if (selectedSquare === square) { setSelectedSquare(null); return; }
    if (selectedSquare && target) {
      attemptMove(selectedSquare, square);
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

  const inCheck = !end && !!game && isInCheck(game, game.turn);

  // King glows from the heroes picked.
  const kingGlows = useMemo(() => {
    if (!viewedState) return undefined;
    return {
      w: HERO_INFO[viewedState.heroes.w.hero].glowColor,
      b: HERO_INFO[viewedState.heroes.b.hero].glowColor,
    };
  }, [viewedState]);

  const boardForRender = viewedState
    ? (viewedState.board as unknown as (MergePieceShape | null)[])
    : (new Array(64).fill(null) as (MergePieceShape | null)[]);

  // Cooldown turn counts (for the abilities panel).
  const myCooldownTurns = game ? turnsUntilReady(game, myEngineColor) : 0;
  const oppCooldownTurns = game ? turnsUntilReady(game, myEngineColor === 'w' ? 'b' : 'w') : 0;

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
        />
        <div className={`board-wrap${!atPresent ? ' viewing-history' : ''}`}>
          <MergeBoard
            board={boardForRender}
            orientation={handoff.iAmWhite ? 'white' : 'black'}
            selectedSquare={atPresent ? selectedSquare : null}
            legalTargets={atPresent ? legalTargets : []}
            onSquareClick={onSquareClick}
            onPieceDrop={onPieceDrop}
            onDragStartSquare={onDragStartSquare}
            interactive={!end && isMyTurn() && atPresent}
            draggable={!end && isMyTurn() && atPresent && !abilityArmed}
            kingGlows={kingGlows}
            frozenSquare={
              viewedState && viewedState.frozen && viewedState.ply < viewedState.frozen.expiresAtPly
                ? idxToSq(viewedState.frozen.idx)
                : null
            }
            abilityAnim={abilityAnim}
            lastMove={lastMove}
          />
          {!bothPicked && (
            <div className="hero-picker-overlay">
              <HeroPicker
                side={handoff.iAmWhite ? 'white' : 'black'}
                myPick={myHero}
                oppPick={oppHero}
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
