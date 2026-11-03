import type { LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Show only the icon (label becomes tooltip / aria-label). */
  iconOnly?: boolean;
}

interface Props<T extends string> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}

/** Accessible segmented control (radiogroup with roving focus). */
export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const idx = options.findIndex((o) => o.value === value);
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + options.length) % options.length;
    else return;
    e.preventDefault();
    onChange(options[next].value);
    (ref.current?.querySelectorAll('button')[next] as HTMLButtonElement | undefined)?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={`df-segmented df-segmented--${size}`} onKeyDown={onKey}>
      {options.map((o) => {
        const Icon = o.icon;
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={selected}
            aria-label={o.iconOnly ? o.label : undefined}
            data-tooltip={o.iconOnly ? o.label : undefined}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'is-selected' : ''}
            onClick={() => onChange(o.value)}
          >
            {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden />}
            {!o.iconOnly && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
