import { describe, expect, it } from 'vitest';
import { localModules, resolveRef, scanCode, scanFile, stripComments } from './scan';

describe('reproducibility scan — R', () => {
  const src = [
    'library(dplyr)',
    'require("ggplot2")',
    '# library(notused)',
    'x <- readr::read_csv("data/eladasok.csv")',
    'y <- readRDS(file = "kimenet/modell.rds")',
    'setwd("/home/anna/projekt")',
    'idx <- sample(nrow(x), 10)',
    'pacman::p_load(tidyr, "stringr")',
    'msg <- "a # not a comment"',
  ].join('\n');
  const r = scanCode(src, 'r');

  it('finds packages, ignoring comments', () => {
    expect([...r.packages.keys()].sort()).toEqual(['dplyr', 'ggplot2', 'pacman', 'readr', 'stringr', 'tidyr']);
    expect(r.packages.get('readr')).toBe(4);
  });

  it('finds data references and risky practices', () => {
    expect(r.dataRefs.map((d) => [d.ref, d.line])).toEqual([
      ['data/eladasok.csv', 4],
      ['kimenet/modell.rds', 5],
    ]);
    const kinds = r.issues.map((i) => `${i.kind}@${i.line}`).sort();
    expect(kinds).toEqual(['absolutePath@6', 'noSeed@7', 'setwd@6']);
  });

  it('accepts seeded randomness', () => {
    expect(scanCode('set.seed(42)\nsample(1:10)', 'r').issues).toEqual([]);
  });

  it('keeps string contents when stripping comments', () => {
    expect(stripComments('a <- "x # y" # c', 'r')).toBe('a <- "x # y"    ');
  });
});

describe('reproducibility scan — Python', () => {
  const src = [
    'import pandas as pd, numpy as np',
    'from sklearn.model_selection import train_test_split',
    'import os.path',
    'from . import helpers',
    'from utils import tisztit',
    'df = pd.read_parquet("data/adat.parquet")',
    'X_tr, X_te = train_test_split(df)',
    "url = 'https://example.org/x.csv'",
    'os.chdir("C:\\\\Users\\\\anna")',
  ].join('\n');
  const p = scanCode(src, 'python');

  it('finds top-level imported modules', () => {
    expect([...p.packages.keys()].sort()).toEqual(['numpy', 'os', 'pandas', 'sklearn', 'utils']);
  });

  it('finds data refs (not URLs) and issues', () => {
    expect(p.dataRefs.map((d) => d.ref)).toEqual(['data/adat.parquet']);
    expect(p.issues.map((i) => i.kind).sort()).toEqual(['absolutePath', 'noSeed', 'setwd']);
    expect(scanCode('from sklearn.model_selection import train_test_split\ntrain_test_split(X, random_state=1)', 'python').issues).toEqual([]);
  });

  it('scans Quarto chunks with their own language and real line numbers', () => {
    const qmd = '---\ntitle: x\n---\n\n```{r}\nlibrary(knitr)\n```\n\n```{python}\nimport polars\n```\n';
    const scans = scanFile('a.qmd', qmd);
    expect(scans.map((s) => [s.lang, [...s.packages.entries()]])).toEqual([
      ['r', [['knitr', 6]]],
      ['python', [['polars', 10]]],
    ]);
  });

  it('reads notebooks', () => {
    const nb = JSON.stringify({ metadata: { kernelspec: { language: 'python' } }, cells: [{ cell_type: 'code', source: ['import seaborn\n', '!pip install x\n'] }] });
    const [s] = scanFile('n.ipynb', nb);
    expect([...s.packages.keys()]).toEqual(['seaborn']);
    expect(s.issues.map((i) => i.kind)).toEqual(['installInScript']);
  });
});

describe('project structure', () => {
  it('knows local modules', () => {
    expect([...localModules(['utils.py', 'pkg/__init__.py', 'pkg/core.py', 'main.py', 'data/a.csv'])].sort()).toEqual(['core', 'main', 'pkg', 'utils']);
  });

  it('resolves data references from the root or the script folder', () => {
    const files = new Set(['data/a.csv', 'docs/b.csv']);
    expect(resolveRef('data/a.csv', 'elemzes.R', files)).toBe('data/a.csv');
    expect(resolveRef('./b.csv', 'docs/riport.Rmd', files)).toBe('docs/b.csv');
    expect(resolveRef('../data/a.csv', 'docs/riport.Rmd', files)).toBe('data/a.csv');
    expect(resolveRef('nincs.csv', 'x.R', files)).toBeNull();
  });
});
