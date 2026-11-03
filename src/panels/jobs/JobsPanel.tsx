/** Background jobs: list, per-chain Stan progress, diagnostics and the log. */
import { AlertTriangle, CheckCircle2, CircleSlash, Download, FileCode2, Play, RefreshCw, Square, Trash2, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { JobInfo } from '../../core/host';
import { isCollabPath, isRemotePath, parseRemote } from '../../core/paths';
import { useSettings } from '../../core/settings';
import { cancelJob, importResults, refreshJobs, removeJob, selectJob, useJobs, type JobView } from '../../jobs/jobsStore';
import { eta, formatDuration, overallFraction, type ChainProgress } from '../../jobs/progress';
import { openJobDialog } from '../../jobs/jobDialog';
import { useEditor } from '../editor/editorStore';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Spinner } from '../../ui/Spinner';
import { stripAnsi } from '../console/ansi';

function StatusIcon({ status }: { status: JobInfo['status'] }) {
  if (status === 'running') return <Spinner size={12} />;
  if (status === 'done') return <CheckCircle2 size={14} className="df-jobs__ok" aria-hidden />;
  if (status === 'cancelled') return <CircleSlash size={14} className="df-jobs__muted" aria-hidden />;
  return <XCircle size={14} className="df-jobs__bad" aria-hidden />;
}

