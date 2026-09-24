import type { SessionHistoryResponse } from "../../protocol"

/**
 * How a history page sits beside the live turn a resume replays: where its
 * prompt is, how many of its steer acknowledgements the page already carries,
 * and where the page is cut so the turn shows once.
 */

/** A user turn the provider persisted as a mid-turn correction. */
export function isCorrection(
  message: SessionHistoryResponse["messages"][number]
) {
  return message.role === "user" && message.metadata?.custom.correction === true
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

/** How far a provider's clock may run behind the proxy's for a stored row. */
const PROMPT_CLOCK_SKEW_MS = 5_000

/**
 * The page a view shows beside a live turn replayed from `startedAt`: the
 * stream owns every row the turn stored from then on, corrections included,
 * so they are dropped and the turn shows once. The page's last prompt stays,
 * since the provider stores no other prompt while a turn runs and the stream
 * carries none. `undefined` when a row after that prompt has no time to cut
 * it by, so only a reset can show the turn once.
 */
export function beforeLiveTurn(
  history: SessionHistoryResponse,
  startedAt: number
): SessionHistoryResponse | undefined {
  const threshold = startedAt - PROMPT_CLOCK_SKEW_MS
  const prompt = lastPromptIndex(history)
  const messages = []
  for (const [index, message] of history.messages.entries()) {
    if (index <= prompt || message.role === "activity") {
      messages.push(message)
      continue
    }
    const createdAt = Date.parse(message.createdAt)
    if (Number.isNaN(createdAt)) return undefined
    if (createdAt < threshold) messages.push(message)
  }
  return { ...history, messages }
}
