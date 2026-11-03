/**
 * Editor operations: documents ↔ Monaco models, file IO, and sending code to
 * the console (Ctrl+Enter / Ctrl+Shift+Enter).
 */
import { ask } from '../../core/dialog';
import { host } from '../../core/host';
import { t } from '../../core/i18n';
import { toast } from '../../core/toast';
import { execute, LANG_LABEL } from '../../kernels/kernels';
import { activeDoc, addFileDoc, basename, closeDocState, type Doc, kernelLangFor, languageForPath, newUntitled, patchDoc, useEditor } from './editorStore';
import type { Monaco } from './monacoSetup';
import { pathToUri } from '../../lsp/convert';
import { lspAttach, lspDetach } from '../../lsp/client';
import { nextStatementLine, statementAt } from './statement';
import { chunkAt, chunkCode, findChunks, isLiterate, stanChunkR, type Chunk } from './chunks';
import { findConflicts, resolvedLines, type Resolution } from '../../git/gitParse';
import { debugLangFor, setBreakpoints, setRevealHook, toggleBreakpoint, useBreakpoints, useDebug } from '../../debug/debugStore';
import { revealPanel } from '../../workbench/layout';
import { emit, on } from '../../core/bus';
import type { Lang } from '../../core/host';
import type * as M from './monaco';

let monacoRef: Monaco | null = null;
// Monaco is loaded on demand so it stays out of the startup bundle.
const loadMonaco = () => import('./monacoSetup').then((m) => m.loadMonaco());
let editorRef: M.editor.IStandaloneCodeEditor | null = null;
const models = new Map<string, M.editor.ITextModel>();
const savedVersion = new Map<string, number>();
const viewStates = new Map<string, M.editor.ICodeEditorViewState | null>();
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const FILE_FILTERS = [
  { name: 'R / Python / Stan', extensions: ['R', 'r', 'py', 'stan'] },
  { name: 'Markdown / Quarto', extensions: ['md', 'qmd', 'Rmd'] },
  { name: 'All files', extensions: ['*'] },
];

export function attachEditor(editor: M.editor.IStandaloneCodeEditor | null, m: Monaco | null) {
  editorRef = editor;
  monacoRef = m;
}

export const currentEditor = () => editorRef;

// --- Hooks for shared sessions ------------------------------------------------
type ModelHook = (doc: Doc, model: M.editor.ITextModel) => void;
const createdHooks = new Set<ModelHook>();
const disposedHooks = new Set<ModelHook>();
/** Called for every document model (also for the ones that already exist). */
export function onModelCreated(h: ModelHook): () => void {
  createdHooks.add(h);
  for (const d of useEditor.getState().docs) {
    const m = models.get(d.id);
    if (m && !m.isDisposed()) h(d, m);
  }
  return () => createdHooks.delete(h);
}
export function onModelDisposed(h: ModelHook): () => void {
  disposedHooks.add(h);
  return () => disposedHooks.delete(h);
}
export function modelForPath(path: string): M.editor.ITextModel | null {
  const d = useEditor.getState().docs.find((x) => x.path === path);
  const m = d ? models.get(d.id) : undefined;
  return m && !m.isDisposed() ? m : null;
}
/** The document at `path` was written by someone else (a shared session's host). */
export function markSaved(path: string) {
  const d = useEditor.getState().docs.find((x) => x.path === path);
  const m = d ? models.get(d.id) : undefined;
  if (!d || !m) return;
  savedVersion.set(d.id, m.getAlternativeVersionId());
  if (d.dirty) patchDoc(d.id, { dirty: false });
}
/** Save the open document at `path`, if any (true when it was open and saved). */
export async function saveByPath(path: string): Promise<boolean | null> {
  const d = useEditor.getState().docs.find((x) => x.path === path);
  return d ? saveDoc(d.id) : null;
}

