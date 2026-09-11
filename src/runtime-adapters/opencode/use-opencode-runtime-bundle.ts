"use client"

import type { AssistantRuntime } from "@assistant-ui/react"
import { useEffect, useMemo } from "react"
import {
  createOpencodeClient,
  type OpenCodeRuntimeOptions,
} from "@assistant-ui/react-opencode"

import { createBrowserArtifactAdapter } from "@/artifacts/browser-artifact-adapter"
import type { RuntimeBundle } from "../contracts"
import { createOpenCodeRuntimeInteractions } from "./opencode-interactions"
import { aosOpenCodeExtras } from "./opencode-runtime-extras"
import { createOpenCodeWorkspace } from "./opencode-workspace"
import {
  createAgentScopedOpenCodeClient,
  OpenCodeSessionOwnership,
} from "./opencode-session-ownership"
import {
  AosOpenCodeEventHub,
  useAosOpenCodeRuntime,
} from "./use-aos-opencode-runtime"

export type UseOpenCodeRuntimeBundleOptions = OpenCodeRuntimeOptions & {
  directory: string
  onInteractionError?: (error: Error | undefined, threadId: string) => void
}
export type OpenCodeRuntimeBundle = RuntimeBundle & {
  client: ReturnType<typeof createOpencodeClient>
  interactions: ReturnType<typeof createOpenCodeRuntimeInteractions>
}

class ThreadReloadBinding {
  #runtime: AssistantRuntime | null = null

  readonly reload = () => this.#runtime?.threads.reload()

  bind(runtime: AssistantRuntime) {
    this.#runtime = runtime
    return () => {
      if (this.#runtime === runtime) this.#runtime = null
    }
  }
}

export function useOpenCodeRuntimeBundle(
  options: UseOpenCodeRuntimeBundleOptions
): OpenCodeRuntimeBundle {
  const baseUrl = options.baseUrl ?? "http://localhost:4096"
  const client = useMemo(
    () =>
      options.client ??
      createOpencodeClient({ baseUrl, directory: options.directory }),
    [baseUrl, options.client, options.directory]
  )
  const defaultProviderId = options.defaultModel?.providerID
  const defaultModelId = options.defaultModel?.modelID
  const { scopedClient, ownership } = useMemo(() => {
    const ownership = new OpenCodeSessionOwnership()
    return {
      scopedClient: createAgentScopedOpenCodeClient({
        client,
        ownership,
        defaultModel:
          defaultProviderId && defaultModelId
            ? { providerID: defaultProviderId, modelID: defaultModelId }
            : undefined,
      }),
      ownership,
    }
  }, [client, defaultModelId, defaultProviderId])
  const threadReload = useMemo(() => new ThreadReloadBinding(), [])
  const eventHub = useMemo(
    () => new AosOpenCodeEventHub(scopedClient),
    [scopedClient]
  )
  const workspace = useMemo(
    () =>
      createOpenCodeWorkspace({
        client: scopedClient,
        events: eventHub,
        ownership,
        reloadThreads: threadReload.reload,
      }),
    [scopedClient, eventHub, ownership, threadReload]
  )
  const runtimeOptions = useMemo(
    () => ({
      ...options,
      revertForEdit: async (sessionID: string, messageID: string) => {
        ownership.assertSendAvailable()
        await ownership.resolve(client, sessionID)
        ownership.assertSendAvailable()
        // This must bypass the reload proxy: it replays the original prompt.
        await client.session.abort({ sessionID }, { throwOnError: true })
        await client.session.revert(
          { sessionID, messageID },
          { throwOnError: true }
        )
      },
    }),
    [client, options, ownership]
  )
  const assistantRuntime = useAosOpenCodeRuntime(
    scopedClient,
    runtimeOptions,
    eventHub
  )
  useEffect(
    () => threadReload.bind(assistantRuntime),
    [assistantRuntime, threadReload]
  )
  const interactions = useMemo(
    () =>
      createOpenCodeRuntimeInteractions(
        scopedClient,
        {
          read(threadId) {
            const extras = aosOpenCodeExtras.tryGet(
              assistantRuntime.thread.getState().extras
            )
            return extras?.session?.id === threadId
              ? {
                  state: extras.state,
                  questions: Object.values(extras.questions),
                }
              : undefined
          },
          subscribe: (listener) => assistantRuntime.thread.subscribe(listener),
        },
        eventHub,
        options.onInteractionError
      ),
    [scopedClient, assistantRuntime, eventHub, options.onInteractionError]
  )
  const artifacts = useMemo(() => createBrowserArtifactAdapter(), [])

  return useMemo(
    () => ({
      assistantRuntime,
      workspace,
      client: scopedClient,
      interactions,
      artifacts,
    }),
    [artifacts, assistantRuntime, interactions, scopedClient, workspace]
  )
}
