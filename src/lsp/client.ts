/**
 * Language client: one per kernel language. Syncs the editor's documents
 * (not console inputs) with the server and adapts LSP features to Monaco.
 */
import { create } from 'zustand';
import { host, type Lang, type LspCommand } from '../core/host';
import { isNonLocalPath } from '../core/paths';
import { t } from '../core/i18n';
import { getSettings } from '../core/settings';
import { useKernels } from '../kernels/kernels';
import type * as M from '../panels/editor/monaco';
import { Connection } from './jsonrpc';
import { completionKind, editsForUri, isKernelGlobalDiagnostic, markerSeverity, pathToUri, symbolKind, toLspPosition, toLspRange, toMarkdown, toMonacoRange, type LspRange } from './convert';

export type LspStatus = 'off' | 'starting' | 'ready' | 'unavailable' | 'error';

export interface LspState {
  status: LspStatus;
  server?: string;
  installHint?: string | null;
  error?: string;
}

export const useLsp = create<{ servers: Record<Lang, LspState>; problems: { errors: number; warnings: number } }>(() => ({
  servers: { r: { status: 'off' }, python: { status: 'off' } },
  problems: { errors: 0, warnings: 0 },
}));

const patch = (lang: Lang, p: Partial<LspState>) =>
  useLsp.setState((s) => ({ servers: { ...s.servers, [lang]: { ...s.servers[lang], ...p } } }));

type Monaco = typeof M;

interface Tracked {
  model: M.editor.ITextModel;
  uri: string;
  listener: M.IDisposable;
}

const MARKER_OWNER = 'lsp';

class LanguageClient {
  conn: Connection | null = null;
  caps: any = {};
  docs = new Map<M.editor.ITextModel, Tracked>();
  byUri = new Map<string, Tracked>();
  providers: M.IDisposable[] = [];
  starting: Promise<boolean> | null = null;
  restarts = 0;

  constructor(
    public lang: Lang,
    private monaco: Monaco,
  ) {}

  get languageId() {
    return this.lang;
  }

