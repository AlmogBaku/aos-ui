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

export function isHttpsOrLoopback(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
  )
}

const PublicOriginSchema = HttpUrlSchema.refine((value) => {
  const url = new URL(value)
  return value === url.origin && isHttpsOrLoopback(url)
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

/** VAPID `sub`: the contact a push service can reach an operator at. */
const VapidSubjectSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      return ["mailto:", "https:"].includes(new URL(value).protocol)
    } catch {
      return false
    }
  })

/**
 * Optional Web Push deployment: where subscriptions are kept, and the VAPID
 * identity they are signed with. The public key is derived from the private one
 * on startup rather than configured, so the two halves cannot disagree.
 */
const PushSchema = z.strictObject({
  stateDir: AbsoluteDirectorySchema,
  vapid: z.strictObject({
    subject: VapidSubjectSchema,
    privateKeyFile: AbsoluteSecretFileSchema,
  }),
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

/** Fields every speech direction shares, whichever provider kind serves it. */
const VoiceProviderFields = {
  provider: z.literal("openai-compatible"),
  baseUrl: HttpUrlSchema,
  apiKeyFile: AbsoluteSecretFileSchema.optional(),
  model: z.string().min(1).max(256),
  mode: z.enum(["fallback", "override"]).default("fallback"),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
}

const VoiceTranscriptionVariantSchema = z.strictObject({
  ...VoiceProviderFields,
  language: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/u)
    .optional(),
})

const VoiceTranscriptionSchema = z.discriminatedUnion("provider", [
  VoiceTranscriptionVariantSchema,
])

const VoiceSpeechVariantSchema = z.strictObject({
  ...VoiceProviderFields,
  voice: z.string().min(1).max(128),
  format: z.enum(["mp3", "opus", "wav", "flac"]).default("mp3"),
})

const VoiceSpeechSchema = z.discriminatedUnion("provider", [
  VoiceSpeechVariantSchema,
])

const VoiceSchema = z
  .strictObject({
    transcription: VoiceTranscriptionSchema.optional(),
    speech: VoiceSpeechSchema.optional(),
  })
  .superRefine((voice, context) => {
    if (voice.transcription === undefined && voice.speech === undefined)
      context.addIssue({
        code: "custom",
        message: "At least one of transcription or speech must be present",
      })
    if (
      voice.transcription?.apiKeyFile !== undefined &&
      !isHttpsOrLoopback(new URL(voice.transcription.baseUrl))
    )
      context.addIssue({
        code: "custom",
        path: ["transcription", "baseUrl"],
        message:
          "baseUrl must be HTTPS or loopback when apiKeyFile is configured",
      })
    if (
      voice.speech?.apiKeyFile !== undefined &&
      !isHttpsOrLoopback(new URL(voice.speech.baseUrl))
    )
      context.addIssue({
        code: "custom",
        path: ["speech", "baseUrl"],
        message:
          "baseUrl must be HTTPS or loopback when apiKeyFile is configured",
      })
  })

/** An HTTP field name: RFC 9110 token characters only. */
const HeaderNameSchema = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/u)

/**
 * How the MCP Apps fallback reaches one MCP server, keyed by the server name
 * the runtime reports. `url` replaces the URL the runtime reports, for a proxy
 * that reaches the server at a different address than the harness does, such
 * as a Compose service name. Each header value is the whole contents of its
 * file, so a credential never sits in configuration.
 */
const McpAppsServerSchema = z
  .strictObject({
    url: HttpUrlSchema.optional(),
    headers: z
      .record(
        HeaderNameSchema,
        z.strictObject({ file: AbsoluteSecretFileSchema })
      )
      .refine((headers) => Object.keys(headers).length > 0)
      .optional(),
  })
  .superRefine((server, context) => {
    if (server.url === undefined && server.headers === undefined)
      context.addIssue({
        code: "custom",
        message: "At least one of url or headers must be present",
      })
    if (
      server.url !== undefined &&
      server.headers !== undefined &&
      !isHttpsOrLoopback(new URL(server.url))
    )
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "url must be HTTPS or loopback when headers are configured",
      })
  })

const McpAppsSchema = z.strictObject({
  fallback: z.strictObject({
    servers: z.record(z.string().min(1).max(256), McpAppsServerSchema),
  }),
})

export const ProxyConfigSchema = z
  .strictObject({
    version: z.literal(1),
    deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    listen: ListenerSchema,
    publicOrigin: PublicOriginSchema,
    runtime: RuntimeSchema,
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
    push: PushSchema.optional(),
    voice: VoiceSchema.optional(),
    mcpApps: McpAppsSchema.optional(),
    shutdownGraceMs: z.number().int().min(100).max(300_000),
  })
  .superRefine((config, context) => {
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
export type VoiceConfig = NonNullable<ProxyConfig["voice"]>
export type McpAppsConfig = NonNullable<ProxyConfig["mcpApps"]>
export type VoiceTranscriptionConfig = NonNullable<VoiceConfig["transcription"]>
export type VoiceSpeechConfig = NonNullable<VoiceConfig["speech"]>

/** Parser issues are hidden because rejected input may contain secrets. */
export function parseProxyConfig(input: unknown): ProxyConfig {
  const result = ProxyConfigSchema.safeParse(input)
  if (!result.success) throw new Error("Invalid proxy configuration")
  return result.data
}
