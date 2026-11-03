import { CornerDownLeft, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { closePalette, fuzzyMatch, runCommand, useCommands, type Command } from '../core/commands';
import { Kbd } from '../ui/Kbd';

interface Item {
  cmd: Command;
  title: string;
  category: string;
  score: number;
  positions: number[];
}

function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <mark key={i} className="df-palette__hit">
            {ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useCommands((s) => s.paletteOpen);
  const commands = useCommands((s) => s.commands);
  const recent = useCommands((s) => s.recent);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Focus synchronously so keystrokes typed right after the shortcut are kept.
  useLayoutEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement;
      setQuery('');
      setIndex(0);
      input.current?.focus();
    }
  }, [open]);

  const items: Item[] = useMemo(() => {
    if (!open) return [];
    const all = Object.values(commands).filter((c) => (c.when ? c.when() : true));
    const res: Item[] = [];
    for (const cmd of all) {
      const title = cmd.literal ? cmd.title : t(cmd.title, cmd.titleArgs?.() ?? {});
      const category = cmd.category ? (cmd.literal ? cmd.category : t(cmd.category)) : '';
      const m = fuzzyMatch(query, title) ?? (query ? fuzzyMatch(query, `${category} ${title}`) : null);
      if (!m) continue;
      const titleHit = fuzzyMatch(query, title);
      const recentBoost = recent.includes(cmd.id) ? (query ? 2 : 100 - recent.indexOf(cmd.id)) : 0;
      res.push({ cmd, title, category, score: m.score + recentBoost, positions: titleHit?.positions ?? [] });
    }
    res.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return res.slice(0, 60);
  }, [open, commands, query, recent, t]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const close = () => {
    closePalette();
    restoreFocus.current?.focus?.();
  };
  const run = (item: Item | undefined) => {
    if (!item) return;
    closePalette();
    restoreFocus.current?.focus?.();
    void runCommand(item.cmd.id);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
    else if (e.key === 'PageDown') setIndex((i) => Math.min(items.length - 1, i + 8));
    else if (e.key === 'PageUp') setIndex((i) => Math.max(0, i - 8));
    else if (e.key === 'Enter') run(items[index]);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  };

  return (
    <div className="df-overlay df-overlay--top" onMouseDown={close}>
      <div className="df-palette" role="dialog" aria-modal="true" aria-label={t('commands.palette')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="df-palette__search">
          <Search size={16} strokeWidth={1.75} aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="df-palette-list"
            aria-activedescendant={items[index] ? `cmd-${items[index].cmd.id}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="df-palette__list" id="df-palette-list" role="listbox" ref={list}>
          {items.length === 0 && <div className="df-palette__empty">{t('palette.noResults')}</div>}
          {items.map((it, i) => (
            <div
              key={it.cmd.id}
              id={`cmd-${it.cmd.id}`}
              role="option"
              aria-selected={i === index}
              className={`df-palette__item ${i === index ? 'is-active' : ''}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(it)}
            >
              {it.category && <span className="df-palette__cat">{it.category}</span>}
              <span className="df-palette__title">
                <Highlight text={it.title} positions={it.positions} />
              </span>
              {it.cmd.keybinding && <Kbd chord={it.cmd.keybinding} />}
            </div>
          ))}
        </div>
        <div className="df-palette__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('palette.navigate')}
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{' '}
            {t('palette.run')}
          </span>
          <span>
            <kbd>Esc</kbd> {t('palette.close')}
          </span>
        </div>
      </div>
    </div>
  );
}
