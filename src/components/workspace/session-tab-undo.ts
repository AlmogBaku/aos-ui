"use client"

import { useEffect, useRef, useState } from "react"

export type ClosedSessionTab = {
  agentId: string
  threadId: string
  title: string
  selectedThreadId: string | null
  selectionChanged?: boolean
  previousLastSelectedThreadId?: string | null
  clearedLastSelected?: boolean
}

export function neighborAfterClose(
  ids: readonly string[],
  closed: string,
  selected: string | null
) {
  if (closed !== selected) return selected
  const index = ids.indexOf(closed)
  return ids[index + 1] ?? ids[index - 1] ?? null
}

export function restoreBackgroundLastSelected(
  lastSelected: Map<string, string | null>,
  closed: ClosedSessionTab
) {
  if (
    !closed.clearedLastSelected ||
    lastSelected.has(closed.agentId) ||
    closed.previousLastSelectedThreadId === undefined
  ) {
    return
  }
  lastSelected.set(closed.agentId, closed.previousLastSelectedThreadId)
}

export function useSessionTabUndo() {
  const [pending, setPending] = useState<ClosedSessionTab | null>(null)
  const latest = useRef<ClosedSessionTab | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  function remember(tab: ClosedSessionTab) {
    clearTimeout(timer.current)
    latest.current = tab
    setPending(tab)
    timer.current = setTimeout(() => {
      latest.current = null
      setPending(null)
    }, 8000)
  }

  function take() {
    clearTimeout(timer.current)
    const tab = latest.current
    latest.current = null
    setPending(null)
    return tab
  }

  return { pending, remember, take }
}
