import { describe, expect, it } from 'vitest';
import { chunkAt, chunkCode, findChunks, isLiterate } from './chunks';

const doc = `---
title: x
---
Intro \`r 1+1\`

\`\`\`{r setup, echo=FALSE}
library(stats)
x <- 1
\`\`\`

Text

\`\`\`{python}
#| label: fig-py
y = 2
\`\`\`

\`\`\`bash
ls
\`\`\`

\`\`\`{r}
\`\`\``.split('\n');

describe('literate chunks', () => {
  it('finds R and Python chunks with labels, skipping other languages', () => {
    const cs = findChunks(doc);
    expect(cs.map((c) => [c.lang, c.header, c.start, c.end, c.label])).toEqual([
      ['r', 5, 6, 7, 'setup'],
      ['python', 12, 13, 14, 'fig-py'],
      ['r', 21, 22, 21, null],
    ]);
  });

  it('locates the chunk under the cursor and strips option lines', () => {
    const cs = findChunks(doc);
    expect(chunkAt(cs, 7)?.lang).toBe('r');
    expect(chunkAt(cs, 8)?.lang).toBe('r'); // closing fence
    expect(chunkAt(cs, 10)).toBeNull();
    expect(chunkCode(doc, cs[1])).toBe('y = 2');
  });

  it('recognises literate files', () => {
    expect(isLiterate('/a/b.qmd')).toBe(true);
    expect(isLiterate('/a/b.Rmd')).toBe(true);
    expect(isLiterate('/a/b.R')).toBe(false);
  });
});
