import type {
  RespondToToolApprovalOptions,
  ThreadMessageLike,
  ToolApprovalOption,
} from "@assistant-ui/react"

import type {
  HermesApproval,
  HermesApprovalChoice,
  HermesNativeClient,
} from "./hermes-native-client"

const labels = {
  en: {
    once: "Allow once",
    session: "Allow for this session",
    always: "Always allow",
    deny: "Deny",
  },
  he: {
    once: "אישור פעם אחת",
    session: "אישור לשיחה זו",
    always: "אישור תמיד",
    deny: "דחייה",
  },
} as const

const kinds: Record<HermesApprovalChoice, ToolApprovalOption["kind"]> = {
  once: "allow-once",
  session: "allow-always",
  always: "allow-always",
  deny: "reject-once",
}

function approvalOptions(
  approval: HermesApproval,
  locale: keyof typeof labels
): readonly ToolApprovalOption[] {
  return (approval.choices ?? ["once", "deny"]).map((choice) => ({
    id: choice,
    kind: kinds[choice],
    label: labels[locale][choice],
  }))
}

export function projectHermesApprovalMessages(
  messages: readonly ThreadMessageLike[],
  approval: HermesApproval | undefined,
  locale: keyof typeof labels
): readonly ThreadMessageLike[] {
  if (!approval) return messages
  const messageIndex = messages.findLastIndex(
    (message) => message.role === "assistant"
  )
  if (messageIndex < 0) return messages
  const message = messages[messageIndex]!
  const content =
    typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : [...message.content]
  const nativeApproval = {
    id: approval.requestId,
    prompt: approval.message,
    options: approvalOptions(approval, locale),
  }
  const toolIndex = content.findLastIndex(
    (part) =>
      part.type === "tool-call" &&
      part.toolName !== "question" &&
      part.result === undefined
  )
  if (toolIndex < 0) {
    content.push({
      type: "tool-call",
      toolCallId: `hermes-approval-${approval.requestId}`,
      toolName: "request_permission",
      args: { action: approval.message },
      argsText: JSON.stringify({ action: approval.message }),
      approval: nativeApproval,
    })
  } else {
    const tool = content[toolIndex]!
    if (tool.type !== "tool-call") return messages
    content[toolIndex] = {
      ...tool,
      approval: nativeApproval,
    }
  }
  const projected = [...messages]
  projected[messageIndex] = {
    ...message,
    content,
    status: { type: "requires-action", reason: "tool-calls" },
  }
  return projected
}

export async function respondToHermesApproval(
  client: Pick<HermesNativeClient, "answerApproval">,
  threadId: string,
  response: RespondToToolApprovalOptions
) {
  const option =
    response.optionId ??
    (response.approved ? ("once" as const) : ("deny" as const))
  if (
    option !== "once" &&
    option !== "session" &&
    option !== "always" &&
    option !== "deny"
  )
    throw new Error("Hermes approval option is not supported")
  if (response.approved === (option === "deny"))
    throw new Error("Hermes approval decision does not match its option")
  await client.answerApproval(threadId, response.approvalId, option)
}
