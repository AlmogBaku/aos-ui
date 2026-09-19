import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { StrictMode, useEffect } from "react"

import { createProxyApp } from "../../../packages/proxy/app"
import { HermesServerAdapter } from "../../../packages/proxy/adapters/hermes/adapter"
import { SessionCoordinator } from "../../../packages/proxy/core/session-coordinator"
import type {
  RuntimeInstance,
  ServerRunEngine,
} from "../../../packages/proxy/core/runtime"
import type { HarnessRuntime } from "../contracts"
import { Thread } from "../../components/assistant-ui/elements/thread.aui"
import { runtimeAdapter } from "./composition"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AOS normalized Session browser integration", () => {
  it("opens normalized history, sends one turn, and issues separate deliberate Stop", async () => {
    const user = userEvent.setup()
    let authoritativeUserId = "native-user-1"
    let authoritativeUserText = "Open it"
    let invalidateEvents: (() => void) | undefined
    class ReadySocket extends EventTarget {
      readyState = 0
      readonly streams = new Map<string, unknown>()
      constructor() {
        super()
        invalidateEvents = () => this.invalidate()
        queueMicrotask(() => {
          this.readyState = 1
          this.dispatchEvent(new Event("open"))
        })
      }
      send(raw: string) {
        const request = JSON.parse(raw) as {
          streamId: string
          scope: unknown
        }
        this.streams.set(request.streamId, request.scope)
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "aos.ready",
                version: 1,
                streamId: request.streamId,
                scope: request.scope,
                generation: 0,
                read: "authoritative",
              }),
            })
          )
        )
      }
      invalidate() {
        for (const [streamId, scope] of this.streams)
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "aos.invalidate",
                version: 1,
                streamId,
                scope,
                generation: 1,
              }),
            })
          )
      }
      close() {
        this.readyState = 3
        this.dispatchEvent(new Event("close"))
      }
    }
    vi.stubGlobal("WebSocket", ReadySocket)
    const finishObservations: Array<() => void> = []
    let continueReasoning: (() => void) | undefined
    const reasoningContinued = new Promise<void>((resolve) => {
      continueReasoning = resolve
    })
    const stop = vi.fn()
    const start = vi.fn(async (_scope, input) => {
      let finishObservation: (() => void) | undefined
      const observationFinished = new Promise<void>((resolve) => {
        finishObservation = resolve
      })
      finishObservations.push(() => finishObservation?.())
      return {
        events: (async function* () {
          yield {
            type: "RUN_STARTED" as const,
            threadId: "stored-alpha",
            runId: input.runId,
          }
          yield {
            type: "REASONING_MESSAGE_START" as const,
            messageId: `${input.runId}:reasoning`,
            role: "reasoning" as const,
          }
          yield {
            type: "REASONING_MESSAGE_CONTENT" as const,
            messageId: `${input.runId}:reasoning`,
            delta: "First",
          }
          await reasoningContinued
          yield {
            type: "REASONING_MESSAGE_CONTENT" as const,
            messageId: `${input.runId}:reasoning`,
            delta: " second",
          }
          await observationFinished
          yield {
            type: "REASONING_MESSAGE_END" as const,
            messageId: `${input.runId}:reasoning`,
          }
          yield {
            type: "RUN_FINISHED" as const,
            threadId: "stored-alpha",
            runId: input.runId,
            outcome: { type: "success" as const },
          }
        })(),
        stop: async () => {
          stop()
          finishObservation?.()
          return "stopping" as const
        },
        settled: observationFinished,
        recoveryPosition: () => ({ epoch: "opaque", lastSeen: 0 }),
      }
    })
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === "profiles.list")
        return {
          profiles: [
            {
              name: "alpha",
              display_name: "Alpha",
              ui_meta: { "hermes-bots": {} },
              ui_meta_revisions: { "hermes-bots": 1 },
            },
            {
              name: "beta",
              display_name: "Beta",
              ui_meta: { "hermes-bots": {} },
              ui_meta_revisions: { "hermes-bots": 1 },
            },
          ],
        }
      if (method === "commands.catalog")
        return { pairs: [["/status", "Show status"]] }
      if (method === "session.resume")
        return {
          session_id: "live-alpha-secret",
          running: false,
          info: {},
        }
      throw new Error(`Unexpected native RPC: ${method}`)
    })
    const nativeHttp = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions?profile=alpha"))
        return {
          sessions: [
            {
              id: "stored-alpha",
              profile: "alpha",
              title: "Older",
              last_active: 1,
              session_id: "live-alpha-secret",
            },
          ],
          total: 1,
        }
      if (path.startsWith("/api/sessions?profile=beta"))
        return {
          sessions: [
            {
              id: "stored-beta",
              profile: "beta",
              title: "Newer",
              last_active: 2,
              session_id: "live-beta-secret",
            },
          ],
          total: 1,
        }
      if (path === "/api/sessions/stored-alpha?profile=alpha")
        return { id: "stored-alpha", profile: "alpha", title: "Older" }
      if (path === "/api/sessions/stored-beta?profile=alpha")
        return { id: "stored-beta", profile: "beta", title: "Newer" }
      if (path.startsWith("/api/sessions/stored-alpha/messages?"))
        return {
          session_id: "stored-alpha",
          messages: [
            {
              id: authoritativeUserId,
              role: "user",
              content: authoritativeUserText,
              timestamp: 1,
              native_position: 99,
              private_path: "/srv/hermes/private",
            },
            {
              id: "native-assistant-1",
              role: "assistant",
              reasoning: "Checking",
              content: "Ready",
              timestamp: 2,
            },
          ],
          pagination: { limit: 200, offset: 0, returned: 2, total: 2 },
        }
      throw new Error(`Unexpected native REST path: ${path}`)
    })
    const hermes = new HermesServerAdapter({
      request: nativeRequest,
      http: nativeHttp,
    })
    const sessions = new SessionCoordinator({
      engine: {
        start,
        recover: vi.fn(async () => {
          throw new Error("Unexpected run recovery")
        }),
      } as unknown as ServerRunEngine,
      maxActiveExecutions: 8,
      maxGuestActiveExecutions: 2,
      maxSubscriberEvents: 64,
      maxSubscriberBytes: 1_000_000,
      maxReplayEvents: 64,
      maxReplayBytes: 1_000_000,
    })
    const runtimeInstance: RuntimeInstance = {
      id: "hermes-main",
      runtime: hermes,
      sessions,
      close: async () => {
        sessions.close()
        await hermes.close()
      },
    }
    const app = createProxyApp({
      publicOrigin: "http://app.test",
      runtimeInstance,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    const browserFetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        if (init?.method === "POST") headers.set("origin", "http://app.test")
        return app.request(
          new Request(new URL(String(input), "http://app.test"), {
            ...init,
            headers,
          })
        )
      }
    )
    vi.stubGlobal("fetch", browserFetch)

    let supplied: HarnessRuntime | undefined
    function RuntimeCapture({ runtime }: { runtime: HarnessRuntime }) {
      useEffect(() => {
        supplied = runtime
      }, [runtime])
      return (
        <AssistantRuntimeProvider runtime={runtime.assistantRuntime}>
          <main>Mounted</main>
          <Thread autoFocus={false} messageRewind={runtime.messageRewind} />
        </AssistantRuntimeProvider>
      )
    }
    const Provider = runtimeAdapter.Provider
    render(
      <StrictMode>
        <Provider
          config={{
            status: "ready",
            mode: "aos",
            composerFeatures: {
              modelSelectorEnabled: true,
              contextEnabled: true,
            },
          }}
          locale="en"
        >
          {(runtime) => <RuntimeCapture runtime={runtime} />}
        </Provider>
      </StrictMode>
    )
    expect(await screen.findByRole("main")).toHaveTextContent("Mounted")
    await waitFor(() => expect(supplied).toBeDefined())
    await supplied!.assistantRuntime.threads.getLoadThreadsPromise()
    expect(supplied!.assistantRuntime.threads.getState().threadIds).toEqual([
      "stored-beta",
      "stored-alpha",
    ])
    expect(
      nativeHttp.mock.calls.some(([path]) =>
        String(path).includes("/messages?")
      )
    ).toBe(false)

    const beforeCrossAgent = nativeHttp.mock.calls.length
    const crossAgent = await browserFetch(
      "/api/aos/v1/agents/alpha/sessions/stored-beta/history"
    )
    expect(crossAgent.status).toBe(404)
    expect(nativeHttp).toHaveBeenCalledTimes(beforeCrossAgent + 1)

    await Promise.race([
      supplied!.assistantRuntime.threads.switchToThread("stored-alpha"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Session switch did not settle: ${JSON.stringify({
                  browser: browserFetch.mock.calls.map(([input, init]) => ({
                    input: String(input),
                    body: init?.body,
                  })),
                  native: nativeHttp.mock.calls.map(([path]) => String(path)),
                })}`
              )
            ),
          1_000
        )
      ),
    ])
    await waitFor(() =>
      expect(
        supplied!.assistantRuntime.thread.getState().messages
      ).toHaveLength(2)
    )
    await waitFor(() =>
      expect(supplied?.composer?.slashCommands).toEqual([
        { name: "status", description: "Show status" },
      ])
    )
    await waitFor(() =>
      expect(browserFetch.mock.calls.map(([input]) => String(input))).toContain(
        "/api/aos/v1/agents/alpha/sessions/stored-alpha/workspace/capabilities"
      )
    )
    await waitFor(() =>
      expect(
        browserFetch.mock.calls.filter(([input]) =>
          String(input).endsWith("/audio")
        )
      ).toHaveLength(0)
    )
    const capabilityReads = browserFetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/workspace/capabilities")
    ).length
    act(() => invalidateEvents?.())
    await Promise.resolve()
    expect(
      browserFetch.mock.calls.filter(([input]) =>
        String(input).endsWith("/workspace/capabilities")
      ).length
    ).toBe(capabilityReads)
    expect(
      browserFetch.mock.calls.filter(([input]) =>
        String(input).endsWith("/audio")
      )
    ).toHaveLength(0)
    expect(supplied!.assistantRuntime.thread.getState().messages).toMatchObject(
      [
        { id: "native-user-1", role: "user" },
        {
          id: "native-assistant-1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Checking" },
            { type: "text", text: "Ready" },
          ],
        },
      ]
    )
    const messageRewind = supplied!.messageRewind
    if (!messageRewind) throw new Error("Expected message rewind support")
    expect(messageRewind.runConfig("native-user-1")).toEqual({
      custom: {
        "aos.rewindSourceId": "native-user-1",
        "aos.rewindSourceText": "Open it",
      },
    })

    const browserState = JSON.stringify({
      threads: supplied!.assistantRuntime.threads.getState(),
      messages: supplied!.assistantRuntime.thread.getState().messages,
      requests: browserFetch.mock.calls.map(([input]) => String(input)),
    })
    expect(browserState).not.toContain("live-alpha-secret")
    expect(browserState).not.toContain("native_position")
    expect(browserState).not.toContain("private_path")
    expect(browserState).not.toContain("/api/sessions")
    expect(browserState).not.toContain("/srv/hermes")

    act(() => {
      supplied!.assistantRuntime.thread
        .getMessageById("native-user-1")
        .composer.beginEdit()
    })
    const editor = document.querySelector<HTMLTextAreaElement>(
      ".aui-edit-composer-input"
    )
    if (!editor) throw new Error("Expected an edit composer")
    await user.clear(editor)
    await user.type(editor, "Open it carefully")
    await user.click(screen.getByRole("button", { name: "Update" }))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start.mock.calls[0]![1]).toMatchObject({
      state: {},
      rewindSourceId: "native-user-1",
      messages: [
        expect.objectContaining({ role: "user", content: "Open it carefully" }),
      ],
      tools: [],
      context: [],
      forwardedProps: {},
    })
    const liveReasoning = () => {
      const messages = supplied!.assistantRuntime.thread.getState().messages
      const assistant = [...messages]
        .reverse()
        .find((message) => message.role === "assistant")
      return assistant?.content.find((part) => part.type === "reasoning")
    }
    await waitFor(() =>
      expect(liveReasoning()).toMatchObject({
        type: "reasoning",
        text: "First",
      })
    )
    act(() => continueReasoning?.())
    await waitFor(() =>
      expect(liveReasoning()).toMatchObject({
        type: "reasoning",
        text: "First second",
      })
    )

    authoritativeUserId = "hermes-row-8"
    authoritativeUserText = "Open it carefully"
    act(() => finishObservations[0]?.())
    await waitFor(() =>
      expect(supplied!.assistantRuntime.thread.getState().isRunning).toBe(false)
    )
    await waitFor(() =>
      expect(
        supplied!.assistantRuntime.thread
          .getState()
          .messages.findLast((message) => message.role === "user")?.id
      ).toBe("hermes-row-8")
    )
    const replacement = supplied!.assistantRuntime.thread
      .getState()
      .messages.findLast((message) => message.role === "user")
    if (!replacement) throw new Error("Expected the replacement user turn")
    act(() => {
      supplied!.assistantRuntime.thread
        .getMessageById(replacement.id)
        .composer.beginEdit()
    })
    const secondEditor = document.querySelector<HTMLTextAreaElement>(
      ".aui-edit-composer-input"
    )
    if (!secondEditor) throw new Error("Expected a second edit composer")
    await user.clear(secondEditor)
    await user.type(secondEditor, "Open it once more")
    await user.click(screen.getByRole("button", { name: "Update" }))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(start.mock.calls[1]![1]).toMatchObject({
      rewindSourceId: "hermes-row-8",
      messages: [
        expect.objectContaining({ role: "user", content: "Open it once more" }),
      ],
    })
    act(() => supplied!.assistantRuntime.thread.cancelRun())
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(browserFetch.mock.calls.map(([input]) => String(input))).toContain(
      "/api/aos/v1/agents/alpha/sessions/stored-alpha/runs/stop"
    )
    await runtimeInstance.close()
  })
})
