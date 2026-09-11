import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { act, render, waitFor } from "@testing-library/react"
import { expect, it } from "vitest"
import { useOpenClawRuntime } from "./use-openclaw-runtime"
import { MockGateway } from "./mock-gateway"

it("composes the shared HarnessRuntime from an authenticated native Gateway", async () => {
  const gateway = new MockGateway()
  gateway.responses.set("models.list", {
    models: [{ id: "model-a", provider: "provider-a", name: "Model A" }],
  })
  gateway.responses.set("sessions.patch", { ok: true })
  gateway.responses.set("sessions.list", {
    sessions: [
      {
        key: "agent:alice:main",
        agentId: "alice",
        activeRunIds: [],
        model: "model-a",
        modelProvider: "provider-a",
      },
      { key: "agent:bob:main", agentId: "bob", activeRunIds: [] },
    ],
  })
  const options = {
    gatewayUrl: "ws://localhost:18789",
    createSocket: gateway.createSocket,
    deviceAuth: {
      loadIdentity: async () => null,
      tokenStore: { load: () => null, store: () => {}, clear: () => {} },
    },
  }
  const result: { current: ReturnType<typeof useOpenClawRuntime> } = {} as never
  function Harness() {
    result.current = useOpenClawRuntime(options, "en")
    return (
      <AssistantRuntimeProvider
        runtime={result.current.runtime.assistantRuntime}
      >
        <div />
      </AssistantRuntimeProvider>
    )
  }
  const { unmount } = render(<Harness />)
  await waitFor(() =>
    expect(result.current.client.getSnapshot().connection).toBe("ready")
  )
  expect(await result.current.runtime.workspace.listAgents()).toHaveLength(2)
  expect(
    result.current.runtime.interactions?.getPending("agent:alice:main")
  ).toBeUndefined()
  expect(result.current.runtime.activityCoverage).toBe("active-session")
  expect(result.current.runtime.artifacts?.resolver).toBeDefined()
  expect(result.current.runtime.media).toBeDefined()
  await act(async () => {
    await result.current.runtime.assistantRuntime.threads.switchToThread(
      "agent:alice:main"
    )
  })
  await waitFor(() =>
    expect(result.current.runtime.composer?.model).toMatchObject({
      selectedId: "provider-a/model-a",
      options: [{ id: "provider-a/model-a", label: "Model A" }],
    })
  )
  await waitFor(() =>
    expect(
      result.current.runtime.assistantRuntime.thread.getState().messages[0]
        ?.content
    ).toEqual([{ type: "text", text: "Hello" }])
  )
  expect(
    result.current.runtime.assistantRuntime.thread.getState().capabilities.edit
  ).toBe(false)
  expect(
    result.current.runtime.assistantRuntime.thread.getState().capabilities
      .reload
  ).toBe(false)
  unmount()
  expect(result.current.client.getSnapshot().connection).toBe("disconnected")
})
