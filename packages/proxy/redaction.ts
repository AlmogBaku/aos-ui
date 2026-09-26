/** What every masked field, URL credential, and credential value becomes. */
const REDACTED = "[REDACTED]"

/**
 * Every word a native field or variable name uses for a credential, lowercase
 * with separators removed (`api_key` and `apiKey` are both `apikey`). The log
 * redactor masks a field whose name ends in one, and the adapters mask tool
 * data, question text, and history by the same list. `code` is deliberately
 * absent: it is the classification an operator diagnoses a failure by, and the
 * only credential spelled that way is an OAuth `?code=` query value, which
 * every logged URL loses.
 */
export const SECRET_TERMS: readonly string[] = [
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "clientsecret",
  "cookie",
  "cookiejar",
  "credential",
  "credentials",
  "pass",
  "passcode",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "refreshtoken",
  "secret",
  "secretkey",
  "setcookie",
  "token",
]

/**
 * The names a push subscription and a VAPID pair carry, which a log masks by
 * exact name: a subscription endpoint is a bearer capability to wake one
 * device. They stay out of `SECRET_TERMS`, because matched as a suffix they
 * would drop ordinary provider fields such as `apiEndpoint` from
 * browser-bound data.
 */
const PUSH_KEYS = new Set(["applicationserverkey", "endpoint", "p256dh"])

/** Whether a logged field name spells a credential, in any case or separator style. */
function isSecretKey(key: string) {
  const normalized = key.toLowerCase().replace(/[-_ ]/gu, "")
  return (
    PUSH_KEYS.has(normalized) ||
    SECRET_TERMS.some((term) => normalized.endsWith(term))
  )
}

/**
 * A URL of any scheme inside text. It stops at whitespace, a quote, an angle
 * bracket, or a backslash, so inside a serialized JSON line it never reaches
 * past its own string.
 */
const URL_IN_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>\\]+/giu

/**
 * `text` with every URL's userinfo, query, and fragment removed, whatever its
 * scheme: `wss://h/api/ws?token=abc` is logged as `wss://h/api/ws`. The whole
 * query goes rather than a list of credential parameters, because each native
 * server names its own.
 */
export function redactText(text: string) {
  return text.replace(URL_IN_TEXT, (url) =>
    url
      .replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/iu, "$1")
      .replace(/[?#].*$/u, "")
  )
}

/**
 * An error as a log reads it: its name and redacted message, the `code` or
 * `reason` a native failure is classified by, and its cause chain. The stack
 * stays out: it names deployment paths and says nothing an operator acts on.
 */
function serializeError(error: Error, seen: WeakSet<object>) {
  const { code, reason } = error as { code?: unknown; reason?: unknown }
  return {
    name: error.name,
    message: redactText(error.message),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
    ...(error.cause === undefined
      ? {}
      : { cause: redactForLog(error.cause, seen) }),
  }
}

export function redactForLog(
  value: unknown,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "string") return redactText(value)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return REDACTED
  seen.add(value)
  if (value instanceof Error) return serializeError(value, seen)
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, seen))
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value))
    output[key] = isSecretKey(key) ? REDACTED : redactForLog(child, seen)
  return output
}

/**
 * Every credential value the proxy has read, which no log line carries
 * verbatim, whatever field, message, or error it arrives in. A value is known
 * in each form it travels in (a password and its Basic header form, say) and
 * in its JSON-escaped spelling, and a rotated value joins its predecessor
 * rather than replacing it, since a late error can still quote the old one.
 */
export class CredentialValues {
  readonly #values = new Set<string>()

  /** Wraps a credential reader so every value it reads, a re-read included, is known. */
  register<A extends unknown[], T>(
    read: (...args: A) => Promise<T>,
    forms: (value: T) => readonly string[]
  ): (...args: A) => Promise<T> {
    return async (...args) => {
      const value = await read(...args)
      for (const form of forms(value))
        if (form !== "")
          this.#values.add(form).add(JSON.stringify(form).slice(1, -1))
      return value
    }
  }

  /** `text` with every known value, longest first, as `[REDACTED]`. */
  scrub(text: string) {
    return [...this.#values]
      .sort((left, right) => right.length - left.length)
      .reduce((scrubbed, value) => scrubbed.replaceAll(value, REDACTED), text)
  }
}
