import { useEffect, useEffectEvent } from "react"

import {
  buildWorkspacePathname,
  parseWorkspacePathname,
} from "@/lib/workspace-routing"

/** How long the last location outlives the operator's last activity. */
export const LAST_LOCATION_TTL_MS = 6 * 60 * 60 * 1000
/** How often input alone rewrites an entry that already holds this path. */
export const LAST_LOCATION_TOUCH_MS = 60 * 1000

const lastLocationKey = "aos_ui:workspace:last-location"

type LocationStorage = Pick<Storage, "getItem" | "setItem">
type LastLocation = { path: string; usedAt: number }

/** Only a path that names an Agent, in the form the router writes, is a place. */
function isWorkspacePlace(path: string) {
  const selection = parseWorkspacePathname(path)
  return (
    Boolean(selection?.agentId) &&
    buildWorkspacePathname(selection ?? { agentId: null, sessionId: null }) ===
      path
  )
}

function readEntry(storage: LocationStorage): LastLocation | null {
  try {
    const value: unknown = JSON.parse(
      storage.getItem(lastLocationKey) ?? "null"
    )
    if (typeof value !== "object" || value === null) return null
    const { path, usedAt } = value as Record<string, unknown>
    return typeof path === "string" &&
      typeof usedAt === "number" &&
      isWorkspacePlace(path)
      ? { path, usedAt }
      : null
  } catch {
    return null
  }
}

/** Milliseconds since `usedAt`; a future entry has no age a window can hold. */
function ageOf({ usedAt }: LastLocation) {
  return Date.now() - usedAt
}

/** The stored workspace path, while it is younger than the inactivity window. */
export function readLastLocation(storage: LocationStorage) {
  const entry = readEntry(storage)
  if (!entry) return null
  const age = ageOf(entry)
  return age >= 0 && age < LAST_LOCATION_TTL_MS ? entry.path : null
}

export function writeLastLocation(storage: LocationStorage, path: string) {
  if (!isWorkspacePlace(path)) return
  try {
    storage.setItem(
      lastLocationKey,
      JSON.stringify({ path, usedAt: Date.now() } satisfies LastLocation)
    )
  } catch {
    // A browser that refuses storage simply reopens at the default.
  }
}

/**
 * Remembers the visible tab's place on every move, and on input while it
 * stays there. Input rewrites at most once a minute, unless another tab has
 * since stored its own place, so the tab used last is the one that reopens.
 */
export function useRememberLocation(path: string) {
  useEffect(() => {
    if (document.visibilityState === "visible")
      writeLastLocation(window.localStorage, path)
  }, [path])

  const touch = useEffectEvent(() => {
    const stored = readEntry(window.localStorage)
    if (stored?.path === path) {
      const age = ageOf(stored)
      if (age >= 0 && age < LAST_LOCATION_TOUCH_MS) return
    }
    writeLastLocation(window.localStorage, path)
  })

  useEffect(() => {
    const listener = () => touch()
    const options = { capture: true, passive: true }
    document.addEventListener("keydown", listener, options)
    document.addEventListener("pointerdown", listener, options)
    return () => {
      document.removeEventListener("keydown", listener, options)
      document.removeEventListener("pointerdown", listener, options)
    }
  }, [])
}
