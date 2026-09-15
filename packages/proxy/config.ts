import { isAbsolute } from "node:path"
import { z } from "zod"

const AbsoluteSecretFileSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"))

const AbsoluteDirectorySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"))

const HttpUrlSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    try {
      const url = new URL(value)
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        context.addIssue({ code: "custom", message: "Invalid URL" })
        return z.NEVER
      }
      return url.href.replace(/\/$/u, "")
    } catch {
      context.addIssue({ code: "custom", message: "Invalid URL" })
      return z.NEVER
    }
  })

const PublicOriginSchema = HttpUrlSchema.refine((value) => {
  const url = new URL(value)
  return (
    value === url.origin &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  )
})

const WebSocketUrlSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    try {
      const url = new URL(value)
      if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        context.addIssue({ code: "custom", message: "Invalid URL" })
        return z.NEVER
      }
      return url.href.replace(/\/$/u, "")
    } catch {
      context.addIssue({ code: "custom", message: "Invalid URL" })
      return z.NEVER
    }
  })

const ListenerSchema = z.union([
  z.strictObject({
    host: z.enum(["127.0.0.1", "::1"]),
    port: z.number().int().min(1).max(65535),
  }),
  z.strictObject({
    host: z.enum(["0.0.0.0", "::"]),
    port: z.number().int().min(1).max(65535),
    exposure: z.literal("private-container"),
  }),
])

const SecretKeySchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  secretFile: AbsoluteSecretFileSchema,
})

const UniqueSecretKeysSchema = z
  .array(SecretKeySchema)
  .min(1)
  .max(3)
  .refine((keys) => new Set(keys.map(({ id }) => id)).size === keys.length)

const LimitsSchema = z.strictObject({
  activeExecutions: z.number().int().min(1).max(4096),
  guestActiveExecutions: z.number().int().min(1).max(4096),
  operatorEventPeers: z.number().int().min(1).max(4096),
  subscriberEvents: z.number().int().min(1).max(16_384),
  subscriberBytes: z
    .number()
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024),
})

const RuntimeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)

const RuntimeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: RuntimeIdSchema,
    kind: z.literal("hermes"),
    baseUrl: HttpUrlSchema,
    tokenFile: AbsoluteSecretFileSchema,
    sessionIdleMs: z.number().int().min(1_000).max(86_400_000),
  }),
  z.strictObject({
    id: RuntimeIdSchema,
    kind: z.literal("opencode"),
    baseUrl: HttpUrlSchema,
    directory: AbsoluteDirectorySchema,
    username: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !value.includes(":") &&
          [...value].every((character) => {
            const code = character.charCodeAt(0)
            return code >= 32 && code !== 127
          })
      ),
    passwordFile: AbsoluteSecretFileSchema,
  }),
  z.strictObject({
    id: RuntimeIdSchema,
    kind: z.literal("openclaw"),
    baseUrl: WebSocketUrlSchema,
    deviceIdentityFile: AbsoluteSecretFileSchema,
    deviceTokenFile: AbsoluteSecretFileSchema,
  }),
])

const ProxyConfigSchema = z
  .strictObject({
    version: z.literal(1),
    deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    listen: ListenerSchema,
    publicOrigin: PublicOriginSchema,
    runtime: RuntimeSchema,
    events: z.strictObject({
      activeKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
      keys: UniqueSecretKeysSchema,
    }),
    limits: LimitsSchema,
    guest: z
      .strictObject({
        listen: ListenerSchema,
        publicOrigin: PublicOriginSchema,
        invitations: z.strictObject({
          keys: UniqueSecretKeysSchema,
          ttlSeconds: z.number().int().min(60).max(2_592_000).default(259_200),
          clockSkewSeconds: z.number().int().min(0).max(60).default(0),
        }),
      })
      .optional(),
    shutdownGraceMs: z.number().int().min(100).max(300_000),
  })
  .superRefine((config, context) => {
    if (!config.events.keys.some(({ id }) => id === config.events.activeKeyId))
      context.addIssue({
        code: "custom",
        path: ["events", "activeKeyId"],
        message: "Unknown active key",
      })
    if (config.limits.guestActiveExecutions > config.limits.activeExecutions)
      context.addIssue({
        code: "custom",
        path: ["limits", "guestActiveExecutions"],
        message: "Guest limit exceeds global limit",
      })
    if (
      config.guest &&
      (config.guest.publicOrigin === config.publicOrigin ||
        (config.guest.listen.host === config.listen.host &&
          config.guest.listen.port === config.listen.port))
    )
      context.addIssue({
        code: "custom",
        path: ["guest"],
        message: "Guest lane must use a separate origin and listener",
      })
  })

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>
export type RuntimeConfig = ProxyConfig["runtime"]
export type RuntimeLimits = ProxyConfig["limits"]

export function parseGuestComposerSlashCommandsEnabled(
  value: string | undefined
) {
  return value?.trim().toLowerCase() === "true"
}

/** Parser issues are hidden because rejected input may contain secrets. */
export function parseProxyConfig(input: unknown): ProxyConfig {
  const result = ProxyConfigSchema.safeParse(input)
  if (!result.success) throw new Error("Invalid proxy configuration")
  return result.data
}
