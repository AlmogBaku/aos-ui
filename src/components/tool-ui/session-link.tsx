"use client"

import {
  createContext,
  useContext,
  type MouseEvent,
  type ReactNode,
} from "react"

/** A Session this surface can open: its address, and the in-app way there. */
export type ToolUiSessionLink = { href: string; open: () => void }

/** How another Session opens, or nothing when this surface cannot open it. */
export type ToolUiSessionLinkResolver = (
  sessionId: string
) => ToolUiSessionLink | undefined

const SessionLinkContext = createContext<ToolUiSessionLinkResolver | undefined>(
  undefined
)

/**
 * Lets tool views link to a Session they spawned. The workspace supplies it;
 * a surface without Session navigation, such as guest chat, leaves it out and
 * the link is not offered.
 */
export function ToolUiSessionLinkProvider({
  sessionLink,
  children,
}: {
  sessionLink: ToolUiSessionLinkResolver
  children: ReactNode
}) {
  return (
    <SessionLinkContext.Provider value={sessionLink}>
      {children}
    </SessionLinkContext.Provider>
  )
}

export function useToolUiSessionLink(sessionId: string | undefined) {
  const sessionLink = useContext(SessionLinkContext)
  return sessionId ? sessionLink?.(sessionId) : undefined
}

/**
 * A plain click opens the Session in place; a modified or non-primary click
 * keeps the browser's own link behavior, such as a new tab.
 */
export function openSessionLinkInPlace(
  event: MouseEvent<HTMLAnchorElement>,
  link: ToolUiSessionLink
) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return
  event.preventDefault()
  link.open()
}
