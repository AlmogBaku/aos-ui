import { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import {
  AOS_ATTACHMENT_URI_SCHEME,
  formatArtifactUri,
} from "../../protocol/acp"
import type { PromptPart } from "../core/member"

/**
 * Text or a resource link, the content every ACP agent takes. A link to a
 * batch the browser staged over REST is appended by its stage; any other
 * link reaches the runtime in the prompt's text.
 */
export function isPromptBlock(block: ContentBlock) {
  return ContentBlock.isText(block) || ContentBlock.isResourceLink(block)
}

function isStagedLink(uri: string) {
  return uri.startsWith(AOS_ATTACHMENT_URI_SCHEME)
}

/**
 * ACP text blocks joined the way the normalized wire carries a turn, each
 * link the stage does not supply written as a Markdown link.
 */
export function promptText(prompt: readonly ContentBlock[]) {
  return prompt
    .flatMap((block) =>
      ContentBlock.isText(block)
        ? [block.text]
        : ContentBlock.isResourceLink(block) && !isStagedLink(block.uri)
          ? [`[${block.name}](${block.uri})`]
          : []
    )
    .join("\n")
}

/**
 * A prompt as the Channel carries it. Only the fields the browser itself
 * writes into a prompt are kept, so nothing else a sender put on a block
 * reaches anyone but the sender.
 */
export function promptParts(prompt: readonly ContentBlock[]): PromptPart[] {
  return prompt.flatMap((block): PromptPart[] => {
    if (ContentBlock.isText(block)) return [{ kind: "text", text: block.text }]
    if (
      block.type !== "resource_link" ||
      typeof block.uri !== "string" ||
      typeof block.name !== "string"
    )
      return []
    return [
      {
        kind: "attachment",
        uri: block.uri,
        name: block.name,
        ...(typeof block.mimeType === "string"
          ? { mimeType: block.mimeType }
          : {}),
      },
    ]
  })
}

/** The ACP blocks a prompt's parts are written back as. */
export function promptBlocks(prompt: readonly PromptPart[]): ContentBlock[] {
  return prompt.map((part): ContentBlock => {
    switch (part.kind) {
      case "text":
        return { type: "text", text: part.text }
      case "attachment":
        return {
          type: "resource_link",
          uri: part.uri,
          name: part.name,
          ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
        }
    }
  })
}

/**
 * A prompt as its viewers are shown it: each staged attachment the provider
 * already names an artifact for links to that artifact instead of the upload,
 * so the echo shows what the turn shows once it is history. `artifactIds`
 * follows the staged attachment parts' order.
 */
export function echoedParts(
  prompt: readonly PromptPart[],
  artifactIds: readonly (string | undefined)[]
): PromptPart[] {
  let index = 0
  return prompt.map((part) => {
    if (part.kind !== "attachment" || !isStagedLink(part.uri)) return part
    const artifactId = artifactIds[index++]
    return artifactId === undefined
      ? part
      : { ...part, uri: formatArtifactUri(artifactId) }
  })
}
