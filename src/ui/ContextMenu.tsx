import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Kbd } from './Kbd';
import type { MenuItem } from './Menu';

/** Menu at a screen position (right click / Shift+F10), keyboard navigable. */
export function ContextMenu({ x, y, items, onClose, label }: { x: number; y: number; items: MenuItem[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)), left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) });
    el.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled])')?.focus();
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const close = () => {
    onClose();
    restore.current?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not([disabled])') ?? [])];
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') btns[(idx + 1) % btns.length]?.focus();
    else if (e.key === 'ArrowUp') btns[(idx - 1 + btns.length) % btns.length]?.focus();
    else if (e.key === 'Escape' || e.key === 'Tab') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className="df-menu" style={pos} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
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
              close();
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
  );
}
