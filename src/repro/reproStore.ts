/**
 * Reproducibility report and export: scans the project, asks the kernels for
 * exact package versions, hashes files, reads the git state, and writes the
 * bundle built by bundle.ts.
 */
import { create } from 'zustand';
import { host, type Lang } from '../core/host';
import { t } from '../core/i18n';
import { getSettings } from '../core/settings';
import { toast } from '../core/toast';
import { callHelper, startKernel } from '../kernels/kernels';
import { bundleEntries, bundleName, type BundleOptions, type PyInfo, type ReproFile, type ReproReport, type RInfo } from './bundle';
import { CODE_EXT, DATA_EXT, localModules, R_BASE, resolveRef, scanFile, type Issue, type IssueKind, type Loc } from './scan';

export type ReproStatus = 'idle' | 'scanning' | 'ready' | 'error';

interface ReproState {
  status: ReproStatus;
  stage: string;
  report: ReproReport | null;
  error: string | null;
  options: Omit<BundleOptions, 'locale'> & { format: 'zip' | 'folder' };
  exporting: boolean;
  lastExport: string | null;
}

export const useRepro = create<ReproState>(() => ({
  status: 'idle',
  stage: '',
  report: null,
  error: null,
  options: { includeCode: true, includeData: true, dockerfile: true, entryPoints: [], format: 'zip' },
  exporting: false,
  lastExport: null,
}));

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const SEVERITY: Record<IssueKind, Issue['severity']> = {
  missingPackage: 'error',
  missingData: 'warning',
  setwd: 'warning',
  absolutePath: 'warning',
  noSeed: 'warning',
  uncommitted: 'warning',
  installInScript: 'info',
  noGit: 'info',
  githubPackage: 'info',
};

export const roleOf = (path: string): ReproFile['role'] => (CODE_EXT.test(path) ? 'code' : DATA_EXT.test(path) ? 'data' : 'other');

export function issueText(i: Issue): string {
  const where = i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : '';
  return t(`repro.issue.${i.kind}`, { detail: i.detail }) + where;
}

const stage = (s: string) => useRepro.setState({ stage: s });

async function langInfo<T>(lang: Lang, args: Record<string, unknown>): Promise<{ info?: T; error?: string }> {
  try {
    if (!(await startKernel(lang))) return { error: t('repro.kernelUnavailable') };
    const info = await callHelper<T>(lang, 'repro_info', args);
    return info ? { info } : { error: t('repro.kernelUnavailable') };
  } catch (e) {
    return { error: String(e) };
  }
}

