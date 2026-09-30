"use client"

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import type { McpAppView } from "@aos/protocol/mcp-apps"
import type { McpAppAdapter, McpAppTarget } from "@/runtime-adapters/contracts"

import type { AppConnectionStatus } from "./use-app-files"

/** What a call reports to its view, which the side panel's view needs too. */
export type McpAppPipData = {
  input?: Record<string, unknown>
  result?: CallToolResult
  cancelled?: string
}

/**
 * A view in the side panel: everything its frame needs, so it stays when its
 * message leaves the rendered window.
 */
export type McpAppPip = McpAppPipData & {
  target: McpAppTarget
  view: McpAppView
  /** When `view` arrived, which its files' passes count from. */
  openedAt: number
  /** The tool's name, when the call reported one. */
  toolName?: string
}

export type McpAppHost = {
  adapter: McpAppAdapter
  agentId: string
  sessionId: string
  /** The runtime connection's state, which the views' files follow. */
  connectionStatus?: AppConnectionStatus
  /** The view in the side panel, while its Session is the one shown. */
  pip?: McpAppPip
  /** Shows a view in the side panel, returning any other to its message. */
  showInPip: (pip: McpAppPip) => void
  /** Returns the side panel's view to its message. */
  leavePip: () => void
  /** Hands the side panel's view what its call reported since it moved. */
  updatePip: (target: McpAppTarget, data: McpAppPipData) => void
}

const McpAppHostContext = createContext<McpAppHost | undefined>(undefined)

const sameTarget = (a: McpAppTarget, b: McpAppTarget) =>
  a.agentId === b.agentId &&
  a.sessionId === b.sessionId &&
  a.toolCallId === b.toolCallId

/**
 * Scopes App views to the Session the conversation surface shows, and holds
 * the one view shown in the side panel.
 */
export function McpAppHostProvider({
  adapter,
  agentId,
  sessionId,
  connectionStatus,
  children,
}: {
  adapter?: McpAppAdapter
  agentId?: string
  sessionId?: string
  connectionStatus?: AppConnectionStatus
  children: ReactNode
}) {
  const [pip, setPip] = useState<McpAppPip>()
  const shown =
    pip && pip.target.agentId === agentId && pip.target.sessionId === sessionId
      ? pip
      : undefined
  // The side panel's view belongs to its Session, so leaving the Session
  // returns it to its message.
  useEffect(() => {
    if (!pip || shown) return
    const timer = window.setTimeout(() => setPip(undefined), 0)
    return () => window.clearTimeout(timer)
  }, [pip, shown])

  const leavePip = useCallback(() => setPip(undefined), [])
  // A call's input, result, and cancellation each arrive once, so the first
  // reported value stands.
  const updatePip = useCallback(
    (target: McpAppTarget, data: McpAppPipData) =>
      setPip((current) => {
        if (!current || !sameTarget(current.target, target)) return current
        const input = current.input ?? data.input
        const result = current.result ?? data.result
        const cancelled = current.cancelled ?? data.cancelled
        return input === current.input &&
          result === current.result &&
          cancelled === current.cancelled
          ? current
          : { ...current, input, result, cancelled }
      }),
    []
  )
  const host = useMemo(
    () =>
      adapter && agentId && sessionId
        ? {
            adapter,
            agentId,
            sessionId,
            connectionStatus,
            pip: shown,
            showInPip: setPip,
            leavePip,
            updatePip,
          }
        : undefined,
    [adapter, agentId, connectionStatus, leavePip, sessionId, shown, updatePip]
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
