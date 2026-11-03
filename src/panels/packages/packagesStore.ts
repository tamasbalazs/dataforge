/** Installed packages per kernel, with actions run visibly in the console. */
import { create } from 'zustand';
import { on } from '../../core/bus';
import type { Lang } from '../../core/host';
import { host } from '../../core/host';
import { callHelper, execute, isRunning, useKernels } from '../../kernels/kernels';

export interface Pkg {
  name: string;
  version: string;
  title?: string | null;
  lib?: string;
  base?: boolean;
  loaded: boolean;
  attached: boolean;
  /** Python: importable module names. */
  modules?: string[];
}

interface State {
  list: Record<Lang, Pkg[]>;
  loading: Record<Lang, boolean>;
  error: Record<Lang, string | null>;
  outdated: Record<Lang, Record<string, string> | null>;
  checking: Record<Lang, boolean>;
  /** Python: pip is missing (uv-created venvs) → install with `uv pip`. */
  noPip: boolean;
}

export const usePackages = create<State>(() => ({
  list: { r: [], python: [] },
  loading: { r: false, python: false },
  error: { r: null, python: null },
  outdated: { r: null, python: null },
  checking: { r: false, python: false },
  noPip: false,
}));

type PerLang = Exclude<keyof State, 'noPip'>;
const patch = <K extends PerLang>(key: K, lang: Lang, value: State[K][Lang]) =>
  usePackages.setState((s) => ({ [key]: { ...s[key], [lang]: value } }) as Partial<State>);

export async function refreshPackages(lang: Lang) {
  if (!isRunning(lang)) return;
  patch('loading', lang, true);
  try {
    if (lang === 'python') {
      const info = await callHelper<{ hasPip?: boolean }>(lang, 'lib_info').catch(() => null);
      usePackages.setState({ noPip: info?.hasPip === false });
    }
    const list = await callHelper<Pkg[]>(lang, 'packages');
    if (list) {
      patch('list', lang, list);
      patch('error', lang, null);
    }
  } catch (e) {
    patch('error', lang, String(e));
  } finally {
    patch('loading', lang, false);
  }
}

export async function checkOutdated(lang: Lang) {
  patch('checking', lang, true);
  try {
    const res = await callHelper<Array<{ name: string; latest: string }>>(lang, 'packages_outdated');
    patch('outdated', lang, Object.fromEntries((res ?? []).map((r) => [r.name.toLowerCase(), r.latest])));
    patch('error', lang, null);
  } catch (e) {
    patch('error', lang, String(e));
  } finally {
    patch('checking', lang, false);
  }
}

const q = (s: string) => JSON.stringify(s);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._\-[\],=<>!~ ]*$/;

/** Console code for package actions. `renv` installs through renv in renv projects. */
export function actionCode(
  lang: Lang,
  action: 'install' | 'update' | 'remove' | 'load' | 'unload',
  names: string[],
  opts: { renv?: boolean; module?: string; uv?: { program: string; python: string } } = {},
): string | null {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (!clean.length || clean.some((n) => !NAME.test(n))) return null;
  if (lang === 'r') {
    const vec = clean.length === 1 ? q(clean[0]) : `c(${clean.map(q).join(', ')})`;
    switch (action) {
      case 'install':
      case 'update':
        return opts.renv ? `renv::install(${vec})` : `install.packages(${vec})`;
      case 'remove':
        return opts.renv ? `renv::remove(${vec})` : `remove.packages(${vec})`;
      case 'load':
        return clean.map((n) => `library(${n})`).join('\n');
      case 'unload':
        return clean.map((n) => `detach("package:${n}", unload = TRUE)`).join('\n');
    }
  }
  const args = clean.map((n) => (/[\s<>=!~]/.test(n) ? q(n) : n)).join(' ');
  if (opts.uv && action !== 'load' && action !== 'unload') {
    const base = `!${q(opts.uv.program)} pip`;
    const py = `--python ${q(opts.uv.python)}`;
    if (action === 'remove') return `${base} uninstall ${py} ${args}`;
    return `${base} install ${py}${action === 'update' ? ' --upgrade' : ''} ${args}`;
  }
  switch (action) {
    case 'install':
      return `%pip install ${args}`;
    case 'update':
      return `%pip install --upgrade ${args}`;
    case 'remove':
      return `%pip uninstall -y ${args}`;
    case 'load':
      return `import ${opts.module ?? clean[0].replace(/-/g, '_')}`;
    case 'unload':
      return null;
  }
}

export async function runPackageAction(lang: Lang, action: Parameters<typeof actionCode>[1], names: string[], opts: Parameters<typeof actionCode>[3] = {}) {
  if (lang === 'python' && usePackages.getState().noPip && !opts.uv) {
    const program = await host().findProgram('uv');
    const python = useKernels.getState().kernels.python.interpreter;
    if (program && python) opts = { ...opts, uv: { program, python } };
  }
  const code = actionCode(lang, action, names, opts);
  if (!code) return false;
  await execute(lang, code);
  return true;
}

const TOUCHES_PACKAGES = /install|remove\.packages|library\(|require\(|detach\(|renv::|%pip|pip install|pip uninstall|import /;

export function installPackageListeners(): () => void {
  const pendingCode = new Map<string, string>();
  const offs = [
    on('kernel:ready', ({ lang }) => {
      patch('outdated', lang, null);
      void refreshPackages(lang);
    }),
    on('kernel:execution-start', ({ msgId, code }) => {
      if (TOUCHES_PACKAGES.test(code)) pendingCode.set(msgId, code);
    }),
    on('kernel:execution-done', ({ lang, msgId }) => {
      if (pendingCode.delete(msgId)) void refreshPackages(lang);
    }),
  ];
  return () => offs.forEach((o) => o());
}
