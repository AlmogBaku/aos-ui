export const locales = ["en", "he"] as const

export type Locale = (typeof locales)[number]
export type LocaleDirection = "ltr" | "rtl"

export const defaultLocale: Locale = "en"
export const localeRequestHeader = "x-aos-ui-locale"
export const localeCookieName = "aos-ui-locale"

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value)
}

export function getLocaleDirection(locale: Locale): LocaleDirection {
  return locale === "he" ? "rtl" : "ltr"
}
