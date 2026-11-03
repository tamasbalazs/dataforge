/**
 * End-to-end check against real tools (opt-in: DF_REAL_BUNDLE=<project dir> DF_OUT=<empty dir>).
 * Scans the project with the same code the app uses, asks real R / Python for
 * versions via the kernel helpers, and writes the bundle folder.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleEntries, bundleName, type ReproFile, type ReproReport } from './bundle';
import { CODE_EXT, DATA_EXT, localModules, R_BASE, resolveRef, scanFile, type Issue, type Loc } from './scan';

const root = process.env.DF_REAL_BUNDLE;
const out = process.env.DF_OUT;
const helpers = join(__dirname, '../../src-tauri/helpers');
const SKIP = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.Rproj.user', '.quarto', '.ipynb_checkpoints']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(relative(root!, p));
  }
  return acc;
}

describe.skipIf(!root || !out)('real reproducibility bundle', () => {
  it('builds a bundle from a real project', () => {
    const paths = walk(root!).sort();
    const files: ReproFile[] = paths.map((p) => ({ path: p, size: statSync(join(root!, p)).size, role: CODE_EXT.test(p) ? 'code' : DATA_EXT.test(p) ? 'data' : 'other' }));
    const set = new Set(paths);
    const usage: Record<'r' | 'python', Record<string, Loc[]>> = { r: {}, python: {} };
    const issues: Issue[] = [];
    for (const f of files.filter((x) => x.role === 'code')) {
      for (const s of scanFile(f.path, readFileSync(join(root!, f.path), 'utf8'))) {
        for (const [p, line] of s.packages) (usage[s.lang][p] ??= []).push({ file: f.path, line });
        for (const d of s.dataRefs) {
          const hit = resolveRef(d.ref, f.path, set);
          if (hit) (files.find((x) => x.path === hit)!.referencedBy ??= []).push({ file: f.path, line: d.line });
        }
        for (const i of s.issues) issues.push({ ...i, file: f.path, severity: 'warning' });
      }
    }
    for (const m of localModules(paths)) delete usage.python[m];
    const rPkgs = [...Object.keys(usage.r).filter((p) => !R_BASE.has(p)), ...(process.env.DF_R_PKGS?.split(',').filter(Boolean) ?? [])];
    const rInfo = JSON.parse(
      execFileSync('Rscript', ['-e', `suppressMessages(source(${JSON.stringify(join(helpers, 'dataforge.R'))})); cat(jsonlite::toJSON(.dataforge$repro_info(as.list(jsonlite::fromJSON('${JSON.stringify(rPkgs)}'))), auto_unbox = TRUE, null = "null"))`], { encoding: 'utf8' }),
    );
    const py = existsVenv(root!) ? join(root!, '.venv/bin/python') : 'python3';
    const pyInfo = JSON.parse(
      execFileSync(py, ['-c', `import json,sys; exec(open(${JSON.stringify(join(helpers, 'dataforge_kernel.py'))}).read()); import _dataforge as d; print(json.dumps(d.repro_info(${JSON.stringify(Object.keys(usage.python))})))`], { encoding: 'utf8' }),
    );
    for (const f of files) f.sha256 = createHash('sha256').update(readFileSync(join(root!, f.path))).digest('hex');
    const git = (args: string[]) => execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim();
    const report: ReproReport = {
      root: root!,
      name: root!.split('/').pop()!,
      createdAt: new Date().toISOString(),
      app: { version: '0.1.0', platform: 'linux' },
      files,
      r: { files: [], usage: usage.r, info: rInfo },
      python: { files: [], usage: usage.python, info: pyInfo },
      missingData: [],
      issues,
      git: { repo: true, commit: git(['rev-parse', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: git(['status', '--porcelain']).split('\n').filter(Boolean) },
      projectLock: { renvLock: false, uvLock: false, pyproject: false },
    };
    const top = bundleName(report.name, new Date());
    const entries = bundleEntries(report, { includeCode: true, includeData: true, dockerfile: true, entryPoints: ['elemzes.R', 'modell.py'], locale: 'hu' }, top, (i) => `${i.kind} ${i.detail}`);
    for (const e of entries) {
      const target = join(out!, e.name);
      mkdirSync(dirname(target), { recursive: true });
      if (e.text != null) writeFileSync(target, e.text);
      else copyFileSync(e.source!, target);
      if (e.executable) chmodSync(target, 0o755);
    }
    expect(entries.length).toBeGreaterThan(10);
    console.log(`bundle: ${join(out!, top)} — R ${rInfo.version} (${rInfo.packages.length} pkgs), Python ${pyInfo.version} (${pyInfo.packages.length} pkgs)`);
  });
});

function existsVenv(r: string) {
  try {
    return statSync(join(r, '.venv/bin/python')).isFile();
  } catch {
    return false;
  }
}
