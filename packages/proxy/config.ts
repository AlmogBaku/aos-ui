import { isAbsolute } from "node:path"
import { z } from "zod"

const AbsoluteSecretFileSchema = z
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

const SecretKeySchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  secretFile: AbsoluteSecretFileSchema,
})

const UniqueSecretKeysSchema = z
  .array(SecretKeySchema)
  .min(1)
  .max(2)
  .refine((keys) => new Set(keys.map(({ id }) => id)).size === keys.length)

const HttpsOriginSchema = HttpUrlSchema.refine((value) => {
  const url = new URL(value)
  return url.protocol === "https:" && value === url.origin
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

const ProxyConfigSchema = z
  .strictObject({
    version: z.literal(1),
    listen: ListenerSchema,
    publicOrigin: PublicOriginSchema,
    operator: z.strictObject({
      issuer: HttpsOriginSchema,
      clientId: z.string().min(1).max(256),
      clientSecretFile: AbsoluteSecretFileSchema,
      principalHmacKeyFile: AbsoluteSecretFileSchema,
      redirectUri: HttpUrlSchema,
      allowedSubjects: z
        .array(z.string().min(1).max(256))
        .min(1)
        .max(256)
        .refine((values) => new Set(values).size === values.length),
      session: z.strictObject({
        deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
        keys: UniqueSecretKeysSchema.max(2),
        ttlSeconds: z.number().int().min(60).max(86_400).default(900),
      }),
    }),
    hermes: z.strictObject({
      baseUrl: HttpUrlSchema,
      auth: z.discriminatedUnion("mode", [
        z.strictObject({
          mode: z.literal("static-token"),
          tokenFile: AbsoluteSecretFileSchema,
        }),
        z.strictObject({
          mode: z.literal("browser-broker"),
          callbackUrl: HttpUrlSchema,
          allowedIdentityOrigins: z
            .array(HttpsOriginSchema)
            .min(1)
            .max(64)
            .refine((values) => new Set(values).size === values.length),
          provider: z.string().min(1).max(128).optional(),
        }),
      ]),
    }),
    events: z.strictObject({
      activeKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
      keys: UniqueSecretKeysSchema,
    }),
    guest: z
      .strictObject({
        listen: ListenerSchema,
        publicOrigin: HttpsOriginSchema,
        hermes: z.strictObject({
          baseUrl: HttpUrlSchema,
          tokenFile: AbsoluteSecretFileSchema,
        }),
        invitations: z.strictObject({
          keys: UniqueSecretKeysSchema,
          ttlSeconds: z.number().int().min(60).max(3_600).default(300),
          clockSkewSeconds: z.number().int().min(0).max(60).default(0),
        }),
      })
      .optional(),
    shutdownGraceMs: z.number().int().min(100).max(300_000),
  })
  .superRefine((config, context) => {
    const expectedOperatorCallback = `${config.publicOrigin}/api/aos/v1/auth/operator/callback`
    if (config.operator.redirectUri !== expectedOperatorCallback)
      context.addIssue({
        code: "custom",
        path: ["operator", "redirectUri"],
        message: "Invalid callback URL",
      })
    if (
      config.hermes.auth.mode === "browser-broker" &&
      config.hermes.auth.callbackUrl !==
        `${config.publicOrigin}/api/aos/v1/auth/runtime/upstream/auth/callback`
    )
      context.addIssue({
        code: "custom",
        path: ["hermes", "auth", "callbackUrl"],
        message: "Invalid callback URL",
      })
    if (!config.events.keys.some(({ id }) => id === config.events.activeKeyId))
      context.addIssue({
        code: "custom",
        path: ["events", "activeKeyId"],
        message: "Unknown active key",
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

/** Guest composer discovery is opt-in; this does not control runtime commands. */
export function parseGuestComposerSlashCommandsEnabled(
  value?: string
): boolean {
  return value?.trim().toLowerCase() === "true"
}

/** Parser issues are deliberately hidden because rejected input may contain secrets. */
export function parseProxyConfig(input: unknown): ProxyConfig {
  const result = ProxyConfigSchema.safeParse(input)
  if (!result.success) throw new Error("Invalid proxy configuration")
  return result.data
}
