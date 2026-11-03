import { BarChart3, ChevronLeft, ChevronRight, Download, Maximize2, Minus, Plus, ScanLine, Trash2, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ask } from '../../core/dialog';
import { host } from '../../core/host';
import { t as tt } from '../../core/i18n';
import { toast } from '../../core/toast';
import { LANG_LABEL } from '../../kernels/kernels';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Menu } from '../../ui/Menu';
import { clearPlots, removePlot, selectPlot, setViewport, usePlots, type Plot, type PlotFormat } from './plotStore';

export async function exportPlot(p: Plot, fmt: PlotFormat) {
  const raw = p.raw[fmt];
  if (!raw) return;
  const path = await host().saveFileDialog(`plot-${p.index}.${fmt}`, [{ name: fmt.toUpperCase(), extensions: [fmt] }]);
  if (!path) return;
  try {
    if (fmt === 'svg') await host().writeText(path, raw);
    else await host().writeBase64(path, raw);
    toast({ kind: 'success', title: tt('plots.exported', { fmt: fmt.toUpperCase() }), detail: path });
  } catch (e) {
    toast({ kind: 'error', title: tt('plots.exportFailed'), detail: String(e) });
  }
}

const bestUrl = (p: Plot) => p.urls.svg ?? p.urls.png ?? '';

function Lightbox({ plot, onClose }: { plot: Plot; onClose: () => void }) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') setScale((s) => Math.min(s * 1.25, 12));
      else if (e.key === '-') setScale((s) => Math.max(s / 1.25, 0.2));
      else if (e.key === '0') {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onWheel = (e: WheelEvent) => {
    const f = Math.exp(-e.deltaY * 0.0015);
    setScale((s) => Math.max(0.2, Math.min(12, s * f)));
  };
  const onDown = (e: RPointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
  };

  return createPortal(
    <div className="df-lightbox" role="dialog" aria-modal="true" aria-label={t('plots.zoomTitle', { n: plot.index })} onClick={onClose}>
      <div className="df-lightbox__bar" onClick={(e) => e.stopPropagation()}>
        <span className="df-lightbox__title">{t('plots.plotN', { n: plot.index })}</span>
        <IconButton icon={Minus} label={t('plots.zoomOut')} onClick={() => setScale((s) => Math.max(s / 1.25, 0.2))} />
        <span className="df-lightbox__scale">{Math.round(scale * 100)}%</span>
        <IconButton icon={Plus} label={t('plots.zoomIn')} onClick={() => setScale((s) => Math.min(s * 1.25, 12))} />
        <IconButton icon={ScanLine} label={t('plots.fit')} onClick={() => (setScale(1), setOffset({ x: 0, y: 0 }))} />
        <IconButton ref={closeBtn} icon={X} label={t('common.close')} onClick={onClose} />
      </div>
      <div className="df-lightbox__stage" onClick={(e) => e.stopPropagation()} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
        <img
          src={bestUrl(plot)}
          alt={t('plots.plotN', { n: plot.index })}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
    </div>,
    document.body,
  );
}

export function PlotsPanel() {
  const { t } = useTranslation();
  const plots = usePlots((s) => s.plots);
  const current = usePlots((s) => s.current);
  const plot = plots[current];
  const viewport = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setViewport(width, height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [plots.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    strip.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowLeft') selectPlot(current - 1);
      else if (e.key === 'ArrowRight') selectPlot(current + 1);
      else return;
      e.preventDefault();
    },
    [current],
  );

  const onClearAll = async () => {
    const ok = await ask(t('plots.clearTitle'), t('plots.clearBody', { count: plots.length }), [
      { id: 'clear', label: t('plots.clearAll'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (ok === 'clear') clearPlots();
  };

  if (!plot) {
    return (
      <div className="df-plots" ref={viewport}>
        <EmptyState icon={BarChart3} title={t('plots.emptyTitle')}>
          {t('plots.emptyBody')}
        </EmptyState>
      </div>
    );
  }

  const formats = (['png', 'svg', 'pdf'] as PlotFormat[]).filter((f) => plot.raw[f]);

  return (
    <div className="df-plots" onKeyDown={onKey}>
      <div className="df-panel-toolbar">
        <IconButton icon={ChevronLeft} label={t('plots.previous')} size="sm" disabled={current <= 0} onClick={() => selectPlot(current - 1)} />
        <span className="df-plots__counter" aria-live="polite">
          {current + 1} / {plots.length}
        </span>
        <IconButton icon={ChevronRight} label={t('plots.next')} size="sm" disabled={current >= plots.length - 1} onClick={() => selectPlot(current + 1)} />
        <span className={`df-lang-tag df-lang-tag--${plot.lang}`}>{LANG_LABEL[plot.lang]}</span>
        <div className="df-panel-toolbar__spacer" />
        <IconButton icon={Maximize2} label={t('plots.zoom')} size="sm" onClick={() => setZoom(true)} />
        <Menu
          align="end"
          items={formats.map((f) => ({ id: f, label: t('plots.exportAs', { fmt: f.toUpperCase() }), onSelect: () => void exportPlot(plot, f) }))}
          trigger={(p) => <IconButton {...p} icon={Download} label={t('plots.export')} size="sm" />}
        />
        <IconButton icon={Trash2} label={t('plots.remove')} size="sm" onClick={() => removePlot(current)} />
        <IconButton icon={XCircle} label={t('plots.clearAll')} size="sm" onClick={() => void onClearAll()} />
      </div>
      <div className="df-plots__viewport" ref={viewport} onDoubleClick={() => setZoom(true)} tabIndex={0} aria-label={t('plots.plotN', { n: plot.index })}>
        <img key={plot.id} className="df-plots__img" src={bestUrl(plot)} alt={t('plots.plotN', { n: plot.index })} draggable={false} />
      </div>
      {plots.length > 1 && (
        <div className="df-plots__strip" ref={strip} role="listbox" aria-label={t('plots.history')}>
          {plots.map((p, i) => (
            <button
              key={p.id}
              role="option"
              aria-selected={i === current}
              className={`df-plots__thumb ${i === current ? 'is-current' : ''}`}
              onClick={() => selectPlot(i)}
              title={t('plots.plotN', { n: p.index })}
            >
              <img src={p.urls.png ?? p.urls.svg} alt="" loading="lazy" decoding="async" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {zoom && <Lightbox plot={plot} onClose={() => setZoom(false)} />}
    </div>
  );
}
