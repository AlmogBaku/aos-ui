import { afterEach, describe, expect, it, vi } from "vitest"
import { HermesMediaBinding } from "./hermes-media-binding"
import { HermesAudioError, type HermesAudioClient } from "./hermes-audio-client"
import type { HermesSession } from "./hermes-native-client"

function setup() {
  const listeners = new Set<() => void>()
  const connections = new Set<() => void>()
  const sessions = new Map<string, HermesSession>([
    [
      "one",
      {
        profile: "alpha",
        liveSessionId: "live-one",
        status: "idle",
        running: false,
        loading: false,
      } as HermesSession,
    ],
    [
      "two",
      {
        profile: "beta",
        liveSessionId: "live-two",
        status: "idle",
        running: false,
        loading: false,
      } as HermesSession,
    ],
  ])
  const client = {
    session: (id: string) => sessions.get(id),
    isConnected: true,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    subscribeConnection: (fn: () => void) => {
      connections.add(fn)
      return () => connections.delete(fn)
    },
  }
  const audio = {
    getAvailability: vi.fn<HermesAudioClient["getAvailability"]>(async () => ({
      transcription: "ready" as const,
      speech: "ready" as const,
    })),
    transcribe: vi.fn<HermesAudioClient["transcribe"]>(
      async () => "transcript"
    ),
    synthesize: vi.fn<HermesAudioClient["synthesize"]>(
      async () => new Blob(["audio"])
    ),
  }
  const onError = vi.fn()
  const binding = new HermesMediaBinding(client, audio, "en", onError)
  const dispose = binding.connect()
  return {
    binding,
    media: binding.media,
    client,
    audio,
    sessions,
    listeners,
    connections,
    onError,
    dispose,
  }
}
afterEach(() => localStorage.clear())

