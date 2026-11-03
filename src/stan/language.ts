/**
 * Stan in the editor: highlighting, completion (blocks, types, distributions
 * after "~", functions with signatures, the model's own variables), hover help,
 * formatting and live diagnostics from stanc3.
 */
import { create } from 'zustand';
import type * as M from '../panels/editor/monaco';
import { allFunctionNames, BLOCKS, DISTRIBUTIONS, distributionFunctions, FUNCTIONS, KEYWORDS, lookup, TYPES } from './catalog';
import { check, format, info, type StanDiagnostic, type StanInfo } from './stanc';

type Monaco = typeof M;

export interface StanStatus {
  checking: boolean;
  errors: number;
  warnings: number;
  /** stanc could not run at all (e.g. the compiler failed to load). */
  unavailable?: string;
}

/** Status per model URI (shown in the editor toolbar). */
export const useStan = create<{ status: Record<string, StanStatus>; pedantic: boolean }>(() => ({ status: {}, pedantic: false }));

const MARKER_OWNER = 'stanc';
const infos = new Map<string, StanInfo>();
let registered = false;

export const STAN_TEMPLATE = `data {
  int<lower=0> N;
  vector[N] y;
}
parameters {
  real mu;
  real<lower=0> sigma;
}
model {
  mu ~ normal(0, 10);
  sigma ~ exponential(1);
  y ~ normal(mu, sigma);
}
generated quantities {
  array[N] real y_rep = normal_rng(rep_vector(mu, N), sigma);
}
`;

