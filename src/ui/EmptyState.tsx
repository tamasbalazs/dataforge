import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ icon: Icon, title, children, actions }: { icon: LucideIcon; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="df-empty">
      <div className="df-empty__icon">
        <Icon size={22} strokeWidth={1.5} aria-hidden />
      </div>
      <div className="df-empty__title">{title}</div>
      {children && <div className="df-empty__body">{children}</div>}
      {actions && <div className="df-empty__actions">{actions}</div>}
    </div>
  );
}
