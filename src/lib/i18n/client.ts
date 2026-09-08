import { localeCookieName, type Locale } from "./config"

export const localeChangeEvent = "aos-ui:locale-change"

export function readPreferredLocale(): Locale | null {
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${localeCookieName}=`))
  const value = match?.slice(localeCookieName.length + 1)
  return value === "en" || value === "he" ? value : null
}

export function setPreferredLocale(locale: Locale) {
  document.cookie = `${localeCookieName}=${locale}; Max-Age=31536000; Path=/; SameSite=Lax`
  window.dispatchEvent(
    new CustomEvent<Locale>(localeChangeEvent, { detail: locale })
  )
}
