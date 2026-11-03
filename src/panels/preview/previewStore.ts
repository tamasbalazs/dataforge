/**
 * Quarto / R Markdown preview: renders the document to a self-contained HTML
 * page in a scratch folder (never next to the sources) and shows it in the
 * Preview panel. Re-renders on save while the panel shows that document.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { on } from '../../core/bus';
import { isNonLocalPath } from '../../core/paths';
import { host, type ProcStep } from '../../core/host';
import { t } from '../../core/i18n';
import { toast } from '../../core/toast';
import { chooseInterpreter } from '../../kernels/kernels';
import { revealPanel } from '../../workbench/layout';
import { activeDoc, basename } from '../editor/editorStore';
import { saveDoc } from '../editor/editorService';

export type PreviewEngine = 'quarto' | 'rmarkdown';
export type PreviewStatus = 'idle' | 'rendering' | 'done' | 'error';

interface PreviewState {
  source: string | null;
  html: string | null;
  outFile: string | null;
  status: PreviewStatus;
  log: string[];
  startedAt: number;
  durationMs: number | null;
  renderOnSave: boolean;
  /** Scroll offset reported by the page, restored after a re-render. */
  scroll: number;
}

export const usePreview = create<PreviewState>()(
  persist(
    (): PreviewState => ({
      source: null,
      html: null,
      outFile: null,
      status: 'idle',
      log: [],
      startedAt: 0,
      durationMs: null,
      renderOnSave: true,
      scroll: 0,
    }),
    { name: 'dataforge.preview', version: 1, partialize: (s) => ({ renderOnSave: s.renderOnSave, source: s.source }) },
  ),
);

const MAX_LOG = 800;

export const isPreviewable = (path: string | null | undefined) => !!path && /\.(qmd|rmd|md|rmarkdown)$/i.test(path);

/** Which tool renders a file. R Markdown prefers rmarkdown (as RStudio does); Quarto files need Quarto. */
export function previewEngine(path: string, have: { quarto: boolean; r: boolean }): PreviewEngine | null {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'rmd' || ext === 'rmarkdown') return have.r ? 'rmarkdown' : have.quarto ? 'quarto' : null;
  if (ext === 'qmd' || ext === 'md') return have.quarto ? 'quarto' : null;
  return null;
}

export const stemOf = (path: string) => basename(path).replace(/\.[^.]+$/, '');

/** R string literal for a path (JSON escaping is valid R syntax). */
const rStr = (s: string) => JSON.stringify(s.replace(/\\/g, '/'));

export interface RenderTools {
  quarto: string | null;
  r: string | null;
  python: string | null;
}

/** The single command that renders `source` into `outDir/<stem>.html`. */
export function buildRenderStep(engine: PreviewEngine, source: string, outDir: string, tools: RenderTools): ProcStep {
  const env: Record<string, string> = {};
  if (tools.python) {
    env.QUARTO_PYTHON = tools.python;
    env.RETICULATE_PYTHON = tools.python;
  }
  if (tools.r) env.QUARTO_R = tools.r;
  if (engine === 'quarto') {
    return { program: tools.quarto ?? 'quarto', args: ['render', source, '--to', 'html', '--output-dir', outDir, '-M', 'embed-resources:true'], env };
  }
  const code =
    `rmarkdown::render(${rStr(source)}, output_format = "html_document", output_dir = ${rStr(outDir)}, ` +
    `intermediates_dir = ${rStr(outDir)}, envir = new.env(), quiet = TRUE)`;
  return { program: tools.r ?? 'R', args: ['--no-echo', '--no-restore', '--no-save', '-e', code], env };
}

/**
 * Wrap the rendered page: keep the scroll position across re-renders and send
 * external links to the system browser (the iframe is sandboxed).
 */
export function decorateHtml(html: string, scroll: number): string {
  const script = `<script>(function(){var y=${Math.max(0, Math.round(scroll))};function go(){if(y)scrollTo(0,y)}addEventListener('DOMContentLoaded',go);addEventListener('load',go);var tm;addEventListener('scroll',function(){clearTimeout(tm);tm=setTimeout(function(){parent.postMessage({dfPreview:'scroll',y:scrollY},'*')},120)},{passive:true});document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';if(/^(https?:|mailto:)/i.test(h)){e.preventDefault();parent.postMessage({dfPreview:'open',url:a.href},'*')}},true)})()</script>`;
  const head = /<head[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length) : script + html;
}

// ---------------------------------------------------------------------------

/** The render in flight: its process id and the page it will produce. */
let current: { id: string; outFile: string } | null = null;
let seq = 0;
let unlisten: (() => void) | null = null;
let quartoPath: string | null | undefined;

