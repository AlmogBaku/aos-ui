import { describe, expect, it, vi } from "vitest"

import {
  AosDraftRegistry,
  createAosSessionDraft,
  type DraftSessionHost,
} from "./aos-drafts"

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
        getById: () => ({
          import: vi.fn(),
          composer: { reset: vi.fn(async () => undefined) },
        }),
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

/** A host whose creates answer when the test says, recording what it holds and closes. */
function backingHost() {
  const creates: PromiseWithResolvers<{ sessionId: string }>[] = []
  const held = new Set<string>()
  const closed: string[] = []
  const gone = new Map<string, () => void>()
  const warn = vi.fn()
  const host: DraftSessionHost = {
    create: () => {
      const created = Promise.withResolvers<{ sessionId: string }>()
      creates.push(created)
      return created.promise
    },
    hold: (sessionId, onGone) => {
      gone.set(sessionId, onGone)
      held.add(sessionId)
      return () => held.delete(sessionId)
    },
    close: (sessionId) => closed.push(sessionId),
  }
  /** Answers the nth create and lets the registry take the answer. */
  const answer = async (index: number, sessionId: string) => {
    creates[index]?.resolve({ sessionId })
    await Promise.resolve()
  }
  return {
    drafts: new AosDraftRegistry(host, { warn }),
    answer,
    held,
    closed,
    creates,
    gone,
    warn,
  }
}

describe("AOS draft backing Sessions", () => {
  it("ends the Session of a draft slot opened again for another Agent", async () => {
    const { drafts, answer, held, closed } = backingHost()
    drafts.record("local-1", "alpha")
    await answer(0, "alpha-session")

    drafts.record("local-1", "beta")
    await answer(1, "beta-session")

    expect(closed).toEqual(["alpha-session"])
    expect([...held]).toEqual(["beta-session"])
    expect(drafts.sessionFor("local-1")).toBe("beta-session")
  })

  it("ends a Session whose draft was left while it was being made", async () => {
    const { drafts, answer, held, closed } = backingHost()
    drafts.record("local-1", "alpha")

    drafts.follow("session-elsewhere")
    await answer(0, "alpha-session")

    expect(closed).toEqual(["alpha-session"])
    expect(held.size).toBe(0)
    expect(drafts.sessionFor("local-1")).toBeUndefined()
  })

  it("gives up on a draft whose replacement Session is lost too", async () => {
    const { drafts, answer, creates, gone, warn } = backingHost()
    drafts.record("local-1", "alpha")
    await answer(0, "first")
    gone.get("first")!()
    await answer(1, "second")
    expect(creates).toHaveLength(2)

    gone.get("second")!()

    expect(creates).toHaveLength(2)
    expect(drafts.sessionFor("local-1")).toBeUndefined()
    await expect(drafts.claim("local-1")).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("hands a first message the Session still being made, closing nothing", async () => {
    const { drafts, answer, creates, closed } = backingHost()
    drafts.record("local-1", "alpha")

    const claimed = drafts.claim("local-1")
    await answer(0, "alpha-session")

    await expect(claimed).resolves.toBe("alpha-session")
    expect(creates).toHaveLength(1)
    expect(closed).toEqual([])
  })
})
