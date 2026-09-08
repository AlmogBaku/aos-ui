import type { Locale } from "./config"
import type { Dictionary } from "./dictionary"

const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
  en: () => import("./dictionaries/en").then(({ en }) => en),
  he: () => import("./dictionaries/he").then(({ he }) => he),
}

export function getDictionary(locale: Locale) {
  return dictionaries[locale]()
}
