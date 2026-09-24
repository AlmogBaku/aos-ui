import type { ThreadRuntime } from "@assistant-ui/react"

import type { MessageRewind } from "@/components/assistant-ui/elements/thread.aui"

/**
 * The conversation controls every AOS surface composes the same way: the
 * operator workspace and the invited guest share Edit, Retry, and the
 * provider's suggested next turn.
 */

/** The provider turn an Edit or Retry replaces is the user turn it replays. */
export const rewindSource = (sourceUserId: string) => ({
  rewindSourceId: sourceUserId,
})

/**
 * The Session projector rewinds locally from `rewindSource`; the run config is
 * what the Thread carries into Edit and Retry.
 */
export const aosMessageRewind: MessageRewind = {
  runConfig(sourceUserId: string) {
    return { custom: { "aos.rewindSourceId": sourceUserId } }
  },
}

/**
 * Shows the next turn the provider suggested, once the run that suggested it has
 * settled. Text already composed outranks the suggestion.
 */
export function applyComposerPrefill(thread: ThreadRuntime, text: string) {
  let unsubscribe = () => {}
  const applyWhenIdle = () => {
    if (thread.getState().isRunning) return
    unsubscribe()
    if (thread.composer.getState().isEmpty) thread.composer.setText(text)
  }
  unsubscribe = thread.subscribe(applyWhenIdle)
  applyWhenIdle()
}
