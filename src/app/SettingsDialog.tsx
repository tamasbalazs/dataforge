import { Check, Copy, Download, Minus, Monitor, Moon, Palette as PaletteIcon, Plus, RefreshCw, Sun, Trash2, Upload, X } from 'lucide-react';
import { activateTheme, allThemes, exportCurrentTheme, importThemeFromFile, removeTheme, useThemes } from '../themes/themeStore';
import { useThemeMode } from '../core/theme';
import { palettes } from '../design/tokens';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Interpreter, Lang } from '../core/host';
import { UI_SCALES, updateSettings, useSettings, type Locale, type ThemePreference } from '../core/settings';
import { toast } from '../core/toast';
import { restartLsp, useLsp } from '../lsp/client';
import { chooseInterpreter, detectInterpreters, LANG_LABEL, LANGS, restartKernel, useKernels } from '../kernels/kernels';
import { Button, IconButton } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { Spinner } from '../ui/Spinner';
import { useUi } from './uiStore';

function Swatch({ colors }: { colors: string[] }) {
  return (
    <span className="df-theme__swatch" aria-hidden>
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/** Imported / extension themes: pick, remove, import (DataForge or VS Code), export. */
function ThemeList() {
  const { t } = useTranslation();
  const active = useSettings((s) => s.customTheme);
  const mode = useThemeMode((s) => s.mode);
  const state = useThemes();
  const themes = allThemes(state);
  return (
    <div className="df-field df-field--stack">
      <label>{t('themes.title')}</label>
      <div className="df-theme__list" role="radiogroup" aria-label={t('themes.title')}>
        <div className="df-theme__item-row">
          <button role="radio" aria-checked={!active} className={`df-theme__item ${!active ? 'is-active' : ''}`} onClick={() => activateTheme(null)}>
            <Swatch colors={[palettes[mode].surface1, palettes[mode].accent, palettes[mode].synString, palettes[mode].synKeyword]} />
            <span className="df-theme__name">{t('themes.builtin')}</span>
            {!active && <Check size={14} aria-hidden />}
          </button>
        </div>
        {themes.map((th) => {
          const p = { ...palettes[th.type], ...th.colors };
          return (
            <div key={th.id} className="df-theme__item-row">
              <button role="radio" aria-checked={active === th.id} className={`df-theme__item ${active === th.id ? 'is-active' : ''}`} onClick={() => activateTheme(th.id)}>
                <Swatch colors={[p.surface1, p.accent, p.synString, p.synKeyword]} />
                <span className="df-theme__name">{th.name}</span>
                <span className="df-theme__meta">
                  {th.type === 'dark' ? t('theme.dark') : t('theme.light')}
                  {th.source === 'vscode' ? ' · VS Code' : th.source === 'extension' ? ` · ${t('themes.fromExtension')}` : ''}
                </span>
                {active === th.id && <Check size={14} aria-hidden />}
              </button>
              {th.source !== 'extension' && <IconButton icon={Trash2} size="sm" label={t('themes.remove', { name: th.name })} onClick={() => removeTheme(th.id)} />}
            </div>
          );
        })}
      </div>
      <div className="df-theme__actions">
        <Button size="sm" variant="secondary" icon={Upload} onClick={() => void importThemeFromFile()}>
          {t('themes.import')}
        </Button>
        <Button size="sm" variant="ghost" icon={Download} onClick={() => void exportCurrentTheme(mode)}>
          {t('themes.export')}
        </Button>
      </div>
      <p className="df-field__hint">
        <PaletteIcon size={12} aria-hidden /> {t('themes.hint')}
      </p>
    </div>
  );
}

export function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Next frame: dialogs that fill in their content in an effect have it by then.
    const raf = requestAnimationFrame(() => {
      if (el && el.contains(document.activeElement) && document.activeElement !== el) return;
      const all = [...(el?.querySelectorAll<HTMLElement>('input, select, textarea, button:not([disabled]), [tabindex="0"]') ?? [])];
      // The content's first control rather than the header's close button.
      const target = el?.querySelector<HTMLElement>('[data-autofocus]') ?? all.find((x) => !x.closest('.df-dialog__header')) ?? all[0];
      target?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, [tabindex="0"]')];
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [active]);
  return ref;
}

export function InterpreterList({ lang }: { lang: Lang }) {
  const { t } = useTranslation();
  const list = useKernels((s) => s.interpreters).filter((i) => i.lang === lang);
  const chosen = useSettings((s) => s.interpreters[lang]);
  const active = chooseInterpreter(lang);
  const select = (i: Interpreter) => {
    updateSettings({ interpreters: { ...useSettings.getState().interpreters, [lang]: i.path } });
    void restartKernel(lang);
  };
  if (!list.length) {
    return <div className="df-interp__none">{t('settings.noneFound', { lang: LANG_LABEL[lang] })}</div>;
  }
  return (
    <div className="df-interp" role="radiogroup" aria-label={LANG_LABEL[lang]}>
      {list.map((i) => {
        const isActive = active?.path === i.path && (chosen == null || chosen === i.path);
        return (
          <div key={i.path} className={`df-interp__row ${isActive ? 'is-active' : ''} ${i.hasKernel ? '' : 'is-missing'}`}>
            <button role="radio" aria-checked={isActive} disabled={!i.hasKernel} onClick={() => select(i)} className="df-interp__main">
              <span className="df-interp__radio">{isActive && <Check size={11} strokeWidth={3} />}</span>
              <span className="df-interp__ver">
                {LANG_LABEL[lang]} {i.version}
              </span>
              <span className="df-interp__src">{i.source}</span>
              <span className="df-interp__path" title={i.path}>
                {i.path}
              </span>
            </button>
            {!i.hasKernel && i.installHint && (
              <div className="df-interp__hint">
                <span>{t('settings.kernelMissing', { pkg: lang === 'r' ? 'IRkernel' : 'ipykernel' })}</span>
                <code>{i.installHint}</code>
                <IconButton
                  icon={Copy}
                  size="sm"
                  label={t('common.copy')}
                  onClick={() => void navigator.clipboard.writeText(i.installHint!).then(() => toast({ kind: 'success', title: t('common.copied') }))}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LspRow({ lang }: { lang: Lang }) {
  const { t } = useTranslation();
  const st = useLsp((s) => s.servers[lang]);
  const text =
    st.status === 'ready'
      ? t('lsp.readyLong', { server: st.server })
      : st.status === 'unavailable'
        ? (st.error ?? t('lsp.notInstalled'))
        : st.status === 'starting'
          ? t('lsp.starting')
          : st.status === 'error'
            ? `${t('lsp.failed')}: ${st.error ?? ''}`
            : t('lsp.idle');
  return (
    <div className="df-lsp-row">
      <div className="df-field">
        <label>{LANG_LABEL[lang]}</label>
        <span className={`df-lsp-row__status is-${st.status}`}>
          {st.status === 'starting' && <Spinner size={12} />} {text}
          {(st.status === 'ready' || st.status === 'error') && (
            <IconButton icon={RefreshCw} size="sm" label={t('lsp.restart')} onClick={() => void restartLsp(lang)} />
          )}
        </span>
      </div>
      {st.status === 'unavailable' && st.installHint && (
        <div className="df-interp__hint">
          <span>{t('lsp.installWith')}</span>
          <code>{st.installHint}</code>
          <IconButton
            icon={Copy}
            size="sm"
            label={t('common.copy')}
            onClick={() => void navigator.clipboard.writeText(st.installHint!).then(() => toast({ kind: 'success', title: t('common.copied') }))}
          />
        </div>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.settingsOpen);
  const s = useSettings();
  const detecting = useKernels((st) => st.detecting);
  const ref = useFocusTrap(open);
  const close = () => useUi.setState({ settingsOpen: false });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  const scaleIdx = UI_SCALES.findIndex((x) => Math.abs(x - s.uiScale) < 0.001);

  return (
    <div className="df-overlay" onMouseDown={close}>
      <div ref={ref} className="df-dialog df-settings" role="dialog" aria-modal="true" aria-labelledby="df-settings-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="df-dialog__header">
          <h2 id="df-settings-title">{t('commands.settings')}</h2>
          <IconButton icon={X} label={t('common.close')} onClick={close} />
        </div>
        <div className="df-dialog__body">
          <section className="df-settings__section">
            <h3>{t('settings.appearance')}</h3>
            <div className="df-field">
              <label>{t('settings.theme')}</label>
              <Segmented<ThemePreference>
                label={t('settings.theme')}
                value={s.theme}
                onChange={(theme) => updateSettings({ theme, customTheme: null })}
                options={[
                  { value: 'system', label: t('theme.system'), icon: Monitor },
                  { value: 'light', label: t('theme.light'), icon: Sun },
                  { value: 'dark', label: t('theme.dark'), icon: Moon },
                ]}
              />
            </div>
            <ThemeList />
            <div className="df-field">
              <label>{t('settings.language')}</label>
              <Segmented<Locale>
                label={t('settings.language')}
                value={s.locale}
                onChange={(locale) => updateSettings({ locale })}
                options={[
                  { value: 'hu', label: 'Magyar' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </div>
            <div className="df-field">
              <label>{t('settings.uiScale')}</label>
              <div className="df-stepper">
                <IconButton icon={Minus} size="sm" label={t('commands.zoomOut')} disabled={scaleIdx <= 0} onClick={() => updateSettings({ uiScale: UI_SCALES[Math.max(0, scaleIdx - 1)] })} />
                <span className="df-stepper__value">{Math.round(s.uiScale * 100)}%</span>
                <IconButton icon={Plus} size="sm" label={t('commands.zoomIn')} disabled={scaleIdx >= UI_SCALES.length - 1} onClick={() => updateSettings({ uiScale: UI_SCALES[Math.min(UI_SCALES.length - 1, scaleIdx + 1)] })} />
              </div>
            </div>
            <div className="df-field">
              <label>{t('settings.editorFont')}</label>
              <div className="df-stepper">
                <IconButton icon={Minus} size="sm" label={t('commands.fontDown')} onClick={() => updateSettings({ editorFontSize: Math.max(9, s.editorFontSize - 1) })} />
                <span className="df-stepper__value">{s.editorFontSize} px</span>
                <IconButton icon={Plus} size="sm" label={t('commands.fontUp')} onClick={() => updateSettings({ editorFontSize: Math.min(28, s.editorFontSize + 1) })} />
              </div>
            </div>
            <div className="df-field">
              <label htmlFor="df-ligatures">{t('settings.ligatures')}</label>
              <button
                id="df-ligatures"
                role="switch"
                aria-checked={s.fontLigatures}
                className={`df-switch ${s.fontLigatures ? 'is-on' : ''}`}
                onClick={() => updateSettings({ fontLigatures: !s.fontLigatures })}
              >
                <span />
              </button>
            </div>
          </section>
          <section className="df-settings__section">
            <div className="df-settings__section-head">
              <h3>{t('settings.interpreters')}</h3>
              <Button size="sm" variant="ghost" icon={detecting ? undefined : RefreshCw} disabled={detecting} onClick={() => void detectInterpreters(true)}>
                {detecting && <Spinner size={12} />} {t('settings.rescan')}
              </Button>
            </div>
            {LANGS.map((l) => (
              <div key={l} className="df-settings__interp">
                <h4>{LANG_LABEL[l]}</h4>
                <InterpreterList lang={l} />
              </div>
            ))}
          </section>
          <section className="df-settings__section">
            <h3>{t('lsp.title')}</h3>
            {LANGS.map((l) => (
              <LspRow key={l} lang={l} />
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
