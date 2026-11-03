/**
 * Static scan of project sources for the reproducibility report: packages
 * used, data files referenced, and practices that break reproducibility.
 * Pure functions (unit-tested); IO lives in reproStore.ts.
 */
import type { Lang } from '../core/host';
import { findChunks } from '../panels/editor/chunks';

export interface Loc {
  file: string;
  line: number;
}

export type IssueKind = 'setwd' | 'absolutePath' | 'noSeed' | 'installInScript' | 'missingData' | 'missingPackage' | 'uncommitted' | 'noGit' | 'githubPackage';

export interface Issue extends Loc {
  kind: IssueKind;
  detail: string;
  severity: 'error' | 'warning' | 'info';
}

export interface FileScan {
  lang: Lang;
  packages: Map<string, number>; // name → first line
  dataRefs: Array<{ ref: string; line: number }>;
  issues: Array<{ kind: IssueKind; line: number; detail: string }>;
}

export const DATA_EXT = /\.(csv|tsv|tab|txt|xlsx?|ods|parquet|feather|arrow|rds|rdata|rda|json|ndjson|jsonl|sav|dta|sas7bdat|xpt|xml|geojson|shp|gpkg|h5|hdf5|nc|pkl|pickle|npy|npz|sqlite|db|duckdb|zip|gz)$/i;
export const CODE_EXT = /\.(r|py|qmd|rmd|ipynb|sql|sh|stan)$/i;

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Blank out comments (keeping offsets) so commented-out code is not reported. */
export function stripComments(text: string, lang: Lang): string {
  // A small state machine: '#' starts a comment outside string literals.
  let out = '';
  let quote: string | null = null;
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inComment) {
      if (c === '\n') {
        inComment = false;
        out += c;
      } else out += ' ';
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || (lang === 'r' && c === '`')) quote = c;
    if (c === '#') {
      inComment = true;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

const R_RANDOM = /\b(sample|sample_n|sample_frac|slice_sample|runif|rnorm|rbinom|rpois|rexp|rgamma|rbeta|rmultinom|kmeans|randomForest|ranger|createDataPartition|initial_split|vfold_cv|bootstraps|cv\.glmnet|xgboost|xgb\.train)\s*\(/;
const R_SEED = /\b(set\.seed|withr::with_seed|with_seed|local_seed|RNGkind)\s*\(/;
const PY_RANDOM = /\b(np\.random\.(?!seed|default_rng\(\s*\d)\w+|numpy\.random\.\w+|random\.(random|randint|choice|choices|shuffle|sample|uniform|gauss)\s*\(|train_test_split\s*\(|KFold\s*\(|RandomForest\w*\s*\(|KMeans\s*\(|torch\.rand\w*\s*\()/;
const PY_SEED = /(\bseed\s*\(|random_state\s*=\s*\d|default_rng\(\s*\d|manual_seed\s*\()/;
const ABS_PATH = /^(\/(home|Users|mnt|media|Volumes|data|srv|tmp|opt|root)\/|[A-Za-z]:[\\/]|~[\\/]|\\\\)/;

function stringLiterals(text: string): Array<{ value: string; index: number }> {
  const out: Array<{ value: string; index: number }> = [];
  const re = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ value: m[2], index: m.index });
  return out;
}

export function scanCode(text: string, lang: Lang, lineOffset = 0): FileScan {
  const code = stripComments(text, lang);
  const res: FileScan = { lang, packages: new Map(), dataRefs: [], issues: [] };
  const add = (name: string, index: number) => {
    if (!res.packages.has(name)) res.packages.set(name, lineOf(code, index) + lineOffset);
  };
  const issue = (kind: IssueKind, index: number, detail: string) => res.issues.push({ kind, line: lineOf(code, index) + lineOffset, detail });
  let m: RegExpExecArray | null;
  if (lang === 'r') {
    const lib = /\b(?:library|require|requireNamespace|loadNamespace)\s*\(\s*["']?([A-Za-z][A-Za-z0-9.]*)["']?/g;
    while ((m = lib.exec(code))) add(m[1], m.index);
    const ns = /\b([A-Za-z][A-Za-z0-9.]*):::?[A-Za-z._]/g;
    while ((m = ns.exec(code))) add(m[1], m.index);
    const pload = /\bp_load\s*\(([^)]*)\)/g;
    while ((m = pload.exec(code))) for (const p of m[1].split(',').map((x) => x.trim().replace(/["']/g, ''))) if (/^[A-Za-z][\w.]*$/.test(p) && !p.includes('=')) add(p, m.index);
    const setwd = /\bsetwd\s*\(/.exec(code);
    if (setwd) issue('setwd', setwd.index, 'setwd()');
    const install = /\b(install\.packages|remotes::install_github|devtools::install_github)\s*\(/.exec(code);
    if (install) issue('installInScript', install.index, install[1]);
    const rnd = R_RANDOM.exec(code);
    if (rnd && !R_SEED.test(code)) issue('noSeed', rnd.index, rnd[1]);
  } else {
    const imp = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
    while ((m = imp.exec(code))) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0].split('.')[0], m.index);
    const from = /^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b/gm;
    while ((m = from.exec(code))) add(m[1].split('.')[0], m.index);
    const chdir = /\bos\.chdir\s*\(|%cd\b/.exec(code);
    if (chdir) issue('setwd', chdir.index, 'os.chdir()');
    const install = /^[ \t]*[!%]pip[ \t]+install\b|subprocess\.\w+\([^)]*pip[^)]*install/m.exec(code);
    if (install) issue('installInScript', install.index, 'pip install');
    const rnd = PY_RANDOM.exec(code);
    if (rnd && !PY_SEED.test(code)) issue('noSeed', rnd.index, rnd[1].replace(/\s*\($/, ''));
  }
  for (const s of stringLiterals(code)) {
    if (ABS_PATH.test(s.value)) issue('absolutePath', s.index, s.value);
    if (DATA_EXT.test(s.value) && !/^[a-z]+:\/\//i.test(s.value) && !/[*?{}%]/.test(s.value)) res.dataRefs.push({ ref: s.value, line: lineOf(code, s.index) + lineOffset });
  }
  return res;
}

/** Scan a whole file; Quarto / R Markdown documents are scanned chunk by chunk. */
export function scanFile(path: string, text: string): FileScan[] {
  if (/\.r$/i.test(path)) return [scanCode(text, 'r')];
  if (/\.py$/i.test(path)) return [scanCode(text, 'python')];
  if (/\.(qmd|rmd)$/i.test(path)) {
    const lines = text.split('\n');
    return findChunks(lines).map((c) => scanCode(lines.slice(c.start, c.end + 1).join('\n'), c.lang, c.start));
  }
  if (/\.ipynb$/i.test(path)) {
    try {
      const nb = JSON.parse(text);
      const lang: Lang = /^r$/i.test(nb?.metadata?.kernelspec?.language ?? nb?.metadata?.language_info?.name ?? '') ? 'r' : 'python';
      const src = (nb.cells ?? [])
        .filter((c: any) => c.cell_type === 'code')
        .map((c: any) => (Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '')))
        .join('\n');
      return [scanCode(src, lang)];
    } catch {
      return [];
    }
  }
  return [];
}

/** Python modules provided by the project itself (not packages to pin). */
export function localModules(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/');
    if (!/\.py$/.test(p)) continue;
    const file = parts[parts.length - 1];
    // Sibling modules of scripts in sub-folders, packages, and their top folder.
    out.add(file === '__init__.py' && parts.length > 1 ? parts[parts.length - 2] : file.replace(/\.py$/, ''));
    if (parts.length > 1) out.add(parts[0]);
  }
  return out;
}

/** Resolve a data reference against the project root, then the script's folder. */
export function resolveRef(ref: string, fromFile: string, files: Set<string>): string | null {
  const norm = (p: string) => {
    const out: string[] = [];
    for (const part of p.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return out.join('/');
  };
  if (ABS_PATH.test(ref)) return null;
  const candidates = [norm(ref)];
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  if (dir) candidates.push(norm(`${dir}/${ref}`));
  return candidates.find((c) => files.has(c)) ?? null;
}

export const R_BASE = new Set(['base', 'stats', 'utils', 'graphics', 'grDevices', 'methods', 'datasets', 'tools', 'parallel', 'grid', 'splines', 'stats4', 'tcltk', 'compiler']);
