import type { CompleteAttachment } from "@assistant-ui/core"
import { createRuntimeExtras } from "@assistant-ui/core/react"

/** What a runtime lets the thread do to a message still waiting in its queue. */
export type QueueControls = {
  /** Replaces a waiting message's text; its attachments stay. False when it is no longer queued. */
  readonly editText: (queueItemId: string, text: string) => boolean
  /** Keeps every queued message waiting until the returned call releases it. */
  readonly hold: () => () => void
  /**
   * Empties the queue into one draft: every text in queue order, a blank line
   * apart, and every attachment. Undefined, leaving the queue as it was, when
   * nothing waits or a message holds a part a composer cannot take back.
   */
  readonly takeAll: () =>
    | {
        readonly text: string
        readonly attachments: readonly CompleteAttachment[]
      }
    | undefined
}

export type QueueControlsExtras = {
  /** Absent on a runtime whose queue the thread cannot edit. */
  readonly queueControls?: QueueControls
}

/**
 * The provider-neutral channel a runtime offers queue editing through, stamped
 * on the same extras object as its own channel. Reordering needs none: it is
 * Assistant UI's own `queueItem.move`.
 */
export const queueControlsExtras =
  createRuntimeExtras<QueueControlsExtras>("queueControls")
