/**
 * Remote development: saved SSH hosts and live connections. A folder on a
 * host is opened as an ordinary project whose root is `ssh://<id>/path`;
 * the host routes files, git, terminals and kernels over SSH.
 */
import { create } from 'zustand';
import { host, type Interpreter, type RemoteInfo, type RemoteProfile } from '../core/host';
import { t } from '../core/i18n';
import { formatRemote, isRemotePath, parseRemote } from '../core/paths';
import { getSettings, updateSettings } from '../core/settings';
import { toast } from '../core/toast';

export type ConnStatus = 'connecting' | 'connected' | 'error';

export interface Connection {
  status: ConnStatus;
  info?: RemoteInfo;
  error?: string;
}

export const useRemote = create<{ connections: Record<string, Connection> }>(() => ({ connections: {} }));

const patchConn = (id: string, c: Connection | null) =>
  useRemote.setState((s) => {
    const next = { ...s.connections };
    if (c) next[id] = c;
    else delete next[id];
    return { connections: next };
  });

export const profiles = () => getSettings().remoteProfiles ?? [];
export const profileById = (id: string) => profiles().find((p) => p.id === id);

/** Display name of a host (profile name, else user@host). */
export function profileLabel(p: RemoteProfile | undefined, fallback = ''): string {
  if (!p) return fallback;
  return p.name?.trim() || `${p.user ? `${p.user}@` : ''}${p.host}`;
}

/** Profile ids are part of workspace paths: short, stable, URL-safe. */
export function newProfileId(name: string, taken: string[] = profiles().map((p) => p.id)): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'host';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

export interface ProfileProblem {
  field: 'name' | 'host' | 'user' | 'port' | 'folder';
  key: string;
}

export function validateProfile(p: RemoteProfile): ProfileProblem[] {
  const out: ProfileProblem[] = [];
  const hostName = p.host.trim();
  if (!hostName) out.push({ field: 'host', key: 'remote.err.hostRequired' });
  else if (hostName.startsWith('-') || /\s/.test(hostName) || hostName.includes('@')) out.push({ field: 'host', key: 'remote.err.hostInvalid' });
  if (p.user && (p.user.startsWith('-') || /[\s@]/.test(p.user))) out.push({ field: 'user', key: 'remote.err.userInvalid' });
  if (p.port != null && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) out.push({ field: 'port', key: 'remote.err.portInvalid' });
  if (p.folder && !p.folder.startsWith('/') && !p.folder.startsWith('~')) out.push({ field: 'folder', key: 'remote.err.folderAbsolute' });
  return out;
}

/** Accepts "user@host:port" pasted into the host field. */
export function splitTarget(input: string): { host: string; user?: string; port?: number } {
  let rest = input.trim().replace(/^ssh:\/\//, '');
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const m = /^(.*?):(\d{1,5})$/.exec(rest);
  if (m && !m[1].includes(':')) return { host: m[1], user, port: Number(m[2]) };
  return { host: rest, user };
}

export function saveProfile(p: RemoteProfile) {
  const list = profiles();
  const i = list.findIndex((x) => x.id === p.id);
  updateSettings({ remoteProfiles: i < 0 ? [...list, p] : list.map((x) => (x.id === p.id ? p : x)) });
}

export async function deleteProfile(id: string) {
  if (useRemote.getState().connections[id]) await disconnect(id);
  updateSettings({ remoteProfiles: profiles().filter((p) => p.id !== id) });
}

const inflight = new Map<string, Promise<RemoteInfo | null>>();

/** Connect (or reuse the connection). Resolves null on failure (and records the error). */
export function connect(id: string, opts: { quiet?: boolean } = {}): Promise<RemoteInfo | null> {
  const existing = useRemote.getState().connections[id];
  if (existing?.status === 'connected' && existing.info) return Promise.resolve(existing.info);
  const running = inflight.get(id);
  if (running) return running;
  const p = (async () => {
    const profile = profileById(id);
    if (!profile) {
      patchConn(id, { status: 'error', error: t('remote.unknownProfile', { id }) });
      return null;
    }
    patchConn(id, { status: 'connecting' });
    try {
      const info = await host().remoteConnect(profile);
      patchConn(id, { status: 'connected', info });
      return info;
    } catch (e) {
      const error = String(e).replace(/^Error:\s*/, '');
      patchConn(id, { status: 'error', error });
      if (!opts.quiet) toast({ kind: 'error', title: t('remote.connectFailed', { name: profileLabel(profile) }), detail: error });
      return null;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

export async function disconnect(id: string) {
  const root = getSettings().workdir;
  if (parseRemote(root)?.id === id) {
    const { openProject } = await import('../project/project');
    await openProject(null);
    if (getSettings().workdir === root) return; // closing was cancelled (unsaved files)
  }
  try {
    await host().remoteDisconnect(id);
  } finally {
    patchConn(id, null);
  }
}

/** Make sure the host of a workspace path is connected (no-op for local paths). */
export async function ensureConnected(path: string | null | undefined, opts: { quiet?: boolean } = {}): Promise<boolean> {
  const r = parseRemote(path);
  if (!r) return true;
  return (await connect(r.id, opts)) != null;
}

/** Expand "~" against the remote home. */
export function resolveRemoteFolder(folder: string | null | undefined, home: string): string {
  const f = (folder ?? '').trim();
  if (!f || f === '~') return home || '/';
  if (f.startsWith('~/')) return `${home.replace(/\/$/, '')}/${f.slice(2)}`;
  return f;
}

/** Connect and open a folder of the host as the current project. */
export async function openRemoteFolder(id: string, folder?: string | null): Promise<boolean> {
  const info = await connect(id);
  if (!info) return false;
  const path = resolveRemoteFolder(folder ?? profileById(id)?.folder, info.home);
  try {
    await host().fsList(formatRemote(id, path), false);
  } catch (e) {
    toast({ kind: 'error', title: t('remote.folderMissing', { path }), detail: String(e) });
    return false;
  }
  const { openProject } = await import('../project/project');
  await openProject(formatRemote(id, path));
  return getSettings().workdir === formatRemote(id, path);
}

/** Interpreters for the current workspace when it is remote (null = local). */
export function remoteInterpreters(workdir = getSettings().workdir): Interpreter[] | null {
  const r = parseRemote(workdir);
  if (!r) return null;
  return useRemote.getState().connections[r.id]?.info?.interpreters ?? [];
}

/** True while the current project lives on an SSH host. */
export const isRemoteWorkspace = (workdir = getSettings().workdir) => isRemotePath(workdir);

export function currentRemote(): { id: string; profile?: RemoteProfile; conn?: Connection } | null {
  const r = parseRemote(getSettings().workdir);
  if (!r) return null;
  return { id: r.id, profile: profileById(r.id), conn: useRemote.getState().connections[r.id] };
}
