"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import {
  useAgUiRuntime,
  type UseAgUiRuntimeOptions,
} from "@assistant-ui/react-ag-ui"

import type { RuntimeBundle } from "../contracts"
import { createAgUiActivityPublisher } from "./ag-ui-activity"
import {
  createAgUiWorkspace,
  type AgUiWorkspaceTransport,
} from "./ag-ui-workspace"
import { AgUiThreadListBridge } from "./ag-ui-thread-list-bridge"

export type UseAgUiRuntimeBundleOptions = UseAgUiRuntimeOptions & {
  workspaceTransport: AgUiWorkspaceTransport
  activityClock?: () => Date
  activityIdFactory?: () => string
}

export function useAgUiRuntimeBundle({
  workspaceTransport,
  activityClock,
  activityIdFactory,
  adapters,
  ...runtimeOptions
}: UseAgUiRuntimeBundleOptions): RuntimeBundle {
  const bridge = useMemo(
    () => new AgUiThreadListBridge(runtimeOptions.agent, workspaceTransport),
    [runtimeOptions.agent, workspaceTransport]
  )
  const bridgeSnapshot = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
    bridge.getSnapshot
  )
  const threadList = useMemo(
    () => bridge.getThreadListAdapter(bridgeSnapshot),
    [bridge, bridgeSnapshot]
  )
  const assistantRuntime = useAgUiRuntime({
    ...runtimeOptions,
    unstable_enableMessageQueue:
      runtimeOptions.unstable_enableMessageQueue ?? true,
    adapters: {
      ...adapters,
      history: bridge.history,
      threadList,
    },
  })
  const activityPublisher = useMemo(
    () =>
      createAgUiActivityPublisher({
        clock: activityClock,
        activityIdFactory,
      }),
    [activityClock, activityIdFactory]
  )
  const workspace = useMemo(
    () =>
      createAgUiWorkspace({
        transport: bridge.workspaceTransport,
        activityPublisher,
      }),
    [activityPublisher, bridge]
  )
  useEffect(() => {
    if (bridgeSnapshot.activeThreadId !== runtimeOptions.agent.threadId) return
    activityPublisher.attach(assistantRuntime, runtimeOptions.agent)
    return () => {
      activityPublisher.detach()
    }
  }, [
    activityPublisher,
    assistantRuntime,
    bridgeSnapshot.activeThreadId,
    runtimeOptions.agent,
  ])

  return useMemo(
    () => ({ assistantRuntime, workspace }),
    [assistantRuntime, workspace]
  )
}
