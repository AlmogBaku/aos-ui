import type {
  AssistantMessage,
  OpenCodeThreadState,
} from "@assistant-ui/react-opencode"

import type { ComposerFeatureViewModel } from "@/components/assistant-ui/composer-features"

function tokenTotal(message: AssistantMessage) {
  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write
  )
}

export function readOpenCodeComposerContext(
  state: OpenCodeThreadState,
  maxTokens: number
): NonNullable<ComposerFeatureViewModel["context"]> | undefined {
  const latestAssistant = state.messageOrder
    .map((id) => state.messagesById[id]?.info)
    .findLast(
      (message): message is AssistantMessage =>
        message?.role === "assistant" && tokenTotal(message) > 0
    )
  if (!latestAssistant) return undefined

  return {
    usage: {
      system: 0,
      tools: 0,
      // The official element derives its ring from the category sum. Keep the
      // native total here for that calculation, but do not render a misleading
      // Messages category when OpenCode did not provide a breakdown.
      messages: Math.round(tokenTotal(latestAssistant) / 1_000),
      total: Math.round(maxTokens / 1_000),
    },
    segments: [],
  }
}
