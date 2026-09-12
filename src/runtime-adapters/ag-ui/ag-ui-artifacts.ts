import type { Toolkit } from "@assistant-ui/react"
import { z } from "zod"

import {
  ARTIFACT_DATA_PART_NAME,
  parseArtifactDescriptor,
  type ArtifactMessage,
} from "@/artifacts/artifacts"
import type { ArtifactDescriptor } from "@/runtime-adapters/contracts"

const inlineSource = z.object({
  type: z.literal("inline"),
  encoding: z.enum(["utf8", "base64"]),
  data: z.string(),
})
const urlSource = z.object({
  type: z.literal("url"),
  url: z.url(),
})
const agUiArtifactSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  source: z.discriminatedUnion("type", [inlineSource, urlSource]),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function completedArtifactResult(part: unknown) {
  if (
    !isRecord(part) ||
    part.type !== "tool-call" ||
    part.toolName !== "present_artifact" ||
    part.result === undefined ||
    part.isError === true ||
    (part.status !== undefined &&
      (!isRecord(part.status) || part.status.type !== "complete"))
  ) {
    return null
  }
  return parseArtifactDescriptor(part.result)
}

/** Project the AG-UI frontend-tool result into the canonical AOS data part. */
export function projectAgUiArtifactMessages(
  messages: readonly ArtifactMessage[]
): ArtifactMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message
    let changed = false
    const content = message.content.flatMap((part) => {
      const artifact = completedArtifactResult(part)
      if (!artifact) return [part]
      changed = true
      return [
        part,
        { type: "data", name: ARTIFACT_DATA_PART_NAME, data: artifact },
      ]
    })
    return changed ? { ...message, content } : message
  })
}

export function publishAgUiArtifact(input: unknown): ArtifactDescriptor {
  if (
    typeof input === "object" &&
    input !== null &&
    "source" in input &&
    typeof input.source === "object" &&
    input.source !== null &&
    "type" in input.source &&
    input.source.type === "provider"
  ) {
    throw new Error("AG-UI artifacts require inline content or a public URL")
  }
  const artifact = parseArtifactDescriptor(input)
  if (!artifact || artifact.source.type === "provider") {
    throw new Error("present_artifact received an invalid artifact")
  }
  return artifact
}

export function createAgUiArtifactToolkit(): Toolkit {
  return {
    present_artifact: {
      type: "frontend",
      description:
        "Publish a completed user-facing artifact. Do not call this for ordinary file edits or intermediate work.",
      parameters: agUiArtifactSchema,
      execute: async (input) => publishAgUiArtifact(input),
      // The artifact projection appends the canonical data part. Rendering a
      // second tool-result card here duplicates the same artifact in a turn.
      render: () => null,
      renderText: {
        running: "Publishing artifact",
        complete: "Published artifact",
      },
    },
  }
}
