import { formatChord, isMac } from '../core/commands';

export function Kbd({ chord, className = '' }: { chord: string; className?: string }) {
  return (
    <span className={`df-kbd ${className}`} aria-label={formatChord(chord).join('+')}>
      {formatChord(chord).map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}


/** Plain-text chord for tooltips, e.g. "Ctrl+Enter" or "⌘↩". */
export const chordLabel = (chord: string) => formatChord(chord).join(isMac ? '' : '+');