/** Get or create the Monaco model for a document. */
export async function ensureModel(doc: Doc): Promise<M.editor.ITextModel> {
  const existing = models.get(doc.id);
  if (existing && !existing.isDisposed()) return existing;
  const m = monacoRef ?? (await loadMonaco());
  let text = doc.draft ?? '';
  if (doc.path) {
    try {
      text = await host().readText(doc.path);
    } catch (e) {
      toast({ kind: 'error', title: t('editor.openFailed', { name: doc.name }), detail: String(e) });
    }
  }
  const uri = m.Uri.parse(`inmemory://dataforge/${doc.id}/${encodeURIComponent(doc.name)}`);
  const model = m.editor.getModel(uri) ?? m.editor.createModel(text, doc.language, uri);
  model.updateOptions({ tabSize: doc.language === 'python' ? 4 : 2, insertSpaces: true });
  models.set(doc.id, model);
  attachLsp(doc, model);
  savedVersion.set(doc.id, doc.path ? model.getAlternativeVersionId() : -1);
  model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== savedVersion.get(doc.id);
    const cur = useEditor.getState().docs.find((d) => d.id === doc.id);
    if (cur && cur.dirty !== dirty) patchDoc(doc.id, { dirty });
    if (!cur?.path) {
      clearTimeout(draftTimers.get(doc.id));
      draftTimers.set(doc.id, setTimeout(() => patchDoc(doc.id, { draft: model.getValue() }), 400));
    }
  });
  for (const h of createdHooks) h(doc, model);
  return model;
}

/** URI the language server knows a document by. */
export const lspUriFor = (doc: Pick<Doc, 'path' | 'name'>) => (doc.path ? pathToUri(doc.path) : `untitled:${doc.name}`);

function attachLsp(doc: Pick<Doc, 'path' | 'name' | 'language'>, model: M.editor.ITextModel) {
  const lang = kernelLangFor(doc.language);
  if (lang) lspAttach(lang, model, lspUriFor(doc));
}

/** Show a document in the editor, preserving each document's scroll/cursor. */
export async function showDoc(doc: Doc) {
  const ed = editorRef;
  if (!ed) return;
  const prevModel = ed.getModel();
  if (prevModel) {
    const prevId = [...models.entries()].find(([, m]) => m === prevModel)?.[0];
    if (prevId) viewStates.set(prevId, ed.saveViewState());
  }
  const model = await ensureModel(doc);
  // Closing several documents in a row can dispose this one meanwhile.
  if (editorRef !== ed || model.isDisposed()) return;
  ed.setModel(model);
  const vs = viewStates.get(doc.id);
  if (vs) ed.restoreViewState(vs);
  ed.focus();
}

export function newFile(lang: 'r' | 'python' | 'stan', content = '') {
  newUntitled(lang, content);
}

export async function openFile(path?: string) {
  const p = path ?? (await host().openFileDialog(FILE_FILTERS));
  if (!p) return;
  addFileDoc(p);
}

export async function saveDoc(id = useEditor.getState().activeId, saveAs = false): Promise<boolean> {
  const doc = useEditor.getState().docs.find((d) => d.id === id);
  if (!doc) return false;
  const model = await ensureModel(doc);
  let path = doc.path;
  if (!path || saveAs) {
    path = await host().saveFileDialog(doc.path ?? doc.name, FILE_FILTERS);
    if (!path) return false;
  }
  try {
    await host().writeText(path, model.getValue());
  } catch (e) {
    toast({ kind: 'error', title: t('editor.saveFailed', { name: basename(path) }), detail: String(e) });
    return false;
  }
  savedVersion.set(doc.id, model.getAlternativeVersionId());
  const language = doc.path === path ? doc.language : languageForPath(path);
  if (language !== doc.language && monacoRef) monacoRef.editor.setModelLanguage(model, language);
  if (path !== doc.path) {
    const oldLang = kernelLangFor(doc.language);
    if (oldLang) lspDetach(oldLang, model);
    attachLsp({ path, name: basename(path), language }, model);
  }
  patchDoc(doc.id, { path, name: basename(path), dirty: false, draft: undefined, language });
  toast({ kind: 'success', title: t('editor.saved', { name: basename(path) }) });
  emit('editor:saved', { path });
  return true;
}

