import type {
  OpenCodeProjectedThreadMessage,
  OpenCodeThreadState,
  Part,
} from "@assistant-ui/react-opencode"

import { ARTIFACT_DATA_PART_NAME } from "@/artifacts/artifacts"
import type { ArtifactDescriptor } from "@/runtime-adapters/contracts"

type ArtifactDataPart = {
  type: "data"
  name: typeof ARTIFACT_DATA_PART_NAME
  data: ArtifactDescriptor
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function parseBase64DataUrl(value: string) {
  if (!value.startsWith("data:")) return null
  const separator = value.indexOf(",")
  if (separator < 0) return null
  const header = value.slice(5, separator)
  const suffix = ";base64"
  if (!header.endsWith(suffix)) return null
  const mimeType = header.slice(0, -suffix.length)
  const data = value.slice(separator + 1)
  if (!MIME_TYPE.test(mimeType) || !BASE64.test(data)) return null

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return {
    mimeType,
    data,
    sizeBytes: (data.length / 4) * 3 - padding,
  }
}

export function projectOpenCodeArtifactPart(
  part: Part
): ArtifactDataPart | null {
  if (part.type !== "tool" || part.tool !== "present_artifact") return null
  if (part.state.status !== "completed") return null

  const aosUi = isRecord(part.state.metadata.aos_ui)
    ? part.state.metadata.aos_ui
    : null
  if (!aosUi || aosUi.kind !== "artifact") return null
  if (typeof aosUi.id !== "string" || aosUi.id.trim().length === 0) return null
  if (typeof aosUi.filename !== "string" || aosUi.filename.trim().length === 0)
    return null
  if (
    aosUi.mimeType !== undefined &&
    (typeof aosUi.mimeType !== "string" || aosUi.mimeType.trim().length === 0)
  )
    return null
  if (
    aosUi.sizeBytes !== undefined &&
    (typeof aosUi.sizeBytes !== "number" ||
      !Number.isSafeInteger(aosUi.sizeBytes) ||
      aosUi.sizeBytes < 0)
  )
    return null

  const attachment = part.state.attachments?.find(
    (candidate) =>
      candidate.type === "file" &&
      candidate.filename === aosUi.filename &&
      typeof candidate.url === "string" &&
      candidate.url.length > 0
  )
  if (!attachment) return null
  const source = parseBase64DataUrl(attachment.url)
  if (!source || source.mimeType !== attachment.mime) return null
  if (aosUi.mimeType !== undefined && aosUi.mimeType !== source.mimeType)
    return null
  if (aosUi.sizeBytes !== undefined && aosUi.sizeBytes !== source.sizeBytes)
    return null

  return {
    type: "data",
    name: ARTIFACT_DATA_PART_NAME,
    data: {
      id: aosUi.id,
      filename: aosUi.filename,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      source: { type: "inline", encoding: "base64", data: source.data },
    },
  }
}

export function projectOpenCodeArtifacts(
  state: OpenCodeThreadState,
  messages: readonly OpenCodeProjectedThreadMessage[]
): OpenCodeProjectedThreadMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.id) return message
    const native = state.messagesById[message.id]
    if (!native) return message
    const artifacts = native.parts.flatMap((part) => {
      const artifact = projectOpenCodeArtifactPart(part)
      return artifact ? [artifact] : []
    })
    if (artifacts.length === 0) return message
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content

    return {
      ...message,
      content: [...content, ...artifacts],
    }
  })
}
