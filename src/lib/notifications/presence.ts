import { PRESENCE_HEARTBEAT_MS, PRESENCE_IDLE_MS } from "@aos/protocol/push"

/**
 * Whether a foreground connection is still attended. The proxy holds a push back
 * only while some connection is present, so a tab nobody is using has to say so,
 * and has to keep saying so while it stays in the foreground.
 */

type PresenceTarget = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>

export type IdleTracker = {
  idle(): boolean
  onChange(listener: (idle: boolean) => void): () => void
  stop(): void
}

/** Input that proves the operator is still at this tab. */
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const
/** A moving pointer reports continuously; once a second is enough to stay present. */
const MOVE_THROTTLE_MS = 1_000

const afterDelay = (ms: number, callback: () => void) => {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

const onEvery = (ms: number, callback: () => void) => {
  const timer = setInterval(callback, ms)
  return () => clearInterval(timer)
}

export function createIdleTracker({
  target,
  idleMs = PRESENCE_IDLE_MS,
  now = () => Date.now(),
  delay = afterDelay,
}: {
  target: PresenceTarget
  idleMs?: number
  now?: () => number
  delay?: (ms: number, callback: () => void) => () => void
}): IdleTracker {
  let idle = false
  let movedAt = 0
  let cancel: (() => void) | undefined
  const listeners = new Set<(idle: boolean) => void>()
  const detach: (() => void)[] = []
  const announce = (next: boolean) => {
    if (idle === next) return
    idle = next
    for (const listener of [...listeners]) {
      try {
        listener(idle)
      } catch {
        /* A failing observer never stops the tracking. */
      }
    }
  }
  const attended = () => {
    cancel?.()
    cancel = delay(idleMs, () => announce(true))
    announce(false)
  }
  const moved = () => {
    const at = now()
    if (at - movedAt < MOVE_THROTTLE_MS) return
    movedAt = at
    attended()
  }
  const listen = (type: string, listener: () => void) => {
    target.addEventListener(type, listener, { passive: true })
    detach.push(() => target.removeEventListener(type, listener))
  }
  for (const type of INPUT_EVENTS) listen(type, attended)
  listen("pointermove", moved)
  attended()
  return {
    idle: () => idle,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stop() {
      cancel?.()
      cancel = undefined
      for (const remove of detach.splice(0)) {
        try {
          remove()
        } catch {}
      }
      listeners.clear()
    },
  }
}

export function createHeartbeat({
  everyMs = PRESENCE_HEARTBEAT_MS,
  active,
  tick,
  repeat = onEvery,
}: {
  everyMs?: number
  /** Only a foreground connection has presence worth repeating. */
  active: () => boolean
  tick: () => void
  repeat?: (ms: number, callback: () => void) => () => void
}) {
  const cancel = repeat(everyMs, () => {
    try {
      if (active()) tick()
    } catch {
      /* A failed report is repeated by the next beat. */
    }
  })
  return {
    stop() {
      try {
        cancel()
      } catch {}
    },
  }
}
