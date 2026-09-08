import type { AssistantRuntime } from "@assistant-ui/react"
import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const {
  officialRuntime,
  client,
  workspace,
  eventHub,
  useAosOpenCodeRuntime,
  createOpenCodeWorkspace,
  createOpencodeClient,
} = vi.hoisted(() => {
  const officialRuntime = {} as AssistantRuntime
  const client = { session: {} } as OpencodeClient
  return {
    officialRuntime,
    client,
    workspace: {},
    eventHub: { subscribe: vi.fn() },
    useAosOpenCodeRuntime: vi.fn<(...args: unknown[]) => AssistantRuntime>(
      () => officialRuntime
    ),
    createOpenCodeWorkspace: vi.fn(),
    createOpencodeClient: vi.fn(() => client),
  }
})

vi.mock("@assistant-ui/react-opencode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react-opencode")>()),
  createOpencodeClient,
}))

vi.mock("./use-aos-opencode-runtime", () => ({
  AosOpenCodeEventHub: class {
    constructor() {
      return eventHub
    }
  },
  useAosOpenCodeRuntime,
}))
vi.mock("./opencode-workspace", () => ({ createOpenCodeWorkspace }))

import { useOpenCodeRuntimeBundle } from "./use-opencode-runtime-bundle"

describe("useOpenCodeRuntimeBundle", () => {
  it("composes AOS workspace data around the official OpenCode runtime", () => {
    createOpenCodeWorkspace.mockReturnValue(workspace)
    const { result } = renderHook(() =>
      useOpenCodeRuntimeBundle({
        baseUrl: "http://opencode.test",
        directory: "/external/worktree",
        defaultAgent: "build",
        initialSessionId: "session-build",
      })
    )

    expect(result.current.assistantRuntime).toBe(officialRuntime)
    expect(result.current.client).not.toBe(client)
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://opencode.test",
      directory: "/external/worktree",
    })
    expect(useAosOpenCodeRuntime).toHaveBeenCalledWith(
      result.current.client,
      expect.objectContaining({
        defaultAgent: "build",
        initialSessionId: "session-build",
      }),
      expect.any(Object)
    )
    expect(createOpenCodeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        events: useAosOpenCodeRuntime.mock.calls[0]?.[2],
      })
    )
  })

  it("keeps the workspace stable when the official runtime facade changes", () => {
    const firstRuntime = {
      threads: { reload: vi.fn() },
    } as unknown as AssistantRuntime
    const secondRuntime = {
      threads: { reload: vi.fn() },
    } as unknown as AssistantRuntime
    useAosOpenCodeRuntime
      .mockReturnValueOnce(firstRuntime)
      .mockReturnValueOnce(secondRuntime)

    const { result, rerender } = renderHook(() =>
      useOpenCodeRuntimeBundle({
        baseUrl: "http://opencode.test",
        directory: "/external/worktree",
      })
    )
    const workspace = result.current.workspace

    rerender()

    expect(result.current.assistantRuntime).toBe(secondRuntime)
    expect(result.current.workspace).toBe(workspace)
  })
})
