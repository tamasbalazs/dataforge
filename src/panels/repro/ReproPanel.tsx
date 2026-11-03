import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Database,
  FileCode2,
  GitBranch,
  Info,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '../environment/envStore';
import { useSettings } from '../../core/settings';
import type { ReproReport } from '../../repro/bundle';
import { analyzeProject, exportBundle, issueText, moveEntryPoint, setOptions, toggleEntryPoint, useRepro } from '../../repro/reproStore';
import type { Issue } from '../../repro/scan';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Segmented } from '../../ui/Segmented';
import { Spinner } from '../../ui/Spinner';
import { openAt } from '../editor/editorService';

type Tone = 'ok' | 'warn' | 'error' | 'muted';
const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, error: AlertCircle, muted: Info };

function Check({ tone, icon: Icon, title, children }: { tone: Tone; icon: typeof Info; title: string; children?: ReactNode }) {
  const S = TONE_ICON[tone];
  return (
    <li className={`df-repro__check is-${tone}`}>
      <Icon size={15} strokeWidth={1.75} aria-hidden className="df-repro__checkicon" />
      <div className="df-repro__checktext">
        <strong>{title}</strong>
        {children && <span>{children}</span>}
      </div>
      <S size={15} strokeWidth={2} className="df-repro__status" aria-label={tone} />
    </li>
  );
}

function Fold({ title, count, children, open: initial = false }: { title: string; count?: number; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="df-repro__fold">
      <button className="df-git__section-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight size={12} strokeWidth={2} className={`df-git__chev ${open ? 'is-open' : ''}`} aria-hidden />
        {title}
        {count != null && <span className="df-git__count">{count}</span>}
      </button>
      {open && <div className="df-repro__foldbody">{children}</div>}
    </section>
  );
}

function IssueRow({ issue, root }: { issue: Issue; root: string }) {
  const Icon = issue.severity === 'error' ? AlertCircle : issue.severity === 'warning' ? AlertTriangle : Info;
  const content = (
    <>
      <Icon size={13} strokeWidth={2} aria-hidden className={`df-repro__sev is-${issue.severity}`} />
      <span>{issueText(issue)}</span>
    </>
  );
  return (
    <li>
      {issue.file ? (
        <button className="df-repro__issue" onClick={() => openAt(`${root}/${issue.file}`, issue.line)}>
          {content}
        </button>
      ) : (
        <div className="df-repro__issue is-static">{content}</div>
      )}
    </li>
  );
}

