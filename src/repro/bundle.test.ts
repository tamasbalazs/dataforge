import { describe, expect, it } from 'vitest';
import { bundleEntries, bundleName, renvLock, reproduceSh, requirementsTxt, runCommand, type ReproReport } from './bundle';

const report: ReproReport = {
  root: '/p/elemzés',
  name: 'Eladási elemzés',
  createdAt: '2026-10-30T12:00:00.000Z',
  app: { version: '0.1.0', platform: 'linux' },
  files: [
    { path: 'elemzes.R', size: 120, sha256: 'a'.repeat(64), role: 'code' },
    { path: 'modell.py', size: 80, sha256: 'b'.repeat(64), role: 'code' },
    { path: 'data/eladasok.csv', size: 2048, sha256: 'c'.repeat(64), role: 'data' },
  ],
  r: {
    files: ['elemzes.R'],
    usage: { dplyr: [{ file: 'elemzes.R', line: 1 }] },
    info: {
      version: '4.3.3',
      platform: 'x86_64-pc-linux-gnu',
      os: 'Ubuntu',
      repos: [{ Name: 'CRAN', URL: 'https://cloud.r-project.org' }],
      packages: [
        { Package: 'dplyr', Version: '1.1.4', Source: 'Repository', Repository: 'CRAN', direct: true },
        { Package: 'mypkg', Version: '0.2.0', Source: 'GitHub', RemoteType: 'github', RemoteUsername: 'anna', RemoteRepo: 'mypkg', RemoteSha: 'abc', direct: true },
        { Package: 'rlang', Version: '1.1.3', Source: 'Repository', Repository: 'CRAN', direct: false },
      ],
      missing: [],
      base: ['stats'],
      session_info: 'R version 4.3.3',
    },
  },
  python: {
    files: ['modell.py'],
    usage: {},
    info: {
      version: '3.12.4',
      implementation: 'CPython',
      platform: 'Linux',
      executable: '/p/.venv/bin/python',
      packages: [
        { name: 'scikit-learn', version: '1.5.0', direct: true, module: 'sklearn' },
        { name: 'numpy', version: '2.0.0', direct: false },
      ],
      missing: [],
      stdlib: ['os'],
      freeze: ['numpy==2.0.0', 'scikit-learn==1.5.0'],
    },
  },
  missingData: [],
  issues: [{ kind: 'noSeed', severity: 'warning', file: 'elemzes.R', line: 7, detail: 'sample' }],
  git: { repo: true, commit: '0123456789abcdef', branch: 'main', dirty: ['elemzes.R'] },
  projectLock: { renvLock: false, uvLock: false, pyproject: false },
};

describe('reproducibility bundle', () => {
  it('writes a renv.lock with CRAN and GitHub sources', () => {
    const lock = JSON.parse(renvLock(report.r!.info!));
    expect(lock.R.Version).toBe('4.3.3');
    expect(lock.Packages.dplyr).toEqual({ Package: 'dplyr', Version: '1.1.4', Source: 'Repository', Repository: 'CRAN' });
    expect(lock.Packages.mypkg.RemoteSha).toBe('abc');
    expect(lock.Packages.dplyr.direct).toBeUndefined();
  });

  it('pins Python requirements and notes the import name', () => {
    expect(requirementsTxt(report.python!.info!, 'x')).toContain('scikit-learn==1.5.0  # import sklearn\nnumpy==2.0.0\n');
  });

  it('runs each kind of entry point', () => {
    expect(runCommand('elemzes.R')).toBe(`Rscript --no-save --no-restore 'elemzes.R'`);
    expect(runCommand("it's.py")).toBe(`"$PYBIN" 'it'\\''s.py'`);
    expect(runCommand('riport.qmd')).toBe(`quarto render 'riport.qmd'`);
    expect(runCommand('notes.txt')).toBeNull();
  });

  it('generates a rebuild script that checks, restores and runs', () => {
    const s = reproduceSh(report, { includeCode: true, includeData: true, dockerfile: false, entryPoints: ['elemzes.R', 'modell.py'], locale: 'en' });
    expect(s).toContain('sha256sum --quiet -c checksums.sha256');
    expect(s).toContain('renv::restore(lockfile = "../environment/R/renv.lock", library = ".r-library", prompt = FALSE)');
    expect(s).toContain('pip install --quiet -r ../environment/python/requirements.txt');
    expect(s.indexOf("Rscript --no-save --no-restore 'elemzes.R'")).toBeLessThan(s.indexOf(`"$PYBIN" 'modell.py'`));
  });

  it('lays out the bundle, leaving data out on request but keeping its checksum', () => {
    const entries = bundleEntries(report, { includeCode: true, includeData: false, dockerfile: true, entryPoints: [], locale: 'hu' }, 'top', (i) => i.kind);
    const names = entries.map((e) => e.name);
    expect(names).toContain('top/project/elemzes.R');
    expect(names).not.toContain('top/project/data/eladasok.csv');
    expect(names).toEqual(expect.arrayContaining(['top/environment/R/renv.lock', 'top/environment/python/requirements.txt', 'top/Dockerfile', 'top/reproduce.sh', 'top/manifest.json', 'top/REPRODUKALAS.md', 'top/checksums.sha256']));
    expect(entries.find((e) => e.name === 'top/project/elemzes.R')?.source).toBe('/p/elemzés/elemzes.R');
    expect(entries.find((e) => e.name === 'top/checksums.sha256')?.text).toContain(`${'c'.repeat(64)}  project/data/eladasok.csv`);
    expect(entries.find((e) => e.name === 'top/reproduce.sh')?.executable).toBe(true);
    const man = JSON.parse(entries.find((e) => e.name === 'top/manifest.json')!.text!);
    expect(man.excludedData.map((f: any) => f.path)).toEqual(['data/eladasok.csv']);
    expect(man.r.direct).toEqual(['dplyr@1.1.4', 'mypkg@0.2.0']);
    const readme = entries.find((e) => e.name === 'top/REPRODUKALAS.md')!.text!;
    expect(readme).toContain('Az adatfájlok nincsenek a csomagban');
    expect(readme).toContain('1 nem commitolt módosítás');
  });

  it('names bundles with an ASCII slug and date', () => {
    expect(bundleName('Eladási elemzés', new Date('2026-10-30T10:00:00Z'))).toBe('Eladasi-elemzes-repro-20261030');
  });

  it('skips the R restore when only base R is used', () => {
    const baseOnly = { ...report, r: { ...report.r!, info: { ...report.r!.info!, packages: [] } } };
    const s = reproduceSh(baseOnly, { includeCode: true, includeData: true, dockerfile: false, entryPoints: [], locale: 'en' });
    expect(s).toContain('base R only');
    expect(s).not.toContain('renv::restore');
  });
});
