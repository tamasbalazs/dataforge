import { describe, expect, it } from 'vitest';
import { diffNames, writesAcross, formatBytes, formatDims, type Variable } from './envStore';

const v = (name: string, preview = ''): Variable => ({ name, type: 'numeric', kind: 'value', dims: 1, size: 56, preview });

describe('environment helpers', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(null)).toBe('—');
  });

  it('formats dimensions', () => {
    expect(formatDims([100, 2])).toBe('100 × 2');
    expect(formatDims(5)).toBe('5');
  });

  it('reports new and changed variables', () => {
    expect(diffNames([v('a', '1'), v('b', '2')], [v('a', '1'), v('b', '3'), v('c')])).toEqual(['b', 'c']);
  });

  it('detects bridge writes into the other language', () => {
    expect(writesAcross('python', 'r.osszesites = d.sum()')).toBe(true);
    expect(writesAcross('python', 'r["my.df"] = df')).toBe(true);
    expect(writesAcross('python', 'x = r.data')).toBe(false);
    expect(writesAcross('python', 'if r.x == 1: pass')).toBe(false);
    expect(writesAcross('r', 'py$model <- lm(y ~ x)')).toBe(true);
    expect(writesAcross('r', 'x <- py$data')).toBe(false);
  });
});
