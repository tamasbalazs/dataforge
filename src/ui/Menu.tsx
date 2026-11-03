import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from './Kbd';

export type MenuItem =
  | { type?: 'item'; id: string; label: string; icon?: LucideIcon; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { type: 'separator'; id: string }
  | { type: 'label'; id: string; label: string };

interface Props {
  items: MenuItem[];
  /** Render prop for the trigger; receives props to spread on a button. */
  trigger: (p: { onClick: () => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; ref: (el: HTMLElement | null) => void }) => ReactElement;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
}

/** Dropdown menu with keyboard navigation, rendered in a portal. */
export function Menu({ items, trigger, align = 'start', side = 'bottom' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerEl = useRef<HTMLElement | null>(null);
  const menuEl = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerEl.current || !menuEl.current) return;
    const r = triggerEl.current.getBoundingClientRect();
    const m = menuEl.current.getBoundingClientRect();
    let left = align === 'end' ? r.right - m.width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
    let top = side === 'bottom' ? r.bottom + 4 : r.top - m.height - 4;
    if (top + m.height > window.innerHeight - 8) top = r.top - m.height - 4;
    setPos({ top: Math.max(8, top), left });
    menuEl.current.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled])')?.focus();
  }, [open, align, side]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuEl.current?.contains(e.target as Node) && !triggerEl.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const btns = [...(menuEl.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not([disabled])') ?? [])];
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') btns[(idx + 1) % btns.length]?.focus();
    else if (e.key === 'ArrowUp') btns[(idx - 1 + btns.length) % btns.length]?.focus();
    else if (e.key === 'Home') btns[0]?.focus();
    else if (e.key === 'End') btns[btns.length - 1]?.focus();
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      triggerEl.current?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <>
      {trigger({
        onClick: () => setOpen((o) => !o),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        ref: (el) => (triggerEl.current = el),
      })}
      {open &&
        createPortal(
          <div
            ref={menuEl}
            role="menu"
            className="df-menu"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            onKeyDown={onKey}
          >
            {items.map((it) =>
              it.type === 'separator' ? (
                <div key={it.id} className="df-menu__sep" role="separator" />
              ) : it.type === 'label' ? (
                <div key={it.id} className="df-menu__label">
                  {it.label}
                </div>
              ) : (
                <button
                  key={it.id}
                  role="menuitem"
                  disabled={it.disabled}
                  className={`df-menu__item ${it.danger ? 'is-danger' : ''}`}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect();
                  }}
                >
                  {it.icon ? <it.icon size={14} strokeWidth={1.75} aria-hidden /> : <span className="df-menu__noicon" />}
                  <span className="df-menu__text">{it.label}</span>
                  {it.shortcut && <Kbd chord={it.shortcut} />}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
