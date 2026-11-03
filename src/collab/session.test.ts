import { describe, expect, it, vi } from 'vitest';
import type { KernelEvent } from '../core/host';
import { formatInvitation, mayCall, parseInvitation, safeRel } from './protocol';
import { GuestSession, HostSession, TEXT_KEY, type GuestAdapter, type HostAdapter } from './session';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

/** In-memory relay with the routing rules of src-tauri/src/collab.rs. */
function relay() {
  let host: HostSession | null = null;
  const guests = new Map<string, GuestSession>();
  let n = 0;
  const later = (f: () => void) => setTimeout(f, 0);
  const hostSend = (frame: string) =>
    later(() => {
      const v = JSON.parse(frame);
      if (v.kick) {
        const g = guests.get(v.kick);
        guests.delete(v.kick);
        g?.close('removed-by-host');
        host?.handleRelay(JSON.stringify({ event: 'leave', peer: v.kick }));
        return;
      }
      if (v.to === '*') for (const [id, g] of guests) id !== v.except && g.handleFrame(v.data);
      else guests.get(v.to)?.handleFrame(v.data);
    });
  return {
    attachHost(h: HostSession) {
      host = h;
    },
    hostSend,
    join(make: (send: (f: string) => void) => GuestSession) {
      const id = `p${++n}`;
      const g = make((frame) => later(() => host?.handleRelay(JSON.stringify({ from: id, data: frame }))));
      guests.set(id, g);
      later(() => {
        host?.handleRelay(JSON.stringify({ event: 'join', peer: id }));
        g.handleFrame(JSON.stringify({ event: 'welcome', peer: id }));
      });
      return { id, g };
    },
  };
}

function hostAdapter(files: Record<string, string>) {
  const executed: Array<{ code: string; by: string }> = [];
  const saved: Record<string, string> = {};
  const a: HostAdapter = {
    projectName: () => 'projekt',
    projectInfo: async () => null,
    interpreters: () => [{ lang: 'r', path: '/usr/bin/R', version: '4.4', hasKernel: true, source: 'PATH' }],
    docText: async (rel) => {
      if (!(rel in files)) throw new Error('missing');
      return files[rel];
    },
    saveDoc: async (rel, text) => {
      saved[rel] = text;
      files[rel] = text;
    },
    fs: {
      list: async (rel) => Object.keys(files).filter((f) => !rel || f.startsWith(`${rel}/`)).map((f) => ({ name: f, path: f, isDir: false, size: 1, modified: null, hidden: false })),
      read: async (rel) => files[rel],
      writeBase64: async () => {},
      create: async (p, name) => (p ? `${p}/${name}` : name),
      rename: async (rel, name) => name + rel,
      trash: async () => {},
    },
    kernels: {
      start: async (lang, mayStart) => {
        if (!mayStart) throw new Error('not running');
        return { id: lang, lang, info: null };
      },
      execute: async (_l, code, _m, by) => {
        executed.push({ code, by });
      },
      call: async (_l, func) => ({ func }),
      complete: async () => ({ matches: [], cursor_start: 0, cursor_end: 0 }) as any,
      interrupt: async () => {},
    },
  };
  return { a, executed, saved };
}

function guestAdapter() {
  const x = {
    events: [] as KernelEvent[],
    saved: [] as string[],
    roles: [] as string[],
    ended: [] as string[],
    onKernelEvent: (ev: KernelEvent) => void x.events.push(ev),
    onExec: vi.fn(),
    onFsChanged: vi.fn(),
    onDocSaved: (rel: string) => void x.saved.push(rel),
    onRole: (r: string) => void x.roles.push(r),
    onEnd: (r: string) => void x.ended.push(r),
  };
  return x satisfies GuestAdapter;
}

