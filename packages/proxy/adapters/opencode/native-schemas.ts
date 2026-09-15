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

export const OpenCodeModelRefSchema = z.object({
  providerID: IdentifierSchema,
  modelID: IdentifierSchema,
  variant: z.string().min(1).max(256).optional(),
})

export const OpenCodeSessionSchema = z.object({
  id: IdentifierSchema,
  agent: IdentifierSchema.optional(),
  title: z.string().min(1).max(4_096),
  time: NativeTimeSchema,
  model: OpenCodeModelRefSchema.optional(),
})

export const OpenCodeSessionCatalogSchema = z.object({
  data: z.array(OpenCodeSessionSchema).max(100),
  cursor: z.object({
    previous: IdentifierSchema.optional(),
    next: IdentifierSchema.optional(),
  }),
})

const NativeFileSchema = z.object({
  mime: z.string().min(1).max(255),
  filename: z.string().min(1).max(255).optional(),
  url: z.string().min(1).max(25_000_000),
})

const NativeToolStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    input: z.record(z.string(), z.unknown()),
    raw: z.string().max(1_000_000),
  }),
  z.object({
    status: z.literal("running"),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.unknown()),
    output: z.string().max(1_000_000),
    result: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.unknown()),
    error: z.string().max(1_000_000),
    result: z.unknown().optional(),
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
    callID: IdentifierSchema,
    tool: IdentifierSchema,
    state: NativeToolStateSchema,
  }),
])

const NativeMessageTimeSchema = z.object({
  created: z.number().finite().nonnegative(),
})

export const OpenCodeNativeMessageSchema = z.discriminatedUnion("type", [
  z.object({
    id: IdentifierSchema,
    type: z.literal("user"),
    text: z.string().max(1_000_000),
    files: z.array(NativeFileSchema).max(16).optional(),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("assistant"),
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
    text: z.string().max(1_000_000),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("compaction"),
    summary: z.string().max(1_000_000),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("agent-switched"),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("model-switched"),
    time: NativeMessageTimeSchema,
  }),
  z.object({
    id: IdentifierSchema,
    type: z.literal("shell"),
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

export const OpenCodeTodoSchema = z.object({
  content: z.string().min(1).max(4_096),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.string().max(64),
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

export function parseOpenCodeMessageCatalog(value: unknown) {
  return OpenCodeMessageCatalogSchema.safeParse(value)
}

export function parseOpenCodeTodos(value: unknown) {
  return z.array(OpenCodeTodoSchema).max(10_000).safeParse(value)
}
