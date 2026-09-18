import { useCallback } from "react"

import type { Locale } from "./config"
import type { Dictionary } from "./dictionary"
import { en } from "./dictionaries/en"
import { he } from "./dictionaries/he"
import { runErrorMessage } from "./run-errors"

/**
 * Both locales ship with the workspace bundle, so copy a runtime root needs
 * before its first paint — a run failure raised while it is still starting — is
 * already localized. Every runtime root reads its dictionary from here.
 */
export const bundledDictionaries: Record<Locale, Dictionary> = { en, he }

/**
 * Localize a normalized run failure. A failure arrives as a stable `AOS_*` code
 * with English provider text: the workspace owns the copy it recognizes and
 * keeps the normalized description for anything else.
 */
export function useRunErrorResolver(
  locale: Locale
): (code: string | undefined, fallback: string) => string {
  return useCallback(
    (code: string | undefined, fallback: string) =>
      runErrorMessage(bundledDictionaries[locale], code, fallback),
    [locale]
  )
}
