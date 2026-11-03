import { describe, expect, it } from 'vitest';
import { nextStatementLine, splitStatements, statementAt } from './statement';

const L = (s: string) => s.split('\n');

describe('R statements', () => {
  it('splits simple lines', () => {
    expect(splitStatements(L('x <- 1\ny <- 2'), 'r')).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ]);
  });

  it('keeps multi-line calls and pipes together', () => {
    const src = `df <- data.frame(\n  a = 1:3,\n  b = 4:6\n)\ndf |>\n  subset(a > 1) |>\n  head()\nprint(df)`;
    expect(splitStatements(L(src), 'r')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 6 },
      { start: 7, end: 7 },
    ]);
  });

  it('handles ggplot + chains and comments', () => {
    const src = `ggplot(mtcars, aes(wt, mpg)) + # comment\n  geom_point() +\n  theme_minimal()\n# just a comment\nx`;
    expect(splitStatements(L(src), 'r')).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 4 },
    ]);
  });

  it('ignores brackets inside strings', () => {
    expect(splitStatements(L(`s <- "(not open"\ny <- 1`), 'r')).toHaveLength(2);
  });

  it('keeps functions with braces together', () => {
    const src = `f <- function(x) {\n  if (x > 1) {\n    x\n  } else {\n    0\n  }\n}\nf(2)`;
    expect(splitStatements(L(src), 'r')).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 7 },
    ]);
  });

  it('finds the statement under the cursor, or the next one on blank lines', () => {
    const src = L(`a <- c(1,\n  2)\n\nb <- 3`);
    expect(statementAt(src, 1, 'r')).toEqual({ start: 0, end: 1 });
    expect(statementAt(src, 2, 'r')).toEqual({ start: 3, end: 3 });
    expect(nextStatementLine(src, { start: 0, end: 1 }, 'r')).toBe(3);
  });
});

describe('Python statements', () => {
  it('groups indented blocks and else/except clauses', () => {
    const src = `def f(x):\n    if x:\n        return 1\n\n    return 2\n\ntry:\n    f(1)\nexcept Exception:\n    pass\nprint(f(0))`;
    expect(splitStatements(L(src), 'python')).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 9 },
      { start: 10, end: 10 },
    ]);
  });

  it('handles decorators, brackets and triple-quoted strings', () => {
    const src = `@decorator\ndef g():\n    pass\nx = [\n  1,\n  2,\n]\ns = """\nhello (\n"""\ny = 1`;
    expect(splitStatements(L(src), 'python')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 6 },
      { start: 7, end: 9 },
      { start: 10, end: 10 },
    ]);
  });

  it('handles backslash continuation', () => {
    expect(splitStatements(L(`total = 1 + \\\n    2\nprint(total)`), 'python')).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 2 },
    ]);
  });
});
