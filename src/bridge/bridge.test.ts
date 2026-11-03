import { describe, expect, it } from 'vitest';
import { targetName, transferCode } from './bridge';

describe('R/Python bridge code', () => {
  it('writes reproducible transfer lines', () => {
    expect(transferCode('r', 'sales')).toBe('sales = r.sales');
    expect(transferCode('python', 'df')).toBe('df <- py$df');
  });

  it('adapts names that are invalid in the target language', () => {
    expect(transferCode('r', 'my.data')).toBe('my_data = r["my.data"]');
    expect(transferCode('r', 'class')).toBe('class_ = r["class"]');
    expect(transferCode('python', 'TRUE')).toBe('TRUE_ <- py[["TRUE"]]');
    expect(targetName('_tmp', 'r')).toBe('tmp');
    expect(targetName('2x', 'python')).toBe('_2x');
  });
});
