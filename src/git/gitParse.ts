/**
 * Parsers for git's machine-readable output. Kept free of IO so they can be
 * unit-tested against real git output samples.
 */

export type StatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface GitFile {
  path: string;
  /** Rename/copy source. */
  origPath?: string;
  /** Staged change (index vs HEAD), null if none. */
  index: StatusCode | null;
  /** Unstaged change (worktree vs index), null if none. */
  worktree: StatusCode | null;
  untracked?: boolean;
  conflict?: boolean;
}

export interface GitStatus {
  /** Current branch, null when HEAD is detached. */
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

const code = (c: string): StatusCode | null => (c === '.' || c === ' ' ? null : (c as StatusCode));

/** `git status --porcelain=v2 --branch -z` */
export function parseStatus(out: string): GitStatus {
  const st: GitStatus = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# ')) {
      const [, key, ...rest] = p.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') st.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') st.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') st.upstream = val;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val);
        if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    const kind = p[0];
    if (kind === '1') {
      const f = p.split(' ');
      st.files.push({ path: f.slice(8).join(' '), index: code(f[1][0]), worktree: code(f[1][1]) });
    } else if (kind === '2') {
      const f = p.split(' ');
      st.files.push({ path: f.slice(9).join(' '), origPath: parts[++i], index: code(f[1][0]), worktree: code(f[1][1]) });
    } else if (kind === 'u') {
      const f = p.split(' ');
      st.files.push({ path: f.slice(10).join(' '), index: 'U', worktree: 'U', conflict: true });
    } else if (kind === '?') {
      st.files.push({ path: p.slice(2), index: null, worktree: null, untracked: true });
    }
  }
  st.files.sort((a, b) => a.path.localeCompare(b.path));
  return st;
}

export const stagedFiles = (s: GitStatus) => s.files.filter((f) => !f.conflict && f.index);
export const unstagedFiles = (s: GitStatus) => s.files.filter((f) => !f.conflict && (f.worktree || f.untracked));
export const conflictFiles = (s: GitStatus) => s.files.filter((f) => f.conflict);

// ---------------------------------------------------------------------------

export interface Commit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  date: number;
  refs: string[];
  subject: string;
}

export const LOG_FORMAT = '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e';

export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [hash, short, parents, author, email, date, refs, subject] = r.split('\x1f');
      return {
        hash,
        short,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: Number(date),
        refs: refs ? refs.split(', ').map((x) => x.replace(/^HEAD -> /, '')).filter((x) => x && x !== 'HEAD') : [],
        subject: subject ?? '',
      };
    });
}

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  short: string;
  upstream: string | null;
  date: number;
}

export const BRANCH_FORMAT = '--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(HEAD)%1f%(committerdate:unix)';

export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, name, short, upstream, head, date] = l.split('\x1f');
      return { name, remote: ref.startsWith('refs/remotes/'), current: head === '*', short, upstream: upstream || null, date: Number(date) || 0 };
    })
    .filter((b) => !(b.remote && b.name.endsWith('/HEAD')))
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || b.date - a.date);
}

export interface ChangedFile {
  status: StatusCode;
  path: string;
  origPath?: string;
}

/** `git show --name-status --format= <hash>` */
export function parseNameStatus(out: string): ChangedFile[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [st, a, b] = l.split('\t');
      const status = st[0] as StatusCode;
      return b !== undefined ? { status, path: b, origPath: a } : { status, path: a };
    });
}

// ---------------------------------------------------------------------------
// Merge conflicts

export interface Conflict {
  /** 0-based line numbers of the markers. */
  start: number;
  base: number | null;
  sep: number;
  end: number;
  current: string;
  incoming: string;
}

export function findConflicts(lines: string[]): Conflict[] {
  const out: Conflict[] = [];
  let open: Partial<Conflict> | null = null;
  lines.forEach((l, i) => {
    if (l.startsWith('<<<<<<<')) open = { start: i, base: null, current: l.slice(7).trim() };
    else if (open && l.startsWith('|||||||') && open.sep === undefined) open.base = i;
    else if (open && l.startsWith('=======') && open.sep === undefined) open.sep = i;
    else if (open && open.sep !== undefined && l.startsWith('>>>>>>>')) {
      out.push({ ...(open as Conflict), end: i, incoming: l.slice(7).trim() });
      open = null;
    }
  });
  return out;
}

export type Resolution = 'current' | 'incoming' | 'both';

/** The lines a conflict block resolves to. */
export function resolvedLines(lines: string[], c: Conflict, how: Resolution): string[] {
  const current = lines.slice(c.start + 1, c.base ?? c.sep);
  const incoming = lines.slice(c.sep + 1, c.end);
  return how === 'current' ? current : how === 'incoming' ? incoming : [...current, ...incoming];
}

/** Replace one conflict block with the chosen side(s). */
export function resolveConflict(lines: string[], c: Conflict, how: Resolution): string[] {
  return [...lines.slice(0, c.start), ...resolvedLines(lines, c, how), ...lines.slice(c.end + 1)];
}

/** "3 minutes ago" style, in the UI language. */
export function relativeTime(unix: number, locale: string, now = Date.now()): string {
  const diff = unix * 1000 - now;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff) / 1000;
  const steps: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
    [2629800, 'week'],
    [31557600, 'month'],
    [Infinity, 'year'],
  ];
  const sizes: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 };
  const unit = steps.find(([lim]) => abs < lim)![1];
  return rtf.format(Math.round(diff / 1000 / sizes[unit]), unit);
}
