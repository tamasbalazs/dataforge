/** Minimal ANSI SGR → styled segments parser for kernel tracebacks and logs. */

export interface Segment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

// eslint-disable-next-line no-control-regex
const ESC = /\u001b\[([0-9;]*)m/g;

export function parseAnsi(input: string): Segment[] {
  const out: Segment[] = [];
  let state: Omit<Segment, 'text'> = {};
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && JSON.stringify({ ...prev, text: '' }) === JSON.stringify({ ...state, text: '' })) prev.text += text;
    else out.push({ text, ...state });
  };
  for (const m of input.matchAll(ESC)) {
    push(input.slice(last, m.index));
    last = m.index! + m[0].length;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) state = {};
      else if (c === 1) state = { ...state, bold: true };
      else if (c === 2) state = { ...state, dim: true };
      else if (c === 3) state = { ...state, italic: true };
      else if (c === 4) state = { ...state, underline: true };
      else if (c === 22) state = { ...state, bold: undefined, dim: undefined };
      else if (c === 23) state = { ...state, italic: undefined };
      else if (c === 24) state = { ...state, underline: undefined };
      else if (c >= 30 && c <= 37) state = { ...state, fg: NAMES[c - 30] };
      else if (c >= 90 && c <= 97) state = { ...state, fg: 'bright-' + NAMES[c - 90] };
      else if (c === 39) state = { ...state, fg: undefined };
      else if (c >= 40 && c <= 47) state = { ...state, bg: NAMES[c - 40] };
      else if (c === 49) state = { ...state, bg: undefined };
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2; // 256-colour: ignored
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) i += 4; // truecolour: ignored
    }
    for (const k of Object.keys(state) as (keyof typeof state)[]) if (state[k] === undefined) delete state[k];
  }
  push(input.slice(last));
  return out;
}

export function stripAnsi(s: string): string {
  return s.replace(ESC, '');
}

// eslint-disable-next-line no-control-regex
const CONTROL = /\u001b\[([0-9;?]*)([A-Za-z])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\r\n|\r|\n|\u001b[()][A-Za-z0-9]|\u0007|\u0008/g;

/**
 * Apply terminal cursor controls so progress bars (tqdm, pip, uv) render as
 * their final state: `\r` restarts the line, `ESC[nA`/`ESC[nB` move between
 * lines, `ESC[2K` clears a line. Colour codes (SGR) are kept for parseAnsi.
 */
export function applyControls(input: string): string {
  if (!/[\r\u001b\u0008]/.test(input)) return input;
  const lines: string[] = [''];
  let row = 0;
  let pendingReturn = false;
  let last = 0;
  const write = (text: string) => {
    if (!text) return;
    if (pendingReturn) {
      lines[row] = '';
      pendingReturn = false;
    }
    lines[row] += text;
  };
  for (const m of input.matchAll(CONTROL)) {
    write(input.slice(last, m.index));
    last = m.index! + m[0].length;
    const tok = m[0];
    if (tok === '\n' || tok === '\r\n') {
      row++;
      // Moving onto a line drawn earlier (after cursor-up) overwrites it.
      pendingReturn = row < lines.length;
      if (row >= lines.length) lines.push('');
    } else if (tok === '\r') {
      // Overwrite on the next write (a bare \r at the end keeps the line).
      pendingReturn = true;
    } else if (tok === '\u0008') {
      lines[row] = lines[row].slice(0, -1);
    } else if (m[2]) {
      const n = Math.max(1, parseInt(m[1] || '1', 10) || 1);
      switch (m[2]) {
        case 'm':
          write(tok);
          break;
        case 'A':
          row = Math.max(0, row - n);
          pendingReturn = true;
          break;
        case 'B':
          row += n;
          while (row >= lines.length) lines.push('');
          break;
        case 'K':
          if ((m[1] || '0') !== '0' || pendingReturn) lines[row] = '';
          pendingReturn = false;
          break;
        case 'J':
          if (m[1] === '2' || m[1] === '3') {
            lines.length = 1;
            lines[0] = '';
            row = 0;
          }
          break;
        default:
          break; // other cursor/mode controls are ignored
      }
    }
  }
  write(input.slice(last));
  return lines.join('\n');
}
