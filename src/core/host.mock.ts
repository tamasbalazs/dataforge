/**
 * In-browser stand-in for the Rust host. It fakes just enough kernel
 * behaviour (output, variables, plots, errors) to develop and demo the UI
 * without R or Python installed. Not used in the desktop app.
 */
import { createMockGit, createMockShell } from './host.mock.git';
import { createMockCollab } from './host.mock.collab';
import { createMockJobs } from './host.mock.jobs';
import exManifest from '../../examples/extensions/data-summary/dataforge-extension.json?raw';
import exMain from '../../examples/extensions/data-summary/main.js?raw';
import exSnipR from '../../examples/extensions/data-summary/snippets/r.json?raw';
import exSnipPy from '../../examples/extensions/data-summary/snippets/python.json?raw';
import exTheme from '../../examples/extensions/data-summary/themes/fjord.json?raw';
import type { CompleteReply, Host, Interpreter, KernelEvent, Lang } from './host';

type Listener = (ev: KernelEvent) => void;

interface MockVar {
  name: string;
  type: string;
  kind: string;
  dims: number[] | number;
  size: number;
  preview: string;
}

const files = new Map<string, string>([
  ['/home/demo/projekt/analysis.R', 'library(stats)\nsummary(cars)\n'],
  ['/home/demo/projekt/model.py', 'import math\nprint(math.pi)\n'],
  ['/home/demo/projekt/data/sales.csv', 'id,value\n1,2\n'],
  ['/home/demo/projekt/data/regions.parquet', ''],
  ['/home/demo/projekt/README.md', '# Projekt\n'],
  ['/home/demo/projekt/report.qmd', '---\ntitle: "Riport"\n---\n\nEladások elemzése.\n\n```{r}\nsales <- read.csv("data/sales.csv")\nsummary(sales)\n```\n\n```{python}\ndf = r.sales\nprint(len(df))\n```\n'],
  ['/home/demo/projekt/renv.lock', '{}'],
]);
const EXT_ROOT = '/home/demo/.dataforge/extensions';
const EX = `${EXT_ROOT}/dataforge.data-summary`;
for (const [rel, body] of [
  ['dataforge-extension.json', exManifest],
  ['main.js', exMain],
  ['snippets/r.json', exSnipR],
  ['snippets/python.json', exSnipPy],
  ['themes/fjord.json', exTheme],
]) files.set(`${EX}/${rel}`, body);
// A development extension that probes the sandbox (used by the e2e test).
const PROBE = '/home/demo/dev-ext/probe';
files.set(`${PROBE}/dataforge-extension.json`, JSON.stringify({ id: 'test.probe', name: 'Sandbox probe', version: '0.0.1', main: 'main.js', permissions: ['editor'], contributes: { commands: [{ id: 'probe', title: 'Sandbox probe: run' }] } }));
files.set(
  `${PROBE}/main.js`,
  `export async function activate(df) {
  await df.commands.register('probe', async () => {
    const out = [];
    try { await fetch('https://example.org'); out.push('fetch:ALLOWED'); } catch (e) { out.push('fetch:blocked'); }
    try { await df.workspace.readFile('analysis.R'); out.push('read:ALLOWED'); } catch (e) { out.push('read:denied'); }
    out.push(typeof self.__TAURI_INTERNALS__ === 'undefined' ? 'ipc:absent' : 'ipc:PRESENT');
    out.push(typeof document === 'undefined' ? 'dom:absent' : 'dom:PRESENT');
    await df.window.showMessage(out.join(' '));
  });
}`,
);
const dirs = new Set(['/home/demo/dev-ext', PROBE, '/home/demo', '/home/demo/projekt', '/home/demo/projekt/data', '/home/demo/projekt/docs', '/home/demo/.dataforge', EXT_ROOT, EX, `${EX}/snippets`, `${EX}/themes`]);
const parentOf = (p: string) => p.replace(/\/[^/]+$/, '') || '/';
const nameOf = (p: string) => p.split('/').pop() ?? p;