async function gitState(root: string): Promise<ReproReport['git']> {
  const run = (args: string[]) => host().gitExec(root, args).catch(() => ({ code: -1, stdout: '', stderr: '' }));
  const head = await run(['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    const inside = await run(['rev-parse', '--is-inside-work-tree']);
    return { repo: inside.code === 0 && inside.stdout.trim() === 'true', commit: null, branch: null, dirty: [] };
  }
  const [branch, status, remote] = await Promise.all([run(['rev-parse', '--abbrev-ref', 'HEAD']), run(['status', '--porcelain', '-z']), run(['config', '--get', 'remote.origin.url'])]);
  const dirty = status.stdout.split('\0').filter(Boolean).map((l) => l.slice(3));
  return { repo: true, commit: head.stdout.trim(), branch: branch.stdout.trim() === 'HEAD' ? null : branch.stdout.trim(), dirty, remote: remote.stdout.trim() || null };
}

/** Build the full report for the current project. */
export async function analyzeProject(): Promise<void> {
  const root = getSettings().workdir;
  if (!root) {
    useRepro.setState({ status: 'idle', report: null });
    return;
  }
  useRepro.setState({ status: 'scanning', error: null });
  try {
    stage(t('repro.stage.files'));
    const list = await host().reproFiles(root);
    const files: ReproFile[] = list.map((f) => ({ ...f, role: roleOf(f.path) }));
    const paths = new Set(files.map((f) => f.path));
    const issues: Issue[] = [];
    const usage: Record<Lang, Record<string, Loc[]>> = { r: {}, python: {} };
    const langFiles: Record<Lang, Set<string>> = { r: new Set(), python: new Set() };
    const missingData: ReproReport['missingData'] = [];
    const refs = new Map<string, Loc[]>();

    stage(t('repro.stage.code'));
    for (const f of files.filter((x) => x.role === 'code' && x.size <= MAX_SCAN_BYTES).slice(0, 3000)) {
      let text: string;
      try {
        text = await host().readText(`${root}/${f.path}`);
      } catch {
        continue;
      }
      for (const scan of scanFile(f.path, text)) {
        langFiles[scan.lang].add(f.path);
        for (const [pkg, line] of scan.packages) (usage[scan.lang][pkg] ??= []).push({ file: f.path, line });
        for (const d of scan.dataRefs) {
          const hit = resolveRef(d.ref, f.path, paths);
          if (hit) (refs.get(hit) ?? refs.set(hit, []).get(hit)!).push({ file: f.path, line: d.line });
          else if (!/^(output|out|results?|figures?|kimenet|eredmeny)/i.test(d.ref) && !/\.(png|pdf|svg|html)$/i.test(d.ref)) missingData.push({ ref: d.ref, file: f.path, line: d.line });
        }
        for (const i of scan.issues) issues.push({ ...i, file: f.path, severity: SEVERITY[i.kind] });
      }
    }
    for (const f of files) if (refs.has(f.path)) f.referencedBy = refs.get(f.path);
    // A file that a script reads but nothing writes is input data; report the unmatched ones.
    const seenMissing = new Set<string>();
    for (const m of missingData) {
      if (seenMissing.has(m.ref)) continue;
      seenMissing.add(m.ref);
      issues.push({ kind: 'missingData', severity: SEVERITY.missingData, file: m.file, line: m.line, detail: m.ref });
    }

    const pyLocal = localModules([...paths]);
    for (const m of Object.keys(usage.python)) if (pyLocal.has(m)) delete usage.python[m];

    let r: ReproReport['r'] = null;
    let python: ReproReport['python'] = null;
    if (langFiles.r.size) {
      stage(t('repro.stage.r'));
      const pkgs = Object.keys(usage.r).filter((p) => !R_BASE.has(p));
      const res = await langInfo<RInfo>('r', { packages: pkgs });
      r = { files: [...langFiles.r], usage: usage.r, ...res };
      for (const p of res.info?.missing ?? []) {
        const loc = usage.r[p]?.[0];
        issues.push({ kind: 'missingPackage', severity: 'error', file: loc?.file ?? '', line: loc?.line ?? 0, detail: `R: ${p}` });
      }
      for (const p of res.info?.packages ?? []) if (p.direct && p.Source !== 'Repository') issues.push({ kind: 'githubPackage', severity: 'info', file: usage.r[p.Package]?.[0]?.file ?? '', line: usage.r[p.Package]?.[0]?.line ?? 0, detail: `${p.Package} (${p.Source})` });
    }
    if (langFiles.python.size) {
      stage(t('repro.stage.python'));
      const res = await langInfo<PyInfo>('python', { modules: Object.keys(usage.python) });
      python = { files: [...langFiles.python], usage: usage.python, ...res };
      for (const m of res.info?.missing ?? []) {
        const loc = usage.python[m]?.[0];
        issues.push({ kind: 'missingPackage', severity: 'error', file: loc?.file ?? '', line: loc?.line ?? 0, detail: `Python: ${m}` });
      }
    }

    stage(t('repro.stage.hash'));
    const hashes = await host().reproHash(root, files.map((f) => f.path));
    for (const f of files) f.sha256 = hashes[f.path] ?? null;

    stage(t('repro.stage.git'));
    const git = await gitState(root);
    if (!git.repo) issues.push({ kind: 'noGit', severity: 'info', file: '', line: 0, detail: '' });
    else if (git.dirty.length) issues.push({ kind: 'uncommitted', severity: 'warning', file: '', line: 0, detail: String(git.dirty.length) });

    const info = await host().appInfo();
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
    const report: ReproReport = {
      root,
      name,
      createdAt: new Date().toISOString(),
      app: { version: info.version, platform: info.platform },
      files,
      r,
      python,
      missingData,
      issues: issues.sort((a, b) => ['error', 'warning', 'info'].indexOf(a.severity) - ['error', 'warning', 'info'].indexOf(b.severity)),
      git,
      projectLock: { renvLock: paths.has('renv.lock'), uvLock: paths.has('uv.lock'), pyproject: paths.has('pyproject.toml') },
    };
    // Default entry points: top-level scripts; keep the user's choice if still valid.
    const prev = useRepro.getState().options.entryPoints.filter((p) => paths.has(p));
    const defaults = files.filter((f) => /^[^/]+\.(r|py)$/i.test(f.path)).map((f) => f.path);
    useRepro.setState((s) => ({ status: 'ready', stage: '', report, options: { ...s.options, entryPoints: prev.length ? prev : defaults } }));
  } catch (e) {
    useRepro.setState({ status: 'error', stage: '', error: String(e) });
  }
}

export function setOptions(patch: Partial<ReproState['options']>) {
  useRepro.setState((s) => ({ options: { ...s.options, ...patch } }));
}

export function toggleEntryPoint(path: string) {
  const cur = useRepro.getState().options.entryPoints;
  setOptions({ entryPoints: cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path] });
}

