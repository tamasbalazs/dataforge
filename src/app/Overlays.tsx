import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogs } from '../core/dialog';
import { dismissToast, holdToast, releaseToast, useToasts } from '../core/toast';
import { useTasks } from '../core/tasks';
import { IconButton } from '../ui/Button';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { useFocusTrap } from './SettingsDialog';

export function DialogHost() {
  const req = useDialogs((s) => s.current);
  const ref = useFocusTrap(!!req);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && req.resolve(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req]);
  if (!req) return null;
  return (
    <div className="df-overlay" onMouseDown={() => req.resolve(null)}>
      <div ref={ref} className="df-dialog df-confirm" role="alertdialog" aria-modal="true" aria-labelledby="df-confirm-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="df-confirm-title">{req.title}</h2>
        {req.body && <p>{req.body}</p>}
        <div className="df-confirm__actions">
          {[...req.buttons].reverse().map((b, i, arr) => (
            <Button key={b.id} variant={b.variant ?? 'secondary'} onClick={() => req.resolve(b.id)} data-autofocus={i === arr.length - 1 ? true : undefined}>
              {b.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { t } = useTranslation();
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="df-toasts" role="region" aria-label={t('common.notifications')} aria-live="polite">
      {toasts.map((to) => {
        const Icon = to.kind === 'success' ? CheckCircle2 : to.kind === 'error' ? AlertCircle : Info;
        return (
          <div
            key={to.id}
            className={`df-toast df-toast--${to.kind}`}
            role={to.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => holdToast(to.id)}
            onMouseLeave={() => releaseToast(to.id)}
            onFocus={() => holdToast(to.id)}
            onBlur={() => releaseToast(to.id)}
          >
            {to.kind === 'progress' ? <Spinner size={14} /> : <Icon size={15} strokeWidth={2} aria-hidden />}
            <div className="df-toast__text">
              <div className="df-toast__title">{to.title}</div>
              {to.detail && <div className="df-toast__detail">{to.detail}</div>}
              {to.action && (
                <Button size="sm" variant="secondary" className="df-toast__action" onClick={() => (to.action!.run(), dismissToast(to.id))}>
                  {to.action.label}
                </Button>
              )}
            </div>
            <button className="df-toast__close" aria-label={t('common.close')} onClick={() => dismissToast(to.id)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function TaskLog() {
  const { t } = useTranslation();
  const id = useTasks((s) => s.logOpen);
  const task = useTasks((s) => (id ? s.tasks[id] : null));
  const ref = useFocusTrap(!!task);
  const close = () => useTasks.setState({ logOpen: null });
  useEffect(() => {
    if (!task) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [task]);
  if (!task) return null;
  return (
    <div className="df-overlay" onMouseDown={close}>
      <div ref={ref} className="df-dialog df-tasklog" role="dialog" aria-modal="true" aria-labelledby="df-tasklog-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="df-dialog__header">
          <h2 id="df-tasklog-title">
            {task.title} {task.status === 'running' ? <Spinner size={14} /> : task.status === 'ok' ? '✓' : `✗ (${task.code})`}
          </h2>
          <IconButton icon={X} label={t('common.close')} onClick={close} />
        </div>
        <div className="df-dialog__body">
          <pre aria-live="polite">
            {task.lines.map((l, i) => (
              <div key={i} className={l.kind === 'stderr' ? 'is-stderr' : ''}>
                {l.text}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
