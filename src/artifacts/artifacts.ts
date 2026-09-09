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
    if (message.role !== "assistant") continue

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
