import type { GuestAuthorization, GuestCapability } from "./guest-invitation"
import { guestCapabilities, guestOperations } from "./guest-invitation"

const MAX_INPUT_BYTES = 65_536
const MAX_OUTPUT_BYTES = 32_768
const MAX_DEPTH = 8
const MAX_NODES = 1_024
const MAX_ARRAY_ITEMS = 64
const MAX_OBJECT_KEYS = 32
const MAX_STRING_BYTES = 32_768

const envelopeKeys = [
  "transport",
  "agentId",
  "sessionId",
  "payload",
  "nativeMetadata",
  "providerPath",
  "liveId",
  "nativePosition",
] as const

const messageKeys = [
  "type",
  "role",
  "text",
  "customUi",
  "attachments",
  "artifacts",
  "reasoning",
  "rawToolArguments",
  "rawToolResult",
  "approval",
  "nativeMetadata",
  "providerPath",
  "liveId",
  "nativePosition",
] as const

const metadataKeys = [
  "name",
  "mediaType",
  "sizeBytes",
  "digest",
  "id",
  "path",
  "url",
  "providerPath",
  "nativeMetadata",
  "liveId",
  "nativePosition",
] as const

const errorKeys = [
  "type",
  "code",
  "description",
  "message",
  "retryable",
  "stack",
  "details",
  "nativeMetadata",
  "providerPath",
  "liveId",
  "nativePosition",
] as const

const interruptPayloadKeys = ["type", "interrupts"] as const
const interruptKeys = [
  "id",
  "reason",
  "message",
  "expiresAt",
  "responseSchema",
  "metadata",
] as const

type Transport = "rest" | "ag-ui" | "ws" | "artifact" | "error"

const publicErrorCodes = [
  "AOS_CONNECTION_INTERRUPTED",
  "AOS_INTERACTION_UNCERTAIN",
  "AOS_SEND_UNCERTAIN",
  "forbidden",
  "not_found",
  "rate_limited",
  "request_failed",
  "temporarily_unavailable",
] as const

export type GuestPublicErrorCode = (typeof publicErrorCodes)[number]

const publicErrorDescriptions: Record<GuestPublicErrorCode, string> = {
  AOS_CONNECTION_INTERRUPTED:
    "The connection was interrupted. Reconnect to continue.",
  AOS_INTERACTION_UNCERTAIN:
    "The response may have been accepted. Reconnect to confirm.",
  AOS_SEND_UNCERTAIN:
    "The message may have been accepted. Reconnect to confirm.",
  forbidden: "You do not have permission to do that.",
  not_found: "The requested item was not found.",
  rate_limited: "Too many requests. Please try again shortly.",
  request_failed: "The request could not be completed.",
  temporarily_unavailable:
    "The service is temporarily unavailable. Please try again.",
}

export function guestErrorDescription(code: GuestPublicErrorCode) {
  return publicErrorDescriptions[code]
}

export type GuestSafeMetadata = {
  name: string
  mediaType: string
  sizeBytes: number
  digest?: string
}

export type GuestSafeCustomUi = {
  type: "card" | "status" | "list"
  title?: string
  text?: string
  items?: readonly string[]
}

export type GuestSafeInterrupt = {
  id: string
  reason: string
  message?: string
  responseSchema: Record<string, unknown>
}

export type GuestOutboundProjection = {
  transport: Transport
  agentId: string
  sessionId?: string
  payload:
    | {
        type: "message"
        role: "assistant" | "guest"
        text?: string
        customUi?: GuestSafeCustomUi
        attachments?: readonly GuestSafeMetadata[]
        artifacts?: readonly GuestSafeMetadata[]
      }
    | ({ type: "artifact" } & GuestSafeMetadata)
    | {
        type: "interrupt"
        interrupts: readonly GuestSafeInterrupt[]
      }
    | {
        type: "error"
        code: GuestPublicErrorCode
        description?: string
        retryable: boolean
      }
}

