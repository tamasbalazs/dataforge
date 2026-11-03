/** Commands around Stan models (toolbar, palette, Environment panel). */
import { t } from '../core/i18n';
import { kernelPath } from '../core/paths';
import { toast } from '../core/toast';
import { callHelper, execute, startKernel } from '../kernels/kernels';
import { currentEditor, saveDoc } from '../panels/editor/editorService';
import { activeDoc, newUntitled } from '../panels/editor/editorStore';
import { revealPanel } from '../workbench/layout';
import { rDataTemplate } from './stanc';
import { stanInfo, useStan } from './language';

export const isStanDoc = () => activeDoc()?.language === 'stan';

/** R variable name for a model file: "hier model.stan" → hier_model_mod. */
export function modelVar(path: string | null, fallback = 'model'): string {
  const base = (path ?? fallback).split(/[\\/]/).pop()!.replace(/\.stan$/i, '');
  const clean = base.replace(/[^A-Za-z0-9_.]/g, '_').replace(/^[^A-Za-z.]+/, '');
  return `${clean || fallback}_mod`;
}

/** R string literal. */
export const rString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function formatStan() {
  void currentEditor()?.getAction('editor.action.formatDocument')?.run();
}

export async function copyDataTemplate() {
  const ed = currentEditor();
  const code = ed?.getModel()?.getValue() ?? '';
  const i = await stanInfo(code).catch(() => null);
  if (!i) {
    toast({ kind: 'error', title: t('stan.fixErrorsFirst') });
    return;
  }
  const text = rDataTemplate(i, code);
  try {
    await navigator.clipboard.writeText(text);
    toast({ kind: 'success', title: t('stan.templateCopied'), detail: text.split('\n').slice(0, 4).join('\n') + (text.split('\n').length > 4 ? '\n…' : '') });
  } catch {
    newUntitled('r', text);
  }
}

/** Save the model (if needed) and compile it in the R console with cmdstanr. */
export async function compileWithCmdstanr() {
  const doc = activeDoc();
  if (!doc || doc.language !== 'stan') return;
  if (!doc.path || doc.dirty) {
    if (!(await saveDoc(doc.id))) return;
  }
  const saved = activeDoc();
  if (!saved?.path) return;
  if (!(await startKernel('r'))) return;
  const v = modelVar(saved.path);
  revealPanel('console', { focus: false });
  await execute('r', `${v} <- cmdstanr::cmdstan_model(${rString(kernelPath(saved.path))})`);
}

export function togglePedantic() {
  const next = !useStan.getState().pedantic;
  useStan.setState({ pedantic: next });
  toast({ kind: 'info', title: next ? t('stan.pedanticOn') : t('stan.pedanticOff') });
}

/** Open the Stan code behind a brmsfit / stanfit / stanmodel / CmdStanModel as a new document. */
export async function openStanCode(name: string) {
  const code = `local({ .x <- ${name}
  .code <- if (inherits(.x, "brmsfit")) brms::stancode(.x)
    else if (inherits(.x, "stanfit")) rstan::get_stancode(.x)
    else if (inherits(.x, "stanmodel")) .x@model_code
    else if (inherits(.x, "CmdStanModel")) paste(.x$code(), collapse = "\\n")
    else stop("not a Stan model")
  cat(.code) })`;
  const out = await callHelper<string>('r', 'ext_eval', { code }).catch((e) => {
    toast({ kind: 'error', title: t('stan.noStanCode', { name }), detail: String(e) });
    return null;
  });
  if (!out || /^Error/.test(out)) {
    if (out) toast({ kind: 'error', title: t('stan.noStanCode', { name }), detail: out });
    return;
  }
  newUntitled('stan', out.endsWith('\n') ? out : `${out}\n`);
  revealPanel('editor');
}

/** R classes that carry Stan code. */
export const STAN_CLASSES = /\b(brmsfit|stanfit|stanmodel|CmdStanModel)\b/;
