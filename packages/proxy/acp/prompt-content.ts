import { ContentBlock } from "@agentclientprotocol/sdk/experimental/v2"

import { AOS_ATTACHMENT_URI_SCHEME } from "../../protocol/acp"

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
 * A prompt as another member of its room receives it. Only the fields the
 * browser itself writes into a prompt are copied, so nothing else a sender put
 * on a block reaches anyone but the sender.
 */
export function promptCopy(prompt: readonly ContentBlock[]): ContentBlock[] {
  return prompt.flatMap((block): ContentBlock[] => {
    if (ContentBlock.isText(block)) return [{ type: "text", text: block.text }]
    if (block.type !== "resource_link") return []
    return [
      {
        type: "resource_link",
        uri: block.uri,
        name: block.name,
        ...(typeof block.mimeType === "string"
          ? { mimeType: block.mimeType }
          : {}),
      },
    ]
  })
}
