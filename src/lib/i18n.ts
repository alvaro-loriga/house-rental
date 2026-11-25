import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import es from '../locales/es.json';
import type { AppLocale } from '../utils/format';

export const LANGUAGE_STORAGE_KEY = 'rental.locale';

export function storedLocale(): AppLocale {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en-GB' ? 'en-GB' : 'es-ES';
  } catch {
    return 'es-ES';
  }
}

/** Switches the interface language in place (no navigation, no remount) and remembers it. */
export async function applyLocale(locale: AppLocale) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Private mode: the choice simply lasts for this visit.
  }
  document.documentElement.lang = locale.slice(0, 2);
  if (i18n.language !== locale) await i18n.changeLanguage(locale);
}

void i18n.use(initReactI18next).init({
  resources: { 'es-ES': { translation: es }, 'en-GB': { translation: en } },
  lng: storedLocale(),
  fallbackLng: 'es-ES',
  interpolation: { escapeValue: false },
  returnNull: false,
});
document.documentElement.lang = storedLocale().slice(0, 2);

export default i18n;
