import { Puzzle } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useThemeMode } from '../../core/theme';
import { cssVariables } from '../../design/tokens';
import { onPanelMessage, panelKey, sendToExtension, useExtensions } from '../../extensions/extensionHost';
import { EmptyState } from '../../ui/EmptyState';

/**
 * The page an extension shows in a panel: a sandboxed iframe (scripts only, no
 * same-origin, no Tauri access) styled with the app's design tokens. Inside,
 * `dataforge.postMessage(msg)` / `dataforge.onMessage(fn)` talk to the extension.
 */
export function buildPanelDocument(html: string, vars: Record<string, string>): string {
  const css = Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  const shim = `<script>
const dataforge = Object.freeze({
  postMessage: (message) => parent.postMessage({ dfExtPanel: true, message }, '*'),
  onMessage: (fn) => addEventListener('message', (e) => { if (e.source === parent && e.data && e.data.dfHost) fn(e.data.message); }),
});
</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${css}}html,body{margin:0;background:var(--surface-1);color:var(--text-primary);font:13px/1.5 var(--font-ui)}a{color:var(--accent-text)}code{font-family:var(--font-mono)}</style>${shim}</head><body>${html}</body></html>`;
}

export function ExtensionPanelView({ params }: { params?: { extId: string; panelId: string; title: string } }) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const key = params ? panelKey(params.extId, params.panelId) : '';
  const html = useExtensions((s) => s.panelHtml[key]);
  const mode = useThemeMode((s) => s.mode);
  const overrides = useThemeMode((s) => s.overrides);
  const doc = useMemo(() => (html == null ? null : buildPanelDocument(html, cssVariables(mode, overrides))), [html, mode, overrides]);

  useEffect(() => {
    if (!params) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data?.dfExtPanel) return;
      sendToExtension(params.extId, params.panelId, e.data.message);
    };
    window.addEventListener('message', onMessage);
    const off = onPanelMessage(key, (message) => frame.current?.contentWindow?.postMessage({ dfHost: true, message }, '*'));
    return () => {
      window.removeEventListener('message', onMessage);
      off();
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!params) return null;
  if (doc == null) {
    return (
      <EmptyState icon={Puzzle} title={params.title}>
        {t('extensions.panelEmpty')}
      </EmptyState>
    );
  }
  return <iframe ref={frame} className="df-extpanel" title={params.title} sandbox="allow-scripts" srcDoc={doc} />;
}
