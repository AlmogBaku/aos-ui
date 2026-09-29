import type { SessionPlatform } from "../../protocol"

const PLATFORMS = new Set<SessionPlatform>([
  "buzz",
  "whatsapp",
  "slack",
  "telegram",
  "email",
  "discord",
])

/**
 * Maps a native platform/source/channel string to a `SessionPlatform`, or
 * returns `undefined` for unknown or absent values. `whatsapp_cloud` is
 * normalized to `whatsapp`; any unlisted or non-string value is silently
 * absent rather than an error.
 */
export function sessionPlatform(native: unknown): SessionPlatform | undefined {
  if (typeof native !== "string") return undefined
  const lower = native.toLowerCase()
  if (lower === "whatsapp_cloud") return "whatsapp"
  return PLATFORMS.has(lower as SessionPlatform)
    ? (lower as SessionPlatform)
    : undefined
}