async function findQuarto() {
  if (quartoPath === undefined) quartoPath = await host().findProgram('quarto').catch(() => null);
  return quartoPath;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** The line that explains a failed render (Quarto's "ERROR: …", R's "Error in …"). */
export function errorSummary(log: string[]): string | null {
  const i = log.findIndex((l) => /^\s*(ERROR\b|Error\b|Quitting from)/.test(l));
  if (i < 0) return null;
  const out = [log[i]];
  // Quarto/knitr put the details on the following indented or non-stack lines.
  for (const l of log.slice(i + 1, i + 9)) {
    if (/^\s+at\s/.test(l) || /^Stack trace:/.test(l)) break;
    out.push(l);
  }
  while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

function append(lines: string[]) {
  usePreview.setState((s) => ({ log: [...s.log, ...lines].slice(-MAX_LOG) }));
}

/** Render a document into the Preview panel. */
export async function renderPreview(source: string) {
  if (isNonLocalPath(source)) {
    // Renders run locally (quarto/rmarkdown need the files on this machine).
    usePreview.setState({ source, status: 'error', log: [t('remote.previewUnavailable')], html: null });
    return;
  }
  const r = chooseInterpreter('r')?.path ?? null;
  const python = chooseInterpreter('python')?.path ?? null;
  const quarto = await findQuarto();
  const engine = previewEngine(source, { quarto: !!quarto, r: !!r });
  if (current) void host().procKill(current.id);
  current = null;
  const switching = usePreview.getState().source !== source;
  usePreview.setState({ source, status: 'rendering', log: [], startedAt: performance.now(), durationMs: null, ...(switching ? { html: null, scroll: 0 } : {}) });
  if (!engine) {
    usePreview.setState({ status: 'error', log: [t(source.toLowerCase().endsWith('.qmd') ? 'preview.needQuarto' : 'preview.needTool')] });
    return;
  }
  const mine = ++seq;
  const outDir = await host().previewDir(source);
  if (mine !== seq) return; // a newer render started meanwhile
  const outFile = `${outDir}/${stemOf(source)}.html`;
  const step = buildRenderStep(engine, source, outDir, { quarto, r, python });
  const id = `preview-${mine}`;
  current = { id, outFile };
  unlisten ??= host().onProcEvent((ev) => {
    const run = current;
    if (!run || ev.id !== run.id) return;
    if (ev.kind !== 'exit') {
      append([stripAnsi(ev.text)]);
      return;
    }
    current = null;
    void finish(ev.code, run.outFile);
  });
  try {
    await host().procRun(id, [step], source.replace(/[\\/][^\\/]*$/, '') || null);
  } catch (e) {
    current = null;
    usePreview.setState({ status: 'error', log: [String(e)] });
  }
}

async function finish(code: number | null, outFile: string) {
  const durationMs = performance.now() - usePreview.getState().startedAt;
  if (code !== 0) {
    usePreview.setState({ status: 'error', durationMs });
    return;
  }
  try {
    const html = await host().readText(outFile);
    usePreview.setState({ status: 'done', html, outFile, durationMs });
  } catch (e) {
    usePreview.setState({ status: 'error', durationMs, log: [...usePreview.getState().log, String(e)] });
  }
}

let pendingSave: ReturnType<typeof setTimeout> | null = null;
let savingForPreview = false;

/** Ctrl+Shift+K: save the active document if needed and render it. */
export async function previewActiveDoc() {
  const doc = activeDoc();
  if (!doc || !isPreviewable(doc.path ?? doc.name)) {
    toast({ kind: 'info', title: t('preview.notPreviewable') });
    return;
  }
  revealPanel('preview', { focus: false });
  if (doc.dirty || !doc.path) {
    savingForPreview = true;
    try {
      if (!(await saveDoc(doc.id))) return;
    } finally {
      savingForPreview = false;
    }
  }
  const path = activeDoc()?.path;
  if (path) void renderPreview(path);
}

export function installPreviewListeners() {
  return on('editor:saved', ({ path }) => {
    const s = usePreview.getState();
    if (savingForPreview || !s.renderOnSave || !isPreviewable(path)) return;
    if (s.source !== path) return;
    if (pendingSave) clearTimeout(pendingSave);
    pendingSave = setTimeout(() => void renderPreview(path), 120);
  });
}

export function setRenderOnSave(on: boolean) {
  usePreview.setState({ renderOnSave: on });
}

export function openRenderedExternally() {
  const f = usePreview.getState().outFile;
  if (f) void host().fsOpenExternal(f);
}

export const previewTitle = () => {
  const s = usePreview.getState().source;
  return s ? basename(s) : null;
};
