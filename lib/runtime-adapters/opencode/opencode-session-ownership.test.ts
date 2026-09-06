import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { describe, expect, it, vi } from "vitest"

import {
  OpenCodeSessionOwnership,
  createAgentScopedOpenCodeClient,
} from "./opencode-session-ownership"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createClient() {
  const prompt = vi.fn(async () => ({ data: { parts: [] } }))
  const promptAsync = vi.fn(async () => ({ data: undefined }))
  const messages = vi.fn(async () => ({ data: [] as unknown[] }))
  const abort = vi.fn(async () => ({ data: true }))
  const revert = vi.fn(async () => ({ data: true }))
  const get = vi.fn(async ({ sessionID }: { sessionID: string }) => ({
    data: { id: sessionID, agent: "build" },
  }))

  return {
    client: {
      session: { get, prompt, promptAsync, messages, abort, revert },
    } as unknown as OpencodeClient,
    abort,
    get,
    prompt,
    promptAsync,
    messages,
    revert,
  }
}

describe("createAgentScopedOpenCodeClient", () => {
  it("adds the authoritative Agent to every asynchronous Assistant UI prompt", async () => {
    const { client, get, promptAsync } = createClient()
    const ownership = new OpenCodeSessionOwnership()
    const scoped = createAgentScopedOpenCodeClient({ client, ownership })

    await scoped.session.promptAsync({
      sessionID: "session-build",
      parts: [{ type: "text", text: "Hello" }],
    })

    expect(get).toHaveBeenCalledWith(
      { sessionID: "session-build" },
      { throwOnError: true }
    )
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "session-build", agent: "build" }),
      undefined
    )
  })

  it("uses registered ownership without another lookup and overrides stale callers", async () => {
    const { client, get, prompt } = createClient()
    const ownership = new OpenCodeSessionOwnership()
    ownership.remember("session-review", "review")
    const scoped = createAgentScopedOpenCodeClient({ client, ownership })

    await scoped.session.prompt({
      sessionID: "session-review",
      agent: "build",
      parts: [{ type: "text", text: "Retry" }],
    })

    expect(get).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "session-review", agent: "review" }),
      undefined
    )
  })

  it("turns the official reload fallback from an undo into an Agent-owned regeneration", async () => {
    const { client, get, messages, abort, promptAsync, revert } = createClient()
    messages.mockResolvedValue({
      data: [
        {
          info: { id: "user-1", role: "user" },
          parts: [
            { type: "text", text: "Retry this response" },
            { type: "tool", state: { input: "not prompt input" } },
          ],
        },
      ],
    })
    const ownership = new OpenCodeSessionOwnership()
    const scoped = createAgentScopedOpenCodeClient({ client, ownership })

    await scoped.session.revert({
      sessionID: "session-build",
      messageID: "user-1",
    })

    expect(messages).toHaveBeenCalledWith(
      { sessionID: "session-build" },
      { throwOnError: true }
    )
    expect(abort).toHaveBeenCalledWith(
      { sessionID: "session-build" },
      undefined
    )
    expect(revert).toHaveBeenCalledWith(
      { sessionID: "session-build", messageID: "user-1" },
      undefined
    )
    expect(promptAsync).toHaveBeenCalledWith(
      {
        sessionID: "session-build",
        agent: "build",
        parts: [{ type: "text", text: "Retry this response" }],
      },
      undefined
    )
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(
      abort.mock.invocationCallOrder[0]!
    )
    expect(abort.mock.invocationCallOrder[0]).toBeLessThan(
      revert.mock.invocationCallOrder[0]!
    )
    expect(revert.mock.invocationCallOrder[0]).toBeLessThan(
      promptAsync.mock.invocationCallOrder[0]!
    )
  })

  it("does not undo the response when retry ownership cannot be resolved", async () => {
    const { client, get, messages, promptAsync, revert } = createClient()
    messages.mockResolvedValue({
      data: [
        {
          info: { id: "user-1", role: "user" },
          parts: [{ type: "text", text: "Keep this response" }],
        },
      ],
    })
    get.mockRejectedValue(new Error("session unavailable"))
    const scoped = createAgentScopedOpenCodeClient({
      client,
      ownership: new OpenCodeSessionOwnership(),
    })

    await expect(
      scoped.session.revert({
        sessionID: "session-missing",
        messageID: "user-1",
      })
    ).rejects.toThrow("session unavailable")

    expect(revert).not.toHaveBeenCalled()
    expect(promptAsync).not.toHaveBeenCalled()
  })

  it("fails scoped sends visibly during the short Agent reload barrier", async () => {
    const { client, promptAsync } = createClient()
    const ownership = new OpenCodeSessionOwnership()
    ownership.remember("session-build", "build")
    const scoped = createAgentScopedOpenCodeClient({ client, ownership })
    const reload = deferred<void>()
    const barrier = ownership.withReloadBarrier(async () => reload.promise)

    await expect(
      scoped.session.promptAsync({
        sessionID: "session-build",
        parts: [{ type: "text", text: "Wait for reload" }],
      })
    ).rejects.toThrow("reloading Agent configuration")
    expect(promptAsync).not.toHaveBeenCalled()

    reload.resolve()
    await barrier
    await expect(
      scoped.session.promptAsync({
        sessionID: "session-build",
        parts: [{ type: "text", text: "Now send" }],
      })
    ).resolves.toBeDefined()
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  it("serializes concurrent reload barriers and always releases after failure", async () => {
    const ownership = new OpenCodeSessionOwnership()
    const first = deferred<void>()
    const timeline: string[] = []
    const firstBarrier = ownership.withReloadBarrier(async () => {
      timeline.push("first:start")
      await first.promise
      timeline.push("first:end")
      throw new Error("reload failed")
    })
    const secondBarrier = ownership.withReloadBarrier(async () => {
      timeline.push("second:start")
      timeline.push("second:end")
    })

    await Promise.resolve()
    expect(timeline).toEqual(["first:start"])
    first.resolve()
    await expect(firstBarrier).rejects.toThrow("reload failed")
    await secondBarrier
    expect(timeline).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ])
    expect(() => ownership.assertSendAvailable()).not.toThrow()
  })
})
