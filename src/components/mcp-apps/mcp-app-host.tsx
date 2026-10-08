"use client"

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import type { McpAppView } from "@harness-gw/sdk/protocol"
import type { ShownFile } from "@/artifacts/artifacts"
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
 * message leaves the rendered window. Without `opened`, the panel opens
 * `target` itself.
 */
export type McpAppPip = McpAppPipData & {
  target: McpAppTarget
  /** The view its message already opened, and when it arrived. */
  opened?: { view: McpAppView; openedAt: number }
  /** The tool's name, when the call reported one. */
  toolName?: string
  /** The file the view shows, which names the panel. */
  file?: ShownFile
  /**
   * The control that opened the panel, which takes the focus back when it
   * closes; one that remounted meanwhile is found again by its
   * `data-artifact-open-id`.
   */
  opener?: HTMLElement
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

/** What a target addresses within its Session: a tool call or an Artifact. */
export const mcpAppTargetKey = (target: McpAppTarget) =>
  "toolCallId" in target
    ? `tool:${target.toolCallId}`
    : `artifact:${target.artifactId}`

export const sameMcpAppTarget = (a: McpAppTarget, b: McpAppTarget) =>
  a.agentId === b.agentId &&
  a.sessionId === b.sessionId &&
  mcpAppTargetKey(a) === mcpAppTargetKey(b)

function restoreFocus(opener: HTMLElement) {
  const key = opener.dataset.artifactOpenId
  const control = opener.isConnected
    ? opener
    : key === undefined
      ? null
      : document.querySelector<HTMLElement>(
          `[data-artifact-open-id="${CSS.escape(key)}"]`
        )
  control?.focus()
}

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
  const opener = useRef<HTMLElement>(undefined)
  const shown =
    pip && pip.target.agentId === agentId && pip.target.sessionId === sessionId
      ? pip
      : undefined
  // The side panel's view belongs to its Session, so leaving the Session
  // returns it to its message.
  useEffect(() => {
    if (!pip || shown) return
    const timer = window.setTimeout(() => {
      opener.current = undefined
      setPip(undefined)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [pip, shown])

  const showInPip = useCallback((next: McpAppPip) => {
    opener.current = next.opener
    setPip(next)
  }, [])
  // The control that opened the panel may render only once the panel is
  // gone, as an inspector row does on a desktop.
  const leavePip = useCallback(() => {
    const control = opener.current
    opener.current = undefined
    setPip(undefined)
    if (control) window.setTimeout(() => restoreFocus(control), 0)
  }, [])
  // A call's input, result, and cancellation each arrive once, so the first
  // reported value stands.
  const updatePip = useCallback(
    (target: McpAppTarget, data: McpAppPipData) =>
      setPip((current) => {
        if (!current || !sameMcpAppTarget(current.target, target))
          return current
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
            showInPip,
            leavePip,
            updatePip,
          }
        : undefined,
    [
      adapter,
      agentId,
      connectionStatus,
      leavePip,
      sessionId,
      showInPip,
      shown,
      updatePip,
    ]
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
