import { useEffect, useState, useSyncExternalStore } from "react"

import type {
  AcpConnection,
  AcpConnectionOutage,
  AcpSessionState,
} from "@harness-gw/sdk"

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

/** What the selected Session's own notice tells the reader. */
export type SessionNotice = "unavailable" | "reconnecting"

/**
 * The selected Session's notice, beneath the connection's: `unavailable` once
 * the Session is gone, and `reconnecting` once a Session joined since it was
 * selected has been rejoining (`joining`, or `unavailable` between retries)
 * past the grace the connection's notice waits. A first open shows nothing
 * however long its join takes, and the notice goes once the Session is joined.
 */
export function useSessionNotice(
  sessionId: string | undefined,
  state: AcpSessionState | undefined
): SessionNotice | undefined {
  // Whether the selected Session has been joined since it was selected.
  const [selected, setSelected] = useState(sessionId)
  const [joined, setJoined] = useState(state === "joined")
  if (selected !== sessionId) {
    setSelected(sessionId)
    setJoined(state === "joined")
  } else if (state === "joined" && !joined) setJoined(true)
  const rejoining = joined && (state === "joining" || state === "unavailable")
  const [graceOver, setGraceOver] = useState(false)
  useEffect(() => {
    if (!rejoining) return
    const timer = setTimeout(
      () => setGraceOver(true),
      RECONNECTING_NOTICE_GRACE_MS
    )
    return () => {
      clearTimeout(timer)
      setGraceOver(false)
    }
  }, [rejoining])
  if (state === "gone") return "unavailable"
  return rejoining && graceOver ? "reconnecting" : undefined
}
