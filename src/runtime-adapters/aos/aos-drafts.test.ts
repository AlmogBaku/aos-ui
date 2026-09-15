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
    const reset = vi.fn()
    const resetComposer = vi.fn()
    const runtime = {
      threads: {
        switchToNewThread,
        getById: () => ({ reset, composer: { reset: resetComposer } }),
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
    expect(reset).toHaveBeenCalledTimes(2)
    expect(reset).toHaveBeenCalledWith([])
    expect(resetComposer).toHaveBeenCalledTimes(2)
  })

  it("clears Assistant UI's reusable draft slot before selecting it again", async () => {
    const reset = vi.fn()
    const resetComposer = vi.fn()
    const runtime = {
      threads: {
        switchToNewThread: vi.fn(async () => undefined),
        getById: () => ({ reset, composer: { reset: resetComposer } }),
        getState: () => ({
          mainThreadId: "reused-local",
          threadItems: {
            "reused-local": {
              id: "reused-local",
              remoteId: undefined,
              externalId: undefined,
            },
          },
        }),
      },
    } as never
    const drafts = new AosDraftRegistry()

    await createAosSessionDraft(runtime, drafts, "alpha")
    await createAosSessionDraft(runtime, drafts, "alpha")

    expect(reset).toHaveBeenCalledTimes(2)
    expect(reset).toHaveBeenNthCalledWith(1, [])
    expect(reset).toHaveBeenNthCalledWith(2, [])
    expect(resetComposer).toHaveBeenCalledTimes(2)
  })
})
