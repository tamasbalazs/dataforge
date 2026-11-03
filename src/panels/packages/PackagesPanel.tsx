import { ArrowUpCircle, BookOpen, Box, Check, Download, FolderOpen, Package, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../../core/dialog';
import { host, type Lang } from '../../core/host';
import { formatNumber } from '../../core/format';
import { runTask } from '../../core/tasks';
import { chooseInterpreter, execute, LANG_LABEL, LANGS, restartKernel, useKernels } from '../../kernels/kernels';
import { inspectProject, openProjectDialog, setProjectInterpreter, useProject } from '../../project/project';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Segmented } from '../../ui/Segmented';
import { Spinner } from '../../ui/Spinner';
import { useConsole } from '../console/consoleStore';
import { showHelp } from '../help/helpStore';
import { checkOutdated, refreshPackages, runPackageAction, usePackages, type Pkg } from './packagesStore';

type Filter = 'all' | 'loaded' | 'outdated';

function EnvCard({ lang }: { lang: Lang }) {
  const { t } = useTranslation();
  const info = useProject((s) => s.info);
  const kernel = useKernels((s) => s.kernels[lang]);
  const root = info?.root ?? null;
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  if (lang === 'r') {
    const renv = info?.r.renv;
    return (
      <div className="df-envcard">
        <Box size={14} className="df-envcard__icon" aria-hidden />
        <div className="df-envcard__text">
          <strong>{renv ? t('packages.renvActive') : t('packages.userLibrary')}</strong>
          <span>{renv ? (info?.r.renvLock ? 'renv.lock' : t('packages.renvNoLock')) : `R ${kernel.version ?? ''}`}</span>
        </div>
        {root && renv && (
          <div className="df-envcard__actions">
            <Button size="sm" variant="ghost" onClick={() => void execute('r', 'renv::snapshot(prompt = FALSE)')}>
              {t('packages.snapshot')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void execute('r', 'renv::restore(prompt = FALSE)')}>
              {t('packages.restore')}
            </Button>
          </div>
        )}
        {root && !renv && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await execute('r', 'renv::init(bare = TRUE, restart = FALSE)');
                await inspectProject();
              })
            }
          >
            {t('packages.renvInit')}
          </Button>
        )}
      </div>
    );
  }

  const venv = info?.python.venvs.find((v) => v.path === kernel.interpreter);
  const python = chooseInterpreter('python');
  const canUv = !!info?.python.uv && (info.python.pyproject || info.python.uvLock);
  return (
    <div className="df-envcard">
      <Box size={14} className="df-envcard__icon" aria-hidden />
      <div className="df-envcard__text">
        <strong>{venv ? t('packages.projectVenv') : t('packages.globalPython')}</strong>
        <span title={kernel.interpreter}>{venv ? venv.path.replace(root ?? '', '.') : (kernel.interpreter ?? '')}</span>
      </div>
      <div className="df-envcard__actions">
        {root && !info?.python.venvs.length && python && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const steps = await host().projectVenvSteps(root, python.path);
                const code = await runTask(t('packages.creatingVenv'), steps, root);
                if (code === 0) {
                  const fresh = await inspectProject(root);
                  const created = fresh?.python.venvs.find((v) => v.hasKernel);
                  if (created) await setProjectInterpreter('python', created.path);
                }
              })
            }
          >
            {t('packages.createVenv')}
          </Button>
        )}
        {root && canUv && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const code = await runTask('uv sync', [{ program: info!.python.uv!, args: ['sync'] }], root);
                if (code === 0) {
                  await inspectProject(root);
                  await restartKernel('python');
                }
              })
            }
          >
            uv sync
          </Button>
        )}
        {root && info?.python.requirements && !canUv && (
          <Button size="sm" variant="ghost" onClick={() => void execute('python', '%pip install -r requirements.txt')}>
            {t('packages.installRequirements')}
          </Button>
        )}
        {!root && (
          <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void openProjectDialog()}>
            {t('project.open')}
          </Button>
        )}
      </div>
    </div>
  );
}

