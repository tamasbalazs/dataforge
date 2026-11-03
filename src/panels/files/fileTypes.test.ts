import { describe, expect, it } from 'vitest';
import { canImport, codePath, fileKind, importCode, isEditable, varNameFor } from './fileTypes';

describe('file types', () => {
  it('classifies files', () => {
    expect(fileKind('analysis.R')).toBe('r');
    expect(fileKind('model.py')).toBe('python');
    expect(fileKind('report.qmd')).toBe('markdown');
    expect(fileKind('sales.parquet')).toBe('data');
    expect(fileKind('renv.lock')).toBe('config');
    expect(isEditable('notes.md')).toBe(true);
    expect(isEditable('data.csv')).toBe(false);
    expect(isEditable('photo.png')).toBe(false);
  });

  it('derives variable names', () => {
    expect(varNameFor('sales 2024-Q1.csv')).toBe('sales_2024_Q1');
    expect(varNameFor('2024.csv')).toBe('d_2024');
    expect(varNameFor('árak.csv')).toBe('rak');
  });

  it('writes project-relative paths', () => {
    expect(codePath('/home/me/proj/data/a.csv', '/home/me/proj')).toBe('"data/a.csv"');
    expect(codePath('C:\\Users\\me\\proj\\a.csv', 'C:\\Users\\me\\proj')).toBe('"a.csv"');
    expect(codePath('/tmp/x "y".csv', '/home/me/proj')).toBe('"/tmp/x \\"y\\".csv"');
  });

  it('generates import code per language', () => {
    expect(importCode('r', '/p/data/sales.csv', '/p')).toBe('sales <- read.csv("data/sales.csv")\nView(sales)');
    expect(importCode('python', '/p/data/sales.parquet', '/p')).toBe('import pandas as pd\nsales = pd.read_parquet("data/sales.parquet")\nView(sales)');
    expect(importCode('r', '/p/x.RData', '/p')).toBe('load("x.RData")');
    expect(importCode('python', '/p/x.rds', '/p')).toBeNull();
    expect(canImport('python', 'x.rds')).toBe(false);
    expect(canImport('r', 'x.xlsx')).toBe(true);
  });
});

describe('Stan files', () => {
  it('open in the editor with their own kind', () => {
    expect(fileKind('nyolc_iskola.stan')).toBe('stan');
    expect(fileKind('helpers.stanfunctions')).toBe('stan');
    expect(isEditable('model.stan')).toBe(true);
  });
});

