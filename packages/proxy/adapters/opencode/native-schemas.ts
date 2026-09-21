import { z } from "zod"

const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )

const NativeTimeSchema = z.object({
  created: z.number().finite().nonnegative(),
  updated: z.number().finite().nonnegative().optional(),
  archived: z.number().finite().nonnegative().optional(),
})

export const OpenCodeAgentSchema = z.object({
  id: IdentifierSchema,
  description: z.string().max(4_096).optional(),
  mode: z.enum(["subagent", "primary", "all"]),
  hidden: z.boolean(),
  permissions: z.array(z.unknown()),
  request: z.record(z.string(), z.unknown()),
})

export const OpenCodeAgentCatalogSchema = z.object({
  data: z.array(OpenCodeAgentSchema).max(1_000),
})

export const OpenCodeModelRefSchema = z
  .union([
    z.object({
      providerID: IdentifierSchema,
      id: IdentifierSchema,
      variant: z.string().min(1).max(256).optional(),
    }),
    z.object({
      providerID: IdentifierSchema,
      modelID: IdentifierSchema,
      variant: z.string().min(1).max(256).optional(),
    }),
  ])
  .transform((value) => ({
    providerID: value.providerID,
    id: "id" in value ? value.id : value.modelID,
    ...(value.variant === undefined ? {} : { variant: value.variant }),
  }))

export const OpenCodeModelCatalogSchema = z.object({
  data: z
    .array(
      z.object({
        id: IdentifierSchema,
        providerID: IdentifierSchema,
        name: z.string().min(1).max(256),
        enabled: z.boolean(),
        status: z.enum(["alpha", "beta", "deprecated", "active"]),
        limit: z.object({
          context: z.number().int().positive(),
          output: z.number().int().positive(),
        }),
      })
    )
    .max(4_096),
})

export const OpenCodeSessionSchema = z.object({
  id: IdentifierSchema,
  agent: IdentifierSchema.optional(),
  title: z.string().min(1).max(4_096),
  time: NativeTimeSchema,
  model: OpenCodeModelRefSchema.optional(),
  /** Native free-form Session metadata; AOS owns only its own namespaced keys. */
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const OpenCodeSessionCatalogSchema = z.object({
  data: z.array(OpenCodeSessionSchema).max(100),
  cursor: z.object({
    previous: IdentifierSchema.optional(),
    next: IdentifierSchema.optional(),
  }),
})

const NativePromptFileAttachmentSchema = z.object({
  uri: z.string().min(1).max(25_000_000),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(4_096).optional(),
  source: z.unknown().optional(),
})

const NativeMessageTimeSchema = z.object({
  created: z.number().finite().nonnegative(),
})

const NativeToolStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    input: z.string().max(1_000_000),
  }),
  z.object({
    status: z.literal("running"),
    input: z.record(z.string(), z.unknown()),
    structured: z.record(z.string(), z.unknown()),
    content: z.array(z.unknown()).max(2_000),
  }),
  z.object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.unknown()),
    attachments: z.array(NativePromptFileAttachmentSchema).max(16).optional(),
    content: z.array(z.unknown()).max(2_000),
    outputPaths: z.array(z.string().max(4_096)).max(100).optional(),
    structured: z.record(z.string(), z.unknown()),
    result: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.unknown()),
    content: z.array(z.unknown()).max(2_000),
    structured: z.record(z.string(), z.unknown()),
    error: z.unknown(),
  }),
])

const NativeAssistantPartSchema = z.discriminatedUnion("type", [
  z.object({
    id: IdentifierSchema,
    type: z.literal("text"),
    text: z.string().max(1_000_000),
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("reasoning"),
    text: z.string().max(1_000_000),
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("tool"),
    name: IdentifierSchema,
    state: NativeToolStateSchema,
    time: NativeMessageTimeSchema,
  }),
])

export const OpenCodeNativeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    id: IdentifierSchema,
    type: z.literal("user"),
    text: z.string().max(1_000_000),
    files: z.array(NativePromptFileAttachmentSchema).max(16).optional(),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("assistant"),
    agent: IdentifierSchema,
    model: OpenCodeModelRefSchema,
    content: z.array(NativeAssistantPartSchema).max(2_000),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("system"),
    text: z.string().max(1_000_000),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("synthetic"),
    sessionID: IdentifierSchema,
    text: z.string().max(1_000_000),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("compaction"),
    reason: z.enum(["auto", "manual"]),
    summary: z.string().max(1_000_000),
    recent: z.string().max(1_000_000),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("agent-switched"),
    agent: IdentifierSchema,
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("model-switched"),
    model: OpenCodeModelRefSchema,
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("shell"),
    callID: IdentifierSchema,
    command: z.string().max(1_000_000),
    output: z.string().max(1_000_000),
    time: NativeMessageTimeSchema,
  }),
])

export const OpenCodeMessageCatalogSchema = z.object({
  data: z.array(OpenCodeNativeMessageSchema).max(500),
  cursor: z.object({
    previous: IdentifierSchema.optional(),
    next: IdentifierSchema.optional(),
  }),
})

export function parseOpenCodeAgentCatalog(value: unknown) {
  return OpenCodeAgentCatalogSchema.safeParse(value)
}

export function parseOpenCodeSessionCatalog(value: unknown) {
  return OpenCodeSessionCatalogSchema.safeParse(value)
}

export function parseOpenCodeSession(value: unknown) {
  return OpenCodeSessionSchema.safeParse(value)
}

export function parseOpenCodeModelCatalog(value: unknown) {
  return OpenCodeModelCatalogSchema.safeParse(value)
}

export function parseOpenCodeMessageCatalog(value: unknown) {
  return OpenCodeMessageCatalogSchema.safeParse(value)
}
