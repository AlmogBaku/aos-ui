/** The largest artifact the proxy reads back for the browser. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

const MAX_PATH_BYTES = 4_096

/**
 * Names that hold credentials or pairing state, ported from the retired Hermes
 * artifact publisher. Every path component is held to them, so neither a file
 * nor a directory by one of these names can be published.
 */
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  "auth.json",
  "auth.lock",
  "credentials",
  "config.yaml",
  ".anthropic_oauth.json",
  "google_token.json",
  "google_oauth_pending.json",
  "google_oauth.json",
  "webhook_subscriptions.json",
  "bws_cache.json",
  "bws_cache.enc.json",
  ".git-credentials",
  ".env",
  ".envrc",
  "mcp-tokens",
  "pairing",
])

function sensitive(component: string) {
  const lowered = component.toLowerCase()
  return SENSITIVE_NAMES.has(lowered) || lowered.startsWith(".env.")
}

/** `path` when every component passes the shared rules, else `undefined`. */
function checkedPath(path: string) {
  if (
    new TextEncoder().encode(path).length > MAX_PATH_BYTES ||
    [...path].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    return undefined
  return path
    .split(/[\\/]/u)
    .some((component) => component === ".." || sensitive(component))
    ? undefined
    : path
}

/**
 * The native path an artifact may be read from, or `undefined` when it is not
 * absolute POSIX, traverses, carries a control character, is overlong, or
 * names anything sensitive. A backslash counts as a separator for these checks.
 */
export function safeArtifactPath(path: string): string | undefined {
  return path.startsWith("/") ? checkedPath(path) : undefined
}

/**
 * The same rules for a path the provider resolves against its own working
 * directory: it must be non-empty and neither rooted nor drive-qualified.
 */
export function safeRelativeArtifactPath(path: string): string | undefined {
  return path && !/^(?:[\\/]|[A-Za-z]:)/u.test(path)
    ? checkedPath(path)
    : undefined
}
