import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host, RemoteProfile } from '../core/host';
import { setHost } from '../core/host';
import { updateSettings } from '../core/settings';

const { connect, newProfileId, resolveRemoteFolder, splitTarget, useRemote, validateProfile, remoteInterpreters, saveProfile, deleteProfile, profileLabel, ensureConnected } = await import('./remoteStore');
const { chooseInterpreter } = await import('../kernels/kernels');

const lab: RemoteProfile = { id: 'lab', name: 'Lab', host: 'lab.example.org', user: 'ana' };

function fakeHost(over: Partial<Host> = {}) {
  const remoteConnect = vi.fn(async () => ({
    home: '/home/ana',
    os: 'Linux',
    hostname: 'gpu-01',
    interpreters: [
      { lang: 'python' as const, path: '/usr/bin/python3', version: '3.12', hasKernel: false, source: 'remote' },
      { lang: 'python' as const, path: '/opt/conda/bin/python', version: '3.11', hasKernel: true, source: 'remote' },
    ],
  }));
  const h = { remoteConnect, remoteDisconnect: vi.fn(async () => {}), ...over } as unknown as Host;
  setHost(h);
  return { remoteConnect };
}

describe('remote profiles', () => {
  beforeEach(() => {
    updateSettings({ remoteProfiles: [], workdir: null, projects: {} });
    useRemote.setState({ connections: {} });
  });

  it('validates host, user, port and folder', () => {
    expect(validateProfile(lab)).toEqual([]);
    const keys = (p: Partial<RemoteProfile>) => validateProfile({ ...lab, ...p }).map((x) => x.key);
    expect(keys({ host: ' ' })).toEqual(['remote.err.hostRequired']);
    expect(keys({ host: '-oProxyCommand=x' })).toEqual(['remote.err.hostInvalid']);
    expect(keys({ host: 'a b' })).toEqual(['remote.err.hostInvalid']);
    expect(keys({ user: '-l' })).toEqual(['remote.err.userInvalid']);
    expect(keys({ port: 70000 })).toEqual(['remote.err.portInvalid']);
    expect(keys({ port: 2.5 })).toEqual(['remote.err.portInvalid']);
    expect(keys({ folder: 'proj' })).toEqual(['remote.err.folderAbsolute']);
    expect(keys({ folder: '~/proj' })).toEqual([]);
  });

  it('splits user@host:port targets', () => {
    expect(splitTarget('ana@lab.example.org:2222')).toEqual({ host: 'lab.example.org', user: 'ana', port: 2222 });
    expect(splitTarget('ssh://lab')).toEqual({ host: 'lab', user: undefined });
    expect(splitTarget('fe80::1')).toEqual({ host: 'fe80::1', user: undefined });
  });

  it('derives unique, path-safe ids', () => {
    expect(newProfileId('Labor GPU-szerver', [])).toBe('labor-gpu-szerver');
    expect(newProfileId('Árvíztűrő', [])).toBe('arvizturo');
    expect(newProfileId('lab', ['lab', 'lab-2'])).toBe('lab-3');
    expect(newProfileId('!!!', [])).toBe('host');
    expect(profileLabel({ ...lab, name: '' })).toBe('ana@lab.example.org');
  });

  it('expands ~ against the remote home', () => {
    expect(resolveRemoteFolder('~/p', '/home/ana')).toBe('/home/ana/p');
    expect(resolveRemoteFolder('', '/home/ana')).toBe('/home/ana');
    expect(resolveRemoteFolder('/srv/x', '/home/ana')).toBe('/srv/x');
  });

  it('connects once, records errors, and forgets deleted hosts', async () => {
    const { remoteConnect } = fakeHost();
    saveProfile(lab);
    const [a, b] = await Promise.all([connect('lab'), connect('lab')]);
    expect(a?.hostname).toBe('gpu-01');
    expect(b).toBe(a);
    expect(remoteConnect).toHaveBeenCalledTimes(1);
    expect(await ensureConnected('/local/path')).toBe(true);
    expect(await ensureConnected('ssh://lab/home/ana')).toBe(true);
    expect(remoteConnect).toHaveBeenCalledTimes(1);

    fakeHost({ remoteConnect: vi.fn(async () => Promise.reject(new Error('lab: authentication failed'))) as any });
    saveProfile({ ...lab, id: 'bad' });
    expect(await connect('bad', { quiet: true })).toBeNull();
    expect(useRemote.getState().connections.bad).toEqual({ status: 'error', error: 'lab: authentication failed' });

    await deleteProfile('bad');
    expect(useRemote.getState().connections.bad).toBeUndefined();
    expect((await import('../core/settings')).getSettings().remoteProfiles.map((p) => p.id)).toEqual(['lab']);
  });

  it('remote projects use the interpreters of their host', async () => {
    fakeHost();
    saveProfile(lab);
    await connect('lab');
    updateSettings({ workdir: 'ssh://lab/home/ana/p' });
    expect(remoteInterpreters()?.length).toBe(2);
    expect(chooseInterpreter('python')?.path).toBe('/opt/conda/bin/python');
    expect(chooseInterpreter('r')).toBeUndefined();
    updateSettings({ workdir: '/home/me/p' });
    expect(remoteInterpreters()).toBeNull();
  });
});
