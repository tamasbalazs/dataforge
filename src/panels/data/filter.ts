/**
 * Column filter expressions typed into the column menu:
 *   numbers/dates: "> 5", ">= 5", "< 5", "<= 5", "= 5", "!= 5", "1 .. 10", "1 - 10"
 *   text:          "abc" (contains), "= abc" (exact), "!= abc"
 *   any column:    "NA" (missing), "!NA" (not missing)
 */
export type FilterOp = 'contains' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'oneof' | 'isna' | 'notna';

export interface ColumnFilter {
  col: number;
  op: FilterOp;
  value?: string | string[];
  /** Original text, shown in the filter chip. */
  text: string;
}

const OPS: Array<[string, FilterOp]> = [
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['!=', 'neq'],
  ['==', 'eq'],
  ['>', 'gt'],
  ['<', 'lt'],
  ['=', 'eq'],
];

export function parseFilter(text: string, tone: string, col: number): ColumnFilter | null {
  const raw = text.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === 'NA' || upper === 'NULL' || upper === 'NAN') return { col, op: 'isna', text: raw };
  if (upper === '!NA' || upper === 'NOT NA') return { col, op: 'notna', text: raw };
  const ordered = tone === 'numeric' || tone === 'date';
  if (ordered) {
    const range = raw.match(/^(.+?)\s*(?:\.\.|\s-\s|–)\s*(.+)$/);
    if (range && !/^[<>=!]/.test(raw)) return { col, op: 'between', value: [range[1].trim(), range[2].trim()], text: raw };
  }
  for (const [sym, op] of OPS) {
    if (raw.startsWith(sym)) {
      const value = raw.slice(sym.length).trim();
      if (!value) return null;
      if (!ordered && !['eq', 'neq'].includes(op)) return { col, op: 'contains', value: raw, text: raw };
      return { col, op, value, text: raw };
    }
  }
  if (ordered && tone === 'numeric') {
    return Number.isFinite(Number(raw)) ? { col, op: 'eq', value: raw, text: raw } : null;
  }
  if (ordered) return { col, op: 'eq', value: raw, text: raw };
  return { col, op: 'contains', value: raw, text: raw };
}

/** Serialisable form sent to the kernel helper. */
export const toWire = (f: ColumnFilter) => ({ col: f.col, op: f.op, value: f.value });
