"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"

import type { McpAppAdapter } from "@/runtime-adapters/contracts"

export type McpAppHost = {
  adapter: McpAppAdapter
  agentId: string
  sessionId: string
}

const McpAppHostContext = createContext<McpAppHost | undefined>(undefined)

/** Scopes App views to the Session the conversation surface shows. */
export function McpAppHostProvider({
  adapter,
  agentId,
  sessionId,
  children,
}: {
  adapter?: McpAppAdapter
  agentId?: string
  sessionId?: string
  children: ReactNode
}) {
  const host = useMemo(
    () =>
      adapter && agentId && sessionId
        ? { adapter, agentId, sessionId }
        : undefined,
    [adapter, agentId, sessionId]
  )
  return (
    <McpAppHostContext.Provider value={host}>
      {children}
    </McpAppHostContext.Provider>
  )
}

/** `undefined` where the runtime hosts no App views. */
export function useMcpAppHost() {
  return useContext(McpAppHostContext)
}