function Bar({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.round(fraction * 100);
  return (
    <div className="df-jobs__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function ChainRow({ c }: { c: ChainProgress }) {
  const { t } = useTranslation();
  const f = c.phase === 'done' ? 1 : c.total ? c.iter / c.total : 0;
  const warm = c.total ? Math.min(1, (c.phase === 'warmup' ? c.iter : c.total / 2) / c.total) : 0;
  return (
    <li className={`df-jobs__chain is-${c.phase}`}>
      <span className="df-jobs__chain-name">{t('jobs.chain', { n: c.chain })}</span>
      <div className="df-jobs__bar df-jobs__bar--chain" role="progressbar" aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={c.iter} aria-label={t('jobs.chain', { n: c.chain })}>
        <span className="is-warmup" style={{ width: `${Math.round(Math.min(f, warm) * 100)}%` }} />
        <span className="is-sampling" style={{ width: `${Math.round(Math.max(0, f - warm) * 100)}%` }} />
      </div>
      <span className="df-jobs__chain-meta">
        {c.phase === 'done' ? (c.seconds != null ? formatDuration(c.seconds) : '✓') : `${c.iter} / ${c.total} · ${t(`jobs.phase.${c.phase}`)}`}
      </span>
    </li>
  );
}

function elapsed(info: JobInfo) {
  return formatDuration((Date.now() - info.created) / 1000);
}

function Row({ v, selected }: { v: JobView; selected: boolean }) {
  const { t } = useTranslation();
  const f = overallFraction(v.progress);
  const left = v.info.status === 'running' ? eta(v.samples) : null;
  return (
    <li>
      <button type="button" className={`df-jobs__row ${selected ? 'is-active' : ''}`} aria-current={selected ? 'true' : undefined} onClick={() => selectJob(v.info.id)}>
        <StatusIcon status={v.info.status} />
        <span className="df-jobs__row-main">
          <span className="df-jobs__name">{v.info.name}</span>
          <span className="df-jobs__muted">
            {t(`jobs.status.${v.info.status}`)}
            {v.info.status === 'running' && ` · ${elapsed(v.info)}`}
            {left != null && left > 0 && ` · ${t('jobs.eta', { time: formatDuration(left) })}`}
          </span>
        </span>
        {f != null && v.info.status === 'running' && <span className="df-jobs__pct">{Math.round(f * 100)}%</span>}
      </button>
      {f != null && v.info.status === 'running' && <Bar fraction={f} label={v.info.name} />}
    </li>
  );
}

function Detail({ v }: { v: JobView }) {
  const { t } = useTranslation();
  const log = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [v.log]);
  const chains = Object.values(v.progress.chains).sort((a, b) => a.chain - b.chain);
  const { divergences, treedepthHits, warnings, errors } = v.progress;
  const running = v.info.status === 'running';
  return (
    <section className="df-jobs__detail" aria-label={v.info.name}>
      <div className="df-jobs__detail-head">
        <StatusIcon status={v.info.status} />
        <strong>{v.info.name}</strong>
        <span className="df-panel-toolbar__spacer" />
        {running && (
          <Button size="sm" variant="secondary" icon={Square} onClick={() => void cancelJob(v.info.id)}>
            {t('jobs.cancel')}
          </Button>
        )}
        {v.info.status === 'done' && v.info.meta?.result && (
          <Button size="sm" variant="primary" icon={Download} onClick={() => void importResults(v.info.id)}>
            {v.info.kind === 'stan' ? t('jobs.importAs', { name: v.info.meta?.resultName ?? 'fit' }) : t('jobs.import')}
          </Button>
        )}
        {!running && <IconButton icon={Trash2} size="sm" label={t('jobs.remove')} onClick={() => void removeJob(v.info.id)} />}
      </div>
      <p className="df-jobs__muted">
        {t('jobs.startedAt', { time: new Date(v.info.created).toLocaleString() })}
        {v.info.exitCode != null && ` · ${t('jobs.exitCode', { code: v.info.exitCode })}`}
        {v.info.status === 'lost' && ` · ${t('jobs.lostHint')}`}
      </p>
      {chains.length > 0 && (
        <ul className="df-jobs__chains" aria-label={t('jobs.chains')}>
          {chains.map((c) => (
            <ChainRow key={c.chain} c={c} />
          ))}
        </ul>
      )}
      {(divergences || treedepthHits || warnings.length > 0) && (
        <div className="df-jobs__warn" role="note">
          <AlertTriangle size={14} aria-hidden />
          <div>
            {divergences ? <p>{t('jobs.divergencesLong', { count: divergences })}</p> : null}
            {treedepthHits ? <p>{t('jobs.treedepthLong', { count: treedepthHits })}</p> : null}
            {warnings.slice(0, 4).map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        </div>
      )}
      {errors.length > 0 && (
        <div className="df-jobs__err" role="alert">
          {errors.slice(0, 3).map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      <pre
        ref={log}
        className="df-jobs__log"
        tabIndex={0}
        aria-label={t('jobs.log')}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
        }}
      >
        {stripAnsi(v.log) || (running ? t('jobs.waitingOutput') : '')}
      </pre>
    </section>
  );
}

export function JobsPanel() {
  const { t } = useTranslation();
  const { jobs, order, selected, loading, error, offline } = useJobs();
  const workdir = useSettings((s) => s.workdir);
  const where = isRemotePath(workdir) ? t('jobs.whereRemote', { host: parseRemote(workdir)!.id }) : t('jobs.whereLocal');
  // Subscribed, so the button follows the editor's active tab.
  const doc = useEditor((s) => s.docs.find((d) => d.id === s.activeId) ?? null);
  const canScript = doc?.language === 'r' || doc?.language === 'stan';
  const sel = selected ? jobs[selected] : null;
  if (isCollabPath(workdir)) {
    return (
      <div className="df-jobs">
        <EmptyState icon={Play} title={t('jobs.title')}>
          <p>{t('jobs.notInSession')}</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="df-jobs">
      <div className="df-panel-toolbar">
        <Button size="sm" variant="secondary" icon={doc?.language === 'stan' ? FileCode2 : Play} disabled={!canScript} onClick={() => void openJobDialog(doc?.language === 'stan' ? { stanFile: doc.path } : { scriptPath: doc?.path })}>
          {doc?.language === 'stan' ? t('jobs.runModel') : t('jobs.runScript')}
        </Button>
        <span className="df-jobs__where">{where}</span>
        <span className="df-panel-toolbar__spacer" />
        {loading && <Spinner size={12} />}
        <IconButton icon={RefreshCw} size="sm" label={t('jobs.refresh')} onClick={() => void refreshJobs()} />
      </div>
      {error && <p className="df-jobs__error" role="alert">{error}</p>}
      {offline && !error && (
        <p className="df-jobs__offline" role="status">
          <AlertTriangle size={14} aria-hidden /> {t('jobs.offline')}
        </p>
      )}
      {!order.length ? (
        <EmptyState icon={Play} title={t('jobs.emptyTitle')}>
          <p>{t('jobs.emptyBody')}</p>
        </EmptyState>
      ) : (
        <div className="df-jobs__body">
          <ul className="df-jobs__list" aria-label={t('jobs.title')}>
            {order.map((id) => jobs[id] && <Row key={id} v={jobs[id]} selected={id === selected} />)}
          </ul>
          {sel && <Detail v={sel} />}
        </div>
      )}
    </div>
  );
}