type Budget = {
  bytes: number
  nodes: number
  seen: WeakSet<object>
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function inspectJson(value: unknown, depth: number, budget: Budget): boolean {
  budget.nodes += 1
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) return false
  if (value === null || typeof value === "boolean") {
    budget.bytes += value === null ? 4 : value ? 4 : 5
    return budget.bytes <= MAX_INPUT_BYTES
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false
    budget.bytes += String(value).length
    return budget.bytes <= MAX_INPUT_BYTES
  }
  if (typeof value === "string") {
    const bytes = utf8Bytes(value)
    if (bytes > MAX_STRING_BYTES) return false
    budget.bytes += bytes
    return budget.bytes <= MAX_INPUT_BYTES
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS || budget.seen.has(value)) return false
    budget.seen.add(value)
    budget.bytes += 2 + value.length
    for (const item of value) {
      if (!inspectJson(item, depth + 1, budget)) return false
    }
    return budget.bytes <= MAX_INPUT_BYTES
  }
  if (!plainRecord(value) || budget.seen.has(value)) return false
  budget.seen.add(value)
  const keys = Reflect.ownKeys(value)
  if (
    keys.length > MAX_OBJECT_KEYS ||
    keys.some((key) => typeof key !== "string")
  )
    return false
  budget.bytes += 2 + keys.length
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) return false
    budget.bytes += utf8Bytes(key)
    if (!inspectJson(descriptor.value, depth + 1, budget)) return false
  }
  return budget.bytes <= MAX_INPUT_BYTES
}

function exactKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
) {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Bytes(value) <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
}

function validText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    utf8Bytes(value) > 0 &&
    utf8Bytes(value) <= maximumBytes
  )
}

function validScope<T extends string>(
  value: readonly T[],
  allowed: readonly T[]
) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= allowed.length &&
    value.every((item) => allowed.includes(item)) &&
    new Set(value).size === value.length
  )
}

function hasCapability(
  authorization: GuestAuthorization,
  capability: GuestCapability
) {
  return authorization.capabilities.includes(capability)
}

function validAuthorization(authorization: GuestAuthorization) {
  return (
    plainRecord(authorization) &&
    authorization.version === 1 &&
    authorization.lane === "guest" &&
    validIdentifier(authorization.runtimeId) &&
    validIdentifier(authorization.agentId) &&
    (authorization.sessionId === undefined ||
      validIdentifier(authorization.sessionId)) &&
    guestOperations.includes(authorization.operation) &&
    validScope(authorization.capabilities, guestCapabilities)
  )
}

function projectCustomUi(value: unknown): GuestSafeCustomUi | undefined {
  if (
    !plainRecord(value) ||
    !exactKnownKeys(value, ["type", "title", "text", "items"])
  )
    return undefined
  if (!(["card", "status", "list"] as const).includes(value.type as never))
    return undefined
  if (value.title !== undefined && !validText(value.title, 2_048))
    return undefined
  if (value.text !== undefined && !validText(value.text, 8_192))
    return undefined
  if (
    value.items !== undefined &&
    (!Array.isArray(value.items) ||
      value.items.length > 32 ||
      value.items.some((item) => !validText(item, 2_048)))
  )
    return undefined
  return {
    type: value.type as GuestSafeCustomUi["type"],
    ...(value.title === undefined ? {} : { title: value.title as string }),
    ...(value.text === undefined ? {} : { text: value.text as string }),
    ...(value.items === undefined
      ? {}
      : { items: [...(value.items as string[])] }),
  }
}

function projectMetadata(
  value: unknown,
  allowDigest: boolean,
  allowType = false
): GuestSafeMetadata | undefined {
  if (
    !plainRecord(value) ||
    !exactKnownKeys(value, allowType ? ["type", ...metadataKeys] : metadataKeys)
  )
    return undefined
  if (
    !validText(value.name, 512) ||
    typeof value.mediaType !== "string" ||
    utf8Bytes(value.mediaType) > 128 ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(value.mediaType) ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > 10_000_000_000 ||
    (value.digest !== undefined &&
      (!allowDigest ||
        typeof value.digest !== "string" ||
        !/^sha256:[a-f0-9]{6,64}$/u.test(value.digest)))
  )
    return undefined
  return {
    name: value.name,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
    ...(value.digest === undefined ? {} : { digest: value.digest as string }),
  }
}

function projectMetadataList(value: unknown, allowDigest: boolean) {
  if (!Array.isArray(value) || value.length > 16) return undefined
  const projected: GuestSafeMetadata[] = []
  for (const item of value) {
    const metadata = projectMetadata(item, allowDigest)
    if (!metadata) return undefined
    projected.push(metadata)
  }
  return projected
}

