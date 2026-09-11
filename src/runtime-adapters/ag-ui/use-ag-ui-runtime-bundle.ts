"use client"

import type { HttpAgent } from "@ag-ui/client"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  useAuiState,
  useRemoteThreadListRuntime,
  type AssistantRuntime,
} from "@assistant-ui/react"
import {
  useAgUiRuntime,
  type UseAgUiRuntimeOptions,
} from "@assistant-ui/react-ag-ui"

import type { WorkspaceAdapter } from "../contracts"
import { createAgUiActivityPublisher } from "./ag-ui-activity"
import {
  createAgUiWorkspace,
  type AgUiWorkspaceTransport,
} from "./ag-ui-workspace"
import { AgUiThreadListBridge } from "./ag-ui-thread-list-bridge"
import { createBrowserArtifactAdapter } from "@/artifacts/browser-artifact-adapter"

export type UseAgUiRuntimeBundleOptions = Omit<
  UseAgUiRuntimeOptions,
  "agent" | "onCancel"
> & {
  /** HttpAgent.abortRun detaches its request; arbitrary native Stop agents are unsafe here. */
  agent: HttpAgent
  workspaceTransport: AgUiWorkspaceTransport
  workspace?: WorkspaceAdapter
  activityClock?: () => Date
  activityIdFactory?: () => string
}

export function useAgUiRuntimeBundle({
  workspaceTransport,
  workspace: suppliedWorkspace,
  activityClock,
  activityIdFactory,
  adapters,
  onError,
  agent,
  logger,
  showThinking,
  autoCancelPendingToolCalls,
  unstable_enableMessageQueue,
  isDisabled,
  isSendDisabled,
  unstable_capabilities,
  suggestions,
}: UseAgUiRuntimeBundleOptions) {
  const bridge = useMemo(
    () => new AgUiThreadListBridge(agent, workspaceTransport),
    [agent, workspaceTransport]
  )
  const bridgeSnapshot = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
    bridge.getSnapshot
  )
  const threadAdapters = useMemo(() => {
    return {
      attachments: adapters?.attachments,
      speech: adapters?.speech,
      dictation: adapters?.dictation,
      voice: adapters?.voice,
      feedback: adapters?.feedback,
    }
  }, [adapters])
  const runtimeHook = useCallback(
    function useThreadRuntime() {
      const remoteId = useAuiState((state) => state.threadListItem.remoteId)
      const localId = useAuiState((state) => state.threadListItem.id)
      const threadId = remoteId ?? localId
      return useAgUiRuntime({
        logger,
        showThinking,
        autoCancelPendingToolCalls,
        isDisabled,
        isSendDisabled,
        unstable_capabilities,
        suggestions,
        agent: bridge.agentForThread(threadId),
        onError,
        // Cancelling this browser runtime only detaches its cloned HttpAgent.
        // A provider-native Stop callback must never be bound here.
        onCancel: undefined,
        unstable_enableMessageQueue: unstable_enableMessageQueue ?? true,
        adapters: {
          ...threadAdapters,
          history: bridge.historyForThread(threadId),
        },
      })
    },
    [
      autoCancelPendingToolCalls,
      bridge,
      isDisabled,
      isSendDisabled,
      logger,
      onError,
      showThinking,
      suggestions,
      threadAdapters,
      unstable_capabilities,
      unstable_enableMessageQueue,
    ]
  )
  const [settledThreadId, setSettledThreadId] = useState<string | undefined>()
  const settledThreadIdRef = useRef<string | undefined>(undefined)
  const assistantRuntimeRef = useRef<AssistantRuntime | undefined>(undefined)
  const onThreadIdChange = useCallback(
    (threadId: string | undefined) => {
      const previousThreadId = settledThreadIdRef.current
      if (previousThreadId && previousThreadId !== threadId) {
        const previousRuntime =
          assistantRuntimeRef.current?.threads.getById(previousThreadId)
        if (previousRuntime?.getState().isRunning) previousRuntime.cancelRun()
      }
      bridge.select(threadId)
      settledThreadIdRef.current = threadId
      setSettledThreadId(threadId)
    },
    [bridge]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: bridge.threadListAdapter,
    runtimeHook,
    threadId: bridgeSnapshot.activeThreadId,
    onThreadIdChange,
  })
  useEffect(() => {
    assistantRuntimeRef.current = assistantRuntime
    return () => {
      assistantRuntimeRef.current = undefined
    }
  }, [assistantRuntime])
  const sessionListKey = bridgeSnapshot.sessions
    .map((session) => session.threadId)
    .join("\u0000")
  useEffect(() => {
    if (bridgeSnapshot.isLoading) return
    void assistantRuntime.threads.reload()
  }, [assistantRuntime, bridgeSnapshot.isLoading, sessionListKey])
  useEffect(() => {
    const threadId = bridgeSnapshot.activeThreadId
    if (!threadId) return
    if (settledThreadId === threadId) return
    void assistantRuntime.threads
      .getLoadThreadsPromise()
      .then(() => assistantRuntime.threads.switchToThread(threadId))
      .then(() => {
        settledThreadIdRef.current = threadId
        setSettledThreadId(threadId)
      })
      .catch((error: unknown) =>
        onError?.(error instanceof Error ? error : new Error(String(error)))
      )
  }, [
    assistantRuntime,
    bridgeSnapshot.activeThreadId,
    onError,
    settledThreadId,
  ])
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
      suppliedWorkspace ??
      createAgUiWorkspace({
        transport: bridge.workspaceTransport,
        activityPublisher,
      }),
    [activityPublisher, bridge, suppliedWorkspace]
  )
  const artifacts = useMemo(() => createBrowserArtifactAdapter(), [])
  useEffect(() => {
    void bridge.initialize().catch((error: unknown) => {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    })
  }, [bridge, onError])
  useEffect(() => {
    if (!workspaceTransport.subscribeSessions) return
    return workspaceTransport.subscribeSessions(
      () => {
        void bridge
          .refresh()
          .catch((error: unknown) =>
            onError?.(error instanceof Error ? error : new Error(String(error)))
          )
      },
      (error) => onError?.(error)
    )
  }, [bridge, workspaceTransport, onError])
  useEffect(() => {
    const threadId = bridgeSnapshot.activeThreadId
    if (!threadId || threadId !== agent.threadId) return
    if (settledThreadId !== threadId) return
    activityPublisher.attach(assistantRuntime, bridge.agentForThread(threadId))
    return () => {
      activityPublisher.detach()
    }
  }, [
    activityPublisher,
    assistantRuntime,
    bridgeSnapshot.activeThreadId,
    bridge,
    agent,
    settledThreadId,
  ])

  return useMemo(
    () => ({ assistantRuntime, workspace, artifacts }),
    [artifacts, assistantRuntime, workspace]
  )
}
