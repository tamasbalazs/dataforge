/** Minimal JSON-RPC 2.0 connection over an arbitrary message transport. */

export interface Transport {
  send(payload: string): Promise<void> | void;
}

type Handler = (params: any) => unknown | Promise<unknown>;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export class Connection {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: unknown) => void; method: string }>();
  private notificationHandlers = new Map<string, Handler>();
  private requestHandlers = new Map<string, Handler>();
  private closed = false;

  constructor(private transport: Transport) {}

  request<T = any>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${method} timed out`));
          void this.notify('$/cancelRequest', { id });
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
        method,
      });
      void Promise.resolve(this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  notify(method: string, params?: unknown) {
    if (this.closed) return;
    return this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  onNotification(method: string, h: Handler) {
    this.notificationHandlers.set(method, h);
  }

  onRequest(method: string, h: Handler) {
    this.requestHandlers.set(method, h);
  }

  /** Feed a raw incoming message. */
  async receive(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const h = this.requestHandlers.get(msg.method);
      let reply: Record<string, unknown>;
      if (!h) reply = { error: { code: -32601, message: `Unhandled method ${msg.method}` } };
      else {
        try {
          reply = { result: (await h(msg.params)) ?? null };
        } catch (e) {
          reply = { error: { code: -32603, message: String(e) } };
        }
      }
      await this.transport.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }));
    } else if (msg.method !== undefined) {
      this.notificationHandlers.get(msg.method)?.(msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  close(reason = 'connection closed') {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
