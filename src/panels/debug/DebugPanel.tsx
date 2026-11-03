import { Bug, ChevronRight, CircleDot, CornerDownRight, Eye, Play, Plus, Redo2, Square, StepForward, Trash2, Undo2, X } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LANG_LABEL } from '../../kernels/kernels';
import {
  addWatch,
  clearAllBreakpoints,
  debugStatusText,
  evaluateInFrame,
  expandVariable,
  motion,
  removeWatch,
  selectFrame,
  setBreakpoints,
  startDebugging,
  stopDebugging,
  useBreakpoints,
  useDebug,
  type DVar,
} from '../../debug/debugStore';
import { Button, IconButton } from '../../ui/Button';
import { chordLabel } from '../../ui/Kbd';
import { revealPanel } from '../../workbench/layout';
import { activeDoc, addFileDoc, basename } from '../editor/editorStore';

function Section({ title, count, children, actions, defaultOpen = true }: { title: string; count?: number; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="df-dbg__section" aria-label={title}>
      <div className="df-dbg__section-head">
        <button className="df-git__section-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronRight size={12} strokeWidth={2} className={`df-git__chev ${open ? 'is-open' : ''}`} aria-hidden />
          {title}
          {count != null && <span className="df-git__count">{count}</span>}
        </button>
        <span className="df-dbg__section-actions">{actions}</span>
      </div>
      {open && <div className="df-dbg__section-body">{children}</div>}
    </section>
  );
}

