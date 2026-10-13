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
  const graceOver = useGraceOver(outage !== undefined)
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
 * the Session is gone, and `reconnecting` once the connection was lost while
 * the Session was joined and it has not joined again (nor gone) past the grace
 * the connection's notice waits. A Session that leaves `joined` with no loss,
 * such as a replay the browser asked for, has no reconnect to report, and
 * neither has a first open. The loss is forgotten once the Session joins.
 *
 * Known limit: the SDK reports a join it retries and one the gateway refused
 * both as `unavailable`, so a rejoin refused after a loss keeps reading as
 * reconnecting until the next transport rejoins it.
 */
export function useSessionNotice(
  connection: AcpConnection,
  sessionId: string | undefined,
  state: AcpSessionState | undefined
): SessionNotice | undefined {
  const outage = useSyncExternalStore(
    connection.subscribeOutage,
    () => connection.outage,
    () => connection.outage
  )
  // Whether the selected Session has joined since it was selected, and
  // whether the connection was lost after it had.
  const [selected, setSelected] = useState(sessionId)
  const [joined, setJoined] = useState(state === "joined")
  const [lost, setLost] = useState(false)
  if (selected !== sessionId) {
    setSelected(sessionId)
    setJoined(state === "joined")
    setLost(false)
  } else if (state === "joined" && !joined) setJoined(true)
  else if (joined && outage !== undefined && !lost) setLost(true)
  else if (lost && state === "joined" && outage === undefined) setLost(false)
  const rejoining = lost && (state === "joining" || state === "unavailable")
  const graceOver = useGraceOver(rejoining)
  if (state === "gone") return "unavailable"
  return rejoining && graceOver ? "reconnecting" : undefined
}

/** Whether `active` has held for the notice's grace; false once it lapses. */
function useGraceOver(active: boolean) {
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
  return graceOver
}