describe("Hermes media binding", () => {
  it("does not let old metadata re-enable audio after authentication is lost", async () => {
    const h = setup()
    let resolve!: (value: { transcription: "ready"; speech: "ready" }) => void
    h.audio.getAvailability.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    h.binding.select("one")
    const signal = h.audio.getAvailability.mock.calls[0]![1]
    h.binding.handleNativeError(new Error("Hermes authentication failed (401)"))
    expect(signal.aborted).toBe(true)
    resolve({ transcription: "ready", speech: "ready" })
    await Promise.resolve()
    expect(h.media.getSnapshot().availability).toEqual({
      transcription: "unavailable",
      speech: "unavailable",
    })
    h.dispose()
  })
  it("uses only the selected owning profile and ignores stale metadata", async () => {
    const h = setup()
    let resolve!: (value: { transcription: "ready"; speech: "ready" }) => void
    h.audio.getAvailability.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    h.binding.select("one")
    const firstSignal = h.audio.getAvailability.mock.calls[0]![1]
    h.binding.select("two")
    await Promise.resolve()
    resolve({ transcription: "ready", speech: "ready" })
    await Promise.resolve()
    expect(firstSignal.aborted).toBe(true)
    expect(
      h.audio.getAvailability.mock.calls.map(([profile]) => profile)
    ).toEqual(["alpha", "beta"])
    expect(h.media.getSnapshot()).toMatchObject({
      scopeId: "two",
      safelyIdle: true,
    })
    h.dispose()
  })
  it("requires a connected attached idle Session and invalidates pending PTT reads on connection changes", async () => {
    const h = setup()
    h.binding.select("one")
    await Promise.resolve()
    expect(h.media.getSnapshot().safelyIdle).toBe(true)
    const send = vi.fn()
    expect(h.media.submitVoiceTurn([], send)).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(h.media.getSnapshot().autoReadRequest).toBeDefined()
    h.client.isConnected = false
    h.connections.forEach((fn) => fn())
    expect(h.media.getSnapshot().safelyIdle).toBe(false)
    expect(h.media.getSnapshot().autoReadRequest).toBeUndefined()
    h.dispose()
  })
  it("disarms a pending PTT read when the owning Session requests approval", async () => {
    const h = setup()
    h.binding.select("one")
    await Promise.resolve()
    expect(h.media.submitVoiceTurn([], vi.fn())).toBe(true)
    const session = h.sessions.get("one")!
    h.sessions.set("one", {
      ...session,
      running: true,
      status: "waiting-for-input",
      approval: {
        threadId: "one",
        liveSessionId: "live-one",
        requestId: "approval-one",
        message: "Approve?",
      },
    })
    h.listeners.forEach((fn) => fn())
    expect(h.media.getSnapshot().autoReadRequest).toBeUndefined()
    h.dispose()
  })
  it("disarms a pending PTT read when the owning Session requests clarification", async () => {
    const h = setup()
    h.binding.select("one")
    await Promise.resolve()
    expect(h.media.submitVoiceTurn([], vi.fn())).toBe(true)
    const session = h.sessions.get("one")!
    h.sessions.set("one", {
      ...session,
      running: true,
      status: "waiting-for-input",
      clarification: {
        threadId: "one",
        liveSessionId: "live-one",
        requestId: "clarify-one",
        questions: [],
      },
    })
    h.listeners.forEach((fn) => fn())
    expect(h.media.getSnapshot().autoReadRequest).toBeUndefined()
    expect(h.media.getSnapshot().safelyIdle).toBe(false)
    h.dispose()
  })
  it("maps a live Hermes message id to its durable history replacement", () => {
    const h = setup()
    h.sessions.set("one", {
      ...h.sessions.get("one")!,
      messages: [
        { id: "hermes-user-live", role: "user", content: "Question" },
        {
          id: "hermes-assistant-live-answer",
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      ],
    })
    h.binding.select("one")
    const reconcile = vi.spyOn(h.media, "reconcilePlaybackOwner")
    h.sessions.set("one", {
      ...h.sessions.get("one")!,
      messages: [
        { id: "durable-question", role: "user", content: "Question" },
        {
          id: "durable-answer",
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      ],
    })
    h.listeners.forEach((fn) => fn())
    expect(reconcile).toHaveBeenCalledWith(
      "one",
      "hermes-assistant-live-answer",
      "durable-answer"
    )
    h.dispose()
  })
  it("does not infer a Hermes playback owner when history shape changes", () => {
    const h = setup()
    h.sessions.set("one", {
      ...h.sessions.get("one")!,
      messages: [
        {
          id: "hermes-assistant-live",
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      ],
    })
    h.binding.select("one")
    const reconcile = vi.spyOn(h.media, "reconcilePlaybackOwner")
    h.sessions.set("one", {
      ...h.sessions.get("one")!,
      messages: [
        { id: "inserted", role: "user", content: "Earlier" },
        {
          id: "durable-answer",
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        },
      ],
    })
    h.listeners.forEach((fn) => fn())
    expect(reconcile).not.toHaveBeenCalled()
    h.dispose()
  })
  it("projects speech text, captures immutable profile, and handles current authentication loss", async () => {
    const h = setup()
    h.binding.select("one")
    await Promise.resolve()
    const create = vi.spyOn(h.media, "createAdapters")
    h.binding.adapters("one", "alpha")
    const services = create.mock.calls[0]![1]
    expect(
      services.projectText("[label](https://example.org)\n\n```js\nsecret\n```")
    ).toContain("label")
    expect(services.projectText("```js\nsecret\n```")).not.toContain("secret")
    const signal = new AbortController().signal
    await services.transcribe(new Blob(["x"]), signal)
    expect(h.audio.transcribe.mock.calls[0]?.[0]).toBe("alpha")
    h.audio.synthesize.mockRejectedValueOnce(
      new HermesAudioError("authentication")
    )
    await expect(services.synthesize("answer", signal)).rejects.toThrow(
      HermesAudioError
    )
    expect(h.media.getSnapshot().availability.speech).toBe("unavailable")
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Hermes authentication failed (401)" })
    )
    h.dispose()
  })
})