export async function closeDoc(id = useEditor.getState().activeId) {
  const doc = useEditor.getState().docs.find((d) => d.id === id);
  if (!doc) return;
  if (doc.dirty) {
    const choice = await ask(t('editor.unsavedTitle', { name: doc.name }), t('editor.unsavedBody'), [
      { id: 'save', label: t('common.save'), variant: 'primary' },
      { id: 'discard', label: t('editor.discard'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (choice === 'save') {
      if (!(await saveDoc(doc.id))) return;
    } else if (choice !== 'discard') return;
  }
  const model = models.get(doc.id);
  if (model && editorRef?.getModel() === model) editorRef.setModel(null);
  if (model) for (const h of disposedHooks) h(doc, model);
  model?.dispose();
  models.delete(doc.id);
  viewStates.delete(doc.id);
  closeDocState(doc.id);
}

// ---------------------------------------------------------------------------
// Running code

function flash(range: { startLine: number; endLine: number }) {
  const ed = editorRef;
  const m = monacoRef;
  if (!ed || !m) return;
  const ids = ed.createDecorationsCollection([
    {
      range: new m.Range(range.startLine, 1, range.endLine, 1),
      options: { isWholeLine: true, className: 'df-run-flash', linesDecorationsClassName: 'df-run-flash-gutter' },
    },
  ]);
  setTimeout(() => ids.clear(), 650);
}

function langOrWarn(doc: Doc | null) {
  const lang = doc ? kernelLangFor(doc.language) : null;
  if (!lang) toast({ kind: 'info', title: t('editor.notRunnable') });
  return lang;
}

const literate = (doc: Doc | null) => !!doc && isLiterate(doc.path ?? doc.name);

/** Run code and resolve when the kernel has finished it (true = no error). */
export function executeAndWait(lang: Lang, code: string): Promise<boolean> {
  return new Promise((resolve) => {
    let id: string | null = null;
    const early = new Map<string, boolean>();
    const off = on('kernel:execution-done', (e) => {
      if (id === null) early.set(e.msgId, e.status === 'ok');
      else if (e.msgId === id) {
        off();
        resolve(e.status === 'ok');
      }
    });
    void execute(lang, code).then((msgId) => {
      id = msgId;
      if (!msgId) {
        off();
        resolve(false);
      } else if (early.has(msgId)) {
        off();
        resolve(early.get(msgId)!);
      }
    });
  });
}

function runChunk(lines: string[], c: Chunk) {
  flash({ startLine: c.header + 1, endLine: c.end + 2 });
  const code = c.stan ? stanChunkR(chunkCode(lines, c), c.stan.outputVar, lines) : chunkCode(lines, c);
  return code.trim() ? executeAndWait(c.lang, code) : Promise.resolve(true);
}

/** Run the chunk whose header is at a 1-based line (CodeLens). */
export async function runChunkAt(lineNumber: number) {
  const model = editorRef?.getModel();
  if (!model) return;
  const lines = model.getLinesContent();
  const c = chunkAt(findChunks(lines), lineNumber - 1);
  if (c) await runChunk(lines, c);
}

/** Run every chunk from the top (or up to the cursor), one after another across languages. */
export async function runAllChunks(opts: { above?: boolean } = {}) {
  const ed = editorRef;
  const model = ed?.getModel();
  if (!ed || !model || !literate(activeDoc())) return;
  const lines = model.getLinesContent();
  const cursor = (ed.getPosition()?.lineNumber ?? 1) - 1;
  for (const c of findChunks(lines)) {
    if (opts.above && c.header >= cursor) break;
    if (!(await runChunk(lines, c))) break; // stop at the first error, like knitr
  }
}

/** Ctrl+Enter / Ctrl+Shift+Enter inside a .qmd/.Rmd: statement or whole chunk, in the chunk's language. */
async function runInChunk(whole: boolean) {
  const ed = editorRef;
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  if (!ed || !model || !sel) return;
  const lines = model.getLinesContent();
  const chunks = findChunks(lines);
  const c = chunkAt(chunks, sel.positionLineNumber - 1);
  if (!c) {
    toast({ kind: 'info', title: t('editor.noChunk') });
    return;
  }
  if (whole) {
    await runChunk(lines, c);
    return;
  }
  if (!sel.isEmpty()) {
    flash({ startLine: sel.startLineNumber, endLine: sel.endLineNumber });
    await execute(c.lang, model.getValueInRange(sel));
    return;
  }
  const inner = lines.slice(c.start, c.end + 1);
  if (!inner.length) return;
  const local = Math.min(Math.max(sel.positionLineNumber - 1 - c.start, 0), inner.length - 1);
  const range = statementAt(inner, local, c.lang);
  if (!range) return;
  flash({ startLine: c.start + range.start + 1, endLine: c.start + range.end + 1 });
  const code = inner.slice(range.start, range.end + 1).join('\n');
  // Past the chunk's last statement the cursor jumps into the next chunk.
  const isLast = !inner.slice(range.end + 1).some((l) => l.trim() && !/^\s*#/.test(l));
  const nextChunk = chunks.find((k) => k.header > c.header);
  const next = isLast ? (nextChunk ? nextChunk.start + 1 : c.end + 3) : c.start + nextStatementLine(inner, range, c.lang) + 1;
  const target = Math.min(next, model.getLineCount());
  ed.setPosition({ lineNumber: target, column: 1 });
  ed.revealLineInCenterIfOutsideViewport(target);
  if (code.trim()) await execute(c.lang, code);
}

/** Ctrl+Enter: run the selection, or the statement under the cursor. */
export async function runSelectionOrStatement() {
  const ed = editorRef;
  const doc = activeDoc();
  if (literate(doc)) return runInChunk(false);
  const lang = langOrWarn(doc);
  if (!ed || !lang) return;
  const model = ed.getModel();
  const sel = ed.getSelection();
  if (!model || !sel) return;
  let code: string;
  if (!sel.isEmpty()) {
    code = model.getValueInRange(sel);
    flash({ startLine: sel.startLineNumber, endLine: sel.endLineNumber });
  } else {
    const lines = model.getLinesContent();
    const range = statementAt(lines, sel.positionLineNumber - 1, lang);
    if (!range) return;
    code = lines.slice(range.start, range.end + 1).join('\n');
    flash({ startLine: range.start + 1, endLine: range.end + 1 });
    const next = nextStatementLine(lines, range, lang) + 1;
    ed.setPosition({ lineNumber: next, column: 1 });
    ed.revealLineInCenterIfOutsideViewport(next);
  }
  if (code.trim()) await execute(lang, code);
}

/** Ctrl+Shift+Enter: run the whole document. */
export async function runDocument() {
  const doc = activeDoc();
  if (literate(doc)) return runInChunk(true);
  const lang = langOrWarn(doc);
  if (!doc || !lang) return;
  const model = await ensureModel(doc);
  const code = model.getValue();
  if (!code.trim()) return;
  flash({ startLine: 1, endLine: model.getLineCount() });
  await execute(lang, code);
}

export function describeRunTarget(doc: Doc | null): string | null {
  const lang = doc ? kernelLangFor(doc.language) : null;
  return lang ? LANG_LABEL[lang] : null;
}

/** For "Insert example" in onboarding and empty states. */
export const EXAMPLES: Record<'r' | 'python', string> = {
  r: `# DataForge – R example
# Ctrl+Enter runs the current statement, Ctrl+Shift+Enter the whole file.

data <- data.frame(
  x = 1:100,
  y = cumsum(rnorm(100))
)

summary(data$y)

plot(data$x, data$y, type = "l", lwd = 2,
     main = "Random walk", xlab = "step", ylab = "value")

if (requireNamespace("ggplot2", quietly = TRUE)) {
  library(ggplot2)
  print(ggplot(mtcars, aes(wt, mpg, colour = factor(cyl))) +
    geom_point(size = 3) +
    labs(title = "Fuel economy", colour = "Cylinders"))
}
`,
  python: `# DataForge – Python example
# Ctrl+Enter runs the current statement, Ctrl+Shift+Enter the whole file.
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 400)
waves = {"sin": np.sin(x), "cos": np.cos(x)}

fig, ax = plt.subplots()
for name, y in waves.items():
    ax.plot(x, y, label=name, linewidth=2)
ax.set_title("Waves")
ax.legend()
plt.show()

print(f"mean of sin: {waves['sin'].mean():.4f}")
`,
};

let lensInstalled = false;

/** "▶ Run chunk" above every R/Python chunk in Markdown-based documents. */
export function installChunkLens(m: Monaco) {
  if (lensInstalled) return;
  lensInstalled = true;
  m.editor.registerCommand('dataforge.runChunk', (_accessor: unknown, line: number) => void runChunkAt(line));
  m.editor.registerCommand('dataforge.runAbove', (_accessor: unknown, line: number) => {
    editorRef?.setPosition({ lineNumber: line, column: 1 });
    void runAllChunks({ above: true });
  });
  m.languages.registerCodeLensProvider('markdown', {
    provideCodeLenses(model) {
      const chunks = findChunks(model.getLinesContent());
      return {
        lenses: chunks.flatMap((c, i) => {
          const range = { startLineNumber: c.header + 1, startColumn: 1, endLineNumber: c.header + 1, endColumn: 1 };
          const lenses = [{ range, command: { id: 'dataforge.runChunk', title: c.stan ? `▶ ${t('stan.compileChunk')}` : `▶ ${t('editor.runChunk', { lang: LANG_LABEL[c.lang] })}`, arguments: [c.header + 1] } }];
          if (i > 0) lenses.push({ range, command: { id: 'dataforge.runAbove', title: t('editor.runAbove'), arguments: [c.header + 1] } });
          return lenses;
        }),
        dispose() {},
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Merge conflicts: highlighted blocks + "Accept current | incoming | both"

let conflictInstalled = false;

function applyResolution(model: M.editor.ITextModel, line: number, how: Resolution) {
  const lines = model.getLinesContent();
  const c = findConflicts(lines).find((x) => x.start === line - 1);
  if (!c) return;
  const kept = resolvedLines(lines, c, how);
  const eol = model.getEOL();
  const last = model.getLineCount();
  const range = kept.length
    ? { startLineNumber: c.start + 1, startColumn: 1, endLineNumber: c.end + 1, endColumn: model.getLineMaxColumn(c.end + 1) }
    : c.end + 2 <= last
      ? { startLineNumber: c.start + 1, startColumn: 1, endLineNumber: c.end + 2, endColumn: 1 }
      : { startLineNumber: Math.max(1, c.start), startColumn: c.start > 0 ? model.getLineMaxColumn(c.start) : 1, endLineNumber: c.end + 1, endColumn: model.getLineMaxColumn(c.end + 1) };
  model.pushEditOperations([], [{ range, text: kept.join(eol) }], () => null);
  if (!findConflicts(model.getLinesContent()).length) offerMarkResolved();
}

function offerMarkResolved() {
  const doc = activeDoc();
  if (!doc?.path) return;
  toast({
    kind: 'success',
    title: t('git.allResolved', { name: doc.name }),
    action: {
      label: t('git.saveAndMarkResolved'),
      run: async () => {
        if (!(await saveDoc(doc.id))) return;
        const { repoRelative, stage } = await import('../../git/gitStore');
        const rel = repoRelative(doc.path!);
        if (rel) await stage([rel]);
      },
    },
  });
}

export function installConflictSupport(m: Monaco, editor: M.editor.IStandaloneCodeEditor) {
  if (!conflictInstalled) {
    conflictInstalled = true;
    m.editor.registerCommand('dataforge.resolveConflict', (_a: unknown, line: number, how: Resolution) => {
      const model = editorRef?.getModel();
      if (model) applyResolution(model, line, how);
    });
    m.languages.registerCodeLensProvider('*', {
      provideCodeLenses(model) {
        const lenses = findConflicts(model.getLinesContent()).flatMap((c) => {
          const range = { startLineNumber: c.start + 1, startColumn: 1, endLineNumber: c.start + 1, endColumn: 1 };
          return (['current', 'incoming', 'both'] as const).map((how) => ({
            range,
            command: { id: 'dataforge.resolveConflict', title: t(`git.accept.${how}`), arguments: [c.start + 1, how] },
          }));
        });
        return { lenses, dispose() {} };
      },
    });
  }
  const deco = editor.createDecorationsCollection();
  const update = () => {
    const model = editor.getModel();
    if (!model) return deco.clear();
    const text = model.getValue();
    if (!text.includes('<<<<<<<')) return deco.clear();
    const whole = (a: number, b: number, cls: string) =>
      b >= a ? [{ range: new m.Range(a + 1, 1, b + 1, 1), options: { isWholeLine: true, className: cls, overviewRuler: { color: cls.includes('incoming') ? '#6EA8FE' : '#5BD38C', position: m.editor.OverviewRulerLane.Full } } }] : [];
    deco.set(
      findConflicts(model.getLinesContent()).flatMap((c) => [
        ...whole(c.start, c.start, 'df-conflict-marker df-conflict-marker--current'),
        ...whole(c.start + 1, (c.base ?? c.sep) - 1, 'df-conflict-current'),
        ...(c.base != null ? whole(c.base, c.sep - 1, 'df-conflict-base') : []),
        ...whole(c.sep, c.sep, 'df-conflict-marker'),
        ...whole(c.sep + 1, c.end - 1, 'df-conflict-incoming'),
        ...whole(c.end, c.end, 'df-conflict-marker df-conflict-marker--incoming'),
      ]),
    );
  };
  editor.onDidChangeModel(update);
  editor.onDidChangeModelContent(update);
  update();
}

// ---------------------------------------------------------------------------
// Debugger: breakpoints in the glyph margin, the paused line, reveal on stop.

let pendingReveal: { path: string; line: number } | null = null;

function revealPending(editor: M.editor.IStandaloneCodeEditor) {
  const doc = activeDoc();
  if (!pendingReveal || !doc?.path || doc.path !== pendingReveal.path) return;
  const { line } = pendingReveal;
  pendingReveal = null;
  editor.revealLineInCenterIfOutsideViewport(line);
  editor.setPosition({ lineNumber: line, column: 1 });
}

/** Toggle a breakpoint at the cursor line of the active document (F9). */
export async function toggleBreakpointAtCursor() {
  const doc = activeDoc();
  const line = editorRef?.getPosition()?.lineNumber;
  if (!doc || !line) return;
  if (!doc.path || !debugLangFor(doc.path)) {
    toast({ kind: 'info', title: t(doc.path ? 'debug.notDebuggable' : 'debug.saveFirst') });
    return;
  }
  toggleBreakpoint(doc.path, line);
}

export function installDebugSupport(m: Monaco, editor: M.editor.IStandaloneCodeEditor) {
  setRevealHook((path, line) => {
    pendingReveal = { path, line };
    addFileDoc(path);
    revealPanel('editor', { focus: false });
    revealPending(editor);
  });
  const bpDeco = editor.createDecorationsCollection();
  const lineDeco = editor.createDecorationsCollection();
  const hint = editor.createDecorationsCollection();
  let syncing = false;
  const render = () => {
    const doc = activeDoc();
    const path = doc?.path ?? null;
    const lines = path ? (useBreakpoints.getState().byPath[path] ?? []) : [];
    const d = useDebug.getState();
    const frame = d.frames.find((f) => f.id === d.frameId);
    const here = d.state === 'paused' && frame?.path === path ? frame!.line : null;
    syncing = true;
    bpDeco.set(
      lines.map((l) => ({
        range: new m.Range(l, 1, l, 1),
        options: {
          glyphMarginClassName: 'df-bp',
          glyphMarginHoverMessage: { value: t('debug.breakpointHover', { line: l }) },
          stickiness: m.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          overviewRuler: { color: '#E5534B', position: m.editor.OverviewRulerLane.Left },
        },
      })),
    );
    lineDeco.set(
      here
        ? [{ range: new m.Range(here, 1, here, 1), options: { isWholeLine: true, className: 'df-debug-line', glyphMarginClassName: lines.includes(here) ? 'df-bp df-debug-arrow' : 'df-debug-arrow' } }]
        : [],
    );
    syncing = false;
  };
  const offs = [
    useBreakpoints.subscribe(render),
    useDebug.subscribe(render),
    useEditor.subscribe((s, p) => s.activeId !== p.activeId && render()),
  ];
  editor.onDidChangeModel(() => {
    render();
    revealPending(editor);
  });
  // Breakpoints move with the text they are on.
  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  editor.onDidChangeModelContent(() => {
    if (syncing) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const path = activeDoc()?.path;
      const model = editor.getModel();
      if (!path || !model) return;
      const now = bpDeco.getRanges().map((r) => r.startLineNumber);
      const before = useBreakpoints.getState().byPath[path] ?? [];
      if (now.length && now.join() !== [...new Set(now)].sort((a, b) => a - b).join()) return;
      if (now.join() !== before.join()) setBreakpoints(path, now);
    }, 300);
  });
  editor.onMouseDown((e) => {
    if (e.target.type !== m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position) return;
    const doc = activeDoc();
    if (!doc?.path || !debugLangFor(doc.path)) {
      toast({ kind: 'info', title: t(doc?.path ? 'debug.notDebuggable' : 'debug.saveFirst') });
      return;
    }
    toggleBreakpoint(doc.path, e.target.position.lineNumber);
  });
  editor.onMouseMove((e) => {
    const l = e.target.type === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ? e.target.position?.lineNumber : null;
    const path = activeDoc()?.path;
    if (l && path && debugLangFor(path) && !(useBreakpoints.getState().byPath[path] ?? []).includes(l)) {
      hint.set([{ range: new m.Range(l, 1, l, 1), options: { glyphMarginClassName: 'df-bp-hint' } }]);
    } else hint.clear();
  });
  editor.onMouseLeave(() => hint.clear());
  render();
  return () => offs.forEach((o) => o());
}

/** Open a file and put the cursor on a line (e.g. from a report). */
export function openAt(path: string, line: number) {
  pendingReveal = { path, line: Math.max(1, line) };
  addFileDoc(path);
  revealPanel('editor');
  if (editorRef) revealPending(editorRef);
}

/** Selection, word under the cursor and language of the active editor (extension API). */
export function selectionInfo(): { text: string; word: string; language: string; path: string | null } {
  const ed = editorRef;
  const model = ed?.getModel();
  const doc = activeDoc();
  if (!ed || !model) return { text: '', word: '', language: '', path: doc?.path ?? null };
  const sel = ed.getSelection();
  const pos = ed.getPosition();
  return {
    text: sel && !sel.isEmpty() ? model.getValueInRange(sel) : '',
    word: pos ? (model.getWordAtPosition(pos)?.word ?? '') : '',
    language: model.getLanguageId(),
    path: doc?.path ?? null,
  };
}

export const activeText = () => editorRef?.getModel()?.getValue() ?? '';

/**
 * Insert text as one undoable edit: at the cursor (replacing the selection), or
 * on a new line below the current line, leaving the user's code untouched.
 */
export function insertAtCursor(text: string, position: 'cursor' | 'newLine' = 'cursor') {
  const ed = editorRef;
  const sel = ed?.getSelection();
  const model = ed?.getModel();
  if (!ed || !sel || !model) return false;
  if (position === 'newLine') {
    const line = sel.endLineNumber;
    const col = model.getLineMaxColumn(line);
    const body = text.replace(/\n$/, '');
    ed.executeEdits('extension', [{ range: { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col }, text: `\n${body}`, forceMoveMarkers: true }]);
    const last = line + body.split('\n').length;
    ed.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
  } else {
    ed.executeEdits('extension', [{ range: sel, text, forceMoveMarkers: true }]);
  }
  ed.focus();
  return true;
}