// --- synthetic data set for the data viewer --------------------------------
const MOCK_ROWS = 100_000;
const GROUPS = ['alpha', 'beta', 'gamma', 'delta'];
const mockColumns = [
  { name: 'id', type: 'int', tone: 'numeric' },
  { name: 'value', type: 'dbl', tone: 'numeric' },
  { name: 'group', type: 'chr', tone: 'text' },
  { name: 'flag', type: 'lgl', tone: 'logical' },
  { name: 'date', type: 'date', tone: 'date' },
];
function mockCell(row: number, col: number): string | number | boolean | null {
  switch (col) {
    case 0: return row + 1;
    case 1: return row % 97 === 0 ? null : Math.round((Math.sin(row / 50) * 100 + (row % 13)) * 1000) / 1000;
    case 2: return GROUPS[(row * 7) % 4];
    case 3: return row % 3 === 0;
    default: return new Date(Date.UTC(2020, 0, 1) + (row % 1500) * 86400000).toISOString().slice(0, 10);
  }
}
const fmt = (v: unknown) => (v === null ? null : String(v));
let mockIndexKey = '';
let mockIndex: number[] = [];
function mockQuery(args: any): number[] {
  const key = JSON.stringify([args.sort, args.search, args.filters]);
  if (key === mockIndexKey) return mockIndex;
  let idx = Array.from({ length: MOCK_ROWS }, (_, i) => i);
  for (const f of args.filters ?? []) {
    idx = idx.filter((r) => {
      const v = mockCell(r, f.col);
      if (f.op === 'isna') return v === null;
      if (f.op === 'notna') return v !== null;
      if (v === null) return false;
      const num = typeof v === 'number';
      const val = num ? Number(f.value) : f.value;
      switch (f.op) {
        case 'contains': return String(v).toLowerCase().includes(String(f.value).toLowerCase());
        case 'eq': return String(v) === String(f.value);
        case 'neq': return String(v) !== String(f.value);
        case 'gt': return v > val;
        case 'gte': return v >= val;
        case 'lt': return v < val;
        case 'lte': return v <= val;
        case 'between': return v >= (num ? Number(f.value[0]) : f.value[0]) && v <= (num ? Number(f.value[1]) : f.value[1]);
        default: return true;
      }
    });
  }
  if (args.search) {
    const q = String(args.search).toLowerCase();
    idx = idx.filter((r) => String(mockCell(r, 2)).includes(q));
  }
  for (const s of [...(args.sort ?? [])].reverse()) {
    idx.sort((a, b) => {
      const x = mockCell(a, s.col);
      const y = mockCell(b, s.col);
      if (x === null) return 1;
      if (y === null) return -1;
      const c = x < y ? -1 : x > y ? 1 : 0;
      return s.desc ? -c : c;
    });
  }
  mockIndexKey = key;
  mockIndex = idx;
  return idx;
}
function mockStats(col: number) {
  const values: Array<string | number | boolean | null> = [];
  for (let r = 0; r < MOCK_ROWS; r++) values.push(mockCell(r, col));
  const na = values.filter((v) => v === null).length;
  if (mockColumns[col].tone === 'numeric') {
    const nums = values.filter((v): v is number => typeof v === 'number');
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const hist = new Array(20).fill(0);
    for (const v of nums) hist[Math.min(19, Math.floor(((v - min) / (max - min || 1)) * 20))]++;
    return { col, na, hist, min: String(min), max: String(max), mean: (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3) };
  }
  const counts = new Map<string, number>();
  for (const v of values) if (v !== null) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }));
  return { col, na, unique: counts.size, top };
}

