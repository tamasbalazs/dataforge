/**
 * Session logic, independent of the UI: HostSession is the authority (checks
 * every guest message against the guest's role, owns the shared documents and
 * relays changes), GuestSession talks only to the host. Both get their
 * environment (files, kernels, editor) through adapters, so they can be tested
 * together in one process.
 */
import * as Y from 'yjs';
import type { CompleteReply, FsEntry, Interpreter, KernelEvent, KernelStarted, Lang, ProjectInfo } from '../core/host';
import {
  cleanName,
  fromBase64,
  MAX_CHAT,
  MAX_CHAT_LEN,
  mayCall,
  PEER_COLORS,
  safeRel,
  toBase64,
  type ChatMessage,
  type GuestMsg,
  type HostMsg,
  type Peer,
  type Presence,
  type Role,
  type SessionInfo,
} from './protocol';

export const TEXT_KEY = 'content';
const REMOTE = 'remote';

export interface HostAdapter {
  projectName(): string;
  projectInfo(): Promise<ProjectInfo | null>;
  interpreters(): Interpreter[];
  /** Current text of a project file (the open editor model wins over the disk). */
  docText(rel: string): Promise<string>;
  /** Write a shared document (through the editor when it is open there). */
  saveDoc(rel: string, text: string): Promise<void>;
  fs: {
    list(rel: string, showHidden: boolean): Promise<FsEntry[]>; // entries' `path` are project-relative
    read(rel: string): Promise<string>;
    writeBase64(rel: string, data: string): Promise<void>;
    create(parentRel: string, name: string, dir: boolean): Promise<string>;
    rename(rel: string, newName: string): Promise<string>;
    trash(rel: string): Promise<void>;
  };
  kernels: {
    start(lang: Lang, mayStart: boolean): Promise<KernelStarted>;
    execute(lang: Lang, code: string, msgId: string, by: string, peerId: string): Promise<void>;
    call(lang: Lang, func: string, args: Record<string, unknown>): Promise<unknown>;
    complete(lang: Lang, code: string, cursor: number): Promise<CompleteReply>;
    interrupt(lang: Lang): Promise<void>;
  };
}

interface HostPeer extends Peer {
  ready: boolean;
}

export class HostSession {
  readonly me: Peer;
  readonly peers = new Map<string, HostPeer>();
  readonly presence: Record<string, Presence> = {};
  chat: ChatMessage[] = [];
  private docs = new Map<string, { doc: Y.Doc; subs: Set<string>; loading?: Promise<Y.Doc> }>();
  private loading = new Map<string, Promise<Y.Doc>>();
  private colorIdx = 1;
  private chatSeq = 0;
  ended = false;

  constructor(
    private send: (frame: string) => void,
    private adapter: HostAdapter,
    readonly opts: { sid: string; name: string; defaultRole: Role; onChange: () => void },
  ) {
    this.me = { id: 'host', name: cleanName(opts.name, 'Host'), color: PEER_COLORS[0], role: 'host' };
  }

  // --- relay frames -----------------------------------------------------------
  handleRelay(frame: string) {
    let v: any;
    try {
      v = JSON.parse(frame);
    } catch {
      return;
    }
    if (v.event === 'join' && typeof v.peer === 'string') {
      const color = PEER_COLORS[this.colorIdx++ % PEER_COLORS.length];
      this.peers.set(v.peer, { id: v.peer, name: 'Guest', color, role: this.opts.defaultRole, ready: false });
      return;
    }
    if (v.event === 'leave' && typeof v.peer === 'string') return this.dropPeer(v.peer);
    if (typeof v.from === 'string' && typeof v.data === 'string') {
      let msg: GuestMsg;
      try {
        msg = JSON.parse(v.data);
      } catch {
        return;
      }
      void this.onGuest(v.from, msg);
    }
  }

  private to(peer: string, msg: HostMsg) {
    this.send(JSON.stringify({ to: peer, data: JSON.stringify(msg) }));
  }
  private broadcast(msg: HostMsg, except?: string) {
    if (![...this.peers.values()].some((p) => p.ready && p.id !== except)) return;
    this.send(JSON.stringify({ to: '*', except, data: JSON.stringify(msg) }));
  }
  private publicPeer = (p: Peer): Peer => ({ id: p.id, name: p.name, color: p.color, role: p.role });

  private dropPeer(id: string) {
    const was = this.peers.get(id);
    this.peers.delete(id);
    delete this.presence[id];
    for (const d of this.docs.values()) d.subs.delete(id);
    if (was?.ready) this.broadcast({ t: 'peer-left', id });
    this.opts.onChange();
  }

