import type { AssistantRuntime } from "@assistant-ui/react"
import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const { officialRuntime, client, useOpenCodeRuntime, createOpencodeClient } =
  vi.hoisted(() => {
    const officialRuntime = {} as AssistantRuntime
    const client = { session: {} } as OpencodeClient
    return {
      officialRuntime,
      client,
      useOpenCodeRuntime: vi.fn(() => officialRuntime),
      createOpencodeClient: vi.fn(() => client),
    }
  })

vi.mock("@assistant-ui/react-opencode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@assistant-ui/react-opencode")>()),
  createOpencodeClient,
  useOpenCodeRuntime,
}))

import { useOpenCodeRuntimeBundle } from "./use-opencode-runtime-bundle"

describe("useOpenCodeRuntimeBundle", () => {
  it("composes AOS workspace data around the official OpenCode runtime", () => {
    const { result } = renderHook(() =>
      useOpenCodeRuntimeBundle({
        baseUrl: "http://opencode.test",
        defaultAgent: "build",
        initialSessionId: "session-build",
      })
    )

    expect(result.current.assistantRuntime).toBe(officialRuntime)
    expect(result.current.client).not.toBe(client)
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://opencode.test",
    })
    expect(useOpenCodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        client: result.current.client,
        defaultAgent: "build",
        initialSessionId: "session-build",
      })
    )
  })
})
