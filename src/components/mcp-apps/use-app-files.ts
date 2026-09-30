"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { backoffDelay } from "@aos/lifecycle"
import type { McpAppFiles } from "@aos/protocol/mcp-apps"
import {
  McpAppFilesRefusedError,
  type HarnessRuntime,
  type McpAppAdapter,
  type McpAppTarget,
} from "@/runtime-adapters/contracts"

export type AppConnectionStatus = HarnessRuntime["connectionStatus"]

/** The soonest a renewal follows the passes it replaces. */
const MIN_RENEWAL_MS = 30_000
const RENEWAL_BACKOFF = { baseMs: 1_000, capMs: 60_000 }

/**
 * A view's file addresses, renewed while it is mounted so their passes do not
 * lapse under it: at half their life, counted from when they arrived; when the
 * page wakes or comes online past that point, since a sleeping page's timers
 * stall; and when the connection comes back. A failed renewal retries with
 * backoff until the proxy refuses it outright. `renew` renews on demand and
 * resolves to the fresh files.
 */
export function useAppFiles({
  files: opened,
  openedAt,
  adapter,
  target,
  connectionStatus,
}: {
  /** The files the view opened with, when its call names any. */
  files: McpAppFiles | undefined
  /** When those files arrived. */
  openedAt: number
  adapter: McpAppAdapter
  target: McpAppTarget
  connectionStatus: AppConnectionStatus
}) {
  const [renewed, setRenewed] = useState<{ files: McpAppFiles; at: number }>()
  const renew = useCallback(async () => {
    const fresh = await adapter.renewFiles(target)
    setRenewed({ files: fresh, at: Date.now() })
    return fresh
  }, [adapter, target])

  const refused = useRef(false)
  const lastStatus = useRef(connectionStatus)
  useEffect(() => {
    const recovered =
      connectionStatus === "reconnected" && lastStatus.current !== "reconnected"
    lastStatus.current = connectionStatus
    const files = renewed?.files ?? opened
    if (!files || Object.keys(files.addresses).length === 0) return
    const arrivedAt = renewed?.at ?? openedAt
    // Passes without an expiry renew only when the connection comes back.
    const dueAt =
      files.expiresAt === undefined
        ? Infinity
        : arrivedAt +
          Math.max(
            (Date.parse(files.expiresAt) - arrivedAt) / 2,
            MIN_RENEWAL_MS
          )

    let timer: ReturnType<typeof setTimeout> | undefined
    let retries = 0
    let renewing = false
    let active = true
    // A success renders fresh files, which schedules the next renewal anew.
    const renewNow = () => {
      clearTimeout(timer)
      if (renewing || refused.current) return
      renewing = true
      renew().catch((error: unknown) => {
        renewing = false
        if (error instanceof McpAppFilesRefusedError) refused.current = true
        else if (active)
          timer = setTimeout(renewNow, backoffDelay(retries++, RENEWAL_BACKOFF))
      })
    }
    const wake = () => {
      if (Date.now() >= dueAt) renewNow()
    }
    if (recovered) renewNow()
    else if (dueAt !== Infinity)
      timer = setTimeout(renewNow, Math.max(0, dueAt - Date.now()))
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
    }
  }, [connectionStatus, opened, openedAt, renew, renewed])

  return { files: renewed?.files ?? opened, renew }
}
