/**
 * Lazy Monaco bootstrap: workers, themes generated from design tokens, and
 * kernel-backed completion for R and Python.
 */
// The worker entry must be editor.worker.js: editor.worker.start.js only defines start().
import EditorWorker from 'monaco-esm/editor/editor.worker.js?worker';
import { host } from '../../core/host';
import { palettes, type Palette, type ThemeMode } from '../../design/tokens';
import { useThemeMode } from '../../core/theme';
import { installSnippetProvider } from '../../extensions/snippets';
import { isRunning, useKernels } from '../../kernels/kernels';
import { initLsp, lspReady } from '../../lsp/client';
import { kernelLangFor } from './editorStore';
import * as monaco from './monaco';
import { registerStan } from '../../stan/language';

export type Monaco = typeof monaco;

(self as any).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

/** Hex colour with alpha, as Monaco requires #RRGGBBAA. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 7)}${a}`;
}

const strip = (hex: string) => hex.replace('#', '');

export function monacoThemeData(mode: ThemeMode, overrides: Partial<Palette> = {}): monaco.editor.IStandaloneThemeData {
  const p = { ...palettes[mode], ...overrides };
  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: strip(p.textPrimary) },
      { token: 'comment', foreground: strip(p.synComment), fontStyle: 'italic' },
      { token: 'keyword', foreground: strip(p.synKeyword) },
      { token: 'string', foreground: strip(p.synString) },
      { token: 'string.escape', foreground: strip(p.synConstant) },
      { token: 'number', foreground: strip(p.synNumber) },
      { token: 'constant', foreground: strip(p.synConstant) },
      { token: 'type', foreground: strip(p.synType) },
      { token: 'predefined', foreground: strip(p.synFunction) },
      { token: 'tag', foreground: strip(p.synFunction) },
      { token: 'operator', foreground: strip(p.synOperator) },
      { token: 'delimiter', foreground: strip(p.synOperator) },
      { token: 'delimiter.bracket', foreground: strip(p.textSecondary) },
      { token: 'identifier', foreground: strip(p.textPrimary) },
      { token: 'variable', foreground: strip(p.textPrimary) },
    ],
    colors: {
      'editor.background': p.surface1,
      'diffEditor.insertedLineBackground': withAlpha(p.success, mode === 'dark' ? 0.12 : 0.1),
      'diffEditor.insertedTextBackground': withAlpha(p.success, mode === 'dark' ? 0.28 : 0.22),
      'diffEditor.removedLineBackground': withAlpha(p.danger, mode === 'dark' ? 0.12 : 0.08),
      'diffEditor.removedTextBackground': withAlpha(p.danger, mode === 'dark' ? 0.3 : 0.2),
      'diffEditorGutter.insertedLineBackground': withAlpha(p.success, 0.2),
      'diffEditorGutter.removedLineBackground': withAlpha(p.danger, 0.2),
      'diffEditor.diagonalFill': withAlpha(p.borderSubtle, 0.6),
      'editor.foreground': p.textPrimary,
      'editorLineNumber.foreground': p.textDisabled,
      'editorLineNumber.activeForeground': p.textSecondary,
      'editor.lineHighlightBackground': withAlpha(p.surface3, mode === 'dark' ? 0.55 : 0.6),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': withAlpha(p.accent, 0.28),
      'editor.inactiveSelectionBackground': withAlpha(p.accent, 0.14),
      'editor.selectionHighlightBackground': withAlpha(p.accent, 0.12),
      'editor.wordHighlightBackground': withAlpha(p.accent, 0.1),
      'editor.findMatchBackground': withAlpha(p.warning, 0.4),
      'editor.findMatchHighlightBackground': withAlpha(p.warning, 0.2),
      'editorCursor.foreground': p.accent,
      'editorWhitespace.foreground': p.borderStrong,
      'editorIndentGuide.background1': p.borderSubtle,
      'editorIndentGuide.activeBackground1': p.borderStrong,
      'editorBracketMatch.background': withAlpha(p.accent, 0.12),
      'editorBracketMatch.border': withAlpha(p.accent, 0.5),
      'editorGutter.background': p.surface1,
      'editorWidget.background': p.surface2,
      'editorWidget.border': p.border,
      'editorHoverWidget.background': p.surface2,
      'editorHoverWidget.border': p.border,
      'editorSuggestWidget.background': p.surface2,
      'editorSuggestWidget.border': p.border,
      'editorSuggestWidget.selectedBackground': p.surface4,
      'editorSuggestWidget.highlightForeground': p.accentText,
      'editorSuggestWidget.foreground': p.textPrimary,
      'list.hoverBackground': p.surface3,
      'input.background': p.surface1,
      'input.border': p.border,
      'focusBorder': withAlpha(p.accent, 0.6),
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': withAlpha(p.textMuted, 0.18),
      'scrollbarSlider.hoverBackground': withAlpha(p.textMuted, 0.3),
      'scrollbarSlider.activeBackground': withAlpha(p.textMuted, 0.4),
      'editorOverviewRuler.border': '#00000000',
      'editorError.foreground': p.danger,
      'editorWarning.foreground': p.warning,
      'editorInfo.foreground': p.info,
      'minimap.background': p.surface1,
    },
  };
}

export const themeName = (mode: ThemeMode) => `dataforge-${mode}`;

/**
 * Bind a key on one editor only. (`addCommand` registers keybindings shared by
 * every standalone editor; actions are scoped by editor id and disposable.)
 */
