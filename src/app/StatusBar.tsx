import { AlertTriangle, ArrowDown, ArrowUp, BrainCircuit, Bug, CircleX, FolderOpen, GitBranch, Play, RotateCcw, Square, TerminalSquare } from 'lucide-react';
import { restartLsp, useLsp } from '../lsp/client';
import { currentEditor } from '../panels/editor/editorService';
import { kernelLangFor } from '../panels/editor/editorStore';
import { useUi } from './uiStore';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { on, type BusEvents } from '../core/bus';
import type { Lang } from '../core/host';
import { useSettings } from '../core/settings';
import { interruptKernel, LANG_LABEL, LANGS, restartKernel, startKernel, useKernels } from '../kernels/kernels';
import { setActiveConsole } from '../panels/console/consoleStore';
import { Menu } from '../ui/Menu';
import { Spinner } from '../ui/Spinner';
import { revealPanel } from '../workbench/layout';
import { useGit } from '../git/gitStore';
import { debugStatusText, useDebug } from '../debug/debugStore';
import { chooseWorkdir } from './appCommands';
import { Server, Users } from 'lucide-react';
import { useCollab } from '../collab/collabStore';
import { isCollabPath, kernelPath, parseRemote } from '../core/paths';
import { projectName } from '../project/project';
import { profileById, profileLabel, useRemote } from '../remote/remoteStore';

