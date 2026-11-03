import { describe, expect, it } from 'vitest';
import { docBlocks } from './docFormat';

describe('docstring blocks', () => {
  it('splits numpydoc sections', () => {
    const doc = 'Compute the mean.\n\nParameters\n----------\nx : array\n    Input.\n\nReturns\n-------\nfloat';
    expect(docBlocks(doc)).toEqual([
      { type: 'text', text: 'Compute the mean.' },
      { type: 'heading', text: 'Parameters' },
      { type: 'text', text: 'x : array\n    Input.' },
      { type: 'heading', text: 'Returns' },
      { type: 'text', text: 'float' },
    ]);
  });

  it('splits Google-style sections', () => {
    expect(docBlocks('Do it.\n\nArgs:\n    x: value\nReturns:\n    y')).toEqual([
      { type: 'text', text: 'Do it.' },
      { type: 'heading', text: 'Args' },
      { type: 'text', text: '    x: value' },
      { type: 'heading', text: 'Returns' },
      { type: 'text', text: '    y' },
    ]);
  });

  it('keeps plain docs as one block', () => {
    expect(docBlocks('Return the number of items in a container.')).toEqual([{ type: 'text', text: 'Return the number of items in a container.' }]);
    expect(docBlocks('')).toEqual([]);
  });
});
