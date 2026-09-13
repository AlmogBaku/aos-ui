import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AssistantRuntimeProvider } from "@assistant-ui/react"

import { createProxyApp } from "../../../packages/proxy/app"
import { HermesServerAdapter } from "../../../packages/proxy/runtimes/hermes/adapter"
import { createOperatorAuthenticator } from "../../../packages/proxy/operator-auth"
import type { HermesRunEngine } from "../../../packages/proxy/runtimes/hermes/run"
import type { HarnessRuntime } from "../contracts"
import { runtimeAdapter } from "./composition"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AOS normalized Session browser integration", () => {
  it("opens normalized history, sends one turn, and issues separate deliberate Stop", async () => {
    class ReadySocket extends EventTarget {
      readyState = 0
      constructor() {
        super()
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
      close() {
        this.readyState = 3
        this.dispatchEvent(new Event("close"))
      }
    }
    vi.stubGlobal("WebSocket", ReadySocket)
    let finishObservation: (() => void) | undefined
    const observationFinished = new Promise<void>((resolve) => {
      finishObservation = resolve
    })
    const stop = vi.fn(async () => "stopping" as const)
    const disconnect = vi.fn(() => finishObservation?.())
    const start = vi.fn(async (_scope, input) => ({
      events: (async function* () {
        yield {
          type: "RUN_STARTED" as const,
          threadId: "hermes:alpha:stored-alpha",
          runId: input.runId,
        }
        await observationFinished
      })(),
      stop,
      disconnect,
      recoveryPosition: () => ({ epoch: "opaque", lastSeen: 0 }),
    }))
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
      if (path.startsWith("/api/sessions/stored-alpha/messages?"))
        return {
          session_id: "stored-alpha",
          messages: [
            {
              id: "native-user-1",
              role: "user",
              content: "Open it",
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
    const app = createProxyApp({
      publicOrigin: "http://app.test",
      operatorAuth: createOperatorAuthenticator({
        allowedSubjects: ["operator@example.test"],
        verifySession: vi.fn(async () => ({
          subject: "operator@example.test",
        })),
      }),
      hermes: new HermesServerAdapter({
        request: nativeRequest,
        http: nativeHttp,
      }),
      runEngine: { start } as unknown as HermesRunEngine,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    let runtimeExpired = false
    const browserFetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://app.test").pathname
        if (runtimeExpired && path.endsWith("/agents"))
          return Promise.resolve(
            Response.json(
              { error: { code: "runtime_authentication_required" } },
              { status: 401 }
            )
          )
        if (runtimeExpired && path.endsWith("/auth/runtime"))
          return Promise.resolve(
            Response.json({ status: "authentication-required" })
          )
        const headers = new Headers(init?.headers)
        headers.set("cookie", "aos_operator=valid")
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
    const Provider = runtimeAdapter.Provider
    render(
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
        {(runtime) => {
          supplied = runtime
          return (
            <AssistantRuntimeProvider runtime={runtime.assistantRuntime}>
              <main>Mounted</main>
            </AssistantRuntimeProvider>
          )
        }}
      </Provider>
    )
    expect(await screen.findByRole("main")).toHaveTextContent("Mounted")

    await supplied!.assistantRuntime.threads.getLoadThreadsPromise()
    expect(supplied!.assistantRuntime.threads.getState().threadIds).toEqual([
      "hermes:beta:stored-beta",
      "hermes:alpha:stored-alpha",
    ])
    expect(
      nativeHttp.mock.calls.some(([path]) =>
        String(path).includes("/messages?")
      )
    ).toBe(false)

    const beforeCrossAgent = nativeHttp.mock.calls.length
    const crossAgent = await browserFetch(
      "/api/aos/v1/agents/alpha/sessions/hermes%3Abeta%3Astored-beta/history"
    )
    expect(crossAgent.status).toBe(404)
    expect(nativeHttp).toHaveBeenCalledTimes(beforeCrossAgent)

    await Promise.race([
      supplied!.assistantRuntime.threads.switchToThread(
        "hermes:alpha:stored-alpha"
      ),
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
      expect(browserFetch.mock.calls.map(([input]) => String(input))).toContain(
        "/api/aos/v1/agents/alpha/sessions/hermes%3Aalpha%3Astored-alpha/workspace/capabilities"
      )
    )
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
      supplied!.assistantRuntime.thread.append({
        role: "user",
        content: [{ type: "text", text: "Continue" }],
      })
    })
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start.mock.calls[0]![1]).toMatchObject({
      state: {},
      messages: [
        expect.objectContaining({ role: "user", content: "Continue" }),
      ],
      tools: [],
      context: [],
      forwardedProps: {},
    })

    act(() => supplied!.assistantRuntime.thread.cancelRun())
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(browserFetch.mock.calls.map(([input]) => String(input))).toContain(
      "/api/aos/v1/agents/alpha/sessions/hermes%3Aalpha%3Astored-alpha/runs/stop"
    )

    runtimeExpired = true
    await expect(supplied!.workspace.refreshAgents()).rejects.toMatchObject({
      kind: "runtime-auth-required",
    })
    expect(
      await screen.findByRole("link", { name: "Connect runtime" })
    ).toBeVisible()
  })
})
