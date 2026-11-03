import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CloudDownload,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getSettings, useSettings } from '../../core/settings';
import { conflictFiles, relativeTime, stagedFiles, unstagedFiles, type ChangedFile, type Commit, type GitFile } from '../../git/gitParse';
import {
  abortMerge,
  checkout,
  commit,
  commitFiles,
  createBranch,
  discard,
  fetchAll,
  initRepo,
  loadBranches,
  loadLog,
  pull,
  push,
  refreshGit,
  stage,
  stageAll,
  sync,
  unstage,
  unstageAll,
  useGit,
} from '../../git/gitStore';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Menu, type MenuItem } from '../../ui/Menu';
import { Segmented } from '../../ui/Segmented';
import { Spinner } from '../../ui/Spinner';
import { openDiff, revealPanel } from '../../workbench/layout';
import { addFileDoc, basename } from '../editor/editorStore';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function StatusBadge({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <span className={`df-git__badge df-git__badge--${code}`} title={t(`git.code.${code}`)} aria-label={t(`git.code.${code}`)}>
      {code === '?' ? 'U' : code}
    </span>
  );
}

type Section = 'conflicts' | 'staged' | 'changes';

function FileRow({ f, section }: { f: GitFile; section: Section }) {
  const { t } = useTranslation();
  const root = useGit((s) => s.root);
  const code = section === 'staged' ? f.index! : f.conflict ? 'U' : f.untracked ? '?' : f.worktree!;
  const openFile = () => root && (addFileDoc(`${root}/${f.path}`), revealPanel('editor'));
  const showDiff = () => {
    if (f.conflict) return openFile();
    const left = section === 'staged' ? (code === 'A' ? 'empty' : 'HEAD') : f.untracked ? 'empty' : ':';
    const right = section === 'staged' ? ':' : code === 'D' ? 'empty' : 'worktree';
    openDiff({ path: f.path, left, right, title: `${basename(f.path)} (${section === 'staged' ? t('git.rev.index') : t('git.rev.worktree')})` });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      void (section === 'staged' ? unstage([f.path]) : stage([f.path]));
    }
  };
  return (
    <li className="df-git__row">
      <button className="df-git__file" onClick={showDiff} onKeyDown={onKey} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
        <FileText size={13} strokeWidth={1.75} aria-hidden className="df-git__fileicon" />
        <span className={`df-git__name ${code === 'D' ? 'is-deleted' : ''}`}>{basename(f.path)}</span>
        <span className="df-git__dir">{f.origPath ? `${basename(f.origPath)} → ` : ''}{dirOf(f.path)}</span>
        <StatusBadge code={code} />
      </button>
      <span className="df-git__actions">
        <IconButton icon={FileText} size="sm" label={t('git.openFile')} onClick={openFile} disabled={code === 'D'} />
        {section === 'changes' && <IconButton icon={Undo2} size="sm" label={t('git.discard')} onClick={() => void discard([f])} />}
        {section === 'staged' ? (
          <IconButton icon={Minus} size="sm" label={t('git.unstage')} onClick={() => void unstage([f.path])} />
        ) : (
          <IconButton icon={section === 'conflicts' ? Check : Plus} size="sm" label={section === 'conflicts' ? t('git.markResolved') : t('git.stage')} onClick={() => void stage([f.path])} />
        )}
      </span>
    </li>
  );
}

