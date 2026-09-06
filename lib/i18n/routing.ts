import { defaultLocale, isLocale, type Locale } from "./config"

export function getLocaleFromPathname(pathname: string): Locale | null {
  const segment = pathname.split("/")[1]
  return segment && isLocale(segment) ? segment : null
}

export function negotiateLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return defaultLocale

  const requestedLanguages = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [languageRange, ...parameters] = part.trim().split(";")
      const qualityParameter = parameters.find((parameter) =>
        parameter.trim().startsWith("q=")
      )
      const quality = qualityParameter
        ? Number.parseFloat(qualityParameter.trim().slice(2))
        : 1

      return {
        language: languageRange?.split("-")[0]?.toLowerCase() ?? "",
        quality: Number.isFinite(quality) ? quality : 0,
        index,
      }
    })
    .sort((a, b) => b.quality - a.quality || a.index - b.index)

  for (const { language, quality } of requestedLanguages) {
    if (quality <= 0) continue
    if (isLocale(language)) return language
  }

  return defaultLocale
}

export function resolveLocale(
  cookieLocale: string | undefined,
  acceptLanguage: string | null
): Locale {
  return cookieLocale && isLocale(cookieLocale)
    ? cookieLocale
    : negotiateLocale(acceptLanguage)
}

export function stripLocaleFromPathname(pathname: string): string {
  if (!getLocaleFromPathname(pathname)) return pathname
  const [, , ...remainingSegments] = pathname.split("/")
  return remainingSegments.length > 0 ? `/${remainingSegments.join("/")}` : "/"
}

export function localizePathname(pathname: string, locale: Locale): string {
  const normalizedPathname = pathname.startsWith("/")
    ? pathname
    : `/${pathname}`

  return normalizedPathname === "/"
    ? `/${locale}`
    : `/${locale}${normalizedPathname}`
}

export function replaceLocaleInPathname(
  pathname: string,
  locale: Locale
): string {
  const normalizedPathname = pathname.startsWith("/")
    ? pathname
    : `/${pathname}`

  if (!getLocaleFromPathname(normalizedPathname)) {
    return localizePathname(normalizedPathname, locale)
  }

  const [, , ...remainingSegments] = normalizedPathname.split("/")
  const remainder = remainingSegments.join("/")
  return remainder ? `/${locale}/${remainder}` : `/${locale}`
}
