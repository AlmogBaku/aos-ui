"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { ChildSessionControls } from "@/runtime-adapters/child-sessions"

/**
 * The controls a subagent's card has over the child Session behind it, from
 * the runtime the thread reads. A runtime whose subagents have no Session of
 * their own provides none, and its cards only show what the child did.
 */
const ChildSessionControlsContext = createContext<
  ChildSessionControls | undefined
>(undefined)

/** Provides `controls`, or keeps an outer provider's when there are none. */
export function ChildSessionControlsProvider({
  controls,
  children,
}: {
  controls: ChildSessionControls | undefined
  children: ReactNode
}) {
  const outer = useContext(ChildSessionControlsContext)
  return (
    <ChildSessionControlsContext.Provider value={controls ?? outer}>
      {children}
    </ChildSessionControlsContext.Provider>
  )
}

export function useChildSessionControls() {
  return useContext(ChildSessionControlsContext)
}
