"use client"

import { createContext, useContext, type ReactNode } from "react"

/** Where another Session opens, or nothing when this surface cannot open one. */
export type ToolUiSessionHref = (sessionId: string) => string | undefined

const SessionHrefContext = createContext<ToolUiSessionHref | undefined>(
  undefined
)

/**
 * Lets tool views link to a Session they spawned. The workspace supplies it;
 * a surface without Session navigation, such as guest chat, leaves it out and
 * the link is not offered.
 */
export function ToolUiSessionLinkProvider({
  sessionHref,
  children,
}: {
  sessionHref: ToolUiSessionHref
  children: ReactNode
}) {
  return (
    <SessionHrefContext.Provider value={sessionHref}>
      {children}
    </SessionHrefContext.Provider>
  )
}

export function useToolUiSessionHref(sessionId: string | undefined) {
  const sessionHref = useContext(SessionHrefContext)
  return sessionId ? sessionHref?.(sessionId) : undefined
}
