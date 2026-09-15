import { describe, expect, it, vi } from "vitest"

import { AosDraftRegistry, createAosSessionDraft } from "./aos-drafts"

describe("AOS local draft registry", () => {
  it("serializes rapid new-draft selections so each local id keeps its Agent", async () => {
    let mainThreadId = ""
    let releaseFirst: (() => void) | undefined
    let releaseSecond: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const switchToNewThread = vi.fn(() => {
      if (switchToNewThread.mock.calls.length === 1) {
        mainThreadId = "local-alpha"
        return first
      }
      mainThreadId = "local-beta"
      return second
    })
    const runtime = {
      threads: {
        switchToNewThread,
        getState: () => ({
          mainThreadId,
          threadItems: { [mainThreadId]: { id: mainThreadId } },
        }),
      },
    } as never
    const drafts = new AosDraftRegistry()
    const alpha = createAosSessionDraft(runtime, drafts, "alpha")
    const beta = createAosSessionDraft(runtime, drafts, "beta")
    releaseFirst!()
    await vi.waitFor(() => expect(switchToNewThread).toHaveBeenCalledTimes(2))
    releaseSecond!()
    await Promise.all([alpha, beta])

    expect(drafts.agentFor("local-alpha")).toBe("alpha")
    expect(drafts.agentFor("local-beta")).toBe("beta")
  })
})
