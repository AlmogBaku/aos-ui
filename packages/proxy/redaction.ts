/**
 * Credential-bearing field names, including everything a push subscription and
 * a VAPID pair carry: a subscription endpoint is a bearer capability to wake one
 * device, so it is a credential too. `code` is deliberately absent: it is the
 * classification an operator diagnoses a failure by, and the only credential
 * spelled that way is an OAuth `?code=` query value, which `redactUrl` strips
 * from every logged URL.
 */
const SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|token|accessToken|refreshToken|secret|clientSecret|privateKey|p256dh|auth|applicationServerKey|endpoint)$/iu

function redactUrl(value: string) {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/u, url.pathname === "/" ? "/" : "")
  } catch {
    return value
  }
}

export function redactForLog(
  value: unknown,
  seen = new WeakSet<object>()
): unknown {
  if (value instanceof Error)
    return { name: value.name, message: "Upstream request failed" }
  if (typeof value === "string")
    return /^https?:\/\//u.test(value) ? redactUrl(value) : value
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[REDACTED]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, seen))
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value))
    output[key] = SECRET_KEY.test(key)
      ? "[REDACTED]"
      : redactForLog(child, seen)
  return output
}
