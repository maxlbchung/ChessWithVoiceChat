import Peer, { type DataConnection, type MediaConnection } from 'peerjs';
import { ICE_SERVERS } from './iceConfig';
import type { WireMessage } from './types';

export type PeerEvents = {
  onOpen?: (peerId: string) => void;
  onConnect?: (conn: DataConnection) => void;
  onIncomingCall?: (call: MediaConnection) => void;
  onMessage?: (msg: WireMessage) => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
};

export class PeerSession {
  peer: Peer;
  conn: DataConnection | null = null;
  call: MediaConnection | null = null;
  remoteStream: MediaStream | null = null;
  events: PeerEvents;

  setEvents(events: PeerEvents) {
    this.events = events;
  }

  constructor(peerId: string | undefined, events: PeerEvents) {
    this.events = events;
    this.peer = new Peer(peerId ?? makePeerId(), {
      config: { iceServers: ICE_SERVERS },
      debug: 1,
    });
    // Always read through this.events so setEvents() (used when handing the
    // session from Home → Game) actually swaps the active handlers.
    this.peer.on('open', (id) => this.events.onOpen?.(id));
    this.peer.on('connection', (conn) => this.attachConn(conn));
    this.peer.on('call', (call) => this.events.onIncomingCall?.(call));
    this.peer.on('error', (err) => this.events.onError?.(err));
    // Peer-broker 'disconnected' is informational — the data channel can stay
    // alive while the broker link blips, and PeerJS may auto-reconnect. Do
    // NOT treat it as a session close (matchmaking can't pair us again, but
    // the existing game keeps working).
    this.peer.on('disconnected', () => console.warn('peer disconnected from broker'));
    this.peer.on('close', () => this.events.onClose?.());
  }

  connectTo(remoteId: string): DataConnection {
    const conn = this.peer.connect(remoteId, { reliable: true });
    this.attachConn(conn);
    return conn;
  }

  private attachConn(conn: DataConnection) {
    this.conn = conn;
    let closed = false;
    const fireClose = () => {
      if (closed) return;
      closed = true;
      this.events.onClose?.();
    };

    conn.on('open', () => {
      this.events.onConnect?.(conn);
      // PeerJS only treats iceConnectionState=failed/closed as a close. When a
      // remote tab closes abruptly the state goes to 'disconnected' and stays
      // there until the browser times out (30s+). Add our own watchdog so we
      // surface a close after 5s of 'disconnected', matching the forfeit
      // grace period in Game.
      const pc = conn.peerConnection;
      if (!pc) return;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const armWatchdog = () => {
        if (watchdog != null) return;
        watchdog = setTimeout(() => {
          watchdog = null;
          const s = pc.iceConnectionState;
          if (s === 'disconnected' || s === 'failed') fireClose();
        }, 5000);
      };
      const cancelWatchdog = () => {
        if (watchdog != null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
      };
      pc.addEventListener('iceconnectionstatechange', () => {
        const s = pc.iceConnectionState;
        if (s === 'failed' || s === 'closed') fireClose();
        else if (s === 'disconnected') armWatchdog();
        else cancelWatchdog();
      });
    });
    conn.on('data', (data) => {
      try {
        const msg = data as WireMessage;
        this.events.onMessage?.(msg);
      } catch (e) {
        console.error('bad wire msg', e);
      }
    });
    conn.on('close', fireClose);
    conn.on('error', (err) => this.events.onError?.(err as Error));
  }

  send(msg: WireMessage) {
    if (!this.conn || !this.conn.open) {
      console.warn('peer not connected, dropping msg', msg);
      return;
    }
    this.conn.send(msg);
  }

  // Voice: place an outgoing call with our local stream, attach incoming stream listener
  startCall(remoteId: string, localStream: MediaStream): MediaConnection {
    const call = this.peer.call(remoteId, localStream);
    this.call = call;
    call.on('stream', (s) => {
      this.remoteStream = s;
    });
    call.on('close', () => {
      this.remoteStream = null;
      this.call = null;
    });
    return call;
  }

  answerCall(call: MediaConnection, localStream: MediaStream) {
    this.call = call;
    call.answer(localStream);
    call.on('stream', (s) => {
      this.remoteStream = s;
    });
    call.on('close', () => {
      this.remoteStream = null;
      this.call = null;
    });
  }

  destroy() {
    try {
      this.call?.close();
    } catch {}
    try {
      this.conn?.close();
    } catch {}
    try {
      this.peer.destroy();
    } catch {}
  }
}

export function makePeerId(): string {
  // Random URL-safe id, prefixed to avoid collisions on the public broker.
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const id = Array.from(bytes, (b) => b.toString(36)).join('').slice(0, 16);
  return `dchess-${id}`;
}
