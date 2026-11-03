/**
 * Workspace paths. Local paths are plain OS paths; a folder on an SSH host is
 * `ssh://<profileId>/absolute/path`. Kernels and terminals running on that
 * host see the plain remote path, so code sent to them uses `kernelPath()`.
 */
export const REMOTE_SCHEME = 'ssh://';

export interface RemoteRef {
  id: string;
  path: string;
}

export const isRemotePath = (p: string | null | undefined): boolean => !!p && p.startsWith(REMOTE_SCHEME);

export function parseRemote(p: string | null | undefined): RemoteRef | null {
  if (!p || !isRemotePath(p)) return null;
  const rest = p.slice(REMOTE_SCHEME.length);
  const i = rest.indexOf('/');
  const id = i < 0 ? rest : rest.slice(0, i);
  if (!id) return null;
  const path = i < 0 ? '/' : rest.slice(i).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return { id, path };
}

export const formatRemote = (id: string, path: string) => `${REMOTE_SCHEME}${id}${path.startsWith('/') ? path : `/${path}`}`;

/** The path as code running next to the file (kernel, terminal) sees it. */
export function kernelPath(p: string): string {
  return parseRemote(p)?.path ?? p;
}

/**
 * Map a path reported by a kernel (debugger frames, errors) back to a
 * workspace path: on a remote workspace, kernel paths live on that host.
 */
export function workspacePath(p: string, workdir: string | null | undefined): string {
  const r = parseRemote(workdir);
  if (!r || p.startsWith(REMOTE_SCHEME) || !p.startsWith('/')) return p;
  return formatRemote(r.id, p);
}

export function baseName(p: string): string {
  const r = parseRemote(p);
  const s = r ? r.path : p;
  return s.split(/[\\/]/).filter(Boolean).pop() ?? s;
}

/** Parent folder; stays inside the same host for remote paths. */
export function dirName(p: string): string {
  const r = parseRemote(p);
  if (r) {
    const i = r.path.lastIndexOf('/');
    return formatRemote(r.id, i <= 0 ? '/' : r.path.slice(0, i));
  }
  return p.replace(/[\\/][^\\/]+[\\/]?$/, '') || p;
}

/** "proj (lab)" style label for a workspace root. */
export function rootLabel(p: string, hostName?: string): string {
  const name = baseName(p) || '/';
  return isRemotePath(p) ? `${name} · ${hostName ?? parseRemote(p)!.id}` : name;
}

// --- Shared sessions -----------------------------------------------------------
/**
 * A guest in a collaboration session sees the host's project as
 * `collab://<sessionId>/<path relative to the host's project root>`.
 */
export const COLLAB_SCHEME = 'collab://';

export const isCollabPath = (p: string | null | undefined): boolean => !!p && p.startsWith(COLLAB_SCHEME);

/** Split `collab://sid/a/b.R` into { sid, rel: "a/b.R" } (rel "" = project root). */
export function parseCollab(p: string | null | undefined): { sid: string; rel: string } | null {
  if (!p || !isCollabPath(p)) return null;
  const rest = p.slice(COLLAB_SCHEME.length);
  const i = rest.indexOf('/');
  const sid = i < 0 ? rest : rest.slice(0, i);
  if (!sid) return null;
  const rel = i < 0 ? '' : rest.slice(i + 1).split('/').filter(Boolean).join('/');
  return { sid, rel };
}

export const formatCollab = (sid: string, rel: string) => `${COLLAB_SCHEME}${sid}${rel ? `/${rel}` : ''}`;

/** Files that are not on this machine (SSH host or a shared session): no local tools (LSP, preview…). */
export const isNonLocalPath = (p: string | null | undefined) => isRemotePath(p) || isCollabPath(p);

/**
 * A path relative to `root` (forward slashes), or null when it is outside.
 * Rejects ".." segments, so a peer can never address files above the root.
 */
export function relativeTo(root: string, path: string): string | null {
  const r = root.replace(/[\\/]+$/, '');
  const norm = path.replace(/\\/g, '/');
  const rr = r.replace(/\\/g, '/');
  if (norm === rr) return '';
  if (!norm.startsWith(`${rr}/`)) return null;
  const rel = norm.slice(rr.length + 1).split('/').filter(Boolean);
  return rel.includes('..') || rel.includes('.') ? null : rel.join('/');
}

/** Join a validated relative path onto a root; null for unsafe input. */
export function joinRelative(root: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  const r = root.replace(/\/+$/, '');
  return parts.length ? `${r}/${parts.join('/')}` : r;
}
