import { Plus, SquareTerminal, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../core/settings';
import { IconButton } from '../../ui/Button';
import { chordLabel } from '../../ui/Kbd';
import { applyTerminalFont, closeTerminal, fitTerminal, mountTerminal, newTerminal, useTerminals } from './terminalStore';

export function TerminalPanel() {
  const { t } = useTranslation();
  const sessions = useTerminals((s) => s.sessions);
  const active = useTerminals((s) => s.active);
  const fontSize = useSettings((s) => s.editorFontSize);
  const screen = useRef<HTMLDivElement>(null);

  // The first visit opens a shell right away, like a system terminal.
  useEffect(() => {
    if (!useTerminals.getState().sessions.length) newTerminal();
  }, []);

  useLayoutEffect(() => {
    if (active && screen.current) void mountTerminal(active, screen.current);
  }, [active]);

  useEffect(() => {
    const el = screen.current;
    if (!el) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = useTerminals.getState().active;
        if (id && el.offsetWidth > 0) fitTerminal(id);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => applyTerminalFont(fontSize), [fontSize]);

  return (
    <div className="df-term">
      <div className="df-panel-toolbar df-term__bar">
        <div className="df-term__tabs" role="tablist" aria-label={t('terminal.sessions')}>
          {sessions.map((s, i) => (
            <div key={s.id} role="presentation" className={`df-term__tab ${s.id === active ? 'is-active' : ''} ${s.exited != null ? 'is-exited' : ''}`}>
              <button
                role="tab"
                aria-selected={s.id === active}
                aria-keyshortcuts="Delete"
                onKeyDown={(e) => e.key === 'Delete' && closeTerminal(s.id)}
                onClick={() => useTerminals.setState({ active: s.id })}
                onAuxClick={(e) => e.button === 1 && closeTerminal(s.id)}
                title={s.title}
              >
                <SquareTerminal size={13} strokeWidth={1.75} aria-hidden />
                <span>
                  {i + 1}: {s.title === '…' ? t('terminal.starting') : s.title}
                </span>
              </button>
              <span className="df-term__close" aria-hidden title={t('terminal.close', { name: s.title })} onClick={() => closeTerminal(s.id)}>
                <X size={11} strokeWidth={2} />
              </span>
            </div>
          ))}
        </div>
        <span className="df-panel-toolbar__spacer" />
        <IconButton icon={Plus} size="sm" label={t('terminal.new')} shortcut={chordLabel("Mod+Shift+`")} onClick={() => newTerminal()} />
        <IconButton icon={Trash2} size="sm" label={t('terminal.kill')} disabled={!active} onClick={() => active && closeTerminal(active)} />
      </div>
      <div ref={screen} className="df-term__host" onClick={() => active && fitTerminal(active)} />
      {!sessions.length && (
        <div className="df-term__empty">
          <button className="df-btn df-btn--secondary df-btn--sm" onClick={() => newTerminal()}>
            <Plus size={14} aria-hidden /> {t('terminal.new')}
          </button>
        </div>
      )}
    </div>
  );
}
