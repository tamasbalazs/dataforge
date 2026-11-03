/** Snippets contributed by extensions (VS Code snippet format), served to Monaco. */
import type { Lang } from '../core/host';
import type { Snippet } from './manifest';

const registry = new Map<string, { lang: Lang; snippets: Snippet[]; source: string }>();

export function setSnippets(key: string, lang: Lang, snippets: Snippet[], source: string) {
  registry.set(key, { lang, snippets, source });
}

export function removeSnippets(prefix: string) {
  for (const k of [...registry.keys()]) if (k.startsWith(prefix)) registry.delete(k);
}

export function snippetsFor(lang: Lang): Array<Snippet & { source: string }> {
  return [...registry.values()].filter((r) => r.lang === lang).flatMap((r) => r.snippets.map((s) => ({ ...s, source: r.source })));
}

let installed = false;

/** One completion provider per language that reads the registry on demand. */
export function installSnippetProvider(monaco: any) {
  if (installed) return;
  installed = true;
  for (const lang of ['r', 'python'] as const) {
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model: any, position: any) {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        return {
          suggestions: snippetsFor(lang).map((s) => ({
            label: { label: s.prefix, description: s.label },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: `${s.description ?? ''}\n\n*${s.source}*\n\n\`\`\`\n${s.body}\n\`\`\`` },
            detail: s.source,
            range,
          })),
        };
      },
    });
  }
}
