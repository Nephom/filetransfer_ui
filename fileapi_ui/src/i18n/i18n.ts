import i18n from "i18next";
import type { TFunction } from "i18next";
import { initReactI18next } from "react-i18next";
import { enUS } from "./locales/en_US";
import { zhTW } from "./locales/zh_TW";

export const APP_LOCALES = ["en_US", "zh_TW"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const localeStorageKey = "nfterm-locale";

const isAppLocale = (value: unknown): value is AppLocale => APP_LOCALES.includes(value as AppLocale);

export function detectAppLocale(languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages || [navigator.language]): AppLocale {
  for (const language of languages) {
    if (typeof language !== "string" || !language.trim()) continue;
    const normalized = language.replace(/_/g, "-").toLowerCase();
    if (normalized === "zh-tw" || normalized.startsWith("zh-hant")) return "zh_TW";
    if (normalized === "en-us" || normalized === "en") return "en_US";
  }
  return "en_US";
}

export function resolveInitialAppLocale(
  saved: string | null,
  languages?: readonly string[],
): AppLocale {
  return isAppLocale(saved) ? saved : detectAppLocale(languages);
}

function readSavedLocale() {
  try {
    return localStorage.getItem(localeStorageKey);
  } catch {
    return null;
  }
}

const initialLocale = (() => {
  const saved = readSavedLocale();
  const locale = resolveInitialAppLocale(saved);
  if (!isAppLocale(saved)) {
    try { localStorage.setItem(localeStorageKey, locale); } catch { /* locale remains selected for this run */ }
  }
  return locale;
})();

void i18n.use(initReactI18next).init({
  resources: {
    en_US: { translation: enUS },
    zh_TW: { translation: zhTW },
  },
  lng: initialLocale,
  fallbackLng: "en_US",
  supportedLngs: [...APP_LOCALES],
  load: "currentOnly",
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

const updateDocumentLanguage = (locale: string) => {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = locale.replace("_", "-");
  }
};

i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage(initialLocale);

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== localeStorageKey || !isAppLocale(event.newValue)) return;
    void i18n.changeLanguage(event.newValue);
  });
}

export async function changeAppLocale(locale: AppLocale) {
  if (!isAppLocale(locale)) return;
  try {
    localStorage.setItem(localeStorageKey, locale);
  } catch {
    // Language switching still works for this WebView when storage is unavailable.
  }
  await i18n.changeLanguage(locale);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nfterm-locale-changed", { detail: locale }));
  }
}

export function getAppLocale(): AppLocale {
  return isAppLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : initialLocale;
}

export function toIntlLocale(locale: AppLocale = getAppLocale()) {
  return locale === "zh_TW" ? "zh-TW" : "en-US";
}

export const translateApp = ((key: string, values?: Record<string, string | number>) => i18n.t(key, values)) as TFunction;

export default i18n;
