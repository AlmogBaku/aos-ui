const SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|token|accessToken|refreshToken|secret|clientSecret|code)$/iu

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
