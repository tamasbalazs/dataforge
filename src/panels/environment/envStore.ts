/** Variables of each kernel, refreshed after every execution. */
import { formatNumber } from '../../core/format';
import { create } from 'zustand';
import { on } from '../../core/bus';
import type { Lang } from '../../core/host';
import { callHelper } from '../../kernels/kernels';

export type VarKind = 'data' | 'value' | 'function' | 'list' | 'environment';

export interface Variable {
  name: string;
  type: string;
  kind: VarKind;
  /** Dimensions (e.g. [rows, cols]) or the length of a vector/list. */
  dims: number[] | number;
  size: number | null;
  preview: string;
}

interface EnvState {
  vars: Record<Lang, Variable[]>;
  loading: Record<Lang, boolean>;
  error: Record<Lang, string | null>;
  /** Names changed by the last refresh, used to highlight rows briefly. */
  changed: Record<Lang, string[]>;
}

export const useEnv = create<EnvState>(() => ({
  vars: { r: [], python: [] },
  loading: { r: false, python: false },
  error: { r: null, python: null },
  changed: { r: [], python: [] },
}));

const signature = (v: Variable) => `${v.type}|${formatDims(v.dims)}|${v.size}|${v.preview}`;

export function formatDims(d: Variable['dims'] | string): string {
  if (Array.isArray(d)) return d.map((n) => formatNumber(n)).join(' × ');
  return typeof d === 'number' ? formatNumber(d) : String(d);
}

export function diffNames(before: Variable[], after: Variable[]): string[] {
  const prev = new Map(before.map((v) => [v.name, signature(v)]));
  return after.filter((v) => prev.get(v.name) !== signature(v)).map((v) => v.name);
}

const inflight: Partial<Record<Lang, Promise<void>>> = {};
const again: Record<Lang, boolean> = { r: false, python: false };

export function refreshEnv(lang: Lang): Promise<void> {
  if (inflight[lang]) {
    again[lang] = true;
    return inflight[lang]!;
  }
  const run = async () => {
    useEnv.setState((s) => ({ loading: { ...s.loading, [lang]: true } }));
    try {
      const list = await callHelper<Variable[]>(lang, 'env_list');
      if (list) {
        useEnv.setState((s) => ({
          vars: { ...s.vars, [lang]: list },
          changed: { ...s.changed, [lang]: s.vars[lang].length ? diffNames(s.vars[lang], list) : [] },
          error: { ...s.error, [lang]: null },
        }));
      }
    } catch (e) {
      useEnv.setState((s) => ({ error: { ...s.error, [lang]: String(e) } }));
    } finally {
      useEnv.setState((s) => ({ loading: { ...s.loading, [lang]: false } }));
      inflight[lang] = undefined;
      if (again[lang]) {
        again[lang] = false;
        void refreshEnv(lang);
      }
    }
  };
  inflight[lang] = run();
  return inflight[lang]!;
}

export async function clearEnv(lang: Lang) {
  await callHelper(lang, 'clear_env');
  await refreshEnv(lang);
}

/** Does code write into the other language through the bridge (`r.x = …`, `py$x <- …`)? */
export function writesAcross(lang: Lang, code: string): boolean {
  return lang === 'python' ? /\br\s*(\.\s*\w+|\[[^\]]+\])\s*=(?!=)/.test(code) : /\bpy\s*(\$\s*[\w.]+|\[\[[^\]]+\]\])\s*(<-|=(?!=))/.test(code);
}

export function installEnvListeners(): () => void {
  const codeOf = new Map<string, string>();
  const offs = [
    on('kernel:execution-start', ({ msgId, code }) => void codeOf.set(msgId, code)),
    on('kernel:execution-done', ({ lang, msgId }) => {
      const code = codeOf.get(msgId) ?? '';
      codeOf.delete(msgId);
      void refreshEnv(lang);
      if (writesAcross(lang, code)) void refreshEnv(lang === 'r' ? 'python' : 'r');
    }),
    on('kernel:ready', ({ lang }) => void refreshEnv(lang)),
    on('kernel:status', ({ lang, status }) => {
      if (status === 'dead' || status === 'starting') {
        useEnv.setState((s) => ({ vars: { ...s.vars, [lang]: [] } }));
      }
    }),
  ];
  return () => offs.forEach((o) => o());
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