  ready() {
    return useLsp.getState().servers[this.lang].status === 'ready';
  }

  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().then((ok) => {
      if (!ok) this.starting = null;
      return ok;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    const interp = useKernels.getState().kernels[this.lang].interpreter;
    if (!interp) {
      patch(this.lang, { status: 'off' });
      return false;
    }
    if (isNonLocalPath(getSettings().workdir)) {
      // Language servers run locally and need the files on disk.
      patch(this.lang, { status: 'unavailable', installHint: null, error: t('remote.lspUnavailable') });
      return false;
    }
    patch(this.lang, { status: 'starting', error: undefined });
    let command: LspCommand | null;
    try {
      const det = await host().lspDetect(this.lang, interp);
      command = det.command;
      if (!command) {
        patch(this.lang, { status: 'unavailable', installHint: det.installHint });
        return false;
      }
    } catch (e) {
      patch(this.lang, { status: 'error', error: String(e) });
      return false;
    }
    const id = `lsp-${this.lang}`;
    const conn = new Connection({ send: (p) => host().lspSend(id, p) });
    this.conn = conn;
    const off = host().onLspEvent((ev) => {
      if (ev.id !== id) return;
      if (ev.kind === 'message') void conn.receive(ev.payload);
      else if (ev.kind === 'exit') {
        off();
        this.onExit(conn);
      }
    });
    this.installServerHandlers(conn, interp);
    const root = getSettings().workdir;
    try {
      await host().lspStart(id, command, root);
      const rootUri = root ? pathToUri(root) : null;
      const init = await conn.request(
        'initialize',
        {
          processId: null,
          clientInfo: { name: 'DataForge', version: '0.2.0' },
          locale: getSettings().locale,
          rootUri,
          workspaceFolders: rootUri ? [{ uri: rootUri, name: root!.split(/[\\/]/).pop() }] : null,
          capabilities: CLIENT_CAPABILITIES,
        },
        60_000,
      );
      this.caps = init.capabilities ?? {};
      await conn.notify('initialized', {});
      patch(this.lang, { status: 'ready', server: command.name, installHint: null });
      this.registerProviders();
      for (const t of this.docs.values()) this.sendOpen(t);
      return true;
    } catch (e) {
      patch(this.lang, { status: 'error', error: String(e) });
      void host().lspStop(id);
      return false;
    }
  }

  private installServerHandlers(conn: Connection, interpreter: string) {
    const settings: Record<string, unknown> = {
      python: { pythonPath: interpreter, defaultInterpreterPath: interpreter, analysis: PY_ANALYSIS },
      'python.analysis': PY_ANALYSIS,
      'basedpyright.analysis': PY_ANALYSIS,
      basedpyright: { analysis: PY_ANALYSIS },
      pyright: {},
      r: { lsp: { diagnostics: true, rich_documentation: true } },
      'r.lsp': { diagnostics: true, rich_documentation: true },
    };
    conn.onRequest('workspace/configuration', (p) => (p.items ?? []).map((i: any) => (i.section ? (settings[i.section] ?? null) : settings)));
    conn.onRequest('client/registerCapability', () => null);
    conn.onRequest('client/unregisterCapability', () => null);
    conn.onRequest('window/workDoneProgress/create', () => null);
    conn.onRequest('window/showMessageRequest', () => null);
    conn.onRequest('workspace/workspaceFolders', () => {
      const root = getSettings().workdir;
      return root ? [{ uri: pathToUri(root), name: root.split(/[\\/]/).pop() }] : null;
    });
    conn.onNotification('textDocument/publishDiagnostics', (p) => this.onDiagnostics(p));
    conn.onNotification('window/logMessage', () => {});
    conn.onNotification('$/progress', () => {});
  }

  private onExit(conn: Connection) {
    conn.close('language server exited');
    if (this.conn !== conn) return;
    this.conn = null;
    this.starting = null;
    this.disposeProviders();
    for (const t of this.docs.values()) this.monaco.editor.setModelMarkers(t.model, MARKER_OWNER, []);
    updateProblems();
    patch(this.lang, { status: 'error', error: 'language server exited' });
    if (this.restarts++ < 2) setTimeout(() => void this.start(), 1000);
  }

  async stop() {
    const conn = this.conn;
    this.conn = null;
    this.starting = null;
    this.disposeProviders();
    if (conn) {
      try {
        await conn.request('shutdown', null, 2000);
        await conn.notify('exit');
      } catch {
        /* ignore */
      }
      conn.close();
    }
    await host().lspStop(`lsp-${this.lang}`);
    patch(this.lang, { status: 'off' });
  }

  // --- documents -----------------------------------------------------------

  attach(model: M.editor.ITextModel, uri: string) {
    this.detach(model);
    const t: Tracked = {
      model,
      uri,
      listener: model.onDidChangeContent((e) => this.sendChange(t, e)),
    };
    this.docs.set(model, t);
    this.byUri.set(uri.toLowerCase(), t);
    model.onWillDispose(() => this.detach(model));
    if (this.ready()) this.sendOpen(t);
    else void this.start();
  }

  detach(model: M.editor.ITextModel) {
    const t = this.docs.get(model);
    if (!t) return;
    t.listener.dispose();
    this.docs.delete(model);
    this.byUri.delete(t.uri.toLowerCase());
    if (this.ready()) void this.conn?.notify('textDocument/didClose', { textDocument: { uri: t.uri } });
    if (!model.isDisposed()) this.monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    updateProblems();
  }

  private sendOpen(t: Tracked) {
    void this.conn?.notify('textDocument/didOpen', {
      textDocument: { uri: t.uri, languageId: this.lang, version: t.model.getVersionId(), text: t.model.getValue() },
    });
  }

  private syncKind(): number {
    const s = this.caps.textDocumentSync;
    return typeof s === 'number' ? s : (s?.change ?? 1);
  }

  private sendChange(t: Tracked, e: M.editor.IModelContentChangedEvent) {
    if (!this.ready() || !this.conn) return;
    const incremental = this.syncKind() === 2;
    const contentChanges = incremental
      ? e.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }))
      : [{ text: t.model.getValue() }];
    void this.conn.notify('textDocument/didChange', { textDocument: { uri: t.uri, version: t.model.getVersionId() }, contentChanges });
  }

  private onDiagnostics(p: { uri: string; diagnostics: any[] }) {
    const t = this.byUri.get(p.uri.toLowerCase());
    if (!t || t.model.isDisposed()) return;
    const markers: M.editor.IMarkerData[] = p.diagnostics.filter((d) => !isKernelGlobalDiagnostic(d.message)).map((d) => ({
      ...toMonacoRange(d.range),
      severity: markerSeverity(d.severity),
      message: d.message,
      source: d.source,
      code: d.code != null ? String(typeof d.code === 'object' ? d.code.value : d.code) : undefined,
      tags: (d.tags ?? []).filter((x: number) => x === 1 || x === 2),
    }));
    this.monaco.editor.setModelMarkers(t.model, MARKER_OWNER, markers);
    updateProblems();
  }

  // --- features --------------------------------------------------------------

  private tracked(model: M.editor.ITextModel) {
    return this.ready() ? this.docs.get(model) : undefined;
  }

  private disposeProviders() {
    this.providers.forEach((p) => p.dispose());
    this.providers = [];
  }

  private registerProviders() {
    this.disposeProviders();
    const m = this.monaco;
    const lang = this.languageId;
    const caps = this.caps;
    const K = m.languages.CompletionItemKind as unknown as Record<string, number>;

    if (caps.completionProvider) {
      const toItem = (it: any, model: M.editor.ITextModel, position: M.Position): M.languages.CompletionItem & { _lsp?: any } => {
        const word = model.getWordUntilPosition(position);
        const defRange = new m.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const te = it.textEdit;
        const range = te ? ('range' in te ? toMonacoRange(te.range) : { insert: toMonacoRange(te.insert), replace: toMonacoRange(te.replace) }) : defRange;
        const label = it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label;
        return {
          label,
          kind: completionKind(it.kind, K) as M.languages.CompletionItemKind,
          detail: it.detail,
          documentation: it.documentation ? { value: toMarkdown(it.documentation).join('\n\n') } : undefined,
          insertText: te?.newText ?? it.insertText ?? it.label,
          insertTextRules: it.insertTextFormat === 2 ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: range as M.IRange,
          sortText: it.sortText,
          filterText: it.filterText,
          preselect: it.preselect,
          additionalTextEdits: it.additionalTextEdits?.map((e: any) => ({ range: toMonacoRange(e.range), text: e.newText })),
          tags: it.deprecated || it.tags?.includes(1) ? [1] : undefined,
          _lsp: it,
        };
      };
      this.providers.push(
        m.languages.registerCompletionItemProvider(lang, {
          triggerCharacters: caps.completionProvider.triggerCharacters,
          provideCompletionItems: async (model, position, ctx) => {
            const t = this.tracked(model);
            if (!t) return undefined;
            const res = await this.conn!.request('textDocument/completion', {
              textDocument: { uri: t.uri },
              position: toLspPosition(position),
              context: { triggerKind: ctx.triggerKind + 1, triggerCharacter: ctx.triggerCharacter },
            }).catch(() => null);
            if (!res) return { suggestions: [] };
            const items = Array.isArray(res) ? res : res.items;
            return { suggestions: items.slice(0, 500).map((it: any) => toItem(it, model, position)), incomplete: !Array.isArray(res) && res.isIncomplete };
          },
          resolveCompletionItem: caps.completionProvider.resolveProvider
            ? async (item: any) => {
                const r = await this.conn?.request('completionItem/resolve', item._lsp).catch(() => null);
                if (r?.documentation) item.documentation = { value: toMarkdown(r.documentation).join('\n\n') };
                if (r?.detail) item.detail = r.detail;
                return item;
              }
            : undefined,
        }),
      );
    }

    if (caps.hoverProvider) {
      this.providers.push(
        m.languages.registerHoverProvider(lang, {
          provideHover: async (model, position) => {
            const t = this.tracked(model);
            if (!t) return null;
            const r = await this.conn!.request('textDocument/hover', { textDocument: { uri: t.uri }, position: toLspPosition(position) }).catch(() => null);
            const parts = toMarkdown(r?.contents);
            if (!parts.length) return null;
            return { contents: parts.map((value) => ({ value })), range: r.range ? toMonacoRange(r.range) : undefined };
          },
        }),
      );
    }

    if (caps.signatureHelpProvider) {
      this.providers.push(
        m.languages.registerSignatureHelpProvider(lang, {
          signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? ['(', ','],
          signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters,
          provideSignatureHelp: async (model, position) => {
            const t = this.tracked(model);
            if (!t) return null;
            const r = await this.conn!.request('textDocument/signatureHelp', { textDocument: { uri: t.uri }, position: toLspPosition(position) }).catch(() => null);
            if (!r?.signatures?.length) return null;
            return {
              value: {
                activeSignature: r.activeSignature ?? 0,
                activeParameter: r.activeParameter ?? r.signatures[r.activeSignature ?? 0]?.activeParameter ?? 0,
                signatures: r.signatures.map((s: any) => ({
                  label: s.label,
                  documentation: s.documentation ? { value: toMarkdown(s.documentation).join('\n\n') } : undefined,
                  parameters: (s.parameters ?? []).map((p: any) => ({
                    label: p.label,
                    documentation: p.documentation ? { value: toMarkdown(p.documentation).join('\n\n') } : undefined,
                  })),
                })),
              },
              dispose() {},
            };
          },
        }),
      );
    }

    if (caps.definitionProvider) {
      this.providers.push(
        m.languages.registerDefinitionProvider(lang, {
          provideDefinition: async (model, position) => {
            const t = this.tracked(model);
            if (!t) return null;
            const r = await this.conn!.request('textDocument/definition', { textDocument: { uri: t.uri }, position: toLspPosition(position) }).catch(() => null);
            const list: any[] = r ? (Array.isArray(r) ? r : [r]) : [];
            // Only locations inside open documents can be shown.
            return list
              .map((l) => ({ uri: (l.targetUri ?? l.uri) as string, range: (l.targetSelectionRange ?? l.range) as LspRange }))
              .map((l) => ({ t: this.byUri.get(l.uri.toLowerCase()), range: l.range }))
              .filter((l) => l.t)
              .map((l) => ({ uri: l.t!.model.uri, range: toMonacoRange(l.range) }));
          },
        }),
      );
    }

    if (caps.documentSymbolProvider) {
      const conv = (s: any): M.languages.DocumentSymbol => ({
        name: s.name,
        detail: s.detail ?? '',
        kind: symbolKind(s.kind),
        tags: [],
        range: toMonacoRange(s.range ?? s.location.range),
        selectionRange: toMonacoRange(s.selectionRange ?? s.location.range),
        children: (s.children ?? []).map(conv),
      });
      this.providers.push(
        m.languages.registerDocumentSymbolProvider(lang, {
          provideDocumentSymbols: async (model) => {
            const t = this.tracked(model);
            if (!t) return [];
            const r = await this.conn!.request('textDocument/documentSymbol', { textDocument: { uri: t.uri } }).catch(() => null);
            return (r ?? []).map(conv);
          },
        }),
      );
    }

    if (caps.documentFormattingProvider) {
      this.providers.push(
        m.languages.registerDocumentFormattingEditProvider(lang, {
          provideDocumentFormattingEdits: async (model, options) => {
            const t = this.tracked(model);
            if (!t) return [];
            const r = await this.conn!.request('textDocument/formatting', {
              textDocument: { uri: t.uri },
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            }).catch(() => null);
            return (r ?? []).map((e: any) => ({ range: toMonacoRange(e.range), text: e.newText }));
          },
        }),
      );
    }

    if (caps.renameProvider) {
      this.providers.push(
        m.languages.registerRenameProvider(lang, {
          provideRenameEdits: async (model, position, newName) => {
            const t = this.tracked(model);
            if (!t) return null;
            const r = await this.conn!.request('textDocument/rename', { textDocument: { uri: t.uri }, position: toLspPosition(position), newName });
            return {
              edits: editsForUri(r, t.uri).map((e) => ({
                resource: model.uri,
                versionId: undefined,
                textEdit: { range: toMonacoRange(e.range), text: e.newText },
              })),
            };
          },
        }),
      );
    }
  }
}