export function bindKey(
  ed: monaco.editor.IStandaloneCodeEditor,
  id: string,
  keybinding: number,
  run: () => void,
  when?: string,
): monaco.IDisposable {
  return ed.addAction({ id: `dataforge.${id}`, label: id, keybindings: [keybinding], keybindingContext: when, run: () => run() });
}

let ready: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  if (ready) return ready;
  ready = (async () => {
    const defineThemes = () => {
      const { mode, overrides } = useThemeMode.getState();
      // Redefining the active theme repaints every editor in place.
      monaco.editor.defineTheme(themeName('dark'), monacoThemeData('dark', mode === 'dark' ? overrides : {}));
      monaco.editor.defineTheme(themeName('light'), monacoThemeData('light', mode === 'light' ? overrides : {}));
    };
    defineThemes();
    useThemeMode.subscribe((s, prev) => (s.overrides !== prev.overrides || s.mode !== prev.mode) && defineThemes());
    initLsp(monaco);
    installSnippetProvider(monaco);
    registerKernelCompletion('r');
    registerKernelCompletion('python');
    registerStan(monaco);
    // Glyph widths are measured once; make sure the code font is loaded first.
    try {
      await Promise.race([
        Promise.all([document.fonts.load('13px "JetBrains Mono"'), document.fonts.load('600 13px "JetBrains Mono"')]),
        new Promise((r) => setTimeout(r, 800)),
      ]);
    } catch {
      /* fall back to whatever is available */
    }
    monaco.editor.remeasureFonts();
    return monaco;
  })();
  return ready;
}

const KIND: Record<string, monaco.languages.CompletionItemKind> = {
  function: monaco.languages.CompletionItemKind.Function,
  method: monaco.languages.CompletionItemKind.Method,
  module: monaco.languages.CompletionItemKind.Module,
  class: monaco.languages.CompletionItemKind.Class,
  instance: monaco.languages.CompletionItemKind.Variable,
  statement: monaco.languages.CompletionItemKind.Variable,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  param: monaco.languages.CompletionItemKind.Variable,
  path: monaco.languages.CompletionItemKind.File,
};

function registerKernelCompletion(language: 'r' | 'python') {
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: language === 'r' ? ['$', '@', ':'] : ['.'],
    async provideCompletionItems(model, position) {
      const lang = kernelLangFor(language)!;
      // Completion goes through the kernel's shell queue; skip while busy.
      if (!isRunning(lang) || useKernels.getState().kernels[lang].status === 'busy') return { suggestions: [] };
      // In editor documents the language server provides completion; the
      // kernel still serves console inputs (it knows runtime objects).
      if (model.uri.authority === 'dataforge' && lspReady(lang)) return { suggestions: [] };
      const code = model.getValue();
      const offset = model.getOffsetAt(position);
      try {
        const reply = await host().kernelComplete(lang, code, offset);
        if (reply.status !== 'ok') return { suggestions: [] };
        const start = model.getPositionAt(reply.cursor_start);
        const end = model.getPositionAt(reply.cursor_end);
        const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
        const types: Array<{ text: string; type: string }> = (reply as any).metadata?._jupyter_types_experimental ?? [];
        const typeOf = new Map(types.map((x) => [x.text, x.type]));
        return {
          suggestions: reply.matches.slice(0, 300).map((m, i) => ({
            label: m,
            kind: KIND[typeOf.get(m) ?? ''] ?? (m.endsWith('(') ? KIND.function : monaco.languages.CompletionItemKind.Variable),
            insertText: m,
            range,
            sortText: String(i).padStart(4, '0'),
            detail: typeOf.get(m),
          })),
        };
      } catch {
        return { suggestions: [] };
      }
    },
  });
}

export { monaco };
