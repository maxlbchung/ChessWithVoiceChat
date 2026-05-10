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
    this.peer.on('disconnected', () => this.events.onClose?.());
    this.peer.on('close', () => this.events.onClose?.());
  }

  connectTo(remoteId: string): DataConnection {
    const conn = this.peer.connect(remoteId, { reliable: true });
    this.attachConn(conn);
    return conn;
  }

  private attachConn(conn: DataConnection) {
    this.conn = conn;
    conn.on('open', () => this.events.onConnect?.(conn));
    conn.on('data', (data) => {
      try {
        const msg = data as WireMessage;
        this.events.onMessage?.(msg);
      } catch (e) {
        console.error('bad wire msg', e);
      }
    });
    conn.on('close', () => this.events.onClose?.());
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
