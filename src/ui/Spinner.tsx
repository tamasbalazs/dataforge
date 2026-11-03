export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return (
    <span className="df-spinner" role={label ? 'status' : undefined} aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}
