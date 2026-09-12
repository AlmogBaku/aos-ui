import type {
  GuestAuthorization,
  GuestCapability,
  GuestOperation,
} from "./guest-invitation"
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
  "message",
  "retryable",
  "stack",
  "details",
  "nativeMetadata",
  "providerPath",
  "liveId",
  "nativePosition",
] as const

type Transport = "rest" | "ag-ui" | "ws" | "artifact" | "error"

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
        type: "error"
        code: string
        message?: string
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

function hasOperation(
  authorization: GuestAuthorization,
  operation: GuestOperation
) {
  return authorization.operations.includes(operation)
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
    validIdentifier(authorization.agentId) &&
    (authorization.sessionId === undefined ||
      validIdentifier(authorization.sessionId)) &&
    validScope(authorization.operations, guestOperations) &&
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
  if (!hasOperation(authorization, "messages:read")) return undefined

  const output = {
    type: "message" as const,
    role: value.role as "assistant" | "guest",
    ...(value.text !== undefined && hasCapability(authorization, "message-text")
      ? { text: value.text }
      : {}),
    ...(customUi && hasCapability(authorization, "custom-ui")
      ? { customUi }
      : {}),
    ...(attachments &&
    hasOperation(authorization, "attachments:read") &&
    hasCapability(authorization, "attachment-metadata")
      ? { attachments }
      : {}),
    ...(artifacts &&
    hasOperation(authorization, "artifacts:read") &&
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
    !hasOperation(authorization, "artifacts:read") ||
    !hasCapability(authorization, "artifact-metadata")
  )
    return undefined
  const metadata = projectMetadata(value, true, true)
  if (!metadata) return undefined
  return { type: "artifact", ...metadata }
}

function projectError(
  value: Record<string, unknown>,
  authorization: GuestAuthorization
): GuestOutboundProjection["payload"] | undefined {
  if (
    !exactKnownKeys(value, errorKeys) ||
    value.type !== "error" ||
    !hasOperation(authorization, "errors:read") ||
    !hasCapability(authorization, "safe-errors") ||
    !validIdentifier(value.code) ||
    typeof value.retryable !== "boolean" ||
    (value.message !== undefined && !validText(value.message, 4_096))
  )
    return undefined
  return {
    type: "error",
    code: value.code,
    ...(value.message === undefined
      ? {}
      : { message: value.message as string }),
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
    payload = projectMessage(input.payload, authorization)
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
