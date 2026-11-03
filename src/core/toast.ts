/** Lightweight toast notifications for operation feedback. */
import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error' | 'progress';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;

const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

function schedule(id: number, ms: number) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => dismissToast(id), ms));
}

/** Toasts with an action stay longer: the user needs time to reach the button. */
export function defaultTimeout(t: Pick<Toast, 'kind' | 'action'>): number {
  if (t.kind === 'progress') return 0;
  if (t.action) return 10000;
  return t.kind === 'error' ? 7000 : 3200;
}

export function toast(t: Omit<Toast, 'id'>, timeoutMs = defaultTimeout(t)): number {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
  if (timeoutMs > 0) schedule(id, timeoutMs);
  return id;
}

/** Pause auto-dismiss while the pointer or keyboard focus is on a toast. */
export function holdToast(id: number) {
  clearTimeout(timers.get(id));
}

export function releaseToast(id: number) {
  const t = useToasts.getState().toasts.find((x) => x.id === id);
  if (t && t.kind !== 'progress') schedule(id, 2500);
}