function monarch(): M.languages.IMonarchLanguage {
  return {
    defaultToken: '',
    keywords: KEYWORDS,
    types: TYPES,
    blocks: ['functions', 'data', 'transformed', 'parameters', 'model', 'generated', 'quantities'],
    builtins: allFunctionNames(),
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/#include\b.*$/, 'keyword'],
        [/#.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?i?/, 'number'],
        [/[A-Za-z_]\w*/, { cases: { '@blocks': 'keyword', '@types': 'type', '@keywords': 'keyword', '@builtins': 'predefined', '@default': 'identifier' } }],
        [/~|<-|\+=|-=|\*=|\/=|\.\*|\.\/|[+\-*/%^'<>=!&|?:\\]/, 'operator'],
        [/[{}()[\]]/, '@brackets'],
        [/[;,]/, 'delimiter'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  } as M.languages.IMonarchLanguage;
}

export function registerStan(monaco: Monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: 'stan', extensions: ['.stan'], aliases: ['Stan', 'stan'] });
  monaco.languages.setLanguageConfiguration('stan', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: '/*', close: ' */', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
    indentationRules: { increaseIndentPattern: /\{[^}"']*$/, decreaseIndentPattern: /^\s*\}/ },
  });
  monaco.languages.setMonarchTokensProvider('stan', monarch());

  const K = monaco.languages.CompletionItemKind;
  const SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  monaco.languages.registerCompletionItemProvider('stan', {
    triggerCharacters: ['~'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const args = (ps: string[]) => ps.map((p, i) => `\${${i + 1}:${p}}`).join(', ');
      if (/~\s*$/.test(before)) {
        // After "~": only distributions, with their parameters as placeholders.
        return {
          suggestions: DISTRIBUTIONS.map((d) => ({
            label: { label: d.name, detail: `(${d.params.join(', ')})` },
            kind: K.Function,
            insertText: `${d.name}(${args(d.params)})`,
            insertTextRules: SNIPPET,
            documentation: d.doc,
            range,
          })),
        };
      }
      const vars = infos.get(model.uri.toString());
      const varItems = vars
        ? (['inputs', 'parameters', 'transformed parameters', 'generated quantities'] as const).flatMap((block) =>
            Object.entries(vars[block] ?? {}).map(([name, v]) => ({ label: { label: name, description: `${v.type}${v.dimensions ? `[${','.repeat(v.dimensions - 1)}]` : ''} · ${block === 'inputs' ? 'data' : block}` }, kind: K.Variable, insertText: name, range, sortText: `0${name}` })),
          )
        : [];
      const fnItem = (name: string, sig: string, doc: string) => {
        const params = sig.replace(/^\(|\)$/g, '').split(/,\s*|\s*\|\s*/).filter((p) => p && !p.includes(' or ') && p !== '...');
        return { label: { label: name, detail: sig }, kind: K.Function, insertText: `${name}(${args(params)})`, insertTextRules: SNIPPET, documentation: doc, range, sortText: `2${name}` };
      };
      return {
        suggestions: [
          ...varItems,
          ...BLOCKS.map((b) => ({ label: b, kind: K.Module, insertText: `${b} {\n\t$0\n}`, insertTextRules: SNIPPET, range, sortText: `3${b}` })),
          ...KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: `1${k}` })),
          ...TYPES.map((tp) => ({ label: tp, kind: K.TypeParameter, insertText: tp, range, sortText: `1${tp}` })),
          ...FUNCTIONS.map((fn) => fnItem(fn.name, fn.sig, fn.doc)),
          ...DISTRIBUTIONS.flatMap((d) => distributionFunctions(d).map((fn) => fnItem(fn.name, fn.sig, fn.doc))),
        ],
      };
    },
  });

  monaco.languages.registerHoverProvider('stan', {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const fn = lookup(w.word);
      const v = infos.get(model.uri.toString());
      const variable = v && (['inputs', 'parameters', 'transformed parameters', 'generated quantities'] as const).map((b) => [b, v[b]?.[w.word]] as const).find(([, x]) => x);
      const contents = fn
        ? [{ value: `\`\`\`stan\n${fn.name}${fn.sig}\n\`\`\`` }, { value: fn.doc }]
        : variable
          ? [{ value: `\`${w.word}\`: **${variable[1]!.type}**${variable[1]!.dimensions ? ` (${variable[1]!.dimensions}-D array)` : ''} — ${variable[0] === 'inputs' ? 'data' : variable[0]}` }]
          : null;
      return contents ? { range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn }, contents } : null;
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider('stan', {
    async provideDocumentFormattingEdits(model) {
      try {
        const text = await format(model.getValue());
        return [{ range: model.getFullModelRange(), text }];
      } catch {
        return [];
      }
    },
  });

  // Live diagnostics for every Stan model.
  const attach = (model: M.editor.ITextModel) => {
    if (model.getLanguageId() !== 'stan') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let run = 0;
    const lint = async () => {
      const mine = ++run;
      const key = model.uri.toString();
      useStan.setState((s) => ({ status: { ...s.status, [key]: { ...(s.status[key] ?? { errors: 0, warnings: 0 }), checking: true } } }));
      try {
        const code = model.getValue();
        const diags = await check(code, { pedantic: useStan.getState().pedantic });
        if (mine !== run || model.isDisposed()) return;
        const shown = includeAware(code, diags);
        monaco.editor.setModelMarkers(model, MARKER_OWNER, shown.map((d) => toMarker(monaco, model, d)));
        useStan.setState((s) => ({
          status: { ...s.status, [key]: { checking: false, errors: shown.filter((d) => d.severity === 'error').length, warnings: shown.filter((d) => d.severity === 'warning').length } },
        }));
        if (!shown.some((d) => d.severity === 'error')) {
          const i = await info(code).catch(() => null);
          if (i && mine === run) infos.set(key, i);
        }
      } catch (e) {
        useStan.setState((s) => ({ status: { ...s.status, [key]: { checking: false, errors: 0, warnings: 0, unavailable: String(e) } } }));
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void lint(), 350);
    };
    schedule();
    const sub = model.onDidChangeContent(schedule);
    const pedanticOff = useStan.subscribe((s, p) => s.pedantic !== p.pedantic && schedule());
    model.onWillDispose(() => {
      sub.dispose();
      pedanticOff();
      if (timer) clearTimeout(timer);
      infos.delete(model.uri.toString());
      useStan.setState((s) => {
        const { [model.uri.toString()]: _gone, ...rest } = s.status;
        return { status: rest };
      });
    });
  };
  monaco.editor.getModels().forEach(attach);
  monaco.editor.onDidCreateModel(attach);
  monaco.editor.onDidChangeModelLanguage(({ model }) => attach(model));
}

/** stanc.js has no file system: missing #include files are reported once, as info. */
export function includeAware(code: string, diags: StanDiagnostic[]): StanDiagnostic[] {
  if (!/^\s*#include\b/m.test(code)) return diags;
  const isInclude = (d: StanDiagnostic) => /include/i.test(d.message);
  const rest = diags.filter((d) => !isInclude(d));
  if (rest.length === diags.length) return diags;
  const line = code.split('\n').findIndex((l) => /^\s*#include\b/.test(l)) + 1;
  return [...rest, { severity: 'info', message: 'Included files are not checked live (the editor has no access to them); CmdStan checks them when compiling.', line, column: 1, endColumn: 2 }];
}

function toMarker(monaco: Monaco, model: M.editor.ITextModel, d: StanDiagnostic): M.editor.IMarkerData {
  const sev = d.severity === 'error' ? monaco.MarkerSeverity.Error : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info;
  const line = Math.min(Math.max(d.line || 1, 1), model.getLineCount());
  const maxCol = model.getLineMaxColumn(line);
  const start = d.line ? Math.min(Math.max(d.column, 1), maxCol) : 1;
  const end = d.line ? Math.min(Math.max(d.endColumn, start + 1), maxCol) : maxCol;
  return { severity: sev, message: d.message, startLineNumber: line, startColumn: start, endLineNumber: line, endColumn: end, source: 'stanc' };
}

export const stanInfoFor = (uri: string) => infos.get(uri);
export { info as stanInfo, format as stanFormat };