function projectMessage(
  value: Record<string, unknown>,
  authorization: GuestAuthorization
): GuestOutboundProjection["payload"] | undefined {
  if (!exactKnownKeys(value, messageKeys) || value.type !== "message")
    return undefined
  if (value.role !== "assistant" && value.role !== "guest") return undefined
  if (value.text !== undefined && !validText(value.text, 16_384))
    return undefined
  const customUi =
    value.customUi === undefined ? undefined : projectCustomUi(value.customUi)
  if (value.customUi !== undefined && !customUi) return undefined
  const attachments =
    value.attachments === undefined
      ? undefined
      : projectMetadataList(value.attachments, false)
  if (value.attachments !== undefined && !attachments) return undefined
  const artifacts =
    value.artifacts === undefined
      ? undefined
      : projectMetadataList(value.artifacts, true)
  if (value.artifacts !== undefined && !artifacts) return undefined
  if (
    authorization.operation !== "messages:read" &&
    authorization.operation !== "attachments:read" &&
    authorization.operation !== "artifacts:read"
  )
    return undefined

  const output = {
    type: "message" as const,
    role: value.role as "assistant" | "guest",
    ...(value.text !== undefined &&
    authorization.operation === "messages:read" &&
    hasCapability(authorization, "message-text")
      ? { text: value.text }
      : {}),
    ...(customUi &&
    authorization.operation === "messages:read" &&
    hasCapability(authorization, "custom-ui")
      ? { customUi }
      : {}),
    ...(attachments &&
    authorization.operation === "attachments:read" &&
    hasCapability(authorization, "attachment-metadata")
      ? { attachments }
      : {}),
    ...(artifacts &&
    authorization.operation === "artifacts:read" &&
    hasCapability(authorization, "artifact-metadata")
      ? { artifacts }
      : {}),
  }
  return Object.keys(output).length > 2 ? output : undefined
}

function projectArtifact(
  value: Record<string, unknown>,
  authorization: GuestAuthorization
): GuestOutboundProjection["payload"] | undefined {
  if (
    value.type !== "artifact" ||
    authorization.operation !== "artifacts:read" ||
    !hasCapability(authorization, "artifact-metadata")
  )
    return undefined
  const metadata = projectMetadata(value, true, true)
  if (!metadata) return undefined
  return { type: "artifact", ...metadata }
}

function projectJsonSchema(
  value: unknown,
  depth = 0
): Record<string, unknown> | undefined {
  if (!plainRecord(value) || depth > 6) return undefined
  const allowed = [
    "type",
    "title",
    "enum",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minLength",
    "maxLength",
  ] as const
  if (!exactKnownKeys(value, allowed)) return undefined
  if (
    typeof value.type !== "string" ||
    ![
      "array",
      "boolean",
      "integer",
      "null",
      "number",
      "object",
      "string",
    ].includes(value.type)
  )
    return undefined
  const output: Record<string, unknown> = { type: value.type }
  if (value.title !== undefined) {
    if (!validText(value.title, 2_048)) return undefined
    output.title = value.title
  }
  if (value.enum !== undefined) {
    if (
      !Array.isArray(value.enum) ||
      value.enum.length < 1 ||
      value.enum.length > 32 ||
      value.enum.some((item) => !validText(item, 2_048))
    )
      return undefined
    output.enum = [...value.enum]
  }
  if (value.properties !== undefined) {
    if (!plainRecord(value.properties)) return undefined
    const entries = Object.entries(value.properties)
    if (entries.length > 32 || entries.some(([key]) => !validIdentifier(key)))
      return undefined
    const properties: Record<string, unknown> = {}
    for (const [key, schema] of entries) {
      const projected = projectJsonSchema(schema, depth + 1)
      if (!projected) return undefined
      properties[key] = projected
    }
    output.properties = properties
  }
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.length > 32 ||
      value.required.some((item) => !validIdentifier(item))
    )
      return undefined
    output.required = [...value.required]
  }
  if (value.additionalProperties !== undefined) {
    if (value.additionalProperties !== false) return undefined
    output.additionalProperties = false
  }
  if (value.items !== undefined) {
    const items = projectJsonSchema(value.items, depth + 1)
    if (!items) return undefined
    output.items = items
  }
  if (value.prefixItems !== undefined) {
    if (!Array.isArray(value.prefixItems) || value.prefixItems.length > 32)
      return undefined
    const prefixItems = value.prefixItems.map((item) =>
      projectJsonSchema(item, depth + 1)
    )
    if (prefixItems.some((item) => item === undefined)) return undefined
    output.prefixItems = prefixItems
  }
  for (const key of [
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
  ] as const) {
    if (value[key] === undefined) continue
    if (
      typeof value[key] !== "number" ||
      !Number.isSafeInteger(value[key]) ||
      value[key] < 0 ||
      value[key] > 1_000_000
    )
      return undefined
    output[key] = value[key]
  }
  if (value.uniqueItems !== undefined) {
    if (typeof value.uniqueItems !== "boolean") return undefined
    output.uniqueItems = value.uniqueItems
  }
  return output
}

