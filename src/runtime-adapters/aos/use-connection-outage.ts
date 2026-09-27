import { useEffect, useState, useSyncExternalStore } from "react"

import type { AcpConnection, AcpConnectionOutage } from "./acp/types"

/** How long a reconnect may run before it shows, so a healthy resume shows nothing. */
export const RECONNECTING_NOTICE_GRACE_MS = 2_000

/**
 * The connection's outage as the UI shows it: `capacity` at once, and
 * `reconnecting` once the outage has lasted its grace. Once shown, it follows
 * the outage until it clears.
 */
export function useConnectionOutage(
  connection: AcpConnection
): AcpConnectionOutage | undefined {
  const outage = useSyncExternalStore(
    connection.subscribeOutage,
    () => connection.outage,
    () => connection.outage
  )
  const active = outage !== undefined
  const [graceOver, setGraceOver] = useState(false)
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(
      () => setGraceOver(true),
      RECONNECTING_NOTICE_GRACE_MS
    )
    return () => {
      clearTimeout(timer)
      setGraceOver(false)
    }
  }, [active])
  return outage === "capacity" || graceOver ? outage : undefined
}
