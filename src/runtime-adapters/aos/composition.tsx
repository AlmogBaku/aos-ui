"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuiState, useRemoteThreadListRuntime } from "@assistant-ui/react"
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui"

import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "../definition"
import { AosAuthGate, AuthGateFailure } from "./aos-auth-gate"
import { AosRemoteClient, createAosRunAgent } from "./aos-client"
import { AosReconciler } from "./aos-reconciliation"
import { AosThreadListAdapter } from "./aos-thread-list"

function ReadyAosRuntimeProvider({
  children,
  onReconnect,
}: RuntimeAdapterProps<"aos"> & { onReconnect(): Promise<void> }) {
  const reconciler = useMemo(
    () => new AosReconciler({ onReconnect }),
    [onReconnect]
  )
  useEffect(() => () => reconciler.close(), [reconciler])
  const client = useMemo(
    () => new AosRemoteClient({ reconciler }),
    [reconciler]
  )
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

export function AosRuntimeProvider(props: RuntimeAdapterProps<"aos">) {
  const startupClient = useMemo(() => new AosRemoteClient(), [])
  const [gateGeneration, setGateGeneration] = useState(0)
  const operatorAuth = useCallback(
    async (signal: AbortSignal) => {
      const state = await startupClient.operatorAuth(signal)
      return state.status === "authenticated"
        ? ({ status: "authenticated" } as const)
        : ({ status: "authentication-required" } as const)
    },
    [startupClient]
  )
  const runtimeAuth = useCallback(
    (signal: AbortSignal) => startupClient.runtimeAuth(signal),
    [startupClient]
  )
  const startup = useCallback(
    async (signal: AbortSignal) => {
      const runtime = await startupClient.runtimeInfo(signal)
      if (runtime.status === "unavailable")
        throw new AuthGateFailure("provider-unavailable")
      await startupClient.listAgentCatalog(signal)
      await startupClient.listSessionCatalog(50, 0, signal)
    },
    [startupClient]
  )
  const onReconnect = useCallback(async () => {
    try {
      const signal = new AbortController().signal
      const operator = await operatorAuth(signal)
      if (operator.status !== "authenticated") throw new Error()
      const runtime = await runtimeAuth(signal)
      if (runtime.status !== "authenticated") throw new Error()
      await startup(signal)
    } catch (error) {
      setGateGeneration((generation) => generation + 1)
      throw error
    }
  }, [operatorAuth, runtimeAuth, startup])

  return (
    <AosAuthGate
      key={gateGeneration}
      locale={props.locale}
      operatorAuth={operatorAuth}
      runtimeAuth={runtimeAuth}
      startup={startup}
    >
      <ReadyAosRuntimeProvider {...props} onReconnect={onReconnect} />
    </AosAuthGate>
  )
}

export const runtimeAdapter: RuntimeAdapterDefinition<"aos"> = {
  mode: "aos",
  Provider: AosRuntimeProvider,
}