function FileSection({ id, title, files, actions }: { id: Section; title: string; files: GitFile[]; actions?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!files.length) return null;
  return (
    <section className="df-git__section" aria-label={title}>
      <div className="df-git__section-head">
        <button className="df-git__section-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronRight size={12} strokeWidth={2} className={`df-git__chev ${open ? 'is-open' : ''}`} aria-hidden />
          {title}
          <span className="df-git__count">{files.length}</span>
        </button>
        <span className="df-git__section-actions">{actions}</span>
      </div>
      {open && (
        <ul className="df-git__list">
          {files.map((f) => (
            <FileRow key={`${id}:${f.path}`} f={f} section={id} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BranchButton() {
  const { t } = useTranslation();
  const status = useGit((s) => s.status);
  const branches = useGit((s) => s.branches);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) input.current?.focus();
  }, [creating]);

  const local = branches.filter((b) => !b.remote);
  const remote = branches.filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`)));
  const items: MenuItem[] = [
    { id: 'new', label: t('git.newBranch'), icon: Plus, onSelect: () => setCreating(true) },
    { type: 'separator', id: 's0' },
    { type: 'label', id: 'l', label: t('git.localBranches') },
    ...local.map<MenuItem>((b) => ({ id: `b:${b.name}`, label: b.name, icon: b.current ? Check : GitBranch, disabled: b.current, onSelect: () => void checkout(b) })),
    ...(remote.length ? [{ type: 'label' as const, id: 'r', label: t('git.remoteBranches') }] : []),
    ...remote.slice(0, 30).map<MenuItem>((b) => ({ id: `r:${b.name}`, label: b.name, icon: CloudDownload, onSelect: () => void checkout(b) })),
  ];

  if (creating) {
    return (
      <form
        className="df-git__newbranch"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void createBranch(name.trim());
          setCreating(false);
          setName('');
        }}
      >
        <GitBranch size={14} strokeWidth={1.75} aria-hidden />
        <input
          ref={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
          onBlur={() => !name && setCreating(false)}
          placeholder={t('git.newBranchPlaceholder')}
          aria-label={t('git.newBranch')}
          spellCheck={false}
        />
      </form>
    );
  }
  return (
    <Menu
      items={items}
      trigger={(p) => (
        <button {...p} className="df-git__branch" onMouseDown={() => void loadBranches()} onFocus={() => void loadBranches()} title={t('git.switchBranch')}>
          <GitBranch size={14} strokeWidth={1.75} aria-hidden />
          <span>{status?.branch ?? (status?.oid ? status.oid.slice(0, 7) : t('git.detached'))}</span>
        </button>
      )}
    />
  );
}

function CommitBox() {
  const { t } = useTranslation();
  const message = useGit((s) => s.message);
  const busy = useGit((s) => s.busy);
  const merging = useGit((s) => s.merging);
  const stagedCount = useGit((s) => (s.status ? stagedFiles(s.status).length : 0));
  const [amend, setAmend] = useState(false);
  const run = async () => {
    if (await commit({ amend })) setAmend(false);
  };
  return (
    <div className="df-git__commit">
      <textarea
        value={message}
        onChange={(e) => useGit.setState({ message: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run();
          }
        }}
        placeholder={merging ? t('git.mergeMessagePlaceholder') : t('git.messagePlaceholder')}
        aria-label={t('git.message')}
        rows={Math.min(6, Math.max(2, message.split('\n').length))}
        spellCheck
      />
      <div className="df-git__commit-row">
        <label className="df-check">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
          {t('git.amend')}
        </label>
        <Button size="sm" variant="primary" icon={GitCommitHorizontal} disabled={!!busy} onClick={() => void run()}>
          {amend ? t('git.amendCommit') : stagedCount ? t('git.commitCount', { count: stagedCount }) : t('git.commit')}
        </Button>
      </div>
    </div>
  );
}

function ChangesView() {
  const { t } = useTranslation();
  const status = useGit((s) => s.status);
  const merging = useGit((s) => s.merging);
  if (!status) return null;
  const conflicts = conflictFiles(status);
  const staged = stagedFiles(status);
  const changes = unstagedFiles(status);
  return (
    <div className="df-git__changes">
      {merging && (
        <div className="df-git__merge" role="status">
          <GitMerge size={14} strokeWidth={1.75} aria-hidden />
          <span>{conflicts.length ? t('git.mergeConflicts', { count: conflicts.length }) : t('git.mergeReady')}</span>
          <Button size="sm" variant="ghost" onClick={() => void abortMerge()}>
            {t('git.abortMerge')}
          </Button>
        </div>
      )}
      <CommitBox />
      <div className="df-git__files">
        <FileSection id="conflicts" title={t('git.conflicts')} files={conflicts} />
        <FileSection
          id="staged"
          title={t('git.staged')}
          files={staged}
          actions={<IconButton icon={Minus} size="sm" label={t('git.unstageAll')} onClick={() => void unstageAll()} />}
        />
        <FileSection
          id="changes"
          title={t('git.changes')}
          files={changes}
          actions={
            <>
              <IconButton icon={Undo2} size="sm" label={t('git.discardAll')} onClick={() => void discard(changes)} />
              <IconButton icon={Plus} size="sm" label={t('git.stageAll')} onClick={() => void stageAll()} />
            </>
          }
        />
        {!conflicts.length && !staged.length && !changes.length && (
          <div className="df-git__clean">
            <Check size={14} strokeWidth={2} aria-hidden /> {t('git.clean')}
          </div>
        )}
      </div>
    </div>
  );
}

function CommitRow({ c }: { c: Commit }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  useEffect(() => {
    if (open && !files) void commitFiles(c.hash).then(setFiles);
  }, [open, files, c.hash]);
  const parent = c.parents[0];
  return (
    <li className={`df-git__commitrow ${open ? 'is-open' : ''}`}>
      <button className="df-git__commitmain" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="df-git__dot" aria-hidden />
        <span className="df-git__subject">
          {c.refs.map((r) => (
            <span key={r} className={`df-git__ref ${r.startsWith('tag:') ? 'is-tag' : r.includes('/') ? 'is-remote' : ''}`}>
              {r.replace(/^tag: /, '')}
            </span>
          ))}
          {c.subject}
        </span>
        <span className="df-git__meta">
          {c.author} · {relativeTime(c.date, i18n.language)} · <code>{c.short}</code>
        </span>
      </button>
      {open && (
        <ul className="df-git__commitfiles">
          {!files && <Spinner size={12} />}
          {files?.map((f) => (
            <li key={f.path}>
              <button
                className="df-git__file"
                onClick={() =>
                  openDiff({
                    path: f.path,
                    left: f.status === 'A' || !parent ? 'empty' : parent,
                    right: f.status === 'D' ? 'empty' : c.hash,
                    title: `${basename(f.path)} @ ${c.short}`,
                  })
                }
              >
                <FileText size={13} strokeWidth={1.75} aria-hidden className="df-git__fileicon" />
                <span className="df-git__name">{basename(f.path)}</span>
                <span className="df-git__dir">{dirOf(f.path)}</span>
                <StatusBadge code={f.status} />
              </button>
            </li>
          ))}
          {files && !files.length && <li className="df-git__muted">{t('git.noFiles')}</li>}
        </ul>
      )}
    </li>
  );
}

function HistoryView() {
  const { t } = useTranslation();
  const log = useGit((s) => s.log);
  const loaded = useGit((s) => s.logLoaded);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!loaded) void loadLog();
  }, [loaded]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? log.filter((c) => c.subject.toLowerCase().includes(s) || c.author.toLowerCase().includes(s) || c.hash.startsWith(s)) : log;
  }, [log, q]);
  if (!loaded) return <Spinner size={14} />;
  if (!log.length) return <div className="df-git__clean">{t('git.noCommits')}</div>;
  return (
    <div className="df-git__history">
      <div className="df-search df-git__search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('git.searchHistory')} aria-label={t('git.searchHistory')} spellCheck={false} />
      </div>
      <ul className="df-git__log">
        {shown.map((c) => (
          <CommitRow key={c.hash} c={c} />
        ))}
      </ul>
    </div>
  );
}

export function GitPanel() {
  const { t } = useTranslation();
  const workdir = useSettings((s) => s.workdir);
  const available = useGit((s) => s.available);
  const root = useGit((s) => s.root);
  const status = useGit((s) => s.status);
  const busy = useGit((s) => s.busy);
  const [view, setView] = useState<'changes' | 'history'>('changes');

  if (!workdir) {
    return (
      <EmptyState icon={GitBranch} title={t('git.noProjectTitle')}>
        {t('git.noProjectBody')}
      </EmptyState>
    );
  }
  if (available === false) {
    return (
      <EmptyState icon={GitBranch} title={t('git.missingTitle')}>
        {t('git.missingBody')}
      </EmptyState>
    );
  }
  if (!root) {
    return (
      <EmptyState icon={GitBranch} title={t('git.notRepoTitle')}>
        <p>{t('git.notRepoBody', { name: basename(getSettings().workdir ?? '') })}</p>
        <Button size="sm" variant="primary" icon={GitBranch} onClick={() => void initRepo()}>
          {t('git.init')}
        </Button>
      </EmptyState>
    );
  }
  const syncLabel = !status?.upstream ? t('git.publish') : t('git.sync');
  return (
    <div className="df-git">
      <div className="df-panel-toolbar">
        <BranchButton />
        {status?.upstream && (status.ahead > 0 || status.behind > 0) && (
          <span className="df-git__ab" aria-label={t('git.aheadBehind', { ahead: status.ahead, behind: status.behind })}>
            {status.behind > 0 && (
              <>
                <ArrowDown size={12} aria-hidden />
                {status.behind}
              </>
            )}
            {status.ahead > 0 && (
              <>
                <ArrowUp size={12} aria-hidden />
                {status.ahead}
              </>
            )}
          </span>
        )}
        <span className="df-panel-toolbar__spacer" />
        {busy && (
          <span className="df-git__busy" role="status">
            <Spinner size={12} /> {busy}
          </span>
        )}
        <Menu
          align="end"
          items={[
            { id: 'sync', label: syncLabel, icon: RefreshCw, onSelect: () => void sync() },
            { id: 'pull', label: t('git.pull'), icon: ArrowDown, disabled: !status?.upstream, onSelect: () => void pull() },
            { id: 'push', label: t('git.push'), icon: ArrowUp, disabled: !status?.upstream, onSelect: () => void push() },
            { id: 'fetch', label: t('git.fetch'), icon: CloudDownload, onSelect: () => void fetchAll() },
          ]}
          trigger={(p) => (
            <button {...p} className="df-icon-btn df-icon-btn--sm df-icon-btn--default" aria-label={t('git.remoteActions')} data-tooltip={t('git.remoteActions')} disabled={!!busy}>
              <ArrowUp size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        />
        <IconButton icon={RefreshCw} size="sm" label={t('git.refresh')} onClick={() => void refreshGit()} />
      </div>
      <div className="df-git__tabs">
        <Segmented
          size="sm"
          label={t('git.view')}
          value={view}
          onChange={(v) => setView(v as 'changes' | 'history')}
          options={[
            { value: 'changes', label: t('git.changesTab', { count: status?.files.length ?? 0 }), icon: GitCommitHorizontal },
            { value: 'history', label: t('git.history'), icon: History },
          ]}
        />
      </div>
      <div className="df-git__body">{view === 'changes' ? <ChangesView /> : <HistoryView />}</div>
    </div>
  );
}
