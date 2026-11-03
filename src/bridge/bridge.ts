import type { Lang } from '../core/host';
import { t } from '../core/i18n';
import { toast } from '../core/toast';
import { execute, LANG_LABEL } from '../kernels/kernels';
import { setActiveConsole } from '../panels/console/consoleStore';

export const otherLang = (lang: Lang): Lang => (lang === 'r' ? 'python' : 'r');

const PY_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '),
);
const R_IDENT = /^([A-Za-z]|\.(?![0-9]))[A-Za-z0-9._]*$/;
const R_RESERVED = new Set('if else repeat while function for next break TRUE FALSE NULL Inf NaN NA NA_integer_ NA_real_ NA_character_ in'.split(' '));

/** A name that is valid in `target`, derived from a variable name of the other language. */
export function targetName(name: string, target: Lang): string {
  if (target === 'python') {
    let n = name.replace(/[^A-Za-z0-9_]/g, '_');
    if (/^[0-9]/.test(n)) n = `_${n}`;
    return PY_KEYWORDS.has(n) ? `${n}_` : n;
  }
  let n = name.replace(/^_+/, '');
  if (!R_IDENT.test(n)) n = `x${n}`;
  return R_RESERVED.has(n) ? `${n}_` : n;
}

/**
 * The visible, reproducible line that copies `name` from `from` into the other
 * language: `name = r.name` / `name <- py$name`.
 */
export function transferCode(from: Lang, name: string): string {
  const target = otherLang(from);
  const dest = targetName(name, target);
  if (target === 'python') {
    return PY_IDENT.test(name) && !PY_KEYWORDS.has(name) ? `${dest} = r.${name}` : `${dest} = r[${JSON.stringify(name)}]`;
  }
  return R_IDENT.test(name) && !R_RESERVED.has(name) ? `${dest} <- py$${name}` : `${dest} <- py[[${JSON.stringify(name)}]]`;
}

/** Copy a variable to the other language by running the transfer line in its console. */
export async function sendToOther(from: Lang, name: string) {
  const target = otherLang(from);
  setActiveConsole(target);
  const id = await execute(target, transferCode(from, name));
  if (!id) toast({ kind: 'error', title: t('bridge.failed', { lang: LANG_LABEL[target] }) });
}
