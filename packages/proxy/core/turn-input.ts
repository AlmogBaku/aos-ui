import type { TurnInput } from "./events"
import type { NewTurnRunInput } from "./runtime"

/** What one user turn carries, in the proxy-owned run vocabulary. */
type UserTurnContent = Extract<
  TurnInput["messages"][number],
  { role: "user" }
>["content"]

/**
 * One admitted user turn, independent of the transport that carried it, so one
 * Session run is admitted the same way whichever protocol asked for it.
 */
export function buildNewTurnInput(options: {
  threadId: string
  runId: string
  messageId: string
  content: UserTurnContent
  /** User turn to rewind before Edit or Retry; validated authoritatively. */
  rewindSourceId?: string
}): NewTurnRunInput {
  return {
    threadId: options.threadId,
    runId: options.runId,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
    messages: [
      { id: options.messageId, role: "user", content: options.content },
    ],
    ...(options.rewindSourceId === undefined
      ? {}
      : { rewindSourceId: options.rewindSourceId }),
  }
}
