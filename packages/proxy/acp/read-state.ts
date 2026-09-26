import type { Catalog } from "../core/catalog"
import type { ServerRuntimeTranslation } from "../core/runtime"
import type { ReadState } from "./types"

/** Collapses a burst of exposure and activity into one watermark write. */
export const FOCUS_DEBOUNCE_MS = 400
/** Least time between two watermark writes for the same Session. */
export const REACK_FLOOR_MS = 5_000

type TimerHandle = ReturnType<typeof setTimeout>

type Target = { agentId: string; sessionId: string }

export type ReadStateOptions = {
  catalog: Pick<Catalog, "info" | "rows" | "markRead">
  /** The execution events after which the runtime marks a Session unread. */
  relighting?: ServerRuntimeTranslation["relighting"]
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => TimerHandle
  cancel?: (handle: TimerHandle) => void
  /** Projects the settled row to this connection. */
  onUnreadChanged: (agentId: string, sessionId: string, unread: boolean) => void
}

function sameTarget(left: Target, right: Target) {
  return left.agentId === right.agentId && left.sessionId === right.sessionId
}

export function createReadState({
  catalog,
  relighting,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  onUnreadChanged,
}: ReadStateOptions): ReadState {
  const { rows } = catalog
  const writtenAt = new Map<string, number>()
  let focused: Target | undefined
  let releaseFocus: (() => void) | undefined
  let pending:
    | {
        handle: TimerHandle
        target: Target
        forced: boolean
      }
    | undefined
  let tracked: Promise<boolean> | undefined
  let closed = false

  const keyOf = ({ agentId, sessionId }: Target) =>
    `${agentId}\u0000${sessionId}`

  /**
   * Whether the runtime keeps a read watermark, which only some do. Only an
   * answer is kept: a failed read is asked again on the next write.
   */
  const tracks = () => {
    tracked ??= catalog.info().then(
      ({ capabilities }) =>
        capabilities.sessionReadState?.status === "available",
      () => {
        tracked = undefined
        return false
      }
    )
    return tracked
  }

  const clearPending = () => {
    if (!pending) return
    cancel(pending.handle)
    pending = undefined
  }

  const write = async (target: Target, forced: boolean) => {
    if (closed) return
    const key = keyOf(target)
    const last = writtenAt.get(key)
    if (!forced && last !== undefined && now() - last < REACK_FLOOR_MS) {
      // The floor only spaces the writes out: a Session still in focus is
      // acknowledged once it passes, or its re-lit row would stand until the
      // next exposure.
      if (focused && sameTarget(focused, target))
        arm(target, false, last + REACK_FLOOR_MS - now())
      return
    }
    if (!(await tracks()) || closed) return
    writtenAt.set(key, now())
    const written = catalog.markRead(target.agentId, target.sessionId)
    onUnreadChanged(target.agentId, target.sessionId, false)
    await written
  }

  /**
   * Restarts the debounce. A forced write survives a re-arm so an exposure
   * never loses its acknowledgement to a floored re-ack.
   */
  function arm(target: Target, force: boolean, delayMs = FOCUS_DEBOUNCE_MS) {
    if (closed) return
    const forced =
      force ||
      (pending !== undefined &&
        sameTarget(pending.target, target) &&
        pending.forced)
    clearPending()
    const handle = schedule(() => {
      pending = undefined
      void write(target, forced)
    }, delayMs)
    pending = { handle, target, forced }
  }

  const unfocus = () => {
    focused = undefined
    releaseFocus?.()
    releaseFocus = undefined
    clearPending()
  }

  return {
    focus(agentId, sessionId) {
      unfocus()
      const target = { agentId, sessionId }
      focused = target
      /*
       * A provider re-lights a Session for activity the operator is already
       * reading, and only a list read reports it. The browser never asks for
       * unread, so an `unread` on the focused row is always the provider and
       * never an operator who wants it kept unread: the row stays read and the
       * provider gets the acknowledgement instead of the browser a flash.
       */
      releaseFocus = rows.holdRead(agentId, sessionId, () => arm(target, false))
      // A watermark that moves only on a write needs one acknowledgement per
      // exposure, even for a row that already reads read.
      if (relighting || rows.get(agentId, sessionId)?.unread) arm(target, true)
    },

    blur: unfocus,

    onExecution(event) {
      if (!focused || !sameTarget(focused, event)) return
      if (!relighting?.includes(event.kind)) return
      arm(focused, false)
    },

    close() {
      closed = true
      unfocus()
    },
  }
}
