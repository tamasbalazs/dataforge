/**
 * Git state for the current project: status, branches, history, and the
 * operations behind the Git panel. Every command runs through host.gitExec
 * (non-interactive `git -C <root> …`); output is parsed in gitParse.ts.
 */
import { create } from 'zustand';
import { ask } from '../core/dialog';
import { host, type GitOutput } from '../core/host';
import { t } from '../core/i18n';
import { workspacePath } from '../core/paths';
import { getSettings, useSettings } from '../core/settings';
import { toast } from '../core/toast';
import { BRANCH_FORMAT, LOG_FORMAT, parseBranches, parseLog, parseNameStatus, parseStatus, type Branch, type ChangedFile, type Commit, type GitFile, type GitStatus } from './gitParse';

interface GitState {
  /** null = not checked yet */
  available: boolean | null;
  /** Repository root (may be above the project folder), null if not a repo. */
  root: string | null;
  status: GitStatus | null;
  merging: boolean;
  /** Label of the running operation (commit, pull, …). */
  busy: string | null;
  branches: Branch[];
  log: Commit[];
  logLoaded: boolean;
  message: string;
  lastError: string | null;
}

export const useGit = create<GitState>(() => ({
  available: null,
  root: null,
  status: null,
  merging: false,
  busy: null,
  branches: [],
  log: [],
  logLoaded: false,
  message: '',
  lastError: null,
}));

export class GitError extends Error {
  constructor(
    message: string,
    readonly out: GitOutput,
  ) {
    super(message);
  }
}

/** The first meaningful line of git's stderr, for toasts. */
export function gitErrorText(out: GitOutput): string {
  const lines = (out.stderr || out.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l))?.replace(/^(fatal|error):\s*/, '') ?? lines[0] ?? `git exited with ${out.code}`;
}

async function run(args: string[], opts: { stdin?: string; root?: string | null; allowFail?: boolean } = {}): Promise<GitOutput> {
  const root = opts.root ?? useGit.getState().root ?? getSettings().workdir;
  if (!root) throw new Error('no project folder');
  const out = await host().gitExec(root, args, opts.stdin ?? null);
  if (out.code !== 0 && !opts.allowFail) throw new GitError(gitErrorText(out), out);
  return out;
}

let refreshing: Promise<void> | null = null;
let again = false;

/** Re-read status (cheap; called on file changes, focus and after every operation). */
export function refreshGit(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  const work = async () => {
    try {
      const workdir = getSettings().workdir;
      if (!workdir) {
        useGit.setState({ root: null, status: null, merging: false });
        return;
      }
      const top = await host().gitExec(workdir, ['rev-parse', '--show-toplevel'], null).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }));
      if (top.code !== 0) {
        const missing = /not installed/.test(top.stderr);
        useGit.setState({ available: !missing, root: null, status: null, merging: false });
        return;
      }
      // On a remote workspace git prints the host's path: keep it addressed through ssh://.
      const root = workspacePath(top.stdout.trim(), workdir);
      const [st, merge] = await Promise.all([
        run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { root }),
        run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { root, allowFail: true }),
      ]);
      const changedRoot = useGit.getState().root !== root;
      useGit.setState({ available: true, root, status: parseStatus(st.stdout), merging: merge.code === 0, ...(changedRoot ? { log: [], logLoaded: false, branches: [] } : {}) });
    } catch (e) {
      useGit.setState({ lastError: String(e) });
    }
  };
  // .finally runs after the assignment even when work() finishes synchronously.
  refreshing = work().finally(() => {
    refreshing = null;
    if (again) {
      again = false;
      void refreshGit();
    }
  });
  return refreshing;
}

/** Run an operation with busy state, error toast and a refresh afterwards. */
async function op<T>(label: string, fn: () => Promise<T>, success?: string): Promise<T | null> {
  useGit.setState({ busy: label });
  try {
    const r = await fn();
    if (success) toast({ kind: 'success', title: success });
    return r;
  } catch (e) {
    const detail = e instanceof GitError ? e.message : String(e);
    toast({ kind: 'error', title: t('git.failed', { op: label }), detail });
    return null;
  } finally {
    useGit.setState({ busy: null });
    await refreshGit();
    if (useGit.getState().logLoaded) void loadLog();
  }
}

