import { createRuntimeExtras } from "@assistant-ui/core/react"

/** How far back a thread reaches, and the one way to reach further. */
export type ThreadHistoryState = {
  /** An older page can be read. */
  readonly hasOlder: boolean
  /** The provider holds older turns no page can reach. */
  readonly truncated: boolean
  readonly loading: boolean
  /** The latest read failed; the next `loadOlder` tries again. */
  readonly failed: boolean
  readonly loadOlder: () => Promise<void>
}

export type ThreadHistoryExtras = {
  /** Absent until the runtime knows where the Session's history stands. */
  readonly history?: ThreadHistoryState
}

/**
 * The provider-neutral channel a runtime offers older history through, so the
 * thread reads it without reaching into any one runtime. A runtime stamps it on
 * the same extras object as its own channel.
 */
export const threadHistoryExtras =
  createRuntimeExtras<ThreadHistoryExtras>("threadHistory")