function PkgRow({ p, lang, latest, renv }: { p: Pkg; lang: Lang; latest?: string; renv: boolean }) {
  const { t } = useTranslation();
  const toggle = () => {
    if (lang === 'r') void runPackageAction('r', p.attached ? 'unload' : 'load', [p.name]);
    else if (!p.loaded) void runPackageAction('python', 'load', [p.name], { module: p.modules?.[0] });
  };
  const canToggle = lang === 'r' ? !p.base : !p.loaded && !!p.modules?.length;
  const remove = async () => {
    const ok = await ask(t('packages.removeTitle', { name: p.name }), t('packages.removeBody'), [
      { id: 'remove', label: t('packages.remove'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (ok === 'remove') await runPackageAction(lang, 'remove', [p.name], { renv });
  };
  return (
    <li className={`df-pkg ${p.attached ? 'is-loaded' : ''}`}>
      <button
        role="checkbox"
        aria-checked={lang === 'r' ? p.attached : p.loaded}
        aria-label={lang === 'r' ? (p.attached ? t('packages.unloadName', { name: p.name }) : t('packages.loadName', { name: p.name })) : t('packages.importName', { name: p.name })}
        className={`df-pkg__check ${(lang === 'r' ? p.attached : p.loaded) ? 'is-on' : ''}`}
        disabled={!canToggle && !(lang === 'r' && p.attached)}
        onClick={toggle}
      >
        {(lang === 'r' ? p.attached : p.loaded) && <Check size={11} strokeWidth={3} />}
      </button>
      <div className="df-pkg__main">
        <div className="df-pkg__line">
          <span className="df-pkg__name">{p.name}</span>
          <span className="df-pkg__version">{p.version}</span>
          {latest && (
            <span className="df-pkg__latest" title={t('packages.updateAvailable', { version: latest })}>
              → {latest}
            </span>
          )}
        </div>
        {p.title && <div className="df-pkg__title">{p.title}</div>}
      </div>
      <div className="df-pkg__actions">
        <IconButton
          icon={BookOpen}
          size="sm"
          label={t('packages.help', { name: p.name })}
          onClick={() => showHelp(lang, lang === 'r' ? `${p.name}-package` : (p.modules?.[0] ?? p.name), lang === 'r' ? p.name : undefined)}
        />
        {latest && <IconButton icon={ArrowUpCircle} size="sm" tone="accent" label={t('packages.update')} onClick={() => void runPackageAction(lang, 'update', [p.name], { renv })} />}
        {!p.base && <IconButton icon={Trash2} size="sm" label={t('packages.remove')} onClick={() => void remove()} />}
      </div>
    </li>
  );
}

export function PackagesPanel() {
  const { t } = useTranslation();
  const consoleLang = useConsole((s) => s.active);
  const [pinned, setPinned] = useState<Lang | null>(null);
  const lang = pinned ?? consoleLang;
  const list = usePackages((s) => s.list[lang]);
  const loading = usePackages((s) => s.loading[lang]);
  const error = usePackages((s) => s.error[lang]);
  const outdated = usePackages((s) => s.outdated[lang]);
  const checking = usePackages((s) => s.checking[lang]);
  const status = useKernels((s) => s.kernels[lang].status);
  const renv = !!useProject((s) => s.info?.r.renv) && lang === 'r';
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [installing, setInstalling] = useState(false);
  const [toInstall, setToInstall] = useState('');

  useEffect(() => {
    if (!list.length && (status === 'idle' || status === 'busy')) void refreshPackages(lang);
  }, [lang, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const qq = query.trim().toLowerCase();
    return list.filter((p) => {
      if (filter === 'loaded' && !(lang === 'r' ? p.attached : p.loaded)) return false;
      if (filter === 'outdated' && !outdated?.[p.name.toLowerCase()]) return false;
      return !qq || p.name.toLowerCase().includes(qq) || (p.title ?? '').toLowerCase().includes(qq);
    });
  }, [list, query, filter, outdated, lang]);

  const install = async () => {
    const names = toInstall.split(/[,\s]+/).filter(Boolean);
    if (!names.length) return;
    if (await runPackageAction(lang, 'install', names, { renv })) {
      setToInstall('');
      setInstalling(false);
    }
  };

  const outdatedCount = outdated ? Object.keys(outdated).length : 0;

  return (
    <div className="df-packages">
      <div className="df-panel-toolbar">
        <Segmented size="sm" label={t('packages.language')} value={lang} onChange={setPinned} options={LANGS.map((l) => ({ value: l, label: LANG_LABEL[l] }))} />
        <div className="df-panel-toolbar__spacer" />
        {loading && <Spinner size={12} label={t('common.loading')} />}
        <IconButton icon={Plus} size="sm" tone="accent" label={t('packages.install')} active={installing} onClick={() => setInstalling((v) => !v)} />
        <IconButton icon={Download} size="sm" label={t('packages.checkUpdates')} disabled={checking || status !== 'idle'} onClick={() => void checkOutdated(lang)} />
        <IconButton icon={RefreshCw} size="sm" label={t('packages.refresh')} onClick={() => void refreshPackages(lang)} />
      </div>
      <EnvCard lang={lang} />
      {installing && (
        <div className="df-packages__install">
          <div className="df-search">
            <Package size={13} aria-hidden />
            <input
              autoFocus
              value={toInstall}
              onChange={(e) => setToInstall(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void install();
                if (e.key === 'Escape') setInstalling(false);
              }}
              placeholder={lang === 'r' ? t('packages.installPlaceholderR') : t('packages.installPlaceholderPy')}
              aria-label={t('packages.install')}
              spellCheck={false}
            />
          </div>
          <Button size="sm" variant="primary" disabled={!toInstall.trim()} onClick={() => void install()}>
            {t('packages.installShort')}
          </Button>
          <IconButton icon={X} size="sm" label={t('common.cancel')} onClick={() => setInstalling(false)} />
        </div>
      )}
      <div className="df-packages__filters">
        <div className="df-search">
          <Search size={13} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('packages.search')} aria-label={t('packages.search')} spellCheck={false} />
        </div>
        <Segmented<Filter>
          size="sm"
          label={t('packages.filter')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('packages.all') },
            { value: 'loaded', label: t('packages.loaded') },
            { value: 'outdated', label: checking ? '…' : outdated ? `${t('packages.outdated')} (${outdatedCount})` : t('packages.outdated') },
          ]}
        />
      </div>
      {error && <div className="df-packages__error">{error}</div>}
      <div className="df-packages__scroll">
        {status === 'unavailable' ? (
          <EmptyState icon={Package} title={t('kernel.status.unavailable')}>
            {t('env.noKernel', { lang: LANG_LABEL[lang] })}
          </EmptyState>
        ) : filter === 'outdated' && !outdated ? (
          <EmptyState
            icon={Download}
            title={t('packages.notChecked')}
            actions={
              <Button size="sm" disabled={checking} onClick={() => void checkOutdated(lang)}>
                {checking && <Spinner size={12} />} {t('packages.checkUpdates')}
              </Button>
            }
          >
            {t('packages.notCheckedBody')}
          </EmptyState>
        ) : (
          <ul className="df-pkg-list">
            {shown.map((p) => (
              <PkgRow key={p.name} p={p} lang={lang} latest={outdated?.[p.name.toLowerCase()]} renv={renv} />
            ))}
          </ul>
        )}
      </div>
      <div className="df-panel-footer">
        {t('packages.summary', { count: list.length, n: formatNumber(list.length), loaded: formatNumber(list.filter((p) => (lang === 'r' ? p.attached : p.loaded)).length) })}
      </div>
    </div>
  );
}
