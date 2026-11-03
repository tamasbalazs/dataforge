/**
 * The Stan compiler (stanc3, compiled to JavaScript) in a sandboxed worker:
 * live diagnostics, formatting and model information without CmdStan.
 *
 * The worker is built from a blob: a prelude that removes network access,
 * then stanc.js (served from /vendor/stanc), then a small message handler.
 */

export interface StanDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 1-based; 0 when stanc gave no location. */
  line: number;
  column: number;
  endColumn: number;
}

export interface StanVar {
  type: string;
  dimensions: number;
}

export interface StanInfo {
  inputs: Record<string, StanVar>;
  parameters: Record<string, StanVar>;
  'transformed parameters': Record<string, StanVar>;
  'generated quantities': Record<string, StanVar>;
  functions?: string[];
  distributions?: string[];
  included_files?: string[];
}

const PRELUDE = `
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
  try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
}
`;

const HANDLER = `
self.onmessage = (e) => {
  const { id, op, name, code, options } = e.data || {};
  try {
    const r = globalThis.stanc(name || 'model', code, options || []);
    // A plain check doesn't need the generated C++ (≈100 KB).
    if (op === 'check' && r) delete r.result;
    self.postMessage({ id, ok: true, result: r });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
`;

let worker: Worker | null = null;
let starting: Promise<Worker> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getWorker(): Promise<Worker> {
  if (worker) return Promise.resolve(worker);
  starting ??= (async () => {
    const base = import.meta.env?.BASE_URL ?? '/';
    const res = await fetch(`${base}vendor/stanc/stanc.js`);
    if (!res.ok) throw new Error(`stanc.js not found (${res.status})`);
    const src = await res.text();
    const url = URL.createObjectURL(new Blob([PRELUDE, src, HANDLER], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = (e) => {
      const p = pending.get(e.data?.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    worker = w;
    return w;
  })();
  return starting;
}

function call(code: string, options: string[], op = 'check', name = 'model'): Promise<{ errors?: string[]; warnings?: string[]; result?: string }> {
  return getWorker().then(
    (w) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, op, name, code, options });
      }),
  );
}

/** Compile for diagnostics only. */
export async function check(code: string, opts: { pedantic?: boolean } = {}): Promise<StanDiagnostic[]> {
  const r = await call(code, opts.pedantic ? ['warn-pedantic'] : []);
  return placeUnlocated(code, [...parseMessages(r.errors ?? [], 'error'), ...parseMessages(r.warnings ?? [], 'warning')]);
}

/** Canonical formatting; throws with the compiler message when the code does not parse. */
export async function format(code: string): Promise<string> {
  const r = await call(code, ['auto-format'], 'format');
  if (r.errors?.length) throw new Error(parseMessages(r.errors, 'error')[0]?.message ?? 'syntax error');
  return r.result ?? code;
}

