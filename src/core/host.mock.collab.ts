/**
 * Browser stand-in for the collaboration relay (src-tauri/src/collab.rs):
 * same routing rules, carried over a BroadcastChannel so two pages of the
 * same browser (e2e test) can host and join a session.
 */
import type { CollabEvent, CollabServerInfo, Host } from './host';

type Mock = Pick<Host, 'collabHostStart' | 'collabHostStop' | 'collabConnect' | 'collabSend' | 'collabClose' | 'onCollabEvent'>;

interface Server {
  info: CollabServerInfo;
  ch: BroadcastChannel;
  host: string | null; // connection key
  guests: Map<string, string>; // peer → key
  peerOf: Map<string, string>; // key → peer
  local: Map<string, string>; // key → conn id (connections from this page)
  next: number;
}

const rnd = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const channelName = (port: number) => `dataforge-collab-${port}`;

export function createMockCollab(): Mock {
  const listeners = new Set<(ev: CollabEvent) => void>();
  const emit = (ev: CollabEvent) => setTimeout(() => listeners.forEach((l) => l(ev)), 0);
  let server: Server | null = null;
  const conns = new Map<string, { key: string; port: number; ch?: BroadcastChannel }>();

  // --- relay ---------------------------------------------------------------
  function deliver(s: Server, key: string, data: string) {
    const conn = s.local.get(key);
    if (conn) emit({ conn, kind: 'message', data });
    else s.ch.postMessage({ kind: 'deliver', key, data });
  }
  function closeConn(s: Server, key: string, reason: string) {
    const conn = s.local.get(key);
    if (conn) {
      emit({ conn, kind: 'closed', data: reason });
      s.local.delete(key);
      conns.delete(conn);
    } else s.ch.postMessage({ kind: 'closed', key, data: reason });
  }
  function accept(s: Server, key: string, token: string): string | null {
    if (token === s.info.hostToken) {
      if (s.host) return 'the host is already connected';
      s.host = key;
      deliver(s, key, JSON.stringify({ event: 'welcome', peer: 'host' }));
      return null;
    }
    if (token === s.info.guestToken) {
      const peer = `p${++s.next}`;
      s.guests.set(peer, key);
      s.peerOf.set(key, peer);
      if (s.host) deliver(s, s.host, JSON.stringify({ event: 'join', peer }));
      deliver(s, key, JSON.stringify({ event: 'welcome', peer }));
      return null;
    }
    return 'invalid invitation';
  }
  function frame(s: Server, key: string, data: string) {
    if (key === s.host) {
      let v: any;
      try {
        v = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof v.kick === 'string') {
        const k = s.guests.get(v.kick);
        if (k) {
          s.guests.delete(v.kick);
          s.peerOf.delete(k);
          closeConn(s, k, 'removed-by-host');
          deliver(s, s.host, JSON.stringify({ event: 'leave', peer: v.kick }));
        }
        return;
      }
      if (typeof v.data !== 'string') return;
      if (v.to === '*') for (const [peer, k] of s.guests) peer !== v.except && deliver(s, k, v.data);
      else if (s.guests.has(v.to)) deliver(s, s.guests.get(v.to)!, v.data);
      return;
    }
    const peer = s.peerOf.get(key);
    if (peer && s.host) deliver(s, s.host, JSON.stringify({ from: peer, data }));
  }
  function disconnect(s: Server, key: string) {
    if (key === s.host) {
      s.host = null;
      for (const k of s.guests.values()) closeConn(s, k, 'host-left');
      s.guests.clear();
      s.peerOf.clear();
      return;
    }
    const peer = s.peerOf.get(key);
    if (!peer) return;
    s.peerOf.delete(key);
    s.guests.delete(peer);
    if (s.host) deliver(s, s.host, JSON.stringify({ event: 'leave', peer }));
  }

  return {
    async collabHostStart(lan) {
      if (server) await this.collabHostStop();
      const port = 40000 + Math.floor(Math.random() * 20000);
      const info: CollabServerInfo = { port, hostToken: rnd(), guestToken: rnd(), addresses: [`${lan ? '192.168.1.20' : '127.0.0.1'}:${port}`], lan };
      const s: Server = { info, ch: new BroadcastChannel(channelName(port)), host: null, guests: new Map(), peerOf: new Map(), local: new Map(), next: 0 };
      s.ch.onmessage = (e) => {
        const m = e.data ?? {};
        if (m.kind === 'connect') {
          const err = accept(s, m.key, m.token);
          s.ch.postMessage(err ? { kind: 'refused', key: m.key, data: err } : { kind: 'accepted', key: m.key });
        } else if (m.kind === 'frame') frame(s, m.key, m.data);
        else if (m.kind === 'close') disconnect(s, m.key);
      };
      server = s;
      return info;
    },
    async collabHostStop() {
      const s = server;
      if (!s) return;
      server = null;
      for (const k of s.guests.values()) closeConn(s, k, 'session-ended');
      if (s.host) closeConn(s, s.host, 'session-ended');
      setTimeout(() => s.ch.close(), 50);
    },
    async collabConnect(id, address, token) {
      const port = Number(address.split(':').pop());
      const key = rnd();
      if (server && server.info.port === port) {
        server.local.set(key, id);
        const err = accept(server, key, token);
        if (err) {
          server.local.delete(key);
          throw new Error(err);
        }
        conns.set(id, { key, port });
        return;
      }
      const ch = new BroadcastChannel(channelName(port));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${address}: connection refused`)), 1500);
        ch.onmessage = (e) => {
          const m = e.data ?? {};
          if (m.key !== key) return;
          if (m.kind === 'accepted') {
            clearTimeout(timer);
            resolve();
          } else if (m.kind === 'refused') {
            clearTimeout(timer);
            reject(new Error(m.data));
          } else if (m.kind === 'deliver') emit({ conn: id, kind: 'message', data: m.data });
          else if (m.kind === 'closed') {
            emit({ conn: id, kind: 'closed', data: m.data });
            conns.delete(id);
            ch.close();
          }
        };
        ch.postMessage({ kind: 'connect', key, token });
      }).catch((e) => {
        ch.close();
        throw e;
      });
      conns.set(id, { key, port, ch });
    },
    async collabSend(id, data) {
      const c = conns.get(id);
      if (!c) throw new Error('not connected');
      if (c.ch) c.ch.postMessage({ kind: 'frame', key: c.key, data });
      else if (server) {
        const s = server;
        setTimeout(() => frame(s, c.key, data), 0);
      }
    },
    async collabClose(id) {
      const c = conns.get(id);
      if (!c) return;
      conns.delete(id);
      if (c.ch) {
        c.ch.postMessage({ kind: 'close', key: c.key });
        c.ch.close();
      } else if (server) {
        server.local.delete(c.key);
        disconnect(server, c.key);
      }
    },
    onCollabEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