const PY_ANALYSIS = {
  typeCheckingMode: 'basic',
  diagnosticMode: 'openFilesOnly',
  autoSearchPaths: true,
  useLibraryCodeForTypes: true,
};

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  textDocument: {
    synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ['markdown', 'plaintext'],
        deprecatedSupport: true,
        labelDetailsSupport: true,
        insertReplaceSupport: true,
        resolveSupport: { properties: ['documentation', 'detail'] },
        tagSupport: { valueSet: [1] },
      },
      contextSupport: true,
    },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    signatureHelp: {
      signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
      contextSupport: false,
    },
    definition: { linkSupport: true },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    formatting: {},
    rename: { prepareSupport: false },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] }, versionSupport: false },
  },
  workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
  window: { workDoneProgress: true },
};

// ---------------------------------------------------------------------------
// Registry

const clients = new Map<Lang, LanguageClient>();
let monacoRef: Monaco | null = null;

export function initLsp(m: Monaco) {
  monacoRef = m;
}

function clientFor(lang: Lang): LanguageClient | null {
  if (!monacoRef) return null;
  let c = clients.get(lang);
  if (!c) {
    c = new LanguageClient(lang, monacoRef);
    clients.set(lang, c);
  }
  return c;
}

/** Track an editor document for its language server. */
export function lspAttach(lang: Lang, model: M.editor.ITextModel, uri: string) {
  clientFor(lang)?.attach(model, uri);
}

