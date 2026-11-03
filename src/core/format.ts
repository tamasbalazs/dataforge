/** Locale-aware number formatting that follows the interface language. */
import i18n from 'i18next';

const cache = new Map<string, Intl.NumberFormat>();

export function formatNumber(n: number, lang = i18n.language || 'en'): string {
  let f = cache.get(lang);
  if (!f) {
    f = new Intl.NumberFormat(lang === 'hu' ? 'hu-HU' : 'en-US');
    cache.set(lang, f);
  }
  return f.format(n);
}
