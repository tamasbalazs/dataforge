import { describe, expect, it, vi } from 'vitest';

vi.mock('../../kernels/kernels', () => ({ callHelper: vi.fn(), startKernel: vi.fn() }));

import { parseHelpRequest, topicAt } from './helpStore';

describe('help requests from the console', () => {
  it('recognises R help syntax', () => {
    expect(parseHelpRequest('r', '?mean')).toEqual({ topic: 'mean', package: undefined });
    expect(parseHelpRequest('r', '?stats::sd')).toEqual({ topic: 'sd', package: 'stats' });
    expect(parseHelpRequest('r', '??regression')).toEqual({ topic: 'regression', search: true });
    expect(parseHelpRequest('r', 'help("lm", package = "stats")')).toEqual({ topic: 'lm', package: 'stats' });
    expect(parseHelpRequest('r', 'mean(x)')).toBeNull();
  });

  it('recognises Python help syntax', () => {
    expect(parseHelpRequest('python', 'help(len)')).toEqual({ topic: 'len' });
    expect(parseHelpRequest('python', 'np.mean?')).toEqual({ topic: 'np.mean' });
    expect(parseHelpRequest('python', 'df.groupby??')).toEqual({ topic: 'df.groupby' });
    expect(parseHelpRequest('python', 'print("?")')).toBeNull();
  });
});

describe('topic under cursor', () => {
  it('finds R names including pkg::fn', () => {
    expect(topicAt('x <- stats::sd(y)', 10, 'r')).toEqual({ topic: 'sd', package: 'stats' });
    expect(topicAt('summary(data.frame(a))', 12, 'r')).toEqual({ topic: 'data.frame' });
  });

  it('finds dotted Python names', () => {
    expect(topicAt('y = np.linalg.norm(x)', 9, 'python')).toEqual({ topic: 'np.linalg.norm' });
    expect(topicAt('    ', 2, 'python')).toBeNull();
  });
});
