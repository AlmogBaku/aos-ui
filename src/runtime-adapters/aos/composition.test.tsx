import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AssistantRuntimeProvider } from "@assistant-ui/react"

import type { HarnessRuntime } from "../contracts"
import { Thread } from "../../components/assistant-ui/elements/thread.aui"
import { AosRemoteClient } from "./aos-client"
import { runtimeAdapter } from "./composition"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("provider-neutral AOS runtime composition", () => {
  it("promotes a local draft before dispatching its first queued run", async () => {
    let title = "Hello"
    const titleInvalidations: Array<() => void> = []
    vi.spyOn(
      AosRemoteClient.prototype,
      "subscribeSessionInvalidation"
    ).mockImplementation((_threadId, listener) => {
      titleInvalidations.push(listener)
      return () => undefined
    })
    vi.spyOn(AosRemoteClient.prototype, "getSession").mockImplementation(
      async (threadId) => ({
        id: threadId,
        agentId: "researcher",
        title,
        archived: false,
        updatedAt: "2026-09-15T18:00:00.000Z",
        status: "idle",
      })
    )
    let resolveSession: ((response: Response) => void) | undefined
    const session = new Promise<Response>((resolve) => {
      resolveSession = resolve
    })
    let resolveHistory: ((response: Response) => void) | undefined
    const history = new Promise<Response>((resolve) => {
      resolveHistory = resolve
    })
    const browserFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === "/api/aos/v1/sessions?limit=50&offset=0")
          return Response.json({
            sessions: [],
            total: 0,
            limit: 50,
            offset: 0,
          })
        if (
          path === "/api/aos/v1/agents/researcher/sessions" &&
          init?.method === "POST"
        )
          return session
        if (
          path ===
          "/api/aos/v1/agents/researcher/sessions/remote-session/history?limit=200&offset=0"
        )
          return history
        if (path.endsWith("/workspace/capabilities"))
          return Response.json(
            {
              error: {
                code: "unavailable",
                description: "Unavailable in this test",
              },
            },
            { status: 503 }
          )
        if (path.endsWith("/runs")) {
          const body = JSON.parse(String(init?.body)) as {
            threadId: string
            runId: string
          }
          return new Response(
            [
              {
                type: "RUN_STARTED",
                threadId: body.threadId,
                runId: body.runId,
              },
              {
                type: "TEXT_MESSAGE_START",
                messageId: "assistant-1",
                role: "assistant",
              },
              {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: "assistant-1",
                delta: "Draft response",
              },
              {
                type: "TEXT_MESSAGE_END",
                messageId: "assistant-1",
              },
              {
                type: "RUN_FINISHED",
                threadId: body.threadId,
                runId: body.runId,
                outcome: { type: "success" },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } }
          )
        }
        throw new Error(`Unexpected request: ${path}`)
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
              <Thread autoFocus={false} />
            </AssistantRuntimeProvider>
          )
        }}
      </Provider>
    )

    await supplied!.assistantRuntime.threads.getLoadThreadsPromise()
    await act(async () => {
      await supplied!.createSessionDraft?.("researcher")
    })
    expect(
      supplied!.assistantRuntime.thread.getState().capabilities.dictation
    ).toBe(true)
    expect(supplied!.media?.getSnapshot()).toMatchObject({
      scopeId: supplied!.assistantRuntime.threads.getState().mainThreadId,
      safelyIdle: true,
      availability: {
        transcription: "unverified",
        speech: "unverified",
      },
    })
    act(() => {
      supplied!.assistantRuntime.thread.composer.setText("Hello")
      supplied!.assistantRuntime.thread.composer.send()
    })

    expect(await screen.findByText("Hello")).toBeVisible()
    expect(
      browserFetch.mock.calls.some(([input]) => String(input).endsWith("/runs"))
    ).toBe(false)
    await act(async () => {
      resolveSession?.(
        Response.json(
          { session: { id: "remote-session", agentId: "researcher" } },
          { status: 201 }
        )
      )
      await session
    })
    await waitFor(() =>
      expect(
        browserFetch.mock.calls.some(([input]) =>
          String(input).endsWith("/runs")
        )
      ).toBe(true)
    )
    await waitFor(() =>
      expect(supplied!.media?.getSnapshot().scopeId).toBe("remote-session")
    )
    const [runUrl, runInit] = browserFetch.mock.calls.find(([input]) =>
      String(input).endsWith("/runs")
    )!
    expect(String(runUrl)).toBe(
      "/api/aos/v1/agents/researcher/sessions/remote-session/runs"
    )
    expect(JSON.parse(String(runInit?.body))).toMatchObject({
      threadId: "remote-session",
      messages: [expect.objectContaining({ role: "user", content: "Hello" })],
    })
    expect(await screen.findByText("Draft response")).toBeVisible()
    await act(async () => {
      resolveHistory?.(
        Response.json({
          sessionId: "remote-session",
          messages: [],
          total: 0,
          limit: 200,
          offset: 0,
          nextOffset: 0,
          execution: { status: "idle" },
        })
      )
      await history
    })
    expect(screen.getByText("Draft response")).toBeVisible()
    await waitFor(() =>
      expect(supplied!.assistantRuntime.thread.getState().isRunning).toBe(false)
    )
    await waitFor(() =>
      expect(
        supplied!.assistantRuntime.threads.mainItem.getState().title
      ).toBe("Hello")
    )
    title = "Harness-generated title"
    expect(titleInvalidations).toHaveLength(1)
    act(() => {
      supplied!.assistantRuntime.thread.composer.setText("Follow up")
      supplied!.assistantRuntime.thread.composer.send()
    })
    await waitFor(() =>
      expect(
        browserFetch.mock.calls.filter(([input]) =>
          String(input).endsWith("/runs")
        )
      ).toHaveLength(2)
    )
    await waitFor(() =>
      expect(supplied!.assistantRuntime.thread.getState().isRunning).toBe(false)
    )
    await waitFor(() =>
      expect(
        supplied!.assistantRuntime.threads.mainItem.getState().title
      ).toBe("Harness-generated title")
    )
  })

  it("mounts the existing workspace runtime with normalized Agents and no provider URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input)
        if (path === "/api/aos/v1/runtime")
          return Response.json({
            runtime: { id: "hermes", name: "Hermes" },
            status: "ready",
            capabilities: {
              agentCatalog: { status: "available" },
              agentVisibility: {
                status: "available",
                concurrency: "revision",
              },
              sessionCatalog: {
                status: "available",
                scope: "workspace",
                order: "recent",
                defaultPageSize: 50,
                maxPageSize: 100,
                maxWindow: 1_000,
              },
              sessionHistory: {
                status: "available",
                order: "chronological",
                compacted: true,
                loading: "on-open",
                defaultPageSize: 200,
                maxPageSize: 500,
              },
              sessionDetail: { status: "available" },
              sessionCreation: { status: "available" },
              sessionTitle: { status: "available" },
              sessionArchival: { status: "available" },
              sessionDeletion: { status: "available" },
              sessionRun: { status: "available" },
              sessionStop: { status: "available" },
              sessionSteer: { status: "available" },
              sessionReadState: { status: "available" },
            },
          })
        if (path === "/api/aos/v1/sessions?limit=50&offset=0")
          return Response.json({
            sessions: [],
            total: 0,
            limit: 50,
            offset: 0,
          })
        if (path !== "/api/aos/v1/agents")
          throw new Error(`Unexpected request: ${String(input)}`)
        return Response.json({
          revision: "profiles:researcher@hermes-bots:7",
          agents: [
            {
              summary: {
                kind: "ready",
                id: "researcher",
                name: "Researcher",
                activity: "unknown",
                visibility: "visible",
              },
              visibility: "visible",
              selectable: true,
              editable: true,
              revision: "hermes-bots:7",
            },
          ],
        })
      })
    )
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
          return <main>Workspace mounted</main>
        }}
      </Provider>
    )

    expect(await screen.findByRole("main")).toHaveTextContent(
      "Workspace mounted"
    )
    expect(await supplied!.workspace.listAgents()).toMatchObject([
      { id: "researcher", name: "Researcher" },
    ])
    expect(supplied!.assistantRuntime.threads.getState().threadIds).toEqual([])
    expect(supplied!.interactions).toBeUndefined()
    expect(supplied!.agUiInterrupts).toBe(true)
    expect(supplied!.activityCoverage).toBe("active-session")
  })
})
