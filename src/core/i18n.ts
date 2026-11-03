import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import hu from '../locales/hu.json';
import { useSettings } from './settings';

export const resources = { en: { translation: en }, hu: { translation: hu } } as const;

export function initI18n() {
  void i18n.use(initReactI18next).init({
    resources,
    lng: useSettings.getState().locale,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  useSettings.subscribe((s, prev) => {
    if (s.locale !== prev.locale) void i18n.changeLanguage(s.locale);
  });
  document.documentElement.lang = useSettings.getState().locale;
  i18n.on('languageChanged', (l) => (document.documentElement.lang = l));
  return i18n;
}

export const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);
export default i18n;