const hasHead = () => !!useGit.getState().status?.oid;

export const stage = (paths: string[]) => op(t('git.op.stage'), () => run(['add', '-A', '--', ...paths]));

export const unstage = (paths: string[]) =>
  op(t('git.op.unstage'), () => (hasHead() ? run(['restore', '--staged', '--', ...paths]) : run(['rm', '--cached', '-q', '-r', '--', ...paths])));

export const stageAll = () => op(t('git.op.stage'), () => run(['add', '-A']));
export const unstageAll = () => op(t('git.op.unstage'), () => (hasHead() ? run(['reset', '-q']) : run(['rm', '--cached', '-q', '-r', '.'])));

/** Throw away worktree changes (tracked files are restored, new files go to the trash). */
export async function discard(files: GitFile[]) {
  if (!files.length) return;
  const choice = await ask(
    files.length === 1 ? t('git.discardOne', { name: files[0].path }) : t('git.discardMany', { count: files.length }),
    t('git.discardBody'),
    [
      { id: 'discard', label: t('git.discard'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ],
  );
  if (choice !== 'discard') return;
  const root = useGit.getState().root!;
  await op(t('git.op.discard'), async () => {
    const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
    const untracked = files.filter((f) => f.untracked).map((f) => f.path);
    if (tracked.length) await run(['restore', '--worktree', '--', ...tracked]);
    for (const p of untracked) await host().fsTrash(`${root}/${p}`);
  });
}

export async function commit(opts: { amend?: boolean } = {}) {
  const s = useGit.getState();
  const message = s.message.trim();
  if (!message && !opts.amend && !s.merging) {
    toast({ kind: 'info', title: t('git.needMessage') });
    return false;
  }
  const staged = s.status?.files.some((f) => f.index && !f.conflict);
  const conflicts = s.status?.files.some((f) => f.conflict);
  if (conflicts) {
    toast({ kind: 'error', title: t('git.resolveFirst') });
    return false;
  }
  if (!staged && !opts.amend && !s.merging) {
    const choice = await ask(t('git.nothingStagedTitle'), t('git.nothingStagedBody'), [
      { id: 'all', label: t('git.stageAllCommit'), variant: 'primary' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (choice !== 'all') return false;
    await run(['add', '-A']);
  }
  const args = ['commit', '--cleanup=strip'];
  if (opts.amend) args.push('--amend');
  if (message) args.push('-F', '-');
  else args.push('--no-edit');
  const ok = await op(t('git.op.commit'), () => run(args, { stdin: message || undefined }), t('git.committed'));
  if (ok) useGit.setState({ message: '' });
  return !!ok;
}

export async function loadBranches() {
  const out = await run(['for-each-ref', BRANCH_FORMAT, 'refs/heads', 'refs/remotes'], { allowFail: true }).catch(() => null);
  if (out?.code === 0) useGit.setState({ branches: parseBranches(out.stdout) });
}

export async function checkout(b: Branch) {
  const dirty = useGit.getState().status?.files.some((f) => !f.untracked);
  if (dirty) {
    const choice = await ask(t('git.dirtySwitchTitle', { name: b.name }), t('git.dirtySwitchBody'), [
      { id: 'switch', label: t('git.switchAnyway'), variant: 'primary' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (choice !== 'switch') return;
  }
  const local = b.remote ? b.name.replace(/^[^/]+\//, '') : b.name;
  const exists = useGit.getState().branches.some((x) => !x.remote && x.name === local);
  const args = b.remote && !exists ? ['switch', '-c', local, '--track', b.name] : ['switch', local];
  await op(t('git.op.switch'), () => run(args), t('git.switched', { name: local }));
  void loadBranches();
}

export const validBranchName = (n: string) =>
  /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*[/.]$)[^\s~^:?*[\\\x00-\x1f\x7f]+$/.test(n);

export async function createBranch(name: string) {
  if (!validBranchName(name)) {
    toast({ kind: 'error', title: t('git.badBranch', { name }) });
    return;
  }
  await op(t('git.op.branch'), () => run(['switch', '-c', name]), t('git.switched', { name }));
  void loadBranches();
}

export async function fetchAll() {
  await op(t('git.op.fetch'), () => run(['fetch', '--all', '--prune']));
}

/** Pull then push; publishes the branch (push -u) when it has no upstream yet. */
export async function sync() {
  const st = useGit.getState().status;
  if (!st?.branch) return;
  if (!st.upstream) {
    const remotes = (await run(['remote'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    if (!remotes.length) {
      toast({ kind: 'info', title: t('git.noRemote') });
      return;
    }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    await op(t('git.op.publish'), () => run(['push', '-u', remote, st.branch!]), t('git.published', { name: st.branch, remote }));
    return;
  }
  await op(
    t('git.op.sync'),
    async () => {
      if (st.behind > 0 || st.ahead === 0) await run(['pull', '--no-rebase', '--no-edit']);
      await refreshGit();
      if ((useGit.getState().status?.ahead ?? 0) > 0) await run(['push']);
    },
    t('git.synced'),
  );
}

export const pull = () => op(t('git.op.pull'), () => run(['pull', '--no-rebase', '--no-edit']), t('git.pulled'));
export const push = () => op(t('git.op.push'), () => run(['push']), t('git.pushed'));

export async function abortMerge() {
  const choice = await ask(t('git.abortMergeTitle'), t('git.abortMergeBody'), [
    { id: 'abort', label: t('git.abortMerge'), variant: 'danger' },
    { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
  ]);
  if (choice === 'abort') await op(t('git.op.abort'), () => run(['merge', '--abort']));
}

export async function initRepo() {
  const root = getSettings().workdir;
  if (!root) return;
  await op(t('git.op.init'), () => run(['init'], { root }), t('git.initialized'));
}

export async function loadLog(limit = 300) {
  const out = await run(['log', LOG_FORMAT, `-n${limit}`, '--date-order'], { allowFail: true }).catch(() => null);
  useGit.setState({ log: out?.code === 0 ? parseLog(out.stdout) : [], logLoaded: true });
}

export async function commitFiles(hash: string): Promise<ChangedFile[]> {
  const out = await run(['show', '--name-status', '--format=', '-m', '--first-parent', hash], { allowFail: true });
  return out.code === 0 ? parseNameStatus(out.stdout) : [];
}

/** Content of a file at a revision: 'HEAD', a commit hash, ':' (index) or 'worktree'. */
export async function fileAt(rev: string, path: string): Promise<string> {
  const root = useGit.getState().root!;
  if (rev === 'worktree') return host().readText(`${root}/${path}`).catch(() => '');
  if (rev === 'empty') return '';
  const spec = rev === ':' ? `:${path}` : `${rev}:${path}`;
  const out = await run(['show', spec], { allowFail: true });
  return out.code === 0 ? out.stdout : '';
}

/** Path of a project file relative to the repository root, or null if outside. */
export function repoRelative(abs: string): string | null {
  const root = useGit.getState().root;
  if (!root) return null;
  const r = root.replace(/[\\/]+$/, '');
  return abs.startsWith(r + '/') || abs.startsWith(r + '\\') ? abs.slice(r.length + 1).replace(/\\/g, '/') : null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
const soon = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void refreshGit(), 350);
};

export function installGitListeners(): () => void {
  const offFs = host().onFsChanged(soon);
  const onFocus = () => soon();
  window.addEventListener('focus', onFocus);
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.workdir !== prev.workdir) {
      useGit.setState({ root: null, status: null, log: [], logLoaded: false, branches: [], message: '' });
      void refreshGit();
    }
  });
  void refreshGit();
  return () => {
    offFs();
    offSettings();
    window.removeEventListener('focus', onFocus);
  };
}
