/** "Run as background job" dialog: Stan sampling (cmdstanr / rstan) or an R script. */
import { PlayCircle, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../app/SettingsDialog';
import { useUi } from '../app/uiStore';
import { t as tr } from '../core/i18n';
import { isCollabPath } from '../core/paths';
import { getSettings } from '../core/settings';
import { toast } from '../core/toast';
import { useEnv } from '../panels/environment/envStore';
import { saveDoc } from '../panels/editor/editorService';
import { useEditor } from '../panels/editor/editorStore';
import { Button, IconButton } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { Spinner } from '../ui/Spinner';
import { revealPanel } from '../workbench/layout';
import { startScriptJob, startStanJob } from './jobsStore';
import { defaultStanOptions, validateStanOptions, type StanJobOptions } from './scripts';

export interface JobDialogRequest {
  stanFile?: string | null;
  scriptPath?: string | null;
}

/** Open the dialog for a model or script; unsaved documents are saved first. */
export async function openJobDialog(req: JobDialogRequest) {
  if (isCollabPath(getSettings().workdir)) {
    toast({ kind: 'error', title: tr('jobs.notInSession') });
    return;
  }
  const path = req.stanFile ?? req.scriptPath;
  const doc = useEditor.getState().docs.find((d) => (path ? d.path === path : d.id === useEditor.getState().activeId));
  if (doc && (!doc.path || doc.dirty)) {
    if (!(await saveDoc(doc.id))) return;
  }
  const saved = doc ? useEditor.getState().docs.find((d) => d.id === doc.id) : null;
  const file = saved?.path ?? path;
  if (!file) return;
  useUi.setState({ jobDialog: file.toLowerCase().endsWith('.stan') ? { stanFile: file } : { scriptPath: file } });
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

export function JobDialog() {
  const { t } = useTranslation();
  const req = useUi((s) => s.jobDialog);
  const rVars = useEnv((s) => s.vars.r);
  const stanFile = req?.stanFile ?? null;
  const base = useMemo(() => defaultStanOptions(stanFile ?? ''), [stanFile]);
  const [o, setO] = useState<StanJobOptions>(base);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dataObject, setDataObject] = useState<string>('');
  const [resultName, setResultName] = useState('fit');
  const [keep, setKeep] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useFocusTrap(!!req);
  const close = () => useUi.setState({ jobDialog: null });

  useEffect(() => {
    setO(base);
    setDraft({});
    setErrors([]);
    // A list called like the usual data objects is the likely choice.
    const guess = rVars.find((v) => /^(stan_?data|data_list|standata|dat)$/i.test(v.name) && v.kind === 'list');
    setDataObject(guess?.name ?? '');
  }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);

  if (!req) return null;
  const name = (stanFile ?? req.scriptPath ?? '').split(/[\\/]/).pop() ?? '';

  const numField = (key: keyof StanJobOptions, label: string, step = '1') => (
    <div className="df-remote__field">
      <label htmlFor={`df-job-${key}`}>{label}</label>
      <input
        id={`df-job-${key}`}
        className="df-input"
        inputMode="decimal"
        step={step}
        value={draft[key] ?? String(o[key] ?? '')}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      />
    </div>
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (stanFile) {
        const opts: StanJobOptions = { ...o };
        for (const [k, v] of Object.entries(draft)) (opts as any)[k] = k === 'seed' && v.trim() === '' ? null : num(v);
        const bad = validateStanOptions(opts);
        if (!/^[A-Za-z.][A-Za-z0-9._]*$/.test(resultName)) bad.push('jobs.err.resultName');
        setErrors(bad);
        if (bad.length) return;
        const job = await startStanJob({ name: `Stan: ${name}`, options: opts, dataObject: dataObject || null, resultName });
        if (job) {
          close();
          revealPanel('jobs', { focus: false });
        }
      } else if (req.scriptPath) {
        const job = await startScriptJob(req.scriptPath, keep);
        if (job) {
          close();
          revealPanel('jobs', { focus: false });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="df-overlay" onMouseDown={close}>
      <div ref={ref} className="df-dialog df-job-dialog" role="dialog" aria-modal="true" aria-labelledby="df-job-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="df-dialog__header">
          <h2 id="df-job-title">{stanFile ? t('jobs.stanTitle', { name }) : t('jobs.scriptTitle', { name })}</h2>
          <IconButton icon={X} label={t('common.close')} onClick={close} />
        </div>
        <form className="df-dialog__body" onSubmit={(e) => void submit(e)} noValidate>
          <p className="df-collab__muted">{t('jobs.intro')}</p>
          {stanFile ? (
            <>
              <div className="df-remote__field">
                <span className="df-job-dialog__label">{t('jobs.backend')}</span>
                <Segmented<StanJobOptions['backend']>
                  label={t('jobs.backend')}
                  value={o.backend}
                  onChange={(backend) => setO((x) => ({ ...x, backend }))}
                  options={[
                    { value: 'cmdstanr', label: 'cmdstanr' },
                    { value: 'rstan', label: 'rstan' },
                  ]}
                />
              </div>
              <div className="df-remote__field">
                <label htmlFor="df-job-data">{t('jobs.data')}</label>
                <select id="df-job-data" className="df-input" value={dataObject} onChange={(e) => setDataObject(e.target.value)} data-autofocus>
                  <option value="">{t('jobs.noData')}</option>
                  {rVars
                    .filter((v) => v.kind === 'list' || v.kind === 'data')
                    .map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name} ({v.type})
                      </option>
                    ))}
                </select>
                <p className="df-field__hint">{rVars.some((v) => v.kind === 'list' || v.kind === 'data') ? t('jobs.dataHint') : t('jobs.noDataObjects')}</p>
              </div>
              <div className="df-job-dialog__grid">
                {numField('chains', t('jobs.chains'))}
                {numField('parallelChains', t('jobs.parallel'))}
                {numField('iterWarmup', t('jobs.warmup'))}
                {numField('iterSampling', t('jobs.sampling'))}
                {numField('seed', t('jobs.seed'))}
                {numField('adaptDelta', 'adapt_delta', '0.01')}
                {numField('maxTreedepth', 'max_treedepth')}
                {numField('refresh', t('jobs.refresh'))}
              </div>
              <div className="df-remote__field">
                <label htmlFor="df-job-result">{t('jobs.resultName')}</label>
                <input id="df-job-result" className="df-input" value={resultName} onChange={(e) => setResultName(e.target.value)} spellCheck={false} />
              </div>
            </>
          ) : (
            <label className="df-job-dialog__check">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
              <span>
                <strong>{t('jobs.keep')}</strong>
                <small>{t('jobs.keepHint')}</small>
              </span>
            </label>
          )}
          {errors.length > 0 && (
            <ul className="df-remote__error" role="alert">
              {errors.map((e) => (
                <li key={e}>{t(e)}</li>
              ))}
            </ul>
          )}
          <div className="df-remote__actions">
            <Button type="button" variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" icon={busy ? undefined : PlayCircle} disabled={busy}>
              {busy && <Spinner size={12} />} {t('jobs.start')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
