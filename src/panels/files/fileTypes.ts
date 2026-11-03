/** File type knowledge for the Files panel: icons, text vs data, import code. */
import type { Lang } from '../../core/host';

export const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

const TEXT = new Set(['stan', 'stanfunctions', 'r', 'py', 'pyw', 'md', 'qmd', 'rmd', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'sh', 'sql', 'csv', 'tsv', 'rprofile', 'renviron', 'gitignore', 'lock', 'html', 'css', 'js', 'ts', 'xml', 'tex', 'bib', 'log', 'rproj', 'dcf']);

export type FileKind = 'r' | 'python' | 'stan' | 'markdown' | 'data' | 'image' | 'pdf' | 'config' | 'text' | 'other';

export function fileKind(name: string): FileKind {
  const e = ext(name);
  const lower = name.toLowerCase();
  if (e === 'r' || lower === '.rprofile') return 'r';
  if (e === 'py' || e === 'pyw' || e === 'ipynb') return 'python';
  if (e === 'stan' || e === 'stanfunctions') return 'stan';
  if (['md', 'qmd', 'rmd'].includes(e)) return 'markdown';
  if (DATA_EXT.includes(e)) return 'data';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'lock', 'rproj', 'dcf'].includes(e) || lower.startsWith('.')) return 'config';
  if (TEXT.has(e)) return 'text';
  return 'other';
}

/** Opens in the editor (as opposed to the system app). */
export const isEditable = (name: string) => {
  const e = ext(name);
  const lower = name.toLowerCase();
  return (TEXT.has(e) || lower === 'dockerfile' || lower === 'makefile' || lower.startsWith('.')) && !['csv', 'tsv'].includes(e);
};

export const DATA_EXT = ['csv', 'tsv', 'parquet', 'feather', 'arrow', 'rds', 'rdata', 'rda', 'xlsx', 'xls', 'sav', 'dta', 'sas7bdat', 'pkl', 'pickle'];

const READERS: Record<Lang, Record<string, (p: string) => string>> = {
  r: {
    csv: (p) => `read.csv(${p})`,
    tsv: (p) => `read.delim(${p})`,
    parquet: (p) => `arrow::read_parquet(${p})`,
    feather: (p) => `arrow::read_feather(${p})`,
    arrow: (p) => `arrow::read_feather(${p})`,
    rds: (p) => `readRDS(${p})`,
    xlsx: (p) => `readxl::read_excel(${p})`,
    xls: (p) => `readxl::read_excel(${p})`,
    sav: (p) => `haven::read_sav(${p})`,
    dta: (p) => `haven::read_dta(${p})`,
    sas7bdat: (p) => `haven::read_sas(${p})`,
  },
  python: {
    csv: (p) => `pd.read_csv(${p})`,
    tsv: (p) => `pd.read_csv(${p}, sep="\\t")`,
    parquet: (p) => `pd.read_parquet(${p})`,
    feather: (p) => `pd.read_feather(${p})`,
    arrow: (p) => `pd.read_feather(${p})`,
    xlsx: (p) => `pd.read_excel(${p})`,
    xls: (p) => `pd.read_excel(${p})`,
    sav: (p) => `pd.read_spss(${p})`,
    dta: (p) => `pd.read_stata(${p})`,
    sas7bdat: (p) => `pd.read_sas(${p})`,
    pkl: (p) => `pd.read_pickle(${p})`,
    pickle: (p) => `pd.read_pickle(${p})`,
  },
};

export const canImport = (lang: Lang, name: string) => {
  const e = ext(name);
  return e in READERS[lang] || (lang === 'r' && (e === 'rdata' || e === 'rda'));
};

/** A valid R/Python identifier derived from a file name. */
export function varNameFor(name: string): string {
  let base = name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) base = 'data';
  if (/^\d/.test(base)) base = `d_${base}`;
  return base;
}

/** Path as written in code: relative to the project root when inside it, forward slashes. */
export function codePath(path: string, root: string | null): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  let p = norm(path);
  if (root) {
    const r = norm(root).replace(/\/$/, '');
    if (p.startsWith(r + '/')) p = p.slice(r.length + 1);
  }
  return JSON.stringify(p);
}

/** Code that reads a data file into a variable and opens it in the viewer. */
export function importCode(lang: Lang, path: string, root: string | null): string | null {
  const name = path.split(/[\\/]/).pop()!;
  const e = ext(name);
  const v = varNameFor(name);
  const p = codePath(path, root);
  if (lang === 'r' && (e === 'rdata' || e === 'rda')) return `load(${p})`;
  const reader = READERS[lang][e];
  if (!reader) return null;
  return lang === 'r' ? `${v} <- ${reader(p)}\nView(${v})` : `import pandas as pd\n${v} = ${reader(p)}\nView(${v})`;
}
