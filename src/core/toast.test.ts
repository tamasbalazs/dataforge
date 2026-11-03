import { describe, expect, it } from 'vitest';
import { defaultTimeout } from './toast';

describe('toast timing', () => {
  it('gives actionable toasts time to be used', () => {
    expect(defaultTimeout({ kind: 'success' })).toBe(3200);
    expect(defaultTimeout({ kind: 'error' })).toBe(7000);
    expect(defaultTimeout({ kind: 'success', action: { label: 'x', run: () => {} } })).toBeGreaterThanOrEqual(10000);
    expect(defaultTimeout({ kind: 'progress' })).toBe(0);
  });
});
