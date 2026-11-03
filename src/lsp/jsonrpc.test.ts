import { describe, expect, it } from 'vitest';
import { Connection, RpcError } from './jsonrpc';

function pair() {
  const sent: any[] = [];
  const conn = new Connection({ send: (p) => void sent.push(JSON.parse(p)) });
  return { conn, sent };
}

describe('JSON-RPC connection', () => {
  it('matches responses to requests', async () => {
    const { conn, sent } = pair();
    const p = conn.request('initialize', { a: 1 });
    expect(sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
    await conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects with RpcError on error responses', async () => {
    const { conn } = pair();
    const p = conn.request('x');
    await conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }));
    await expect(p).rejects.toBeInstanceOf(RpcError);
  });

  it('answers server requests and reports unknown methods', async () => {
    const { conn, sent } = pair();
    conn.onRequest('workspace/configuration', (p) => p.items.map(() => ({ x: 1 })));
    await conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [{}, {}] } }));
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: [{ x: 1 }, { x: 1 }] });
    await conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'foo/bar' }));
    expect(sent[1].error.code).toBe(-32601);
  });

  it('dispatches notifications and fails pending requests on close', async () => {
    const { conn } = pair();
    let got: any = null;
    conn.onNotification('textDocument/publishDiagnostics', (p) => (got = p));
    await conn.receive(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'u' } }));
    expect(got).toEqual({ uri: 'u' });
    const p = conn.request('slow');
    conn.close('server exited');
    await expect(p).rejects.toThrow('server exited');
  });
});