function projectInterrupt(
  value: Record<string, unknown>,
  authorization: GuestAuthorization
): GuestOutboundProjection["payload"] | undefined {
  if (
    authorization.operation !== "messages:read" ||
    !exactKnownKeys(value, interruptPayloadKeys) ||
    value.type !== "interrupt" ||
    !Array.isArray(value.interrupts) ||
    value.interrupts.length < 1 ||
    value.interrupts.length > 32
  )
    return undefined
  const interrupts: GuestSafeInterrupt[] = []
  for (const candidate of value.interrupts) {
    if (
      !plainRecord(candidate) ||
      !exactKnownKeys(candidate, interruptKeys) ||
      !validIdentifier(candidate.id) ||
      !validText(candidate.reason, 128) ||
      (candidate.message !== undefined &&
        !validText(candidate.message, 4_096)) ||
      (candidate.expiresAt !== undefined &&
        (!validText(candidate.expiresAt, 64) ||
          !Number.isFinite(Date.parse(candidate.expiresAt as string)) ||
          new Date(candidate.expiresAt as string).toISOString() !==
            candidate.expiresAt))
    )
      return undefined
    const responseSchema = projectJsonSchema(candidate.responseSchema)
    if (!responseSchema) return undefined
    if (candidate.reason === "approval" && Array.isArray(responseSchema.enum)) {
      const choices = responseSchema.enum.filter(
        (choice) => choice !== "always"
      )
      if (choices.length === 0) return undefined
      responseSchema.enum = choices
    }
    interrupts.push({
      id: candidate.id,
      reason: candidate.reason,
      ...(candidate.message === undefined
        ? {}
        : { message: candidate.message as string }),
      responseSchema,
    })
  }
  return { type: "interrupt", interrupts }
}

function projectError(
  value: Record<string, unknown>,
  authorization: GuestAuthorization
): GuestOutboundProjection["payload"] | undefined {
  if (
    !exactKnownKeys(value, errorKeys) ||
    value.type !== "error" ||
    authorization.operation !== "errors:read" ||
    !hasCapability(authorization, "safe-errors") ||
    !publicErrorCodes.includes(value.code as never) ||
    typeof value.retryable !== "boolean" ||
    (value.description !== undefined &&
      value.description !==
        publicErrorDescriptions[value.code as GuestPublicErrorCode]) ||
    (value.message !== undefined && !validText(value.message, 4_096))
  )
    return undefined
  return {
    type: "error",
    code: value.code as GuestPublicErrorCode,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    retryable: value.retryable,
  }
}

export function projectGuestOutbound(
  input: unknown,
  authorization: GuestAuthorization
): GuestOutboundProjection | undefined {
  const budget: Budget = { bytes: 0, nodes: 0, seen: new WeakSet() }
  if (
    !inspectJson(input, 0, budget) ||
    !plainRecord(input) ||
    !exactKnownKeys(input, envelopeKeys) ||
    !validAuthorization(authorization) ||
    !(["rest", "ag-ui", "ws", "artifact", "error"] as const).includes(
      input.transport as never
    ) ||
    !validIdentifier(input.agentId) ||
    (input.sessionId !== undefined && !validIdentifier(input.sessionId)) ||
    input.agentId !== authorization.agentId ||
    (authorization.sessionId !== undefined &&
      input.sessionId !== authorization.sessionId) ||
    !plainRecord(input.payload)
  )
    return undefined

  let payload: GuestOutboundProjection["payload"] | undefined
  if (
    input.transport === "rest" ||
    input.transport === "ag-ui" ||
    input.transport === "ws"
  ) {
    payload =
      input.payload.type === "interrupt"
        ? projectInterrupt(input.payload, authorization)
        : projectMessage(input.payload, authorization)
  } else if (input.transport === "artifact") {
    payload = projectArtifact(input.payload, authorization)
  } else {
    payload = projectError(input.payload, authorization)
  }
  if (!payload) return undefined

  const output: GuestOutboundProjection = {
    transport: input.transport as Transport,
    agentId: input.agentId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    payload,
  }
  return utf8Bytes(JSON.stringify(output)) <= MAX_OUTPUT_BYTES
    ? output
    : undefined
}
