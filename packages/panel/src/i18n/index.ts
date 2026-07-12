import i18next from "i18next";
import type { i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { admin as adminEn } from "./locales/en/admin";
import { aiSettings as aiSettingsEn } from "./locales/en/ai-settings";
import { auth as authEn } from "./locales/en/auth";
import { bots as botsEn } from "./locales/en/bots";
import { botData as botDataEn } from "./locales/en/bot-data";
import { common as commonEn } from "./locales/en/common";
import { admin as adminZhCN } from "./locales/zh-CN/admin";
import { aiSettings as aiSettingsZhCN } from "./locales/zh-CN/ai-settings";
import { auth as authZhCN } from "./locales/zh-CN/auth";
import { bots as botsZhCN } from "./locales/zh-CN/bots";
import { botData as botDataZhCN } from "./locales/zh-CN/bot-data";
import { common as commonZhCN } from "./locales/zh-CN/common";

export const supportedLocales = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export const localeStorageKey = "cos-tool-bot.locale";

export function normalizeLocale(locale: string | null | undefined): SupportedLocale | null {
  if (!locale) return null;

  const normalized = locale.trim().toLowerCase();
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

function readStoredLocale(): SupportedLocale | null {
  try {
    return normalizeLocale(window.localStorage.getItem(localeStorageKey));
  } catch {
    return null;
  }
}

function detectBrowserLocale(): SupportedLocale | null {
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return null;
}

export function detectInitialLocale(): SupportedLocale {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "en";
  return readStoredLocale() ?? detectBrowserLocale() ?? "en";
}

export const i18n: I18nInstance = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: commonEn,
      auth: authEn,
      admin: adminEn,
      bots: botsEn,
      botData: botDataEn,
      aiSettings: aiSettingsEn,
    },
    "zh-CN": {
      common: commonZhCN,
      auth: authZhCN,
      admin: adminZhCN,
      bots: botsZhCN,
      botData: botDataZhCN,
      aiSettings: aiSettingsZhCN,
    },
  },
  lng: detectInitialLocale(),
  fallbackLng: "en",
  supportedLngs: supportedLocales,
  defaultNS: "common",
  fallbackNS: "common",
  initAsync: false,
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
});

function applyLocale(locale: string) {
  const resolvedLocale = normalizeLocale(locale) ?? "en";
  document.documentElement.lang = resolvedLocale;

  try {
    window.localStorage.setItem(localeStorageKey, resolvedLocale);
  } catch {
    // Language still works for this session when storage is unavailable.
  }
}

if (typeof document !== "undefined") {
  applyLocale(i18n.resolvedLanguage ?? i18n.language);
  i18n.on("languageChanged", applyLocale);
}

export function getResolvedLocale(): SupportedLocale {
  return normalizeLocale(i18n.resolvedLanguage ?? i18n.language) ?? "en";
}