export function moveEntryPoint(path: string, delta: -1 | 1) {
  const cur = [...useRepro.getState().options.entryPoints];
  const i = cur.indexOf(path);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= cur.length) return;
  [cur[i], cur[j]] = [cur[j], cur[i]];
  setOptions({ entryPoints: cur });
}

/** Ask for a destination and write the bundle. */
export async function exportBundle(): Promise<string | null> {
  const { report, options } = useRepro.getState();
  if (!report) return null;
  const locale = getSettings().locale === 'hu' ? 'hu' : 'en';
  const top = bundleName(report.name, new Date());
  let dest: string | null;
  if (options.format === 'zip') {
    dest = await host().saveFileDialog(`${top}.zip`, [{ name: 'ZIP', extensions: ['zip'] }]);
    if (dest && !/\.zip$/i.test(dest)) dest += '.zip';
  } else {
    const parent = await host().openFolderDialog();
    dest = parent ? `${parent.replace(/[\\/]+$/, '')}/${top}` : null;
  }
  if (!dest) return null;
  // The bundle must not end up inside the project it packs.
  if (dest.startsWith(report.root.replace(/[\\/]+$/, '') + '/') && options.format === 'folder') {
    toast({ kind: 'error', title: t('repro.insideProject') });
    return null;
  }
  useRepro.setState({ exporting: true });
  try {
    const entries = bundleEntries(report, { ...options, locale }, options.format === 'zip' ? top : '.', issueText).map((e) => ({ ...e, name: e.name.replace(/^\.\//, '') }));
    const bytes = await host().reproWrite(dest, entries);
    useRepro.setState({ lastExport: dest });
    const finalDest = dest;
    toast({
      kind: 'success',
      title: t('repro.exported', { name: finalDest.split(/[\\/]/).pop(), size: (bytes / 1048576).toFixed(1) }),
      action: { label: t('repro.reveal'), run: () => void host().fsReveal(finalDest) },
    });
    return dest;
  } catch (e) {
    toast({ kind: 'error', title: t('repro.exportFailed'), detail: String(e) });
    return null;
  } finally {
    useRepro.setState({ exporting: false });
  }
}
