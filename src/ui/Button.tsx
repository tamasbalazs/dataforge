import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, children, className = '', ...rest },
  ref,
) {
  return (
    <button ref={ref} className={`df-btn df-btn--${variant} df-btn--${size} ${className}`} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 15} strokeWidth={1.75} aria-hidden />}
      {children && <span>{children}</span>}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
  active?: boolean;
  size?: 'sm' | 'md';
  tone?: 'default' | 'accent' | 'danger';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, shortcut, active, size = 'md', tone = 'default', className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      data-tooltip={shortcut ? `${label}  ·  ${shortcut}` : label}
      aria-pressed={active}
      className={`df-icon-btn df-icon-btn--${size} df-icon-btn--${tone} ${active ? 'is-active' : ''} ${className}`}
      {...rest}
    >
      <Icon size={size === 'sm' ? 14 : 16} strokeWidth={1.75} aria-hidden />
    </button>
  );
});