function Packages({ report }: { report: ReproReport }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const rows = [
    ...(report.r?.info?.packages ?? []).map((p) => ({ lang: 'R', name: p.Package, version: p.Version, source: p.Source === 'Repository' ? (p.Repository ?? 'CRAN') : p.Source, direct: p.direct, loc: report.r?.usage[p.Package]?.[0] })),
    ...(report.python?.info?.packages ?? []).map((p) => ({ lang: 'Python', name: p.name, version: p.version, source: 'PyPI', direct: p.direct, loc: p.module ? report.python?.usage[p.module]?.[0] : undefined })),
  ];
  const shown = all ? rows : rows.filter((r) => r.direct);
  return (
    <Fold title={t('repro.packages')} count={rows.length}>
      <table className="df-repro__table">
        <thead>
          <tr>
            <th>{t('repro.col.package')}</th>
            <th>{t('repro.col.version')}</th>
            <th>{t('repro.col.source')}</th>
            <th>{t('repro.col.usedIn')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={`${r.lang}:${r.name}`} className={r.direct ? '' : 'is-dep'}>
              <td>
                <span className="df-repro__lang">{r.lang}</span> {r.name}
              </td>
              <td className="df-repro__mono">{r.version}</td>
              <td>{r.source}</td>
              <td>
                {r.loc ? (
                  <button className="df-repro__link" onClick={() => openAt(`${report.root}/${r.loc!.file}`, r.loc!.line)}>
                    {r.loc.file}:{r.loc.line}
                  </button>
                ) : (
                  <span className="df-repro__muted">{t('repro.dependency')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length || all ? (
        <button className="df-repro__link df-repro__more" onClick={() => setAll((a) => !a)}>
          {all ? t('repro.directOnly') : t('repro.showDeps', { count: rows.length - shown.length })}
        </button>
      ) : null}
    </Fold>
  );
}

export function ReproPanel() {
  const { t } = useTranslation();
  const workdir = useSettings((s) => s.workdir);
  const s = useRepro();
  const report = s.report;

  useEffect(() => {
    if (workdir && (!report || report.root !== workdir) && s.status !== 'scanning') void analyzeProject();
  }, [workdir]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const i of report?.issues ?? []) c[i.severity]++;
    return c;
  }, [report]);

  if (!workdir) {
    return (
      <EmptyState icon={ShieldCheck} title={t('repro.noProjectTitle')}>
        {t('repro.noProjectBody')}
      </EmptyState>
    );
  }

  const data = report?.files.filter((f) => f.role === 'data') ?? [];
  const code = report?.files.filter((f) => f.role === 'code') ?? [];
  const dataSize = data.reduce((a, f) => a + f.size, 0);
  const r = report?.r;
  const py = report?.python;
  const headline = !report ? '' : counts.error ? t('repro.headline.errors', { count: counts.error }) : counts.warning ? t('repro.headline.warnings', { count: counts.warning }) : t('repro.headline.ok');

  return (
    <div className="df-repro">
      <div className="df-panel-toolbar">
        <ShieldCheck size={14} strokeWidth={1.75} aria-hidden className="df-repro__titleicon" />
        <span className="df-repro__title">{t('repro.title')}</span>
        {s.status === 'scanning' && (
          <span className="df-repro__stage" role="status">
            <Spinner size={12} /> {s.stage}
          </span>
        )}
        <span className="df-panel-toolbar__spacer" />
        <IconButton icon={RefreshCw} size="sm" label={t('repro.rescan')} disabled={s.status === 'scanning'} onClick={() => void analyzeProject()} />
      </div>
      <div className="df-repro__body">
        {s.status === 'error' && <p className="df-repro__error">{s.error}</p>}
        {!report && s.status === 'scanning' && <p className="df-repro__muted">{t('repro.scanning')}</p>}
        {report && (
          <>
            <div className={`df-repro__headline is-${counts.error ? 'error' : counts.warning ? 'warn' : 'ok'}`}>
              {counts.error ? <AlertCircle size={18} aria-hidden /> : counts.warning ? <AlertTriangle size={18} aria-hidden /> : <CheckCircle2 size={18} aria-hidden />}
              <div>
                <strong>{headline}</strong>
                <span>{t('repro.headlineBody')}</span>
              </div>
            </div>

            <ul className="df-repro__checks">
              <Check
                tone={!r ? 'muted' : r.error ? 'error' : r.info?.missing.length ? 'error' : 'ok'}
                icon={PackageCheck}
                title={r?.info ? t('repro.check.r', { version: r.info.version }) : t('repro.check.rNone')}
              >
                {r?.error ?? (r?.info ? t('repro.check.pinned', { count: r.info.packages.length, direct: r.info.packages.filter((p) => p.direct).length }) : t('repro.check.notUsed'))}
              </Check>
              <Check
                tone={!py ? 'muted' : py.error ? 'error' : py.info?.missing.length ? 'error' : 'ok'}
                icon={PackageCheck}
                title={py?.info ? t('repro.check.python', { version: py.info.version }) : t('repro.check.pythonNone')}
              >
                {py?.error ?? (py?.info ? t('repro.check.pinned', { count: py.info.packages.length, direct: py.info.packages.filter((p) => p.direct).length }) : t('repro.check.notUsed'))}
              </Check>
              <Check tone={report.missingData.length ? 'warn' : 'ok'} icon={Database} title={t('repro.check.data', { count: data.length, size: formatBytes(dataSize) })}>
                {report.missingData.length ? t('repro.check.dataMissing', { count: new Set(report.missingData.map((m) => m.ref)).size }) : t('repro.check.dataOk')}
              </Check>
              <Check tone={!report.git.repo ? 'muted' : report.git.dirty.length ? 'warn' : 'ok'} icon={GitBranch} title={report.git.repo ? t('repro.check.git', { commit: report.git.commit?.slice(0, 7) ?? '—', branch: report.git.branch ?? '—' }) : t('repro.check.noGit')}>
                {report.git.repo ? (report.git.dirty.length ? t('repro.check.dirty', { count: report.git.dirty.length }) : t('repro.check.clean')) : t('repro.check.noGitBody')}
              </Check>
              <Check tone="ok" icon={FileCode2} title={t('repro.check.code', { count: code.length })}>
                {t('repro.check.checksums', { count: report.files.length })}
              </Check>
            </ul>

            {report.issues.length > 0 && (
              <Fold title={t('repro.issues')} count={report.issues.length} open>
                <ul className="df-repro__issues">
                  {report.issues.map((i, k) => (
                    <IssueRow key={k} issue={i} root={report.root} />
                  ))}
                </ul>
              </Fold>
            )}
            <Packages report={report} />
            <Fold title={t('repro.dataFiles')} count={data.length}>
              <ul className="df-repro__files">
                {data.map((f) => (
                  <li key={f.path}>
                    <Database size={12} aria-hidden />
                    <span className="df-repro__mono">{f.path}</span>
                    <span className="df-repro__muted">{formatBytes(f.size)}</span>
                    <span className="df-repro__muted">{f.referencedBy?.length ? t('repro.usedBy', { file: f.referencedBy[0].file }) : t('repro.notReferenced')}</span>
                  </li>
                ))}
              </ul>
            </Fold>

            <section className="df-repro__export" aria-label={t('repro.export')}>
              <h3>{t('repro.export')}</h3>
              <label className="df-check">
                <input type="checkbox" checked={s.options.includeData} onChange={(e) => setOptions({ includeData: e.target.checked })} />
                {t('repro.opt.data', { size: formatBytes(dataSize) })}
              </label>
              <label className="df-check">
                <input type="checkbox" checked={s.options.dockerfile} onChange={(e) => setOptions({ dockerfile: e.target.checked })} />
                {t('repro.opt.docker')}
              </label>
              <div className="df-repro__entry">
                <span className="df-repro__label">{t('repro.opt.entry')}</span>
                <ul>
                  {code
                    .filter((f) => /\.(r|py|qmd|rmd|ipynb)$/i.test(f.path))
                    .sort((a, b) => {
                      const ea = s.options.entryPoints.indexOf(a.path);
                      const eb = s.options.entryPoints.indexOf(b.path);
                      return (ea < 0 ? 1e6 : ea) - (eb < 0 ? 1e6 : eb) || a.path.localeCompare(b.path);
                    })
                    .map((f) => {
                      const idx = s.options.entryPoints.indexOf(f.path);
                      return (
                        <li key={f.path}>
                          <label className="df-check">
                            <input type="checkbox" checked={idx >= 0} onChange={() => toggleEntryPoint(f.path)} />
                            {idx >= 0 && <span className="df-repro__order">{idx + 1}.</span>}
                            <span className="df-repro__mono">{f.path}</span>
                          </label>
                          {idx >= 0 && (
                            <span className="df-repro__move">
                              <IconButton icon={ArrowUp} size="sm" label={t('repro.moveUp')} disabled={idx === 0} onClick={() => moveEntryPoint(f.path, -1)} />
                              <IconButton icon={ArrowDown} size="sm" label={t('repro.moveDown')} disabled={idx === s.options.entryPoints.length - 1} onClick={() => moveEntryPoint(f.path, 1)} />
                            </span>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </div>
              <div className="df-repro__exportrow">
                <Segmented
                  size="sm"
                  label={t('repro.opt.format')}
                  value={s.options.format}
                  onChange={(v) => setOptions({ format: v as 'zip' | 'folder' })}
                  options={[
                    { value: 'zip', label: 'ZIP' },
                    { value: 'folder', label: t('repro.opt.folder') },
                  ]}
                />
                <Button variant="primary" size="sm" icon={ShieldCheck} disabled={s.exporting || s.status === 'scanning'} onClick={() => void exportBundle()}>
                  {s.exporting ? t('repro.exporting') : t('repro.exportButton')}
                </Button>
              </div>
              {counts.error > 0 && <p className="df-repro__note">{t('repro.exportWithErrors')}</p>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
