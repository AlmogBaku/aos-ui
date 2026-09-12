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

const ProxyConfigSchema = z.strictObject({
  version: z.literal(1),
  listen: z.union([
    z.strictObject({
      host: z.enum(["127.0.0.1", "::1"]),
      port: z.number().int().min(1).max(65535),
    }),
    z.strictObject({
      host: z.enum(["0.0.0.0", "::"]),
      port: z.number().int().min(1).max(65535),
      exposure: z.literal("private-container"),
    }),
  ]),
  publicOrigin: HttpUrlSchema,
  operator: z.strictObject({
    issuer: HttpUrlSchema.refine((value) => value.startsWith("https://")),
    clientId: z.string().min(1).max(256),
    clientSecretFile: AbsoluteSecretFileSchema,
    redirectUri: HttpUrlSchema,
    allowedSubjects: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(256)
      .refine((values) => new Set(values).size === values.length),
  }),
  hermes: z.strictObject({
    baseUrl: HttpUrlSchema,
    auth: z.discriminatedUnion("mode", [
      z.strictObject({
        mode: z.literal("static-token"),
        tokenFile: AbsoluteSecretFileSchema,
      }),
      z.strictObject({ mode: z.literal("browser-broker") }),
    ]),
  }),
  shutdownGraceMs: z.number().int().min(100).max(300_000),
})

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>

/** Parser issues are deliberately hidden because rejected input may contain secrets. */
export function parseProxyConfig(input: unknown): ProxyConfig {
  const result = ProxyConfigSchema.safeParse(input)
  if (!result.success) throw new Error("Invalid proxy configuration")
  return result.data
}
