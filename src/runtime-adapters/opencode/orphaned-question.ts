import type {
  OpenCodeThreadState,
  QuestionRequest,
} from "@assistant-ui/react-opencode"

export type OrphanedOpenCodeQuestion = {
  messageId: string
  callId: string
  askedAt: number
  questions: QuestionRequest["questions"]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseQuestions(value: unknown): QuestionRequest["questions"] | null {
  if (!Array.isArray(value) || value.length === 0) return null

  const questions: QuestionRequest["questions"] = []
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.header !== "string" ||
      candidate.header.trim() === "" ||
      typeof candidate.question !== "string" ||
      candidate.question.trim() === "" ||
      !Array.isArray(candidate.options)
    ) {
      return null
    }

    const options: QuestionRequest["questions"][number]["options"] = []
    for (const option of candidate.options) {
      if (
        !isRecord(option) ||
        typeof option.label !== "string" ||
        option.label.trim() === "" ||
        typeof option.description !== "string"
      ) {
        return null
      }
      options.push({ label: option.label, description: option.description })
    }

    if (
      (candidate.multiple !== undefined &&
        typeof candidate.multiple !== "boolean") ||
      (candidate.custom !== undefined && typeof candidate.custom !== "boolean")
    ) {
      return null
    }

    questions.push({
      header: candidate.header,
      question: candidate.question,
      options,
      ...(candidate.multiple === undefined
        ? {}
        : { multiple: candidate.multiple }),
      ...(candidate.custom === undefined ? {} : { custom: candidate.custom }),
    })
  }
  return questions
}

export function findOrphanedOpenCodeQuestion(
  state: OpenCodeThreadState
): OrphanedOpenCodeQuestion | null {
  if (
    state.loadState.type !== "ready" ||
    state.runState.type !== "idle" ||
    (state.sessionStatus && state.sessionStatus.type !== "idle") ||
    Object.values(state.pendingUserMessages).some(
      (message) => message.status === "pending"
    )
  ) {
    return null
  }

  const lastMessageId = state.messageOrder.at(-1)
  if (!lastMessageId) return null
  const message = state.messagesById[lastMessageId]
  if (message?.info?.role !== "assistant") return null

  for (const part of [...message.parts].reverse()) {
    if (
      part.type !== "tool" ||
      part.tool !== "question" ||
      part.sessionID !== state.sessionId ||
      (part.state.status !== "pending" && part.state.status !== "running")
    ) {
      continue
    }
    const questions = parseQuestions(part.state.input.questions)
    if (!questions) return null
    return {
      messageId: lastMessageId,
      callId: part.callID,
      askedAt:
        part.state.status === "running" ? part.state.time.start : Date.now(),
      questions,
    }
  }
  return null
}