async function setup() {
  const files: Record<string, string> = { 'elemzes.R': 'x <- 1\n', 'data/a.csv': 'a\n1\n' };
  const r = relay();
  const ha = hostAdapter(files);
  const host = new HostSession(r.hostSend, ha.a, { sid: 's1', name: 'Anna', defaultRole: 'edit', onChange: () => {} });
  r.attachHost(host);
  const ga1 = guestAdapter();
  const ga2 = guestAdapter();
  const j1 = r.join((send) => new GuestSession(send, ga1, { name: 'Béla', onChange: () => {} }));
  const j2 = r.join((send) => new GuestSession(send, ga2, { name: 'Cili\nX', onChange: () => {} }));
  await settle();
  return { files, host, ha, g1: j1.g, g2: j2.g, id1: j1.id, id2: j2.id, ga1, ga2 };
}

describe('collaboration protocol', () => {
  it('parses invitations', () => {
    const token = 'a'.repeat(64);
    const link = formatInvitation({ address: '192.168.1.5:41234', token });
    expect(parseInvitation(link)).toEqual({ address: '192.168.1.5:41234', token });
    expect(parseInvitation(` 127.0.0.1:5000 ${token} `)).toEqual({ address: '127.0.0.1:5000', token });
    expect(parseInvitation('127.0.0.1:99999/' + token)).toBeNull();
    expect(parseInvitation('evil.com/x?y')).toBeNull();
    expect(parseInvitation('127.0.0.1:5000/short')).toBeNull();
  });

  it('checks roles and paths', () => {
    expect(mayCall('view', 'kernel.call', 'env_list')).toBe(true);
    expect(mayCall('view', 'kernel.call', 'ext_eval')).toBe(false);
    expect(mayCall('edit', 'kernel.call', 'setwd')).toBe(false);
    expect(mayCall('run', 'kernel.call', 'setwd')).toBe(true);
    expect(mayCall('edit', 'kernel.execute')).toBe(false);
    expect(mayCall('run', 'kernel.execute')).toBe(true);
    expect(mayCall('view', 'fs.write')).toBe(false);
    expect(mayCall('run', 'shell.exec')).toBe(false);
    expect(safeRel('a/b.R')).toBe('a/b.R');
    expect(safeRel('../x')).toBeNull();
    expect(safeRel('/etc/passwd')).toBeNull();
    expect(safeRel('a\\..\\b')).toBeNull();
  });
});

