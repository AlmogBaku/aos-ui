import type { Dictionary } from "./dictionary"

export type RunErrorCode = keyof Dictionary["runErrors"]

/**
 * Normalized run failures carry a stable `AOS_*` code with English provider
 * text. The workspace prefers its own localized copy and keeps the normalized
 * description for a code this build does not know.
 */
export function runErrorMessage(
  dictionary: Dictionary,
  code: string | undefined,
  fallback: string
) {
  // Only an own key is a code this build knows: an inherited object key must
  // keep the normalized description like any unknown code.
  return code !== undefined && Object.hasOwn(dictionary.runErrors, code)
    ? dictionary.runErrors[code as RunErrorCode]
    : fallback
}
