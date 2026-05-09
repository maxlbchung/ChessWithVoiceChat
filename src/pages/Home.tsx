import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TimeModeSelector } from '../components/TimeModeSelector';
import { TIME_CONTROLS, type TimeControl } from '../lib/timeControls';
import { useIdentityStore } from '../store/identityStore';
import { Matchmaker } from '../lib/matchmaking';
import { PeerSession, makePeerId } from '../lib/peer';
import { setLobbyHandoff } from '../store/lobbyHandoff';

export function Home() {
  const { identity, rating, loaded, signUp } = useIdentityStore();
  const [handleInput, setHandleInput] = useState('');
  const [selected, setSelected] = useState<TimeControl | null>(TIME_CONTROLS[2] ?? null);
  const [searching, setSearching] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string>('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!searching) return;
    if (!identity || !selected) return;

    let cancelled = false;
    const matcher = new Matchmaker();
    let session: PeerSession | null = null;

    const myPeerId = makePeerId();
    setStatusMsg(`Looking for ${selected.label} ${selected.category}…`);

    // Spin up a peer eagerly so we're discoverable when matched
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
          setSearching(false);
          setStatusMsg('Search cancelled.');
          session?.destroy();
          return;
        }
        // Hand the live session over to the Game page so we don't reconnect
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
        setSearching(false);
      },
    });

    return () => {
      cancelled = true;
      matcher.cancel();
      // Don't destroy the session here — the Game page may have taken it.
    };
  }, [searching, identity, selected, rating, navigate]);

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

  return (
    <div className="page">
      <div className="hero">
        <h1 className="page-title">Find a game</h1>
        <p className="muted">
          Pick a time control — moves go peer-to-peer, voice chat rides along, and your rating
          updates locally from signed game records.
        </p>
      </div>

      <TimeModeSelector
        selectedId={selected?.id ?? null}
        onSelect={(tc) => setSelected(tc)}
      />

      <div className="play-row">
        {!searching ? (
          <button
            className="primary-btn big"
            disabled={!selected}
            onClick={() => setSearching(true)}
          >
            Play {selected?.label} {selected?.category}
          </button>
        ) : (
          <button className="secondary-btn big" onClick={() => setSearching(false)}>
            Cancel search
          </button>
        )}
        {statusMsg && <div className="status-msg">{statusMsg}</div>}
      </div>
    </div>
  );
}