describe('host and guests', () => {
  it('joins with names, colours and the default role', async () => {
    const { g1, g2, host, id1 } = await setup();
    expect(g1.info?.project).toBe('projekt');
    expect(g1.role).toBe('edit');
    expect(g2.info?.you.name).toBe('Cili X');
    expect(host.peers.get(id1)?.name).toBe('Béla');
    expect(g2.peers.has('host')).toBe(true);
    expect(g2.peers.get(id1)?.name).toBe('Béla'); // announced when g2 joined after, or listed
    expect(new Set([host.me.color, g1.info!.you.color, g2.info!.you.color]).size).toBe(3);
  });

  it('keeps documents in sync between the host and guests', async () => {
    const { host, g1, g2 } = await setup();
    const [d1, d2] = await Promise.all([g1.openDoc('elemzes.R'), g2.openDoc('elemzes.R')]);
    const hd = await host.getDoc('elemzes.R');
    expect(d1.getText(TEXT_KEY).toString()).toBe('x <- 1\n');
    d1.getText(TEXT_KEY).insert(7, 'y <- 2\n');
    d2.getText(TEXT_KEY).insert(0, '# árvíztűrő\n');
    hd.getText(TEXT_KEY).insert(hd.getText(TEXT_KEY).length, 'z <- 3\n');
    await settle();
    const all = [hd, d1, d2].map((d) => d.getText(TEXT_KEY).toString());
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toContain('# árvíztűrő\n');
    expect(all[0]).toContain('y <- 2\n');
    expect(all[0]).toContain('z <- 3\n');
  });

  it('drops edits from viewers and tells everyone about role changes', async () => {
    const { host, g1, g2, id2, ga2 } = await setup();
    host.setRole(id2, 'view');
    await settle();
    expect(g2.role).toBe('view');
    expect(ga2.roles).toEqual(['view']);
    expect(g1.peers.get(id2)?.role).toBe('view');
    const d2 = await g2.openDoc('elemzes.R');
    d2.getText(TEXT_KEY).insert(0, 'HACK ');
    await settle();
    expect((await host.getDoc('elemzes.R')).getText(TEXT_KEY).toString()).toBe('x <- 1\n');
    // Viewers can't save either.
    g2.saveDoc('elemzes.R');
    await settle();
    expect(host.peers.get(id2)?.role).toBe('view');
  });

  it('saves through the host and reports it', async () => {
    const { g1, ha, ga1 } = await setup();
    const d = await g1.openDoc('elemzes.R');
    d.getText(TEXT_KEY).insert(0, '# mentve\n');
    await settle();
    g1.saveDoc('elemzes.R');
    await settle();
    expect(ha.saved['elemzes.R']).toBe('# mentve\nx <- 1\n');
    expect(ga1.saved).toEqual(['elemzes.R']);
  });

  it('enforces permissions on RPC calls', async () => {
    const { host, g1, id1, ha } = await setup();
    await expect(g1.rpc('kernel.execute', { lang: 'r', code: '1+1', msgId: 'm1' })).rejects.toThrow(/not allowed for the "edit" role/);
    await expect(g1.rpc('kernel.start', { lang: 'r' })).rejects.toThrow(/not running/);
    expect(await g1.rpc('kernel.call', { lang: 'r', func: 'env_list' })).toEqual({ func: 'env_list' });
    await expect(g1.rpc('kernel.call', { lang: 'r', func: 'ext_eval', args: { code: 'system("x")' } })).rejects.toThrow(/not allowed/);
    await expect(g1.rpc('fs.read', { rel: '../../etc/passwd' })).rejects.toThrow(/invalid path/);
    await expect(g1.rpc('fs.trash', { rel: '' })).rejects.toThrow(/project root/);
    await expect(g1.rpc('kernel.call', { lang: 'sh', func: 'env_list' })).rejects.toThrow(/invalid language/);
    expect(await g1.rpc('fs.list', { rel: 'data' })).toHaveLength(1);

    host.setRole(id1, 'run');
    await settle();
    expect(await g1.rpc('kernel.execute', { lang: 'r', code: 'summary(cars)', msgId: 'm2' })).toBe('m2');
    expect(ha.executed).toEqual([{ code: 'summary(cars)', by: 'Béla' }]);
    expect(await g1.rpc('kernel.start', { lang: 'python' })).toMatchObject({ lang: 'python' });
  });

  it('relays chat, presence, kernel output and kicks', async () => {
    const { host, g1, g2, id1, ga1, ga2 } = await setup();
    g1.sendChat('  helló mindenki  ');
    await settle();
    host.sendChat('szia');
    g1.setPresence({ doc: 'elemzes.R', anchor: null, head: null, line: 3 });
    host.kernelEvent({ kernelId: 'r', msgType: 'stream', parentId: 'm9', content: { name: 'stdout', text: '42' } });
    await settle();
    expect(g2.chat.map((c) => `${c.name}: ${c.text}`)).toEqual(['Béla: helló mindenki', 'Anna: szia']);
    expect(host.chat).toHaveLength(2);
    expect(g2.presence[id1]).toMatchObject({ doc: 'elemzes.R', line: 3 });
    expect(host.presence[id1]?.doc).toBe('elemzes.R');
    expect(ga2.events.map((e) => e.content.text)).toEqual(['42']);
    expect(ga1.events).toHaveLength(1);

    host.kick(id1);
    await settle();
    expect(ga1.ended).toEqual(['removed-by-host']);
    expect(host.peers.has(id1)).toBe(false);
    expect(g2.peers.has(id1)).toBe(false);
    await expect(g1.rpc('fs.list', {})).rejects.toThrow(/ended/);

    host.end();
    await settle();
    expect(ga2.ended).toEqual(['session-ended']);
  });
});
