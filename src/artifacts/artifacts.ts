import { readAosToolArtifact } from "@/lib/tool-artifact"
import type {
  ArtifactDescriptor,
  ArtifactSource,
} from "@/runtime-adapters/contracts"

export const ARTIFACT_DATA_PART_NAME = "aos.artifact"

export type ArtifactOccurrence = {
  key: string
  messageId: string
  partIndex: number
  artifact: ArtifactDescriptor
}

export type ArtifactMessage = {
  id: string
  role: string
  content: readonly unknown[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false

  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

const parseArtifactSource = (value: unknown): ArtifactSource | null => {
  if (!isRecord(value)) return null

  if (
    value.type === "inline" &&
    (value.encoding === "utf8" || value.encoding === "base64") &&
    typeof value.data === "string"
  ) {
    return { type: "inline", encoding: value.encoding, data: value.data }
  }

  if (value.type === "url" && isHttpUrl(value.url)) {
    return { type: "url", url: value.url }
  }

  if (
    value.type === "provider" &&
    typeof value.reference === "string" &&
    value.reference.trim().length > 0
  ) {
    return { type: "provider", reference: value.reference }
  }

  return null
}

export function parseArtifactDescriptor(
  value: unknown
): ArtifactDescriptor | null {
  if (!isRecord(value)) return null

  const { mimeType, sizeBytes } = value
  if (mimeType !== undefined && typeof mimeType !== "string") return null
  if (
    sizeBytes !== undefined &&
    (typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0)
  ) {
    return null
  }

  const source = parseArtifactSource(value.source)

  if (
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.filename !== "string" ||
    value.filename.trim().length === 0 ||
    !source
  ) {
    return null
  }

  return {
    id: value.id,
    filename: value.filename,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    source,
  }
}

export function extractArtifactOccurrences(
  messages: readonly ArtifactMessage[]
): ArtifactOccurrence[] {
  const occurrences: ArtifactOccurrence[] = []

  for (const message of messages) {
    // An artifact travels on an Agent's answer or on the operator's own
    // attachment, so both roles publish; no other role does.
    if (message.role !== "assistant" && message.role !== "user") continue

    message.content.forEach((part, partIndex) => {
      if (
        !isRecord(part) ||
        part.type !== "data" ||
        part.name !== ARTIFACT_DATA_PART_NAME
      ) {
        return
      }

      const artifact = parseArtifactDescriptor(part.data)
      if (!artifact) return

      occurrences.push({
        key: `${message.id}:${partIndex}`,
        messageId: message.id,
        partIndex,
        artifact,
      })
    })
  }

  return occurrences
}

/** A file an MCP App view shows: its display name and declared type. */
export type ShownFile = { filename: string; mimeType?: string }

const parsedRecord = (value: unknown) => {
  if (typeof value !== "string") return isRecord(value) ? value : undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The file a tool call's result says its view shows: a `structuredContent`
 * carrying a string `filename`, itself or in the `value` a presentation
 * result wraps it in. No tool name decides it.
 */
export function shownFileOf(result: unknown): ShownFile | undefined {
  const structured = parsedRecord(result)?.structuredContent
  if (!isRecord(structured)) return undefined
  for (const candidate of [structured, structured.value]) {
    if (!isRecord(candidate)) continue
    const { filename, mimeType } = candidate
    if (typeof filename !== "string" || filename.trim().length === 0) continue
    return {
      filename,
      ...(typeof mimeType === "string" ? { mimeType } : {}),
    }
  }
  return undefined
}

/**
 * One file the Session published: an Artifact, or a file a tool call's MCP
 * App view shows.
 */
export type SessionOutput =
  | { key: string; kind: "artifact"; artifact: ArtifactDescriptor }
  | {
      key: string
      kind: "app"
      toolCallId: string
      toolName?: string
      file: ShownFile
    }

/** Every file the conversation published, in the order it did. */
export function extractSessionOutputs(
  messages: readonly ArtifactMessage[]
): SessionOutput[] {
  const outputs: SessionOutput[] = []
  const artifacts = new Map(
    extractArtifactOccurrences(messages).map((occurrence) => [
      occurrence.key,
      occurrence.artifact,
    ])
  )
  for (const message of messages) {
    message.content.forEach((part, partIndex) => {
      const key = `${message.id}:${partIndex}`
      const artifact = artifacts.get(key)
      if (artifact) {
        outputs.push({ key, kind: "artifact", artifact })
        return
      }
      if (
        message.role !== "assistant" ||
        !isRecord(part) ||
        part.type !== "tool-call" ||
        typeof part.toolCallId !== "string" ||
        readAosToolArtifact(part.artifact)?.app === undefined
      )
        return
      const file = shownFileOf(part.result)
      if (!file) return
      outputs.push({
        key,
        kind: "app",
        toolCallId: part.toolCallId,
        ...(typeof part.toolName === "string"
          ? { toolName: part.toolName }
          : {}),
        file,
      })
    })
  }
  return outputs
}
