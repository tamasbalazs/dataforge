/**
 * Plot history. Plots arrive as display_data with PNG/SVG/PDF; heavy payloads
 * are turned into object URLs once, and nothing is decoded until shown.
 */
import { create } from 'zustand';
import { emit, on } from '../../core/bus';
import type { Lang } from '../../core/host';
import { plotTheme } from '../../design/tokens';
import { useThemeMode } from '../../core/theme';
import { addBeforeExecuteHook, callHelper, LANGS } from '../../kernels/kernels';

export interface Plot {
  id: string;
  lang: Lang;
  index: number;
  createdAt: number;
  /** Object URLs per available format. */
  urls: Partial<Record<PlotFormat, string>>;
  /** Raw payloads for export (base64 for binary formats, text for SVG). */
  raw: Partial<Record<PlotFormat, string>>;
  width?: number;
  height?: number;
}

export type PlotFormat = 'png' | 'svg' | 'pdf';

export const MIME: Record<PlotFormat, string> = { png: 'image/png', svg: 'image/svg+xml', pdf: 'application/pdf' };
const MAX_PLOTS = 200;

interface PlotState {
  plots: Plot[];
  current: number;
  /** Size of the plot viewport in CSS pixels, used to size new plots. */
  viewport: { width: number; height: number } | null;
}

export const usePlots = create<PlotState>(() => ({ plots: [], current: -1, viewport: null }));

let counter = 0;

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function plotFromDisplayData(lang: Lang, data: Record<string, any>, metadata: Record<string, any> = {}): Plot | null {
  const urls: Plot['urls'] = {};
  const raw: Plot['raw'] = {};
  const asString = (v: unknown) => (Array.isArray(v) ? v.join('') : String(v));
  for (const fmt of ['png', 'svg', 'pdf'] as PlotFormat[]) {
    const v = data[MIME[fmt]];
    if (v == null) continue;
    const s = asString(v);
    raw[fmt] = s;
    const blob = fmt === 'svg' ? new Blob([s], { type: MIME.svg }) : b64ToBlob(s, MIME[fmt]);
    urls[fmt] = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : '';
  }
  if (!raw.png && !raw.svg) return null;
  const md = metadata[MIME.png] ?? metadata[MIME.svg] ?? {};
  counter++;
  return {
    id: `plot-${Date.now().toString(36)}-${counter}`,
    lang,
    index: counter,
    createdAt: Date.now(),
    urls,
    raw,
    width: md.width,
    height: md.height,
  };
}

function release(p: Plot) {
  if (typeof URL.revokeObjectURL === 'function') Object.values(p.urls).forEach((u) => u && URL.revokeObjectURL(u));
}

export function addPlot(p: Plot) {
  usePlots.setState((s) => {
    let plots = [...s.plots, p];
    if (plots.length > MAX_PLOTS) {
      plots.slice(0, plots.length - MAX_PLOTS).forEach(release);
      plots = plots.slice(-MAX_PLOTS);
    }
    return { plots, current: plots.length - 1 };
  });
}

export function selectPlot(index: number) {
  usePlots.setState((s) => ({ current: Math.max(0, Math.min(index, s.plots.length - 1)) }));
}

export function showPlotById(id: string) {
  const idx = usePlots.getState().plots.findIndex((p) => p.id === id);
  if (idx >= 0) selectPlot(idx);
}

export function removePlot(index: number) {
  usePlots.setState((s) => {
    const p = s.plots[index];
    if (p) release(p);
    const plots = s.plots.filter((_, i) => i !== index);
    return { plots, current: Math.min(s.current, plots.length - 1) };
  });
}

export function clearPlots() {
  usePlots.getState().plots.forEach(release);
  usePlots.setState({ plots: [], current: -1 });
}

// ---------------------------------------------------------------------------
// Kernel-side plot configuration (size + theme)

const dirty: Record<Lang, boolean> = { r: true, python: true };

export function setViewport(width: number, height: number) {
  const v = usePlots.getState().viewport;
  if (v && Math.abs(v.width - width) < 8 && Math.abs(v.height - height) < 8) return;
  usePlots.setState({ viewport: { width, height } });
  dirty.r = dirty.python = true;
}

/** Plot size in inches + dpi for the current viewport. */
export function plotConfig(viewport = usePlots.getState().viewport, dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) {
  const w = Math.max(320, viewport?.width ?? 700);
  const h = Math.max(240, viewport?.height ?? 480);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { width: round(w / 96), height: round(h / 96), dpi: Math.round(96 * Math.max(2, dpr)) };
}

async function configure(lang: Lang, includeTheme: boolean) {
  const args: Record<string, unknown> = { plot: plotConfig() };
  if (includeTheme) args.theme = plotTheme(useThemeMode.getState().mode, useThemeMode.getState().overrides);
  await callHelper(lang, 'configure', args);
  dirty[lang] = false;
}

export function installPlotListeners(): () => void {
  const offs = [
    on('kernel:output', ({ lang, parentId, msgType, content }) => {
      if (msgType !== 'display_data') return;
      const p = plotFromDisplayData(lang, content.data ?? {}, content.metadata ?? {});
      if (!p) return;
      addPlot(p);
      emit('plots:added', { id: p.id, lang, parentId, index: p.index });
    }),
    on('kernel:ready', ({ lang }) => void configure(lang, true)),
    addBeforeExecuteHook(async (lang) => {
      if (dirty[lang]) await configure(lang, false);
    }),
    useThemeMode.subscribe((s, prev) => {
      if (s.mode !== prev.mode || s.overrides !== prev.overrides) LANGS.forEach((l) => void configure(l, true).catch(() => undefined));
    }),
  ];
  return () => offs.forEach((o) => o());
}