function mockPlotSvg(seed: number, bg: string, fg: string, palette: string[]): string {
  const pts = Array.from({ length: 40 }, (_, i) => {
    const x = 60 + i * 13;
    const y = 220 - (Math.sin((i + seed) / 4) * 70 + i * 2.2);
    return `${x},${y.toFixed(1)}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320">
<rect width="640" height="320" fill="${bg}"/>
<g stroke="${fg}" stroke-opacity="0.15">${[80, 140, 200, 260].map((y) => `<line x1="50" x2="620" y1="${y}" y2="${y}"/>`).join('')}</g>
<polyline fill="none" stroke="${palette[0]}" stroke-width="2.5" points="${pts.join(' ')}"/>
${pts.filter((_, i) => i % 4 === 0).map((p) => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="4" fill="${palette[1]}"/>`).join('')}
<text x="50" y="40" fill="${fg}" font-family="sans-serif" font-size="16" font-weight="600">Mock plot #${seed}</text>
</svg>`;
}

export function createMockHost(): Host {
  const listeners = new Set<Listener>();
  const fsListeners = new Set<(p: string[]) => void>();
  const procListeners = new Set<(e: import('./host').ProcEvent) => void>();
  const ptyListeners = new Set<(e: import('./host').PtyEvent) => void>();
  const git = createMockGit(files);
  const shell = createMockShell(files, (e) => ptyListeners.forEach((l) => l(e)));
  const vars: Record<string, MockVar[]> = { r: [], python: [] };
  const theme = { bg: '#ffffff', fg: '#111111', palette: ['#4C58D6', '#E07B24'] };
  let plotSeed = 0;
  let counter = 0;
  const emit = (ev: KernelEvent) => listeners.forEach((l) => l(ev));
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // --- R debugger mock: debugSource() stops at each breakpoint of the file.
  const rBreakpoints: Record<string, number[]> = {};
  const rDebugListeners = new Set<(e: any) => void>();
  let rDebugWaiter: ((cmd: string) => void) | null = null;
  const rDebugEmit = (e: any) => rDebugListeners.forEach((l) => l(e));
  async function mockDebugSource(path: string) {
    rDebugEmit({ event: 'started', path });
    for (const line of [...(rBreakpoints[path] ?? [])].sort((a, b) => a - b)) {
      rDebugEmit({ event: 'stopped', reason: 'breakpoint', frames: [{ id: 2, name: 'f', line, path }, { id: 1, name: '<script>', line: 1, path }] });
      const cmd = await new Promise<string>((r) => (rDebugWaiter = r));
      rDebugWaiter = null;
      rDebugEmit({ event: 'continued' });
      if (cmd === 'terminate') break;
    }
    rDebugEmit({ event: 'terminated' });
  }

  async function run(id: string, msgId: string, code: string) {
    const lang = id as Lang;
    const ev = (msgType: string, content: any) => emit({ kernelId: id, msgType, parentId: msgId, content });
    ev('status', { execution_state: 'busy' });
    const dbg = /^debugSource\("(.+)"\)$/.exec(code.trim());
    if (lang === 'r' && dbg) {
      await mockDebugSource(dbg[1]);
      emit({ kernelId: id, msgType: 'execute_reply', parentId: msgId, content: { status: 'ok', execution_count: ++counter } });
      ev('status', { execution_state: 'idle' });
      return;
    }
    await later(120 + Math.random() * 200);
    counter++;
    let error = false;
    for (const raw of code.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const assign = line.match(/^([A-Za-z_.][\w.]*)\s*(<-|=)\s*(.+)$/);
      const call = line.match(/^print\((.*)\)$/);
      if (/^(stop|raise)\b/.test(line)) {
        ev('error', {
          ename: lang === 'r' ? 'Error' : 'RuntimeError',
          evalue: 'something went wrong',
          traceback: [lang === 'r' ? 'Error: something went wrong' : '\u001b[0;31mRuntimeError\u001b[0m: something went wrong'],
        });
        error = true;
        break;
      } else if (/^View\((\w+)\)/.test(line)) {
        const name = line.match(/^View\((\w+)\)/)![1];
        ev('display_data', { data: { 'application/vnd.dataforge.view+json': JSON.stringify({ name, title: name }), 'text/plain': `View: ${name}` }, metadata: {} });
      } else if (/plot|plt\.|ggplot/.test(line)) {
        plotSeed++;
        const svg = mockPlotSvg(plotSeed, theme.bg, theme.fg, theme.palette);
        ev('display_data', { data: { 'image/svg+xml': svg, 'text/plain': '<plot>' }, metadata: {} });
      } else if (assign) {
        const [, name, , value] = assign;
        const isData = /data\.frame|DataFrame|read/.test(value);
        const v: MockVar = isData
          ? { name, type: lang === 'r' ? 'data.frame' : 'DataFrame', kind: 'data', dims: [MOCK_ROWS, 5], size: 4_800_000, preview: `${MOCK_ROWS} obs. of 5 variables` }
          : /function|lambda|def /.test(value)
            ? { name, type: 'function', kind: 'function', dims: 1, size: 1200, preview: value.slice(0, 40) }
            : { name, type: /^["']/.test(value) ? 'character' : 'numeric', kind: 'value', dims: 1, size: 56, preview: value };
        vars[lang] = [...vars[lang].filter((x) => x.name !== name), v].sort((a, b) => a.name.localeCompare(b.name));
      } else if (call) {
        ev('stream', { name: 'stdout', text: (lang === 'r' ? '[1] ' : '') + call[1] + '\n' });
      } else {
        ev('execute_result', { data: { 'text/plain': (lang === 'r' ? '[1] ' : '') + line }, execution_count: counter });
      }
    }
    emit({ kernelId: id, msgType: 'execute_reply', parentId: msgId, content: { status: error ? 'error' : 'ok', execution_count: counter } });
    ev('status', { execution_state: 'idle' });
  }

  const remotes = new Set<string>();
  const interpreters: Interpreter[] = [
    { lang: 'r', path: '/usr/bin/R', version: '4.4.1', hasKernel: true, source: 'PATH (mock)' },
    { lang: 'python', path: '/usr/bin/python3', version: '3.12.4', hasKernel: true, source: 'PATH (mock)' },
  ];

  return {
    kind: 'mock',
    async appInfo() {
      return { version: '0.1.0', platform: 'browser', home: '/home/demo', cwd: '/home/demo', uptimeMs: Math.round(performance.now()) };
    },
    async detectInterpreters() {
      await later(400);
      return interpreters;
    },
    async kernelStart(id, lang, _interp, cwd) {
      await later(500 + Math.random() * 400);
      const remote = cwd?.startsWith('ssh://');
      if (remote && !remotes.has(cwd!.slice(6).split('/')[0])) throw new Error('not connected to remote');
      return { id, lang, info: { version: interpreters.find((i) => i.lang === lang)!.version, cwd: remote ? cwd!.replace(/^ssh:\/\/[^/]+/, '') : '/home/demo' } };
    },
    async remoteConnect(profile) {
      await later(300);
      if (/fail/.test(profile.host)) throw new Error(`${profile.host}: authentication failed (no usable key – add one to ssh-agent or set an identity file)`);
      remotes.add(profile.id);
      const base = `ssh://${profile.id}/home/ana`;
      for (const d of [`ssh://${profile.id}/home`, base, `${base}/klaszter`, `${base}/klaszter/data`]) dirs.add(d);
      const seed: Array<[string, string]> = [
        ['klaszter/elemzes.R', 'meres <- read.csv("data/meres.csv")\nsummary(meres)\n'],
        ['klaszter/train.py', 'import os\nprint("fut:", os.uname().nodename)\n'],
        ['klaszter/data/meres.csv', 'id,ertek\n1,3.2\n2,4.1\n'],
      ];
      for (const [rel, body] of seed) if (!files.has(`${base}/${rel}`)) files.set(`${base}/${rel}`, body);
      return {
        home: '/home/ana',
        os: 'Linux',
        hostname: 'gpu-01',
        interpreters: [
          { lang: 'python', path: '/opt/conda/bin/python', version: '3.11.9', hasKernel: true, source: 'remote' },
          { lang: 'r', path: '/usr/bin/R', version: '4.3.3', hasKernel: true, source: 'remote', kernelLib: '/usr/lib/R/site-library' },
        ],
      };
    },
    async remoteDisconnect(id) {
      remotes.delete(id);
    },
    ...createMockCollab(),
    ...createMockJobs(),
    async kernelExecute(id, code, msgId) {
      setTimeout(() => run(id, msgId, code), 0);
      return msgId;
    },
    async kernelCall<T>(id: string, func: string, args: Record<string, unknown> = {}): Promise<T> {
      await later(30);
      if (func === 'env_list') return vars[id] as T;
      if (func === 'ext_eval') {
        const code = String(args.code);
        return (id === 'r' ? `   Min. 1st Qu.  Median    Mean 3rd Qu.    Max. \n   1.00    2.00    3.00    3.00    4.00    5.00   # ${code}` : `       value\ncount    5.0\nmean     3.0   # ${code}`) as T;
      }
      if (func === 'repro_info') {
        const used = ((args.packages ?? args.modules) as string[]) ?? [];
        if (id === 'r')
          return {
            version: '4.4.1', platform: 'x86_64-pc-linux-gnu', os: 'Ubuntu 24.04', repos: [{ Name: 'CRAN', URL: 'https://cloud.r-project.org' }],
            packages: [...used.filter((p) => p !== 'nincsilyen').map((p) => ({ Package: p, Version: '1.2.3', Source: 'Repository', Repository: 'CRAN', direct: true })), { Package: 'rlang', Version: '1.1.4', Source: 'Repository', Repository: 'CRAN', direct: false }],
            missing: used.filter((p) => p === 'nincsilyen'), base: [], renv: '1.0.7', session_info: 'R version 4.4.1 (mock)',
          } as T;
        return {
          version: '3.12.4', implementation: 'CPython', platform: 'Linux', executable: '/usr/bin/python3',
          packages: used.filter((m) => !['math', 'os', 'sys', 're', 'json'].includes(m)).map((m) => ({ name: m, version: '2.0.0', direct: true, module: m })),
          missing: [], stdlib: used.filter((m) => ['math', 'os', 'sys', 're', 'json'].includes(m)), freeze: [],
        } as T;
      }
      if (func === 'dbg_set_breakpoints') {
        rBreakpoints[args.path as string] = args.lines as number[];
        return true as T;
      }
      if (func === 'clear_env') {
        vars[id] = [];
        return true as T;
      }
      if (func === 'configure' && args.theme) Object.assign(theme, args.theme);
      if (func === 'setwd') return args.path as T;
      if (func === 'data_info') return { name: args.name, rows: MOCK_ROWS, cols: mockColumns.length, columns: mockColumns, class: 'data.frame' } as T;
      if (func === 'data_page') {
        const idx = mockQuery(args);
        const offset = Number(args.offset ?? 0);
        const rows = idx.slice(offset, offset + Number(args.limit ?? 100));
        await later(20);
        return { total: idx.length, offset, rows: rows.map((r) => r + 1), columns: mockColumns.map((_, c) => rows.map((r) => fmt(mockCell(r, c)))) } as T;
      }
      if (func === 'packages') {
        const r = [
          ['dplyr', '1.1.4', 'A Grammar of Data Manipulation', true],
          ['ggplot2', '3.5.1', 'Create Elegant Data Visualisations Using the Grammar of Graphics', true],
          ['readr', '2.1.5', 'Read Rectangular Text Data', false],
          ['stats', '4.4.1', 'The R Stats Package', true],
          ['tidyr', '1.3.1', 'Tidy Messy Data', false],
        ];
        const py = [
          ['numpy', '2.1.0', 'Fundamental package for array computing in Python', true],
          ['pandas', '2.2.2', 'Powerful data structures for data analysis', true],
          ['polars', '1.6.0', 'Blazingly fast DataFrame library', false],
          ['scikit-learn', '1.5.1', 'A set of python modules for machine learning', false],
        ];
        return (id === 'r' ? r : py).map(([name, version, title, loaded]) => ({
          name, version, title, loaded, attached: loaded, base: name === 'stats',
          modules: id === 'python' ? [name === 'scikit-learn' ? 'sklearn' : name] : undefined,
        })) as T;
      }
      if (func === 'packages_outdated') return (id === 'r' ? [{ name: 'dplyr', latest: '1.1.5' }] : [{ name: 'pandas', latest: '2.2.3' }]) as T;
      if (func === 'help_html')
        return {
          found: true, topic: args.topic, package: args.package ?? 'base', title: 'Arithmetic Mean',
          html: `<h2>Arithmetic Mean</h2><h3>Description</h3><p>Generic function for the (trimmed) arithmetic mean.</p><h3>Usage</h3><pre><code>mean(x, ...)\n\n## Default S3 method:\nmean(x, trim = 0, na.rm = FALSE, ...)</code></pre><h3>Arguments</h3><table><tr><td><code>x</code></td><td>An R object.</td></tr><tr><td><code>trim</code></td><td>the fraction (0 to 0.5) of observations to be trimmed.</td></tr></table><h3>See Also</h3><p><a href="../../stats/html/weighted.mean.html">weighted.mean</a>, <a href="../../base/html/colSums.html">colMeans</a></p>`,
        } as T;
      if (func === 'help_doc')
        return {
          found: true, topic: args.topic, name: args.topic, module: 'builtins', kind: 'function', signature: '(obj, /)',
          doc: 'Return the number of items in a container.\n\nParameters\n----------\nobj : Sized\n    Any container.\n\nReturns\n-------\nint', members: [],
        } as T;
      if (func === 'help_search') return [{ topic: 'mean', package: 'base', title: 'Arithmetic Mean' }, { topic: 'weighted.mean', package: 'stats', title: 'Weighted Arithmetic Mean' }] as T;
      if (func === 'data_stats') return (args.cols as number[]).map(mockStats) as T;
      return true as T;
    },
    async kernelComplete(_id, code, cursor): Promise<CompleteReply> {
      const prefix = code.slice(0, cursor).match(/[\w.]*$/)?.[0] ?? '';
      const words = ['print', 'plot', 'paste', 'data.frame', 'summary', 'mean', 'median', 'library'];
      return { matches: words.filter((w) => w.startsWith(prefix)), cursor_start: cursor - prefix.length, cursor_end: cursor, status: 'ok' };
    },
    async kernelInterrupt() {},
    async kernelShutdown() {},
    onKernelEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async readText(path) {
      if (!files.has(path)) throw new Error(`No such file: ${path}`);
      return files.get(path)!;
    },
    async writeText(path, content) {
      files.set(path, content);
    },
    async writeBase64() {},
    async openFileDialog() {
      return null;
    },
    async openFolderDialog() {
      // Tests can pick the folder the "dialog" returns.
      const next = (window as any).__dfNextFolder as string | undefined;
      (window as any).__dfNextFolder = undefined;
      return next ?? '/home/demo/projekt';
    },
    async saveFileDialog(defaultPath) {
      return `/home/demo/${defaultPath}`;
    },
    async showWindow() {},
    async fsList(path, showHidden) {
      const kids = [...dirs].filter((d) => parentOf(d) === path && d !== path).map((d) => ({ path: d, isDir: true }));
      const fs = [...files.keys()].filter((f) => parentOf(f) === path).map((f) => ({ path: f, isDir: false }));
      return [...kids, ...fs]
        .map((e) => ({ name: nameOf(e.path), path: e.path, isDir: e.isDir, size: e.isDir ? 0 : (files.get(e.path)?.length ?? 0) * 997, modified: Date.now() - 3_600_000, hidden: nameOf(e.path).startsWith('.') }))
        .filter((e) => showHidden || !e.hidden)
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    },
    async fsCreate(parent, name, dir) {
      const p = `${parent}/${name}`;
      if (dir) dirs.add(p);
      else files.set(p, '');
      fsListeners.forEach((l) => l([p]));
      return p;
    },
    async fsRename(path, newName) {
      const p = `${parentOf(path)}/${newName}`;
      if (files.has(path)) {
        files.set(p, files.get(path)!);
        files.delete(path);
      }
      fsListeners.forEach((l) => l([p]));
      return p;
    },
    async fsTrash(path) {
      files.delete(path);
      dirs.delete(path);
      fsListeners.forEach((l) => l([path]));
    },
    async fsReveal() {},
    async fsOpenExternal() {},
    async projectInspect(root) {
      return {
        root,
        name: nameOf(root),
        git: true,
        r: { renv: files.has(`${root}/renv.lock`), renvLock: files.has(`${root}/renv.lock`), rproj: null, description: false },
        python: { venvs: [], pyproject: false, uvLock: false, requirements: false, environmentYml: false, uv: '/usr/bin/uv' },
      };
    },
    async projectWatch() {},
    onFsChanged(cb) {
      fsListeners.add(cb);
      return () => fsListeners.delete(cb);
    },
    async procRun(id, steps) {
      for (const st of steps) procListeners.forEach((l) => l({ id, kind: 'stdout', text: `$ ${st.program} ${st.args.join(' ')}`, code: null }));
      // Document renders (quarto render / rmarkdown::render): produce a small HTML page.
      const render = steps.find((st) => st.args[0] === 'render' || st.args.some((a) => a.includes('rmarkdown::render')));
      if (render) {
        const source = render.args[0] === 'render' ? render.args[1] : /render\("((?:[^"\\]|\\.)*)"/.exec(render.args.join(' '))?.[1] ?? '';
        const outDir = render.args[0] === 'render' ? render.args[render.args.indexOf('--output-dir') + 1] : /output_dir = "((?:[^"\\]|\\.)*)"/.exec(render.args.join(' '))?.[1] ?? '';
        const stem = nameOf(source).replace(/\.[^.]+$/, '');
        const body = (files.get(source) ?? '').replace(/^---[\s\S]*?---/, '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
        files.set(`${outDir}/${stem}.html`, `<!doctype html><html><head><title>${stem}</title></head><body><h1>${stem}</h1><pre>${body}</pre></body></html>`);
      }
      setTimeout(() => procListeners.forEach((l) => l({ id, kind: 'exit', text: '', code: 0 })), 600);
    },
    async procKill() {},
    onProcEvent(cb) {
      procListeners.add(cb);
      return () => procListeners.delete(cb);
    },
    async projectVenvSteps(root, python) {
      return [{ program: python, args: ['-m', 'venv', `${root}/.venv`] }];
    },
    async openUrl(url) {
      window.open(url, '_blank', 'noopener');
    },
    async findProgram(name) {
      return ({ uv: '/usr/bin/uv', quarto: '/usr/local/bin/quarto' } as Record<string, string>)[name] ?? null;
    },
    async ptyOpen(id) {
      return shell.open(id);
    },
    async ptyWrite(id, data) {
      shell.write(id, data);
    },
    async ptyResize() {},
    async ptyKill() {},
    onPtyEvent(cb) {
      ptyListeners.add(cb);
      return () => ptyListeners.delete(cb);
    },
    async reproFiles(root) {
      return [...files.keys()]
        .filter((p) => p.startsWith(root + '/'))
        .map((p) => ({ path: p.slice(root.length + 1), size: Math.max(1, (files.get(p) ?? '').length) * (p.endsWith('.csv') ? 4096 : 1) }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async reproHash(_root, paths) {
      const hex = (s: string) => Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(s.charCodeAt(i % s.length) + i * 7) % 16]).join('');
      return Object.fromEntries(paths.map((p) => [p, hex(p)]));
    },
    async reproWrite(dest, entries) {
      let n = 0;
      for (const e of entries) {
        const text = e.text ?? files.get(e.source ?? '') ?? '';
        n += text.length;
        if (!dest.endsWith('.zip')) files.set(`${dest}/${e.name}`, text);
      }
      if (dest.endsWith('.zip')) files.set(dest, `zip with ${entries.length} entries`);
      return n;
    },
    async extDir() {
      return EXT_ROOT;
    },
    async extInstall() {
      return 'dataforge.data-summary';
    },
    async extUninstall(id) {
      for (const k of [...files.keys()]) if (k.startsWith(`${EXT_ROOT}/${id}/`)) files.delete(k);
      for (const d of [...dirs]) if (d.startsWith(`${EXT_ROOT}/${id}`)) dirs.delete(d);
    },
    async kernelDebug() {
      throw new Error('Python debugging needs a real kernel');
    },
    async rDebug(command: any) {
      await later(20);
      if (command.command === 'variables') {
        if (command.ref === 7) return [{ name: 'a', type: 'integer', value: '1 2 3', variablesReference: 0 }, { name: 'b', type: 'character', value: '"x" "y" "z"', variablesReference: 0 }] as any;
        return [
          { name: 'adat', type: 'data.frame', value: '3 obs. of 2 variables', variablesReference: 7 },
          { name: 'n', type: 'numeric', value: '4', variablesReference: 0 },
          { name: 'total', type: 'numeric', value: '6', variablesReference: 0 },
        ] as any;
      }
      if (command.command === 'evaluate') return { ok: true, result: `[1] ${command.expression === 'total * 2' ? 12 : command.expression}`, variablesReference: 0 } as any;
      if (command.command === 'setBreakpoints') {
        rBreakpoints[command.path] = command.lines;
        return true as any;
      }
      rDebugWaiter?.(command.command);
      return { queued: true } as any;
    },
    onRDebugEvent(cb) {
      rDebugListeners.add(cb);
      return () => rDebugListeners.delete(cb);
    },
    async gitExec(root, args, stdin) {
      await later(30);
      if (root.startsWith('ssh://')) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      return git.exec(root, args, stdin);
    },
    async previewDir(source) {
      return `/tmp/dataforge-preview/${nameOf(source).replace(/\W/g, '_')}`;
    },
    async lspDetect(lang) {
      return { lang, command: null, installHint: null };
    },
    async lspStart() {
      throw new Error('Language servers are not available in the browser preview');
    },
    async lspSend() {},
    async lspStop() {},
    onLspEvent() {
      return () => {};
    },
    async setZoom(factor) {
      (document.documentElement.style as any).zoom = String(factor);
    },
  };
}
