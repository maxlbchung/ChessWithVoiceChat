import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useIdentityStore } from '../store/identityStore';
import { PeerSession, makePeerId } from '../lib/peer';
import { getIceServers } from '../lib/iceConfig';
import { setLobbyHandoff } from '../store/lobbyHandoff';
import { getTimeControl } from '../lib/timeControls';

export function Join() {
  const { hostPeerId } = useParams<{ hostPeerId: string }>();
  const { identity, rating, loaded, signUp } = useIdentityStore();
  const [handleInput, setHandleInput] = useState('');
  const [statusMsg, setStatusMsg] = useState('Connecting…');
  const [errored, setErrored] = useState(false);
  const navigate = useNavigate();
  const ranRef = useRef(false);

  useEffect(() => {
    if (!loaded || !identity || !hostPeerId) return;
    if (ranRef.current) return;
    ranRef.current = true;

    let cancelled = false;
    let handedOff = false;
    let session: PeerSession | null = null;
    const myPeerId = makePeerId();

    (async () => {
      const iceServers = await getIceServers();
      if (cancelled) return;
      session = new PeerSession(myPeerId, {
        onOpen: () => {
          if (cancelled) return;
          setStatusMsg('Reaching host…');
          session!.connectTo(hostPeerId);
        },
        onConnect: () => {
          if (cancelled) return;
          setStatusMsg('Identifying…');
          session!.send({
            type: 'hello',
            publicKeyHex: identity.publicKeyHex,
            handle: identity.handle,
            rating,
          });
        },
        onMessage: (msg) => {
          if (cancelled) return;
          if (msg.type !== 'lobby-confirm') return;
          const tc = getTimeControl(msg.timeControlId);
          if (!tc) {
            setStatusMsg(`Unknown time control: ${msg.timeControlId}`);
            setErrored(true);
            return;
          }
          handedOff = true;
          setLobbyHandoff({
            gameId: msg.gameId,
            session: session!,
            myPeerId,
            partnerPeerId: hostPeerId,
            partnerPubKey: msg.hostPubKey,
            partnerHandle: msg.hostHandle,
            partnerRating: msg.hostRating,
            iAmWhite: msg.iAmWhite,
            timeControlId: msg.timeControlId,
          });
          navigate(`/play/${msg.gameId}`);
        },
        onError: (err) => {
          if (cancelled) return;
          setStatusMsg(`Could not reach host: ${err.message}`);
          setErrored(true);
        },
        onClose: () => {
          if (cancelled || handedOff) return;
          setStatusMsg('Host closed the connection.');
          setErrored(true);
        },
      }, iceServers);
    })();

    return () => {
      cancelled = true;
      if (!handedOff) {
        try { session?.destroy(); } catch {}
      }
    };
  }, [loaded, identity, rating, hostPeerId, navigate]);

  if (!loaded) {
    return <div className="page-narrow muted">Loading…</div>;
  }

  if (!identity) {
    return (
      <div className="page-narrow">
        <h1 className="page-title">Join a game</h1>
        <p className="muted">
          Pick a handle to play. We'll generate a keypair locally — no signup, no email.
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
            maxLength={20}
          />
          <button className="primary-btn" type="submit" disabled={!handleInput.trim()}>
            Continue
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="page-narrow">
      <h1 className="page-title">Joining game</h1>
      <p className="muted">Host: {hostPeerId?.slice(-8)}</p>
      <p className={errored ? 'status-msg error' : 'status-msg'}>{statusMsg}</p>
      {errored && (
        <button className="secondary-btn" onClick={() => navigate('/')}>
          Back to lobby
        </button>
      )}
    </div>
  );
}