  private async onGuest(id: string, msg: GuestMsg) {
    const peer = this.peers.get(id);
    if (!peer || this.ended) return;
    if (msg.t === 'hello') {
      peer.name = cleanName(String(msg.name ?? ''));
      peer.ready = true;
      const info: SessionInfo = {
        sid: this.opts.sid,
        project: this.adapter.projectName(),
        you: this.publicPeer(peer),
        peers: [this.me, ...[...this.peers.values()].filter((p) => p.ready && p.id !== id).map(this.publicPeer)],
        presence: { ...this.presence },
        chat: this.chat.slice(-50),
        interpreters: this.adapter.interpreters(),
      };
      this.to(id, { t: 'session', ...info });
      this.broadcast({ t: 'peer', peer: this.publicPeer(peer) }, id);
      this.opts.onChange();
      return;
    }
    if (!peer.ready) return;
    const role = peer.role as Role;
    switch (msg.t) {
      case 'rpc':
        return this.rpc(peer, msg.id, msg.m, msg.p ?? {});
      case 'doc-open': {
        const rel = safeRel(msg.rel);
        if (rel == null || !rel) return;
        const entry = await this.ensureDoc(rel).catch(() => null);
        if (!entry) return;
        entry.subs.add(id);
        this.to(id, { t: 'doc-state', rel, u: toBase64(Y.encodeStateAsUpdate(entry.doc)) });
        return;
      }
      case 'doc-close': {
        const rel = safeRel(msg.rel);
        if (rel) this.docs.get(rel)?.subs.delete(id);
        return;
      }
      case 'doc-update': {
        const rel = safeRel(msg.rel);
        const entry = rel ? this.docs.get(rel) : undefined;
        // Viewers can't change documents: their updates are dropped here.
        if (!entry || !entry.subs.has(id) || role === 'view') return;
        try {
          Y.applyUpdate(entry.doc, fromBase64(msg.u), id);
        } catch {
          /* malformed update */
        }
        return;
      }
      case 'doc-save': {
        const rel = safeRel(msg.rel);
        const entry = rel ? this.docs.get(rel) : undefined;
        if (!entry || role === 'view') return;
        try {
          await this.adapter.saveDoc(rel!, entry.doc.getText(TEXT_KEY).toString());
          this.docSaved(rel!);
        } catch {
          /* the host sees the error in its own UI */
        }
        return;
      }
      case 'presence': {
        const p: Presence = { doc: safeRel(msg.doc) || null, anchor: msg.anchor ?? null, head: msg.head ?? null, line: Number(msg.line) || undefined };
        this.presence[id] = p;
        this.broadcast({ t: 'presence', id, ...p }, id);
        this.opts.onChange();
        return;
      }
      case 'chat': {
        const text = String(msg.text ?? '').slice(0, MAX_CHAT_LEN).trim();
        if (text) this.postChat(peer, text);
        return;
      }
    }
  }

  private async rpc(peer: HostPeer, id: number, m: string, p: any) {
    const role = peer.role as Role;
    const reply = (ok: boolean, v?: unknown, e?: string) => this.to(peer.id, { t: 'rpc-res', id, ok, v, e });
    if (!mayCall(role, m, p?.func)) return reply(false, undefined, `not allowed for the "${role}" role`);
    const rel = (x: unknown) => {
      const r = safeRel(x ?? '');
      if (r == null) throw new Error('invalid path');
      return r;
    };
    const lang = (x: unknown): Lang => {
      if (x !== 'r' && x !== 'python') throw new Error('invalid language');
      return x;
    };
    try {
      const a = this.adapter;
      let v: unknown;
      switch (m) {
        case 'fs.list':
          v = await a.fs.list(rel(p.rel), !!p.showHidden);
          break;
        case 'fs.read':
          v = await a.fs.read(rel(p.rel));
          break;
        case 'fs.write':
          v = await a.fs.writeBase64(rel(p.rel), String(p.data ?? ''));
          break;
        case 'fs.create':
          v = await a.fs.create(rel(p.rel), String(p.name ?? ''), !!p.dir);
          break;
        case 'fs.rename':
          v = await a.fs.rename(rel(p.rel), String(p.name ?? ''));
          break;
        case 'fs.trash':
          if (!rel(p.rel)) throw new Error('refusing to trash the project root');
          v = await a.fs.trash(rel(p.rel));
          break;
        case 'project.info':
          v = await a.projectInfo();
          break;
        case 'kernel.start':
          v = await a.kernels.start(lang(p.lang), role === 'run');
          break;
        case 'kernel.execute':
          await a.kernels.execute(lang(p.lang), String(p.code ?? ''), String(p.msgId ?? ''), peer.name, peer.id);
          v = p.msgId;
          break;
        case 'kernel.call':
          v = await a.kernels.call(lang(p.lang), String(p.func), (p.args ?? {}) as Record<string, unknown>);
          break;
        case 'kernel.complete':
          v = await a.kernels.complete(lang(p.lang), String(p.code ?? ''), Number(p.cursor) || 0);
          break;
        case 'kernel.interrupt':
          v = await a.kernels.interrupt(lang(p.lang));
          break;
      }
      reply(true, v ?? null);
    } catch (e) {
      reply(false, undefined, String((e as Error)?.message ?? e));
    }
  }

