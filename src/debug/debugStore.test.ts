import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/host', () => ({ host: () => ({}) }));
vi.mock('../kernels/kernels', () => ({
  callHelper: vi.fn(),
  execute: vi.fn(),
  interruptKernel: vi.fn(),
  isRunning: () => false,
  startKernel: vi.fn(),
  LANG_LABEL: { r: 'R', python: 'Python' },
}));

const { debugLangFor, setBreakpoints, toggleBreakpoint, useBreakpoints, clearAllBreakpoints } = await import('./debugStore');

describe('breakpoints', () => {
  beforeEach(() => useBreakpoints.setState({ byPath: {} }));

  it('knows which files can be debugged', () => {
    expect(debugLangFor('/p/a.R')).toBe('r');
    expect(debugLangFor('/p/a.r')).toBe('r');
    expect(debugLangFor('/p/b.py')).toBe('python');
    expect(debugLangFor('/p/c.qmd')).toBeNull();
    expect(debugLangFor(null)).toBeNull();
  });

  it('toggles, sorts and de-duplicates lines per file', () => {
    toggleBreakpoint('/p/a.R', 7);
    toggleBreakpoint('/p/a.R', 3);
    setBreakpoints('/p/b.py', [5, 5, 2, 0]);
    expect(useBreakpoints.getState().byPath).toEqual({ '/p/a.R': [3, 7], '/p/b.py': [2, 5] });
    toggleBreakpoint('/p/a.R', 7);
    toggleBreakpoint('/p/a.R', 3);
    expect(useBreakpoints.getState().byPath['/p/a.R']).toBeUndefined();
    clearAllBreakpoints();
    expect(useBreakpoints.getState().byPath).toEqual({});
  });
});
