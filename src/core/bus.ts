/** Typed event bus: the only coupling between modules besides service APIs. */
import type { Lang } from './host';

export type KernelStatus = 'off' | 'starting' | 'idle' | 'busy' | 'dead' | 'unavailable' | 'error';

export interface BusEvents {
  'kernel:status': { lang: Lang; status: KernelStatus };
  'kernel:ready': { lang: Lang };
  'kernel:output': { lang: Lang; parentId: string | null; msgType: string; content: any };
  'kernel:execution-start': { lang: Lang; msgId: string; code: string; echo: boolean; by?: string };
  'kernel:execution-done': { lang: Lang; msgId: string; status: 'ok' | 'error' | 'aborted'; durationMs: number };
  'kernel:log': { lang: Lang; text: string };
  'editor:saved': { path: string };
  'debug:paused': { lang: Lang };
  'debug:ended': Record<string, never>;
  'editor:cursor': { line: number; column: number; language: string } | null;
  'plots:added': { id: string; lang: Lang; parentId: string | null; index: number };
  'plots:show': { id: string };
  'help:show': { lang: Lang; topic: string; package?: string };
}

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

const handlers: Partial<Record<keyof BusEvents, Set<Handler<any>>>> = {};

export function on<K extends keyof BusEvents>(event: K, h: Handler<K>): () => void {
  const set = (handlers[event] ??= new Set()) as Set<Handler<K>>;
  set.add(h);
  return () => set.delete(h);
}

export function emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]) {
  const set = handlers[event] as Set<Handler<K>> | undefined;
  set?.forEach((h) => {
    try {
      h(payload);
    } catch (e) {
      console.error(`bus handler for ${event} failed`, e);
    }
  });
}
