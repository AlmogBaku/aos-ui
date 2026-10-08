import { useEffect, useState, useSyncExternalStore } from "react"

import type { AcpConnection, AcpConnectionOutage } from "@harness-gw/sdk"

/** How long a reconnect may run before it shows, so a healthy resume shows nothing. */
export const RECONNECTING_NOTICE_GRACE_MS = 2_000

/** How long `reconnected` shows once a shown outage clears. */
export const RECONNECTED_NOTICE_MS = 2_000

/** What the UI tells the reader about the connection. */
export type ConnectionNotice = AcpConnectionOutage | "reconnected"

/**
 * The connection's outage as the UI shows it: `capacity` at once, and
 * `reconnecting` once the outage has lasted its grace. Once shown, it follows
 * the outage until it clears, and then shows `reconnected` for a moment.
 */
export function useConnectionOutage(
  connection: AcpConnection
): ConnectionNotice | undefined {
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
  const shown = outage === "capacity" || graceOver ? outage : undefined
  const [previous, setPrevious] = useState(shown)
  const [reconnected, setReconnected] = useState(false)
  if (shown !== previous) {
    setPrevious(shown)
    // A connection that ended rather than recovered shows nothing.
    setReconnected(shown === undefined && connection.status === "ready")
  }
  useEffect(() => {
    if (!reconnected) return
    const timer = setTimeout(() => setReconnected(false), RECONNECTED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [reconnected])
  return shown ?? (reconnected ? "reconnected" : undefined)
}
