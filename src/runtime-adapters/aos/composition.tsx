"use client"

import { useMemo } from "react"
import {
  fromThreadMessageLike,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type RemoteThreadListAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react"

import type {
  RuntimeAdapterDefinition,
  RuntimeAdapterProps,
} from "../definition"
import { AosRemoteClient } from "./aos-client"

const unavailable = () =>
  Promise.reject(new Error("Session operations are not available yet"))

const emptyThreadListAdapter: RemoteThreadListAdapter = {
  async list() {
    return { threads: [] }
  },
  fetch: unavailable,
  initialize: unavailable,
  rename: unavailable,
  archive: unavailable,
  unarchive: unavailable,
  delete: unavailable,
  async generateTitle() {
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    }) as Awaited<ReturnType<RemoteThreadListAdapter["generateTitle"]>>
  },
}

function useUnavailableThreadRuntime() {
  return useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: (message, index) =>
      fromThreadMessageLike(message, `aos-message-${index}`, {
        type: "complete",
        reason: "unknown",
      }),
    isDisabled: true,
    async onNew() {
      throw new Error("Session runs are not available yet")
    },
  })
}

function AosRuntimeProvider({ children }: RuntimeAdapterProps<"aos">) {
  const client = useMemo(() => new AosRemoteClient(), [])
  const assistantRuntime = useRemoteThreadListRuntime({
    adapter: emptyThreadListAdapter,
    runtimeHook: useUnavailableThreadRuntime,
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
