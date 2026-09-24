import { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import { AOS_ATTACHMENT_URI_SCHEME } from "../../protocol/acp"
import type { PromptPart } from "../core/member"

/** Text, or a link to a batch the browser staged over REST. */
export function isPromptBlock(block: ContentBlock) {
  return (
    ContentBlock.isText(block) ||
    (block.type === "resource_link" &&
      typeof block.uri === "string" &&
      block.uri.startsWith(AOS_ATTACHMENT_URI_SCHEME))
  )
}

/** ACP text blocks joined the way the normalized wire carries a turn. */
export function promptText(prompt: readonly ContentBlock[]) {
  return prompt
    .filter(ContentBlock.isText)
    .map(({ text }) => text)
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
