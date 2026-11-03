import { Eye, ExternalLink, FileText, RefreshCw, ScrollText, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { chordLabel, Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { openExternalUrl } from '../help/openUrl';
import { basename } from '../editor/editorStore';
import { decorateHtml, errorSummary, openRenderedExternally, previewActiveDoc, renderPreview, setRenderOnSave, usePreview } from './previewStore';

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 200);
    return () => clearInterval(id);
  }, []);
  return <>{((now - since) / 1000).toFixed(1)} s</>;
}

export function PreviewPanel() {
  const { t } = useTranslation();
  const s = usePreview();
  const frame = useRef<HTMLIFrameElement>(null);
  const [showLog, setShowLog] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);
  const logBox = useRef<HTMLDivElement>(null);

  // The scroll offset is read only when a new page arrives, so scrolling does
  // not rebuild the document.
  const doc = useMemo(() => (s.html ? decorateHtml(s.html, usePreview.getState().scroll) : null), [s.html]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { dfPreview?: string; y?: number; url?: string };
      if (d?.dfPreview === 'scroll' && typeof d.y === 'number') usePreview.setState({ scroll: d.y });
      if (d?.dfPreview === 'open' && d.url) void openExternalUrl(d.url);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Failures open the log at the explaining line; a successful render closes it.
  useEffect(() => {
    if (s.status === 'error') setShowLog(true);
    if (s.status === 'done') setShowLog(false);
  }, [s.status]);
  useEffect(() => {
    if (s.status === 'rendering') logEnd.current?.scrollIntoView({ block: 'end' });
    else if (s.status === 'error') logBox.current?.scrollTo({ top: 0 });
  }, [s.log, s.status, showLog]);

  const name = s.source ? basename(s.source) : null;
  const rendering = s.status === 'rendering';

  return (
    <div className="df-preview" data-status={s.status}>
      <div className="df-panel-toolbar">
        <FileText size={14} strokeWidth={1.75} className="df-preview__icon" aria-hidden />
        <span className="df-preview__name" title={s.source ?? undefined}>
          {name ?? t('preview.none')}
        </span>
        <span className="df-preview__status" role="status" aria-live="polite">
          {rendering && (
            <>
              <Spinner size={12} /> {t('preview.rendering')} <Elapsed since={s.startedAt} />
            </>
          )}
          {s.status === 'done' && s.durationMs != null && t('preview.renderedIn', { s: (s.durationMs / 1000).toFixed(1) })}
          {s.status === 'error' && <span className="df-preview__err">{t('preview.failed')}</span>}
        </span>
        <span className="df-panel-toolbar__spacer" />
        <IconButton
          icon={Zap}
          size="sm"
          label={t('preview.renderOnSave')}
          active={s.renderOnSave}
          onClick={() => setRenderOnSave(!s.renderOnSave)}
        />
        <IconButton icon={ScrollText} size="sm" label={t('preview.log')} active={showLog} disabled={!s.log.length} onClick={() => setShowLog((v) => !v)} />
        <IconButton icon={ExternalLink} size="sm" label={t('preview.openExternal')} disabled={!s.outFile || rendering} onClick={openRenderedExternally} />
        <IconButton
          icon={RefreshCw}
          size="sm"
          tone="accent"
          label={t('preview.render')}
          shortcut={chordLabel('Mod+Shift+K')}
          disabled={!s.source || rendering}
          onClick={() => s.source && void renderPreview(s.source)}
        />
      </div>
      {rendering && <div className="df-preview__progress" aria-hidden />}
      <div className="df-preview__body">
        {doc ? (
          <iframe
            ref={frame}
            className={`df-preview__frame ${rendering ? 'is-stale' : ''}`}
            title={t('preview.frameTitle', { name: name ?? '' })}
            sandbox="allow-scripts allow-popups"
            srcDoc={doc}
          />
        ) : rendering ? (
          <EmptyState icon={Eye} title={t('preview.firstRenderTitle')}>
            {t('preview.firstRenderBody')}
          </EmptyState>
        ) : s.status !== 'error' ? (
          <EmptyState icon={Eye} title={t('preview.emptyTitle')}>
            <p>{t('preview.emptyBody')}</p>
            <div className="df-preview__hint">
              <Kbd chord="Mod+Shift+K" />
              <Button size="sm" variant="secondary" icon={Eye} onClick={() => void previewActiveDoc()}>
                {t('preview.previewActive')}
              </Button>
            </div>
          </EmptyState>
        ) : null}
        {showLog && s.log.length > 0 && (
          <div ref={logBox} className={`df-preview__log ${doc ? 'is-overlay' : ''}`} role="log" aria-label={t('preview.log')}>
            {s.status === 'error' && errorSummary(s.log) && <pre className="df-preview__errline">{errorSummary(s.log)}</pre>}
            <pre>
              {s.log.join('\n')}
              <div ref={logEnd} />
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