/** Variables of each block (for the data template and completion). */
export async function info(code: string): Promise<StanInfo | null> {
  const r = await call(code, ['info'], 'info');
  if (r.errors?.length || !r.result) return null;
  try {
    return JSON.parse(r.result) as StanInfo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message parsing

/**
 * stanc's `errors` is [0, "<report>"]; `warnings` a list of reports. Two formats:
 *   stanc 2.36:  Semantic error in 'string', line 3, column 8 to column 31:
 *                   ---------------------------
 *                     3:  model { … }
 *                               ^
 *                   ---------------------------
 *                Ill-typed arguments to '~' statement. …
 *   newer:       error: Ill-typed "~"-statement.
 *                    ┌─ string:3:37   … ^^^^^^^ explanation
 * Warnings may have no location ("Warning: The parameter sigma has no priors…").
 */
export function parseMessages(raw: unknown[], fallback: 'error' | 'warning'): StanDiagnostic[] {
  const out: StanDiagnostic[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || /^\s*\d+\s*$/.test(item)) continue;
    const d = /┌─/.test(item) ? parseCodespan(item, fallback) : parseClassic(item, fallback);
    if (d) out.push(d);
  }
  return out;
}

const CLASSIC = /^(Syntax error|Semantic error|Error|Warning|Info)(?:\s+in\s+'[^']*',\s+line (\d+),\s+column (\d+)(?:\s+to\s+(?:line (\d+),\s+)?column (\d+))?)?[^:\n]*:?/i;

function severityOf(word: string, fallback: 'error' | 'warning'): StanDiagnostic['severity'] {
  if (/error/i.test(word)) return 'error';
  if (/warning/i.test(word)) return 'warning';
  if (/info/i.test(word)) return 'info';
  return fallback;
}

function parseClassic(report: string, fallback: 'error' | 'warning'): StanDiagnostic | null {
  const text = report.replace(/\r\n?/g, '\n').trim();
  const m = CLASSIC.exec(text);
  const severity = m ? severityOf(m[1], fallback) : fallback;
  // The explanation follows the code excerpt (between dashed lines), or the header.
  let body = text.slice(m ? m[0].length : 0);
  const dashes = [...body.matchAll(/^\s*-{5,}\s*$/gm)];
  if (dashes.length >= 2) body = body.slice(dashes[1].index! + dashes[1][0].length);
  const message = body
    .replace(/\nstanc was given information about the following files:[\s\S]*$/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  if (!m || !m[2]) return { severity, message: message || text, line: 0, column: 0, endColumn: 0 };
  const line = Number(m[2]);
  const column = Number(m[3]) + 1; // stanc counts columns from 0
  const sameLine = !m[4] || Number(m[4]) === line;
  const endColumn = m[5] && sameLine ? Math.max(Number(m[5]) + 1, column + 1) : column + 1000;
  return { severity, message: message || text, line, column, endColumn };
}

function parseCodespan(report: string, fallback: 'error' | 'warning'): StanDiagnostic | null {
  const lines = report.split('\n');
  const head = lines[0];
  const severity = severityOf(head, fallback);
  const loc = /┌─\s*[^:\n]*:(\d+):(\d+)/.exec(report);
  const title = head.replace(/^(?:error|warning|info)\s*:?\s*/i, '').trim();
  let detail = '';
  let span = 1;
  const caretAt = lines.findIndex((l) => /│\s*\^+/.test(l));
  if (caretAt >= 0) {
    const c = /│(\s*)(\^+)\s*(.*)$/.exec(lines[caretAt])!;
    span = c[2].length;
    const rest = [c[3]];
    for (const l of lines.slice(caretAt + 1)) {
      const k = /^\s*│\s{2,}(.*)$/.exec(l);
      if (!k || /^\s*\d+\s*│/.test(l)) break;
      rest.push(k[1]);
    }
    detail = rest.join(' ').replace(/\s+/g, ' ').trim();
  }
  const message = [title, detail].filter(Boolean).join(' – ') || report.trim();
  if (!loc) return { severity, message, line: 0, column: 0, endColumn: 0 };
  const column = Number(loc[2]);
  return { severity, message, line: Number(loc[1]), column, endColumn: column + span };
}

/** Put location-less messages ("The parameter sigma has no priors") on the declaration. */
export function placeUnlocated(code: string, diags: StanDiagnostic[]): StanDiagnostic[] {
  const lines = code.split('\n');
  return diags.map((d) => {
    if (d.line) return d;
    const name = /\b(?:parameter|variable)\s+'?([A-Za-z_]\w*)'?/.exec(d.message)?.[1];
    if (!name) return d;
    const re = new RegExp(`\\b${name}\\s*(;|=)`);
    const i = lines.findIndex((l) => re.test(l.replace(/\/\/.*$/, '')));
    if (i < 0) return d;
    const col = lines[i].search(new RegExp(`\\b${name}\\b`)) + 1;
    return { ...d, line: i + 1, column: col, endColumn: col + name.length };
  });
}

/** Declared type text of each variable in the data block ("vector[N]", "int<lower=0>"). */
export function declaredTypes(code: string, block = 'data'): Record<string, string> {
  const clean = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(\/\/|#).*$/gm, '');
  const m = new RegExp(`(^|[^\\w])${block}\\s*\\{`).exec(clean);
  if (!m) return {};
  let i = m.index + m[0].length;
  let depth = 1;
  const startBody = i;
  for (; i < clean.length && depth; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') depth--;
  }
  const out: Record<string, string> = {};
  for (const stmt of clean.slice(startBody, i - 1).split(';')) {
    const d = /^\s*([\s\S]*?)\s+([A-Za-z_]\w*)\s*$/.exec(stmt.replace(/\s+/g, ' '));
    if (d && d[1]) out[d[2]] = d[1].trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// R data template from the model's data block

/** Empty R value from stanc's info (type is int or real; vectors/matrices count as dimensions). */
function rEmpty(type: string, dims: number): string {
  const int = /^int\b/.test(type);
  if (dims === 0) return int ? 'NA_integer_' : 'NA_real_';
  if (dims === 1) return int ? 'integer(0)' : 'numeric(0)';
  if (dims === 2) return int ? 'matrix(integer(0), 0, 0)' : 'matrix(numeric(0), 0, 0)';
  return `array(${int ? 'integer(0)' : 'numeric(0)'}, dim = rep(0, ${dims}))`;
}

/** `stan_data <- list(...)` skeleton listing every data variable with its declared type. */
export function rDataTemplate(info: StanInfo, code = '', varName = 'stan_data'): string {
  const entries = Object.entries(info.inputs ?? {});
  if (!entries.length) return `${varName} <- list()  # the model has no data`;
  const declared = declaredTypes(code);
  const width = Math.max(...entries.map(([n]) => n.length));
  const lines = entries.map(([name, v], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    const kind = declared[name] ?? (v.dimensions ? `${v.type}, ${v.dimensions}-D` : v.type);
    return `  ${name.padEnd(width)} = ${rEmpty(v.type, v.dimensions)}${comma}  # ${kind}`;
  });
  return `${varName} <- list(\n${lines.join('\n')}\n)`;
}