/** Running background jobs (e.g. Stan sampling) with their progress. */
function JobsChip() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<{ count: number; fraction: number | null; eta: number | null } | null>(null);
  useEffect(() => {
    let off = () => {};
    let live = true;
    void import('../jobs/jobsStore').then((m) => {
      if (!live) return;
      const update = () => setSummary(m.runningSummary(m.useJobs.getState()));
      update();
      off = m.useJobs.subscribe(update);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  if (!summary?.count) return null;
  const pct = summary.fraction != null ? ` ${Math.round(summary.fraction * 100)}%` : '';
  return (
    <button className="df-status__item df-status__jobs" onClick={() => revealPanel('jobs')} title={t('jobs.chipTitle')}>
      <Spinner size={10} />
      <span>{t('jobs.chip', { count: summary.count })}{pct}</span>
    </button>
  );
}

/** Shared session: who is here; opens the Session panel. */
function CollabChip() {
  const { t } = useTranslation();
  const status = useCollab((s) => s.status);
  const peers = useCollab((s) => s.peers);
  const unread = useCollab((s) => s.unread);
  if (status !== 'hosting' && status !== 'joined') return null;
  const label = status === 'hosting' ? t('collab.chipHosting', { count: peers.length }) : t('collab.chipGuest');
  return (
    <button className="df-status__item df-status__collab" onClick={() => revealPanel('collab')} title={peers.map((p) => p.name).join(', ')} aria-label={`${label}${unread ? ` – ${t('collab.unread', { count: unread })}` : ''}`}>
      <Users size={12} strokeWidth={1.8} aria-hidden />
      <span className="df-status__collab-dots" aria-hidden>
        {peers.slice(0, 4).map((p) => (
          <span key={p.id} style={{ background: p.color }} />
        ))}
      </span>
      <span>{label}</span>
      {unread > 0 && <span className="df-status__badge">{unread}</span>}
    </button>
  );
}

/** Remote indicator (like VS Code's): where the project lives; opens the SSH dialog. */
function RemoteChip() {
  const { t } = useTranslation();
  const workdir = useSettings((s) => s.workdir);
  useSettings((s) => s.remoteProfiles);
  const r = parseRemote(workdir);
  const conn = useRemote((s) => (r ? s.connections[r.id] : undefined));
  const open = () => useUi.setState({ remoteOpen: true });
  if (!r)
    return (
      <button className="df-status__item df-status__remote-local" onClick={open} title={t('commands.remoteConnect')} aria-label={t('commands.remoteConnect')}>
        <Server size={12} strokeWidth={1.8} aria-hidden />
      </button>
    );
  const name = profileLabel(profileById(r.id), r.id);
  const status = conn?.status ?? 'off';
  return (
    <button
      className={`df-status__item df-status__remote ${status === 'error' || status === 'off' ? 'is-error' : ''}`}
      onClick={open}
      title={conn?.error ?? t(`remote.status.${status}`)}
      aria-label={`${t('remote.chip', { name })} – ${t(`remote.status.${status}`)}`}
    >
      {status === 'connecting' ? <Spinner size={10} /> : <Server size={12} strokeWidth={1.8} aria-hidden />}
      <span>{t('remote.chip', { name })}</span>
    </button>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, []);
  const s = (now - since) / 1000;
  return <span className="df-status__elapsed">{s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`}</span>;
}

function KernelChip({ lang }: { lang: Lang }) {
  const { t } = useTranslation();
  const k = useKernels((s) => s.kernels[lang]);
  const busy = k.status === 'busy';
  return (
    <Menu
      side="top"
      items={[
        { type: 'label', id: 'l', label: `${LANG_LABEL[lang]} ${k.version ?? ''} · ${t(`kernel.status.${k.status}`)}` },
        { id: 'console', label: t('commands.focusConsole', { lang: LANG_LABEL[lang] }), icon: TerminalSquare, onSelect: () => (setActiveConsole(lang), revealPanel('console')) },
        ...(k.status === 'off' || k.status === 'dead' || k.status === 'error'
          ? [{ id: 'start', label: t('kernel.start'), icon: Play, onSelect: () => void startKernel(lang) }]
          : []),
        { id: 'interrupt', label: t('kernel.interrupt'), icon: Square, disabled: !busy, onSelect: () => void interruptKernel(lang) },
        { id: 'restart', label: t('kernel.restart'), icon: RotateCcw, onSelect: () => void restartKernel(lang) },
      ]}
      trigger={(p) => (
        <button {...p} className={`df-status__item df-status__kernel is-${k.status}`} title={k.error ?? k.interpreter ?? ''}>
          {k.status === 'busy' || k.status === 'starting' ? <Spinner size={10} /> : <span className={`df-dot df-dot--${k.status}`} />}
          <span className="df-status__kernel-name">{LANG_LABEL[lang]}</span>
          {k.version && k.status !== 'unavailable' && <span className="df-status__muted">{k.version}</span>}
          {busy && k.busySince != null && <Elapsed since={k.busySince} />}
          {k.status === 'unavailable' && <span className="df-status__muted">{t('kernel.status.unavailable')}</span>}
        </button>
      )}
    />
  );
}

function Problems() {
  const { t } = useTranslation();
  const { errors, warnings } = useLsp((s) => s.problems);
  const next = () => {
    const ed = currentEditor();
    ed?.focus();
    void ed?.getAction('editor.action.marker.nextInFiles')?.run();
  };
  return (
    <button className="df-status__item" onClick={next} title={t('status.problems', { errors, warnings })}>
      <CircleX size={12} strokeWidth={2} className={errors ? 'df-status__err' : ''} aria-hidden />
      <span>{errors}</span>
      <span className="df-sr-only">{t('status.errorsWord')},</span>
      <AlertTriangle size={12} strokeWidth={2} className={warnings ? 'df-status__warn' : ''} aria-hidden />
      <span>{warnings}</span>
      <span className="df-sr-only">{t('status.warningsWord')}</span>
    </button>
  );
}

function LspChip({ language }: { language: string }) {
  const { t } = useTranslation();
  const lang = kernelLangFor(language);
  const st = useLsp((s) => (lang ? s.servers[lang] : null));
  if (!lang || !st || st.status === 'off') return null;
  const label =
    st.status === 'ready' ? st.server : st.status === 'starting' ? t('lsp.starting') : st.status === 'unavailable' ? t('lsp.unavailable') : t('lsp.failed');
  return (
    <Menu
      side="top"
      align="end"
      items={[
        { type: 'label', id: 'l', label: st.status === 'ready' ? t('lsp.readyLong', { server: st.server }) : (st.error ?? label ?? '') },
        ...(st.status === 'unavailable'
          ? [{ id: 'install', label: t('lsp.howToInstall'), onSelect: () => useUi.setState({ settingsOpen: true }) }]
          : [{ id: 'restart', label: t('lsp.restart'), icon: RotateCcw, onSelect: () => void restartLsp(lang) }]),
      ]}
      trigger={(p) => (
        <button {...p} className={`df-status__item df-status__lsp is-${st.status}`}>
          {st.status === 'starting' ? <Spinner size={10} /> : <BrainCircuit size={12} strokeWidth={1.8} aria-hidden />}
          <span>{label}</span>
        </button>
      )}
    />
  );
}

function DebugChip() {
  const { t } = useTranslation();
  const lang = useDebug((s) => s.lang);
  const state = useDebug((s) => s.state);
  const frames = useDebug((s) => s.frames);
  if (state === 'idle') return null;
  const text = debugStatusText({ lang, state, frames });
  return (
    <button className={`df-status__item df-status__debug is-${state}`} onClick={() => revealPanel('debug')} aria-label={t('debug.statusChip', { text })}>
      <Bug size={12} strokeWidth={1.8} aria-hidden />
      <span>{text}</span>
    </button>
  );
}

function GitChip() {
  const { t } = useTranslation();
  const st = useGit((s) => s.status);
  const busy = useGit((s) => s.busy);
  const merging = useGit((s) => s.merging);
  if (!st) return null;
  const changes = st.files.length;
  const name = st.branch ?? st.oid?.slice(0, 7) ?? '';
  return (
    <button
      className={`df-status__item ${merging ? 'is-warn' : ''}`}
      onClick={() => revealPanel('git')}
      title={t('git.statusChip', { branch: name, count: changes })}
      aria-label={t('git.statusChip', { branch: name, count: changes })}
    >
      {busy ? <Spinner size={10} /> : <GitBranch size={12} strokeWidth={1.8} aria-hidden />}
      <span>
        {name}
        {merging ? ' (merge)' : ''}
        {changes ? '*' : ''}
      </span>
      {st.behind > 0 && (
        <span className="df-status__muted">
          <ArrowDown size={10} aria-hidden />
          {st.behind}
        </span>
      )}
      {st.ahead > 0 && (
        <span className="df-status__muted">
          <ArrowUp size={10} aria-hidden />
          {st.ahead}
        </span>
      )}
    </button>
  );
}

export function StatusBar() {
  const { t } = useTranslation();
  const workdir = useSettings((s) => s.workdir);
  const cwd = useKernels((s) => s.kernels.r.cwd ?? s.kernels.python.cwd);
  const [cursor, setCursor] = useState<BusEvents['editor:cursor']>(null);
  useEffect(() => on('editor:cursor', setCursor), []);
  const dir = workdir ?? cwd;

  return (
    <footer className="df-status" role="contentinfo">
      <div className="df-status__left">
        <RemoteChip />
        <CollabChip />
        <JobsChip />
        {LANGS.map((l) => (
          <KernelChip key={l} lang={l} />
        ))}
        <button className="df-status__item" onClick={() => void chooseWorkdir()} title={t('commands.workdir')}>
          <FolderOpen size={12} strokeWidth={1.8} aria-hidden />
          <span className="df-status__path">
            {/* LRM marks keep slashes in place while truncating from the left */}
            {dir ? (isCollabPath(dir) ? projectName(dir) : `\u200e${kernelPath(dir)}\u200e`) : t('status.noWorkdir')}
          </span>
        </button>
        <GitChip />
        <DebugChip />
      </div>
      <div className="df-status__right">
        <Problems />
        {cursor && (
          <>
            <LspChip language={cursor.language} />
            <span className="df-status__item is-static">{t('status.cursor', { line: cursor.line, col: cursor.column })}</span>
            <span className="df-status__item is-static">{cursor.language === 'r' ? 'R' : cursor.language === 'python' ? 'Python' : cursor.language}</span>
            <span className="df-status__item is-static">UTF-8</span>
          </>
        )}
      </div>
    </footer>
  );
}
