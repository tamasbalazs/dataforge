import { describe, expect, it } from 'vitest';
import { parseAnsi, stripAnsi } from './ansi';

describe('parseAnsi', () => {
  it('returns plain text unchanged', () => {
    expect(parseAnsi('hello')).toEqual([{ text: 'hello' }]);
  });

  it('applies and resets colours', () => {
    expect(parseAnsi('\u001b[0;31mError\u001b[0m: x')).toEqual([{ text: 'Error', fg: 'red' }, { text: ': x' }]);
  });

  it('handles bold and bright colours', () => {
    expect(parseAnsi('\u001b[1;92mok')).toEqual([{ text: 'ok', bold: true, fg: 'bright-green' }]);
  });

  it('skips 256-colour sequences without breaking', () => {
    expect(parseAnsi('\u001b[38;5;208mA\u001b[0mB')).toEqual([{ text: 'AB' }]);
  });

  it('strips escapes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });
});

import { applyControls } from './ansi';

describe('applyControls', () => {
  it('leaves plain text alone', () => {
    expect(applyControls('a\nb')).toBe('a\nb');
  });

  it('renders carriage-return progress bars as their last state (tqdm/pip)', () => {
    expect(applyControls(' 10%|█   |\r 50%|████ |\r100%|█████|\ndone')).toBe('100%|█████|\ndone');
  });

  it('keeps Windows line endings', () => {
    expect(applyControls('a\r\nb')).toBe('a\nb');
  });

  it('handles cursor-up + erase-line redraws (uv)', () => {
    const s = 'Resolving\nprogress 10%\u001b[1A\u001b[2KResolved 1 package\nprogress 100%';
    expect(applyControls(s)).toBe('Resolved 1 package\nprogress 100%');
  });

  it('keeps colour codes and drops other escapes', () => {
    expect(applyControls('\u001b[?25l\u001b[32mok\u001b[0m\u001b]0;title\u0007')).toBe('\u001b[32mok\u001b[0m');
  });
});
