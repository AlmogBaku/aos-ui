import type { SessionHistoryResponse } from "../../protocol"

/**
 * How a history page sits beside the live turn a resume replays: where its
 * prompt is, how many of its steer acknowledgements the page already carries,
 * and which rows it leaves to the replay so the turn shows once.
 */

/** A user turn the provider persisted as a mid-turn correction. */
export function isCorrection(
  message: SessionHistoryResponse["messages"][number]
) {
  if (message.role !== "user") return false
  return message.correction === true
}

/** Where the page's last prompt sits: its last user turn that is no correction. */
export function lastPromptIndex(history: SessionHistoryResponse) {
  return history.messages.findLastIndex(
    (message) => message.role === "user" && !isCorrection(message)
  )
}

/**
 * How many of the live turn's steer acknowledgements this history already carried
 * as user turns. Only the corrections after the running turn's prompt count: the
 * provider cannot persist another prompt while a turn runs, so every flagged
 * user turn beyond the last plain one belongs to the turn the journal replays.
 */
export function persistedCorrections(history: SessionHistoryResponse) {
  // No plain prompt in the page leaves every flagged turn to count.
  return history.messages
    .slice(lastPromptIndex(history) + 1)
    .filter((message) => message.role === "user").length
}

/**
 * The page a view shows beside a live turn whose replay carries the rows
 * `live` names: the replay owns each of them, so the page drops them and the
 * turn shows once. The rows are joined by id, the one a message or tool call
 * carries both stored and streamed; the prompt and every row the replay does
 * not name stay. Only rows after the page's last prompt can be the live
 * turn's, as for its corrections, so an earlier turn that reused a tool
 * call's id keeps its row.
 */
export function withoutLiveRows(
  history: SessionHistoryResponse,
  live: ReadonlySet<string>
): SessionHistoryResponse {
  const prompt = lastPromptIndex(history)
  return {
    ...history,
    messages: history.messages.filter(
      (message, index) =>
        index <= prompt ||
        message.role === "activity" ||
        !(
          live.has(message.id) ||
          message.content.some(
            (part) => part.type === "tool-call" && live.has(part.toolCallId)
          )
        )
    ),
  }
}
