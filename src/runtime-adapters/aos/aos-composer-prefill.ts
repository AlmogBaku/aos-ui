import type { ThreadRuntime } from "@assistant-ui/react"
import type { AosLoadedHistory } from "./aos-client"

export async function reconcileComposerPrefill(
  thread: ThreadRuntime,
  loadHistory: () => Promise<Pick<AosLoadedHistory, "messages">>,
  text: string
) {
  // Capture the thread runtime before fetching: the selected thread may change.
  const history = await loadHistory()
  const messages = history.messages.map((message) => ({
    ...message,
    createdAt: new Date(message.createdAt),
  }))
  let unsubscribe: () => void = () => undefined
  const applyWhenIdle = () => {
    if (thread.getState().isRunning) return
    unsubscribe()
    const draft = thread.composer.getState()
    thread.reset(messages)
    // reset restores history, not a user's newly composed text.
    thread.composer.setText(draft.isEmpty ? text : draft.text)
  }
  unsubscribe = thread.subscribe(applyWhenIdle)
  queueMicrotask(applyWhenIdle)
}
