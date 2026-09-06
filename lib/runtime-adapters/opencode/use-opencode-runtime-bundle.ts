"use client"

import { useMemo } from "react"
import {
  createOpencodeClient,
  useOpenCodeRuntime,
  type OpenCodeRuntimeOptions,
} from "@assistant-ui/react-opencode"

import type { RuntimeBundle } from "../contracts"
import { createOpenCodeWorkspace } from "./opencode-workspace"
import {
  createAgentScopedOpenCodeClient,
  OpenCodeSessionOwnership,
} from "./opencode-session-ownership"

export type UseOpenCodeRuntimeBundleOptions = OpenCodeRuntimeOptions & {
  managementUrl?: string
}
export type OpenCodeRuntimeBundle = RuntimeBundle & {
  client: ReturnType<typeof createOpencodeClient>
}

export function useOpenCodeRuntimeBundle(
  options: UseOpenCodeRuntimeBundleOptions = {}
): OpenCodeRuntimeBundle {
  const baseUrl = options.baseUrl ?? "http://localhost:4096"
  const client = useMemo(
    () => options.client ?? createOpencodeClient({ baseUrl }),
    [baseUrl, options.client]
  )
  const { scopedClient, workspace } = useMemo(() => {
    const ownership = new OpenCodeSessionOwnership()
    return {
      scopedClient: createAgentScopedOpenCodeClient({ client, ownership }),
      workspace: createOpenCodeWorkspace({
        client,
        ownership,
        managementUrl: options.managementUrl,
      }),
    }
  }, [client, options.managementUrl])
  const assistantRuntime = useOpenCodeRuntime({
    ...options,
    client: scopedClient,
  })

  return useMemo(
    () => ({ assistantRuntime, workspace, client: scopedClient }),
    [assistantRuntime, scopedClient, workspace]
  )
}