function VarNode({ v, depth }: { v: DVar; depth: number }) {
  const children = useDebug((s) => (v.ref ? s.children[v.ref] : undefined));
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (!v.ref) return;
    if (!open) void expandVariable(v.ref);
    setOpen((o) => !o);
  };
  return (
    <li>
      <button
        className="df-dbg__var"
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={v.ref ? open : undefined}
        onClick={toggle}
        title={`${v.name}${v.type ? ` (${v.type})` : ''} = ${v.value}`}
      >
        <span className={`df-dbg__twisty ${v.ref ? '' : 'is-leaf'}`} aria-hidden>
          <ChevronRight size={11} strokeWidth={2} className={open ? 'is-open' : ''} />
        </span>
        <span className="df-dbg__vname">{v.name}</span>
        {v.type && <span className="df-dbg__vtype">{v.type}</span>}
        <span className="df-dbg__vvalue">{v.value}</span>
      </button>
      {open && children && (
        <ul className="df-dbg__tree">
          {children.map((c, i) => (
            <VarNode key={`${c.name}:${i}`} v={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Toolbar() {
  const { t } = useTranslation();
  const state = useDebug((s) => s.state);
  const lang = useDebug((s) => s.lang);
  const frames = useDebug((s) => s.frames);
  const paused = state === 'paused';
  const doc = activeDoc();
  return (
    <div className="df-panel-toolbar df-dbg__bar">
      {state === 'idle' ? (
        <Button size="sm" variant="primary" icon={Play} onClick={() => void startDebugging(activeDoc()?.path ?? null)} disabled={!doc?.path}>
          {t('debug.start')}
        </Button>
      ) : (
        <>
          <IconButton icon={Play} size="sm" tone="accent" label={t('debug.continue')} shortcut="F5" disabled={!paused} onClick={() => void motion('continue')} />
          <IconButton icon={StepForward} size="sm" label={t('debug.next')} shortcut="F10" disabled={!paused} onClick={() => void motion('next')} />
          <IconButton icon={CornerDownRight} size="sm" label={t('debug.stepIn')} shortcut="F11" disabled={!paused} onClick={() => void motion('stepIn')} />
          <IconButton icon={Undo2} size="sm" label={t('debug.stepOut')} shortcut={chordLabel('Shift+F11')} disabled={!paused} onClick={() => void motion('stepOut')} />
          <IconButton icon={Square} size="sm" tone="danger" label={t('debug.stop')} shortcut={chordLabel('Shift+F5')} onClick={() => void stopDebugging()} />
        </>
      )}
      <span className={`df-dbg__status is-${state}`} role="status" aria-live="polite">
        {lang && state !== 'idle' && <span className="df-dbg__lang">{LANG_LABEL[lang]}</span>}
        {debugStatusText({ lang, state, frames })}
      </span>
    </div>
  );
}

function Breakpoints() {
  const { t } = useTranslation();
  const byPath = useBreakpoints((s) => s.byPath);
  const entries = Object.entries(byPath).flatMap(([path, lines]) => lines.map((line) => ({ path, line })));
  return (
    <Section
      title={t('debug.breakpoints')}
      count={entries.length}
      actions={entries.length ? <IconButton icon={Trash2} size="sm" label={t('debug.clearBreakpoints')} onClick={clearAllBreakpoints} /> : null}
    >
      {!entries.length ? (
        <p className="df-dbg__muted">{t('debug.noBreakpointsHint')}</p>
      ) : (
        <ul className="df-dbg__list">
          {entries.map(({ path, line }) => (
            <li key={`${path}:${line}`} className="df-dbg__row">
              <button className="df-dbg__item" onClick={() => (addFileDoc(path), revealPanel('editor'))}>
                <CircleDot size={12} className="df-dbg__bpicon" aria-hidden />
                <span className="df-dbg__vname">{basename(path)}</span>
                <span className="df-dbg__vtype">{t('debug.line', { line })}</span>
              </button>
              <IconButton icon={X} size="sm" label={t('debug.removeBreakpoint')} onClick={() => setBreakpoints(path, (byPath[path] ?? []).filter((l) => l !== line))} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function DebugPanel() {
  const { t } = useTranslation();
  const s = useDebug();
  const [watch, setWatch] = useState('');
  const [expr, setExpr] = useState('');
  const [hist, setHist] = useState<number>(-1);
  const paused = s.state === 'paused';

  const onEvalKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const past = s.log.map((l) => l.expr);
    if (e.key === 'Enter' && expr.trim()) {
      void evaluateInFrame(expr);
      setExpr('');
      setHist(-1);
    } else if (e.key === 'ArrowUp' && past.length) {
      const i = hist < 0 ? past.length - 1 : Math.max(0, hist - 1);
      setHist(i);
      setExpr(past[i]);
      e.preventDefault();
    } else if (e.key === 'ArrowDown' && hist >= 0) {
      const i = hist + 1;
      setHist(i >= past.length ? -1 : i);
      setExpr(i >= past.length ? '' : past[i]);
      e.preventDefault();
    }
  };

  return (
    <div className="df-dbg">
      <Toolbar />
      <div className="df-dbg__body">
        {s.state === 'idle' && (
          <div className="df-dbg__intro">
            <Bug size={18} strokeWidth={1.6} aria-hidden />
            <p>{t('debug.intro')}</p>
          </div>
        )}
        {s.state !== 'idle' && (
          <>
            <Section title={t('debug.variables')} count={paused ? s.variables.length : undefined}>
              {!paused ? (
                <p className="df-dbg__muted">{t('debug.runningHint')}</p>
              ) : (
                <ul className="df-dbg__tree" role="tree">
                  {s.variables.map((v, i) => (
                    <VarNode key={`${v.name}:${i}`} v={v} depth={0} />
                  ))}
                  {!s.variables.length && <li className="df-dbg__muted">{t('debug.noVariables')}</li>}
                </ul>
              )}
            </Section>
            <Section title={t('debug.callStack')} count={s.frames.length || undefined}>
              <ul className="df-dbg__list">
                {s.frames.map((f) => (
                  <li key={f.id}>
                    <button className={`df-dbg__item ${f.id === s.frameId ? 'is-active' : ''}`} onClick={() => void selectFrame(f.id)}>
                      <span className="df-dbg__vname">{f.name === '<script>' ? t('debug.script') : f.name}</span>
                      <span className="df-dbg__vtype">
                        {f.path ? basename(f.path) : '?'}:{f.line}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
        <Section title={t('debug.watch')} count={s.watches.length || undefined} defaultOpen={s.watches.length > 0}>
          <ul className="df-dbg__list">
            {s.watches.map((w) => (
              <li key={w} className="df-dbg__row">
                <span className="df-dbg__item is-static">
                  <Eye size={12} aria-hidden className="df-dbg__bpicon is-watch" />
                  <span className="df-dbg__vname">{w}</span>
                  <span className="df-dbg__vvalue">{paused ? (s.watchValues[w] ?? '…') : ''}</span>
                </span>
                <IconButton icon={X} size="sm" label={t('debug.removeWatch')} onClick={() => removeWatch(w)} />
              </li>
            ))}
          </ul>
          <form
            className="df-dbg__add"
            onSubmit={(e) => {
              e.preventDefault();
              addWatch(watch);
              setWatch('');
            }}
          >
            <Plus size={12} aria-hidden />
            <input value={watch} onChange={(e) => setWatch(e.target.value)} placeholder={t('debug.addWatch')} aria-label={t('debug.addWatch')} spellCheck={false} />
          </form>
        </Section>
        <Breakpoints />
        {s.state !== 'idle' && (
          <Section title={t('debug.console')}>
            <div className="df-dbg__log" role="log">
              {s.log.map((l, i) => (
                <div key={i} className="df-dbg__logentry">
                  <div className="df-dbg__logexpr">
                    <Redo2 size={11} aria-hidden /> {l.expr}
                  </div>
                  <pre className={l.ok ? '' : 'is-error'}>{l.result}</pre>
                </div>
              ))}
            </div>
            <input
              className="df-dbg__eval"
              value={expr}
              disabled={!paused}
              onChange={(e) => setExpr(e.target.value)}
              onKeyDown={onEvalKey}
              placeholder={paused ? t('debug.evalPlaceholder') : t('debug.runningHint')}
              aria-label={t('debug.evalPlaceholder')}
              spellCheck={false}
            />
          </Section>
        )}
      </div>
    </div>
  );
}
