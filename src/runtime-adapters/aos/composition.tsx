"use client"

import { useCallback, useMemo } from "react"
import { useAuiState, useRemoteThreadListRuntime } from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"

import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "../definition"
import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import { AosThreadListAdapter } from "./aos-thread-list"

function AosRuntimeProvider({ children }: RuntimeAdapterProps<"aos">) {
  const client = useMemo(() => new AosRemoteClient(), [])
  const threadList = useMemo(() => new AosThreadListAdapter(client), [client])
  const runtimeHook = useCallback(
    function useAosThreadRuntime() {
      const remoteId = useAuiState((state) => state.threadListItem.remoteId)
      const agentId = useAuiState((state) => {
        const value = state.threadListItem.custom?.agentId
        return typeof value === "string" ? value : undefined
      })
      const agent = useMemo(
        () =>
          createAosRunAgent({
            agentId: agentId ?? "",
            threadId: remoteId ?? "",
          }),
        [agentId, remoteId]
      )
      const history = useMemo(
        () => (remoteId ? threadList.historyFor(remoteId) : undefined),
        [remoteId]
      )
      return useAgUiRuntime({
        agent,
        isDisabled: !remoteId || !agentId,
        adapters: { history },
        onCancel: () => {
          if (remoteId) void client.stopRun(remoteId).catch(() => undefined)
        },
      })
    },
    [client, threadList]
  )
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: threadList,
    runtimeHook,
  })

  return children({
    assistantRuntime,
    workspace: client,
    activityCoverage: "workspace",
  })
}

export const runtimeAdapter: RuntimeAdapterDefinition<"aos"> = {
  mode: "aos",
  Provider: AosRuntimeProvider,
}