  // --- documents ----------------------------------------------------------------
  /** The shared document for a project file, created from its current text. */
  async getDoc(rel: string): Promise<Y.Doc> {
    return (await this.ensureDoc(rel)).doc;
  }

  hasDoc(rel: string) {
    return this.docs.has(rel);
  }

  private async ensureDoc(rel: string) {
    const have = this.docs.get(rel);
    if (have) return have;
    let p = this.loading.get(rel);
    if (!p) {
      p = (async () => {
        const text = await this.adapter.docText(rel);
        const doc = new Y.Doc();
        doc.getText(TEXT_KEY).insert(0, text);
        return doc;
      })();
      this.loading.set(rel, p);
    }
    try {
      const doc = await p;
      if (!this.docs.has(rel)) {
        const entry = { doc, subs: new Set<string>() };
        doc.on('update', (u: Uint8Array, origin: unknown) => {
          const msg = JSON.stringify({ t: 'doc-update', rel, u: toBase64(u) } satisfies HostMsg);
          for (const s of entry.subs) if (s !== origin) this.send(JSON.stringify({ to: s, data: msg }));
        });
        this.docs.set(rel, entry);
      }
      return this.docs.get(rel)!;
    } finally {
      this.loading.delete(rel);
    }
  }

  docSaved(rel: string) {
    const entry = this.docs.get(rel);
    if (!entry) return;
    const msg = JSON.stringify({ t: 'doc-saved', rel } satisfies HostMsg);
    for (const s of entry.subs) this.send(JSON.stringify({ to: s, data: msg }));
  }

  // --- host actions -------------------------------------------------------------
  setRole(id: string, role: Role) {
    const p = this.peers.get(id);
    if (!p) return;
    p.role = role;
    this.to(id, { t: 'role', role });
    this.broadcast({ t: 'peer', peer: this.publicPeer(p) }, id);
    this.opts.onChange();
  }

  kick(id: string) {
    this.send(JSON.stringify({ kick: id }));
  }

  setPresence(p: Presence) {
    this.presence.host = p;
    this.broadcast({ t: 'presence', id: 'host', ...p });
  }

  sendChat(text: string) {
    const t = text.slice(0, MAX_CHAT_LEN).trim();
    if (t) this.postChat(this.me, t);
  }

  private postChat(from: Peer, text: string) {
    const m: ChatMessage = { id: `c${++this.chatSeq}`, peer: from.id, name: from.name, color: from.color, text, ts: Date.now() };
    this.chat = [...this.chat, m].slice(-MAX_CHAT);
    this.broadcast({ t: 'chat', ...m });
    this.opts.onChange();
  }

  kernelEvent(ev: KernelEvent) {
    this.broadcast({ t: 'kev', ev });
  }

  execStarted(lang: Lang, msgId: string, code: string, by: string, exceptPeer?: string) {
    this.broadcast({ t: 'exec', lang, msgId, code, by }, exceptPeer);
  }

  fsChanged(rels: string[]) {
    if (rels.length) this.broadcast({ t: 'fs', rels });
  }

  end(reason = 'session-ended') {
    if (this.ended) return;
    this.broadcast({ t: 'end', reason });
    this.ended = true;
    for (const d of this.docs.values()) d.doc.destroy();
    this.docs.clear();
  }
}

// =============================================================================

export interface GuestAdapter {
  onKernelEvent(ev: KernelEvent): void;
  onExec(lang: Lang, msgId: string, code: string, by: string): void;
  onFsChanged(rels: string[]): void;
  onDocSaved(rel: string): void;
  onRole(role: Role): void;
  onEnd(reason: string): void;
}

export class GuestSession {
  info: SessionInfo | null = null;
  role: Role = 'view';
  readonly peers = new Map<string, Peer>();
  readonly presence: Record<string, Presence> = {};
  chat: ChatMessage[] = [];
  readonly docs = new Map<string, Y.Doc>();
  private waiting = new Map<string, Array<(d: Y.Doc) => void>>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  ended = false;
  readonly ready: Promise<SessionInfo>;
  private resolveReady!: (i: SessionInfo) => void;
  private rejectReady!: (e: Error) => void;

