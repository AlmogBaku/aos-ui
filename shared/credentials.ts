export const REDACTED = "[REDACTED]"

/**
 * A labelled secret (`token=…`, `Authorization: Bearer …`) captures the label
 * and the value apart so only the value is masked; a self-identifying token
 * (`sk-…`, `ghp_…`, a JWT) has no label and is masked whole.
 */
const CREDENTIAL =
  /(\b(?:access[-_]?token|api[-_]?key|auth(?:orization)?|credential|password|secret|token)\s*[=:]\s*["'`]?(?:(?:basic|bearer)\s+)?|\b(?:basic|bearer)\s+)([^\s"'`]+)|\b(?:gh[opsur]_\w+|sk-[\w-]+|xox[baprs]-\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/giu

/** A value that names a secret rather than holding one: `$TOKEN`, `${TOKEN}`, `<token>`, `{token}`. */
export function isCredentialPlaceholder(value: string) {
  return /^[$<{]/u.test(value)
}

/** The text with every credential-shaped secret value replaced by `[REDACTED]`. */
export function redactCredentials(text: string) {
  return text.replace(
    CREDENTIAL,
    (match, label: string | undefined, value: string | undefined) => {
      if (label === undefined || value === undefined) return REDACTED
      return isCredentialPlaceholder(value) ? match : `${label}${REDACTED}`
    }
  )
}

/** True when the text carries a credential-shaped secret value. */
export function containsCredential(text: string) {
  return redactCredentials(text) !== text
}
