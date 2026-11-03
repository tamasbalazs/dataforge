/** Turns Python docstrings (numpydoc / Google style) into simple blocks. */
export type DocBlock = { type: 'heading'; text: string } | { type: 'text'; text: string };

const GOOGLE = /^(Args|Arguments|Parameters|Returns|Return|Yields|Raises|Examples?|Notes?|See Also|Attributes|References|Warnings?|Other Parameters):\s*$/;

export function docBlocks(doc: string): DocBlock[] {
  const lines = doc.replace(/\r\n/g, '\n').split('\n');
  const out: DocBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    while (buf.length && !buf[0].trim()) buf.shift();
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length) out.push({ type: 'text', text: buf.join('\n') });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line.trim() && next !== undefined && /^\s*-{3,}\s*$/.test(next) && next.trim().length >= Math.min(3, line.trim().length)) {
      flush();
      out.push({ type: 'heading', text: line.trim() });
      i++;
      continue;
    }
    const g = line.match(GOOGLE);
    if (g) {
      flush();
      out.push({ type: 'heading', text: g[1] });
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}
