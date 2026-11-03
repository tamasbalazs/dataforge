/**
 * LSP ↔ Monaco conversions. Monaco is 1-based, LSP 0-based; Monaco API
 * objects are passed in so this module stays testable without Monaco.
 */

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export const toLspPosition = (p: { lineNumber: number; column: number }): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });

export const toMonacoRange = (r: LspRange): MonacoRangeLike => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

export const toLspRange = (r: MonacoRangeLike): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

/** LSP CompletionItemKind (1-based) → Monaco CompletionItemKind. */
export function completionKind(kind: number | undefined, K: Record<string, number>): number {
  const map: Record<number, string> = {
    1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field', 6: 'Variable', 7: 'Class', 8: 'Interface',
    9: 'Module', 10: 'Property', 11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet', 16: 'Color',
    17: 'File', 18: 'Reference', 19: 'Folder', 20: 'EnumMember', 21: 'Constant', 22: 'Struct', 23: 'Event',
    24: 'Operator', 25: 'TypeParameter',
  };
  return K[map[kind ?? 1] ?? 'Text'] ?? K.Text;
}

/** LSP SymbolKind → Monaco SymbolKind (Monaco is 0-based, same order). */
export const symbolKind = (kind: number) => Math.max(0, kind - 1);

/** DiagnosticSeverity → Monaco MarkerSeverity (Error 8, Warning 4, Info 2, Hint 1). */
export function markerSeverity(sev: number | undefined): number {
  return sev === 1 ? 8 : sev === 2 ? 4 : sev === 3 ? 2 : sev === 4 ? 1 : 8;
}

/** MarkupContent | MarkedString | MarkedString[] → markdown strings. */
export function toMarkdown(contents: any): string[] {
  if (contents == null) return [];
  if (Array.isArray(contents)) return contents.flatMap(toMarkdown);
  if (typeof contents === 'string') return contents ? [contents] : [];
  if ('kind' in contents) {
    if (!contents.value) return [];
    return [contents.kind === 'markdown' ? contents.value : '```\n' + contents.value + '\n```'];
  }
  if ('language' in contents) return ['```' + contents.language + '\n' + contents.value + '\n```'];
  return [];
}

export interface TextEditLike {
  range: LspRange;
  newText: string;
}

/** Text edits for one document from a WorkspaceEdit. */
export function editsForUri(edit: any, uri: string): TextEditLike[] {
  if (!edit) return [];
  const same = (u: string) => u.toLowerCase() === uri.toLowerCase();
  const out: TextEditLike[] = [];
  for (const [u, edits] of Object.entries<TextEditLike[]>(edit.changes ?? {})) if (same(u)) out.push(...edits);
  for (const dc of edit.documentChanges ?? []) if (dc.textDocument && same(dc.textDocument.uri)) out.push(...dc.edits);
  return out;
}

/** file URI for a local path (POSIX and Windows). */
export function pathToUri(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(p)) p = '/' + p;
  return 'file://' + p.split('/').map(encodeURIComponent).join('/').replace(/^\/([a-zA-Z])%3A/, '/$1:');
}

/** Names DataForge injects into the kernels (`r`/`py` bridges, `View`); static checkers can't know them. */
const KERNEL_GLOBALS = ['r', 'py', 'View'];
const UNDEFINED_NAME = [/^"([\w.]+)" is not defined/, /^Undefined name `([\w.]+)`/, /no visible (?:binding for global variable|global function definition for) ['‘]([\w.]+)['’]/];

export function isKernelGlobalDiagnostic(message: string): boolean {
  for (const re of UNDEFINED_NAME) {
    const m = re.exec(message);
    if (m) return KERNEL_GLOBALS.includes(m[1]);
  }
  return false;
}
