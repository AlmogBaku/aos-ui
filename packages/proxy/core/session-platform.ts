import { SessionPlatformSchema, type SessionPlatform } from "../../protocol"

/**
 * The platform a native Session came from, or `undefined` for anything AOS
 * does not draw: its own Sessions, CLI, cron, and unlisted platforms.
 */
export function sessionPlatform(native: unknown): SessionPlatform | undefined {
  if (typeof native !== "string") return undefined
  const lower = native.toLowerCase()
  return SessionPlatformSchema.safeParse(
    lower === "whatsapp_cloud" ? "whatsapp" : lower
  ).data
}