  constructor(
    private send: (frame: string) => void,
    private adapter: GuestAdapter,
    private opts: { name: string; onChange: () => void },
  ) {
    this.ready = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.catch(() => undefined);
  }

  private out(msg: GuestMsg) {
    if (!this.ended) this.send(JSON.stringify(msg));
  }

  handleFrame(frame: string) {
    let msg: any;
    try {
      msg = JSON.parse(frame);
    } catch {
      return;
    }
    if (msg.event === 'welcome') {
      this.out({ t: 'hello', name: this.opts.name });
      return;
    }
    this.onHost(msg as HostMsg);
  }

  private onHost(msg: HostMsg) {
    switch (msg.t) {
      case 'session': {
        const { t: _t, ...info } = msg;
        this.info = info;
        this.role = info.you.role as Role;
        for (const p of info.peers) this.peers.set(p.id, p);
        Object.assign(this.presence, info.presence);
        this.chat = info.chat;
        this.resolveReady(info);
        break;
      }
      case 'rpc-res': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.v);
        else p.reject(new Error(msg.e ?? 'failed'));
        return;
      }
      case 'doc-state': {
        let doc = this.docs.get(msg.rel);
        if (!doc) {
          doc = new Y.Doc();
          const d = doc;
          const rel = msg.rel;
          doc.on('update', (u: Uint8Array, origin: unknown) => {
            if (origin !== REMOTE) this.out({ t: 'doc-update', rel, u: toBase64(u) });
          });
          this.docs.set(rel, d);
        }
        Y.applyUpdate(doc, fromBase64(msg.u), REMOTE);
        for (const w of this.waiting.get(msg.rel) ?? []) w(doc);
        this.waiting.delete(msg.rel);
        return;
      }
      case 'doc-update': {
        const doc = this.docs.get(msg.rel);
        if (doc) Y.applyUpdate(doc, fromBase64(msg.u), REMOTE);
        return;
      }
      case 'doc-saved':
        this.adapter.onDocSaved(msg.rel);
        return;
      case 'peer':
        this.peers.set(msg.peer.id, msg.peer);
        break;
      case 'peer-left':
        this.peers.delete(msg.id);
        delete this.presence[msg.id];
        break;
      case 'presence': {
        const { t: _t, id, ...p } = msg;
        this.presence[id] = p;
        break;
      }
      case 'chat': {
        const { t: _t, ...m } = msg;
        this.chat = [...this.chat, m].slice(-MAX_CHAT);
        break;
      }
      case 'role':
        this.role = msg.role;
        if (this.info) this.info.you = { ...this.info.you, role: msg.role };
        this.adapter.onRole(msg.role);
        break;
      case 'kev':
        this.adapter.onKernelEvent(msg.ev);
        return;
      case 'exec':
        this.adapter.onExec(msg.lang, msg.msgId, msg.code, msg.by);
        return;
      case 'fs':
        this.adapter.onFsChanged(msg.rels);
        return;
      case 'end':
        this.close(msg.reason);
        return;
    }
    this.opts.onChange();
  }

  /** The connection is gone (or the host ended the session). */
  close(reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.rejectReady(new Error(reason || 'closed'));
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('The shared session has ended'));
    }
    this.pending.clear();
    for (const d of this.docs.values()) d.destroy();
    this.docs.clear();
    this.adapter.onEnd(reason);
    this.opts.onChange();
  }

  rpc<T>(m: string, p: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    if (this.ended) return Promise.reject(new Error('The shared session has ended'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The host did not answer'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.out({ t: 'rpc', id, m, p });
    });
  }

  /** Subscribe to a shared document; resolves with its synced Y.Doc. */
  openDoc(rel: string): Promise<Y.Doc> {
    const have = this.docs.get(rel);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const list = this.waiting.get(rel) ?? [];
      const first = list.length === 0;
      const timer = setTimeout(() => reject(new Error(`${rel}: the host did not send the document`)), 30_000);
      list.push((d) => {
        clearTimeout(timer);
        resolve(d);
      });
      this.waiting.set(rel, list);
      if (first) this.out({ t: 'doc-open', rel });
    });
  }

  closeDoc(rel: string) {
    const d = this.docs.get(rel);
    if (!d) return;
    this.docs.delete(rel);
    d.destroy();
    this.out({ t: 'doc-close', rel });
  }

  saveDoc(rel: string) {
    this.out({ t: 'doc-save', rel });
  }

  setPresence(p: Presence) {
    this.out({ t: 'presence', ...p });
  }

  sendChat(text: string) {
    const t = text.slice(0, MAX_CHAT_LEN).trim();
    if (t) this.out({ t: 'chat', text: t });
  }
}