export function lspDetach(lang: Lang, model: M.editor.ITextModel) {
  clients.get(lang)?.detach(model);
}

export function lspReady(lang: Lang) {
  return useLsp.getState().servers[lang].status === 'ready';
}

export async function restartLsp(lang: Lang) {
  const c = clients.get(lang);
  if (!c) return;
  await c.stop();
  c.restarts = 0;
  if (c.docs.size) await c.start();
}

function updateProblems() {
  if (!monacoRef) return;
  const markers = monacoRef.editor.getModelMarkers({ owner: MARKER_OWNER });
  useLsp.setState({
    problems: {
      errors: markers.filter((x) => x.severity === 8).length,
      warnings: markers.filter((x) => x.severity === 4).length,
    },
  });
}

// Interpreter changes (new kernel) → restart that language's server.
useKernels.subscribe((s, prev) => {
  for (const lang of ['r', 'python'] as Lang[]) {
    const a = s.kernels[lang].interpreter;
    const b = prev.kernels[lang].interpreter;
    const c = clients.get(lang);
    if (!c || a === b || !a) continue;
    if (useLsp.getState().servers[lang].status === 'off' || useLsp.getState().servers[lang].status === 'unavailable') {
      if (c.docs.size) void c.start();
    } else if (b) void restartLsp(lang);
  }
});
