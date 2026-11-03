import { ArrowLeft, ArrowRight, CheckCircle2, Code2, Focus, LayoutGrid, Monitor, Moon, Sparkles, Sun, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateSettings, useSettings, type LayoutPreset, type Locale, type ThemePreference } from '../core/settings';
import { detectInterpreters, LANG_LABEL, LANGS, startKernel, useKernels } from '../kernels/kernels';
import { EXAMPLES, newFile } from '../panels/editor/editorService';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { Segmented } from '../ui/Segmented';
import { Spinner } from '../ui/Spinner';
import { applyPreset } from '../workbench/layout';
import { InterpreterList, useFocusTrap } from './SettingsDialog';
import { Logo } from './TitleBar';
import { useUi } from './uiStore';

const STEPS = ['welcome', 'environment', 'start'] as const;

function EnvironmentStep() {
  const { t } = useTranslation();
  const detecting = useKernels((s) => s.detecting);
  const interpreters = useKernels((s) => s.interpreters);
  useEffect(() => {
    void detectInterpreters(true);
  }, []);
  return (
    <div className="df-onb__env">
      {detecting && interpreters.length === 0 ? (
        <div className="df-onb__scanning" role="status">
          <Spinner size={18} />
          {t('onboarding.scanning')}
        </div>
      ) : (
        LANGS.map((l) => {
          const ok = interpreters.some((i) => i.lang === l && i.hasKernel);
          return (
            <div key={l} className="df-onb__lang">
              <div className={`df-onb__lang-head ${ok ? 'is-ok' : 'is-missing'}`}>
                {ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                <strong>{LANG_LABEL[l]}</strong>
                <span>{ok ? t('onboarding.ready') : t('onboarding.notReady')}</span>
              </div>
              <InterpreterList lang={l} />
            </div>
          );
        })
      )}
    </div>
  );
}

export function Onboarding() {
  const { t } = useTranslation();
  const open = useUi((s) => s.onboardingOpen);
  const theme = useSettings((s) => s.theme);
  const locale = useSettings((s) => s.locale);
  const preset = useSettings((s) => s.layoutPreset);
  const [step, setStep] = useState(0);
  const ref = useFocusTrap(open);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // Keep keyboard users on the primary action as the steps change.
  useEffect(() => {
    if (open) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
  }, [open, step, ref]);

  if (!open) return null;

  const finish = (example?: 'r' | 'python') => {
    updateSettings({ onboarded: true });
    useUi.setState({ onboardingOpen: false });
    if (example) newFile(example, EXAMPLES[example]);
    LANGS.forEach((l) => void startKernel(l));
  };

  const id = STEPS[step];
  return (
    <div className="df-overlay df-overlay--onboarding">
      <div ref={ref} className="df-dialog df-onb" role="dialog" aria-modal="true" aria-labelledby="df-onb-title">
        <div className="df-onb__progress" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s} className={i <= step ? 'is-done' : ''} />
          ))}
        </div>
        <div className="df-onb__content" key={id}>
          {id === 'welcome' && (
            <>
              <div className="df-onb__hero">
                <Logo size={56} />
              </div>
              <h2 id="df-onb-title">{t('onboarding.welcomeTitle')}</h2>
              <p className="df-onb__lead">{t('onboarding.welcomeBody')}</p>
              <div className="df-onb__fields">
                <div className="df-field">
                  <label>{t('settings.language')}</label>
                  <Segmented<Locale>
                    label={t('settings.language')}
                    value={locale}
                    onChange={(l) => updateSettings({ locale: l })}
                    options={[
                      { value: 'hu', label: 'Magyar' },
                      { value: 'en', label: 'English' },
                    ]}
                  />
                </div>
                <div className="df-field">
                  <label>{t('settings.theme')}</label>
                  <Segmented<ThemePreference>
                    label={t('settings.theme')}
                    value={theme}
                    onChange={(v) => updateSettings({ theme: v })}
                    options={[
                      { value: 'system', label: t('theme.system'), icon: Monitor },
                      { value: 'light', label: t('theme.light'), icon: Sun },
                      { value: 'dark', label: t('theme.dark'), icon: Moon },
                    ]}
                  />
                </div>
              </div>
            </>
          )}
          {id === 'environment' && (
            <>
              <h2 id="df-onb-title">{t('onboarding.envTitle')}</h2>
              <p className="df-onb__lead">{t('onboarding.envBody')}</p>
              <EnvironmentStep />
            </>
          )}
          {id === 'start' && (
            <>
              <h2 id="df-onb-title">{t('onboarding.startTitle')}</h2>
              <p className="df-onb__lead">{t('onboarding.startBody')}</p>
              <div className="df-onb__layouts" role="radiogroup" aria-label={t('layout.label')}>
                {(
                  [
                    ['analysis', LayoutGrid],
                    ['development', Code2],
                    ['focus', Focus],
                  ] as [LayoutPreset, typeof LayoutGrid][]
                ).map(([p, Icon]) => (
                  <button key={p} role="radio" aria-checked={preset === p} className={`df-onb__layout ${preset === p ? 'is-selected' : ''}`} onClick={() => applyPreset(p)}>
                    <Icon size={18} strokeWidth={1.6} />
                    <strong>{t(`layout.${p}`)}</strong>
                    <span>{t(`layout.${p}Desc`)}</span>
                  </button>
                ))}
              </div>
              <dl className="df-shortcut-list df-shortcut-list--wide">
                <dt>{t('editor.runLine')}</dt>
                <dd>
                  <Kbd chord="Mod+Enter" />
                </dd>
                <dt>{t('editor.runFile')}</dt>
                <dd>
                  <Kbd chord="Mod+Shift+Enter" />
                </dd>
                <dt>{t('commands.palette')}</dt>
                <dd>
                  <Kbd chord="Mod+Shift+P" />
                </dd>
                <dt>{t('commands.cycleTheme')}</dt>
                <dd>
                  <Kbd chord="Mod+Alt+T" />
                </dd>
              </dl>
            </>
          )}
        </div>
        <div className="df-onb__footer">
          {step > 0 ? (
            <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(step - 1)}>
              {t('common.back')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => finish()}>
              {t('onboarding.skip')}
            </Button>
          )}
          <div className="df-panel-toolbar__spacer" />
          {id === 'start' ? (
            <>
              <Button variant="ghost" onClick={() => finish()}>
                {t('onboarding.empty')}
              </Button>
              <Button icon={Sparkles} onClick={() => finish('python')}>
                {t('editor.examplePython')}
              </Button>
              <Button variant="primary" icon={Sparkles} onClick={() => finish('r')} data-autofocus>
                {t('editor.exampleR')}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => setStep(step + 1)} data-autofocus>
              {t('common.next')} <ArrowRight size={14} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
