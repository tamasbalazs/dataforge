/**
 * Statement boundary detection for "run current statement" (Ctrl+Enter).
 * A lightweight, string/comment-aware scanner — no full parser needed for
 * the common cases (multi-line calls, pipes, blocks, decorators).
 */
export type StatementLang = 'r' | 'python';

export interface Range {
  /** 0-based inclusive line indices. */
  start: number;
  end: number;
}

interface LineInfo {
  /** Bracket depth after this line. */
  depth: number;
  /** Inside an unterminated (multi-line) string after this line. */
  inString: boolean;
  /** Code part without comment, trimmed at the end. */
  code: string;
  blank: boolean;
}

function scan(lines: string[], lang: StatementLang): LineInfo[] {
  const out: LineInfo[] = [];
  let depth = 0;
  let quote: string | null = null; // ' " ` or ''' """
  for (const line of lines) {
    let code = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (quote) {
        code += ch;
        if (ch === '\\') {
          code += line[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (quote.length === 3 ? line.startsWith(quote, i) : ch === quote) {
          if (quote.length === 3) code += quote.slice(1);
          i += quote.length;
          quote = null;
          continue;
        }
        i++;
        continue;
      }
      if (ch === '#') break;
      if (lang === 'python' && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        quote = line.slice(i, i + 3);
        code += quote;
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'" || (lang === 'r' && ch === '`')) {
        quote = ch;
      } else if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      code += ch;
      i++;
    }
    // Single-quoted strings do not continue across lines in Python.
    if (lang === 'python' && quote && quote.length === 1 && !line.endsWith('\\')) quote = null;
    out.push({ depth, inString: quote !== null, code: code.trimEnd(), blank: line.trim() === '' || line.trim().startsWith('#') });
  }
  return out;
}

const R_CONTINUATION = /(\+|-|\*|\/|\^|%[^%]*%|\|>|\||&|<-|<<-|->|=|,|~|\$|@|:|!|==|!=|<=|>=|<|>|&&|\|\|)$/;

function continues(info: LineInfo, lang: StatementLang): boolean {
  if (info.depth > 0 || info.inString) return true;
  if (lang === 'r') return R_CONTINUATION.test(info.code);
  return info.code.endsWith('\\') || info.code.endsWith(':') || info.code.trimStart().startsWith('@');
}

const PY_CONTINUES_BLOCK = /^(elif\b|else\b|except\b|finally\b|case\b)/;
const R_CONTINUES_BLOCK = /^(else\b)/;

/** Split a document into top-level statements. */
export function splitStatements(lines: string[], lang: StatementLang): Range[] {
  const info = scan(lines, lang);
  const ranges: Range[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (info[i].blank) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    for (;;) {
      if (continues(info[end], lang) && end + 1 < n) {
        end++;
        continue;
      }
      // Python: indented lines and block continuations belong to the statement.
      if (lang === 'python' || lang === 'r') {
        let j = end + 1;
        while (j < n && info[j].blank) j++;
        if (j < n) {
          const next = lines[j];
          const trimmed = next.trimStart();
          const indented = lang === 'python' && next.length > 0 && /^\s/.test(next);
          const blockCont = (lang === 'python' ? PY_CONTINUES_BLOCK : R_CONTINUES_BLOCK).test(trimmed);
          const closing = /^[)\]}]/.test(trimmed);
          if (indented || blockCont || (lang === 'r' && closing)) {
            end = j;
            continue;
          }
        }
      }
      break;
    }
    ranges.push({ start, end });
    i = end + 1;
  }
  return ranges;
}

/**
 * The statement to run for a cursor on `line`. On a blank or comment line the
 * next statement is used, like RStudio.
 */
export function statementAt(lines: string[], line: number, lang: StatementLang): Range | null {
  const ranges = splitStatements(lines, lang);
  return ranges.find((r) => line >= r.start && line <= r.end) ?? ranges.find((r) => r.start > line) ?? null;
}

/** Line to move the cursor to after running `range`. */
export function nextStatementLine(lines: string[], range: Range, lang: StatementLang): number {
  const next = splitStatements(lines, lang).find((r) => r.start > range.end);
  return next ? next.start : Math.min(range.end + 1, lines.length - 1);
}
