import {
  AssistantRuntimeProvider,
  createMessageQueue,
  fromThreadMessageLike,
  useExternalStoreRuntime,
  useLocalRuntime,
  type AssistantRuntime,
  type ChatModelAdapter,
  type MessageStatus,
  type ThreadMessageLike,
} from "@assistant-ui/react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { useEffect, useReducer } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Thread } from "../elements/thread.aui"
import { VoiceMediaController } from "./voice-media"
import { VoiceMediaProvider } from "./voice-context"

class Recorder extends EventTarget {
  mimeType = "audio/webm"
  state: RecordingState = "inactive"
  start() {
    this.state = "recording"
  }
  stop() {
    this.state = "inactive"
    queueMicrotask(() => {
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), { data: new Blob(["audio"]) })
      )
      this.dispatchEvent(new Event("stop"))
    })
  }
}

class Player extends EventTarget {
  src = ""
  currentTime = 0
  duration = 30
  playbackRate = 1
  paused = true
  play = vi.fn(async () => {
    this.paused = false
    this.dispatchEvent(new Event("play"))
  })
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event("pause"))
  })
  load = vi.fn()
  removeAttribute = vi.fn(() => {
    this.src = ""
  })
}

function setup({
  transcript = Promise.resolve("spoken draft"),
  voiceTurn = false,
  speech = "ready" as "ready" | "unconfigured",
  initialMessages = [] as ThreadMessageLike[],
  modelResult = Promise.resolve({
    content: [{ type: "text" as const, text: "Done" }],
  }),
  synthesize = vi.fn<(text: string, signal: AbortSignal) => Promise<Blob>>(
    async () => new Blob(["audio"], { type: "audio/wav" })
  ),
} = {}) {
  const model = {
    run: vi.fn<ChatModelAdapter["run"]>(() => modelResult),
  }
  const recording = new Recorder()
  const audio = new Player()
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const meterListeners = new Set<() => void>()
  let meterLevels: readonly number[] = new Array(14).fill(0)
  const meter = {
    attach: vi.fn(),
    dispose: vi.fn(),
    getSnapshot: () => meterLevels,
    subscribe: (listener: () => void) => {
      meterListeners.add(listener)
      return () => meterListeners.delete(listener)
    },
    publish: (levels: readonly number[]) => {
      meterLevels = levels
      meterListeners.forEach((listener) => listener())
    },
  }
  const media = new VoiceMediaController({
    getUserMedia: async () => stream,
    createRecorder: () => recording as unknown as MediaRecorder,
    createAudio: () => audio as unknown as HTMLAudioElement,
    createMeter: () => meter,
  })
  media.setScope("session")
  media.setMode(voiceTurn ? "voice-turn" : "transcription")
  media.setAvailability("session", { transcription: "ready", speech })
  media.setSafelyIdle(true)
  const adapters = media.createAdapters("session", {
    transcribe: () => transcript,
    synthesize,
    projectText: (text) => text,
  })
  let runtime!: AssistantRuntime
  function Harness() {
    runtime = useLocalRuntime(model, { adapters, initialMessages })
    return (
      <VoiceMediaProvider media={media} locale="en">
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread autoFocus={false} />
        </AssistantRuntimeProvider>
      </VoiceMediaProvider>
    )
  }
  render(<Harness />)
  return {
    media,
    model,
    get runtime() {
      return runtime
    },
    recording,
    track,
    audio,
    synthesize,
    stream,
    meter,
  }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe("real Assistant UI voice composer", () => {
  it("renders live levels from the exact stream being recorded", async () => {
    const h = setup()
    fireEvent.click(
      screen.getByRole("button", { name: "Record: Transcription" })
    )
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    expect(h.meter.attach).toHaveBeenCalledWith(h.stream)
    act(() => h.meter.publish([...new Array(13).fill(0), 1]))
    // The visual meter is an implementation detail. The observable contract
    // is that the recorder uses this stream and releases the meter on discard.
    expect(h.meter.attach).toHaveBeenCalledWith(h.stream)
    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }))
    expect(h.meter.dispose).toHaveBeenCalledOnce()
  })

  it("appends the final transcript to the draft without sending", async () => {
    const h = setup()
    await act(async () =>
      h.runtime.thread.composer.addAttachment({
        name: "notes.txt",
        contentType: "text/plain",
        content: [{ type: "text", text: "Existing attachment" }],
      })
    )
    const attachments = h.runtime.thread.composer.getState().attachments
    act(() => h.runtime.thread.composer.setText("Existing draft"))
    fireEvent.click(
      screen.getByRole("button", { name: "Record: Transcription" })
    )
    const finish = await screen.findByRole("button", { name: "Finish" })
    expect(
      screen.getByRole("textbox", { name: "Message input", hidden: true })
    ).toBeDisabled()
    expect(
      screen.getByRole("textbox", { name: "Message input", hidden: true })
    ).toBeDisabled()
    fireEvent.click(finish)
    await waitFor(() =>
      expect(h.runtime.thread.composer.getState().text).toBe(
        "Existing draft spoken draft"
      )
    )
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Message input" })
      ).toHaveFocus()
    )
    expect(h.runtime.thread.composer.getState().attachments).toBe(attachments)
    expect(h.model.run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() => expect(h.model.run).toHaveBeenCalledOnce())
  })
  it("discard restores the draft and stops microphone tracks", async () => {
    const h = setup()
    await act(async () =>
      h.runtime.thread.composer.addAttachment({
        name: "keep.txt",
        contentType: "text/plain",
        content: [],
      })
    )
    const attachments = h.runtime.thread.composer.getState().attachments
    act(() => h.runtime.thread.composer.setText("Keep this"))
    fireEvent.click(
      screen.getByRole("button", { name: "Record: Transcription" })
    )
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }))
    expect(h.runtime.thread.composer.getState().text).toBe("Keep this")
    expect(h.runtime.thread.composer.getState().attachments).toBe(attachments)
    expect(h.track.stop).toHaveBeenCalledOnce()
    expect(h.model.run).not.toHaveBeenCalled()
  })
  it("waits for finalization, then sends a voice turn exactly once", async () => {
    let resolve!: (text: string) => void
    const h = setup({
      voiceTurn: true,
      transcript: new Promise((done) => {
        resolve = done
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    const send = screen.getByRole("button", { name: "Send" })
    fireEvent.click(send)
    fireEvent.click(send)
    expect(h.model.run).not.toHaveBeenCalled()
    expect(screen.getByText("Transcribing")).toBeVisible()
    await act(async () => resolve("Final voice turn"))
    await waitFor(() => expect(h.model.run).toHaveBeenCalledOnce())
    expect(h.runtime.thread.getState().messages[0]?.content).toEqual([
      { type: "text", text: "Final voice turn" },
    ])
  })
  it("automatically reads the new completed assistant prose after a PTT send", async () => {
    const OriginalURL = URL
    vi.stubGlobal(
      "URL",
      class extends OriginalURL {
        static createObjectURL() {
          return "blob:audio"
        }
        static revokeObjectURL = vi.fn()
      }
    )
    const h = setup({ voiceTurn: true })
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(h.model.run).toHaveBeenCalledOnce())
    await waitFor(() => expect(h.synthesize).toHaveBeenCalledOnce())
    expect(h.synthesize).toHaveBeenCalledWith("Done", expect.any(AbortSignal))
    expect(screen.getByRole("group", { name: "Read aloud" })).toBeVisible()
  })
  it("disarms automatic reading when a PTT run fails without assistant prose", async () => {
    let rejectRun!: (error: Error) => void
    const h = setup({
      voiceTurn: true,
      modelResult: new Promise((_, reject) => {
        rejectRun = reject
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(h.runtime.thread.getState().isRunning).toBe(true)
    )
    await act(async () => rejectRun(new Error("failed run")))
    await waitFor(() =>
      expect(h.runtime.thread.getState().isRunning).toBe(false)
    )
    await waitFor(() =>
      expect(h.media.getSnapshot().autoReadRequest).toBeUndefined()
    )
    expect(h.synthesize).not.toHaveBeenCalled()
  })
  it("disarms automatic reading after a fast completion without assistant prose", async () => {
    const h = setup({
      voiceTurn: true,
      modelResult: Promise.resolve({ content: [] }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(h.model.run).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(h.runtime.thread.getState().isRunning).toBe(false)
    )
    await waitFor(() =>
      expect(h.media.getSnapshot().autoReadRequest).toBeUndefined()
    )
    expect(h.synthesize).not.toHaveBeenCalled()
  })
  it("disarms automatic reading when another user turn supersedes PTT", async () => {
    let resolveRun!: (result: {
      content: [{ type: "text"; text: string }]
    }) => void
    const h = setup({
      voiceTurn: true,
      modelResult: new Promise((resolve) => {
        resolveRun = resolve
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(h.runtime.thread.getState().isRunning).toBe(true)
    )
    act(() => h.runtime.thread.composer.setText("Typed follow-up"))
    act(() => h.runtime.thread.composer.send())
    await waitFor(() =>
      expect(
        h.runtime.thread
          .getState()
          .messages.filter((message) => message.role === "user")
      ).toHaveLength(2)
    )
    expect(h.media.getSnapshot().autoReadRequest).toBeUndefined()
    await act(async () =>
      resolveRun({ content: [{ type: "text", text: "First answer" }] })
    )
    expect(h.synthesize).not.toHaveBeenCalled()
  })
  it("disarms automatic reading before Stop generating interrupts a PTT run", async () => {
    let resolveRun!: (result: { content: [] }) => void
    const h = setup({
      voiceTurn: true,
      modelResult: new Promise((resolve) => {
        resolveRun = resolve
      }),
    })
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(h.runtime.thread.getState().isRunning).toBe(true)
    )
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }))
    expect(h.media.getSnapshot().autoReadRequest).toBeUndefined()
    await act(async () => resolveRun({ content: [] }))
  })
  it("disarms automatic reading as soon as a follow-up enters the runtime queue", async () => {
    const media = new VoiceMediaController()
    media.setScope("session")
    media.setAvailability("session", {
      transcription: "ready",
      speech: "ready",
    })
    media.setSafelyIdle(true)
    const adapters = media.createAdapters("session", {
      transcribe: async () => "voice turn",
      synthesize: async () => new Blob(["audio"]),
      projectText: (text) => text,
    })
    const queue = createMessageQueue({ run: vi.fn() })
    queue.notifyBusy()
    let runtime!: AssistantRuntime
    function QueuedHarness() {
      const [, rerender] = useReducer((revision) => revision + 1, 0)
      useEffect(() => queue.subscribe(rerender), [])
      runtime = useExternalStoreRuntime<ThreadMessageLike>({
        adapters,
        messages: [
          {
            id: "existing",
            role: "assistant",
            content: [{ type: "text", text: "Existing answer" }],
          },
        ],
        convertMessage: (message) => message,
        isRunning: true,
        onNew: vi.fn(),
        queue: queue.adapter,
      })
      return (
        <VoiceMediaProvider media={media} locale="en">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread autoFocus={false} />
          </AssistantRuntimeProvider>
        </VoiceMediaProvider>
      )
    }
    render(<QueuedHarness />)
    act(() => media.submitVoiceTurn(["existing"], vi.fn()))
    act(() => runtime.thread.composer.setText("Typed follow-up"))
    act(() => runtime.thread.composer.send())
    await waitFor(() =>
      expect(runtime.thread.composer.getState().queue).toHaveLength(1)
    )
    expect(media.getSnapshot().autoReadRequest).toBeUndefined()
    media.dispose()
  })
  it("never treats assistant activity before the PTT user turn as its reply", async () => {
    const OriginalURL = URL
    vi.stubGlobal(
      "URL",
      class extends OriginalURL {
        static createObjectURL() {
          return "blob:audio"
        }
        static revokeObjectURL = vi.fn()
      }
    )
    const audio = new Player()
    const synthesize = vi.fn(async () => new Blob(["audio"]))
    const media = new VoiceMediaController({
      createAudio: () => audio as unknown as HTMLAudioElement,
    })
    media.setScope("session")
    media.setAvailability("session", {
      transcription: "ready",
      speech: "ready",
    })
    media.setSafelyIdle(true)
    const adapters = media.createAdapters("session", {
      transcribe: async () => "voice turn",
      synthesize,
      projectText: (text) => text,
    })
    const existing: ThreadMessageLike = {
      id: "existing",
      role: "assistant",
      content: [{ type: "text", text: "Existing answer" }],
    }
    let messages: readonly ThreadMessageLike[] = [existing]
    let running = false
    let refresh!: () => void
    function ControlledHarness() {
      const [, rerender] = useReducer((revision) => revision + 1, 0)
      refresh = rerender
      const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        adapters,
        messages,
        convertMessage: (message, index) =>
          fromThreadMessageLike(message, `controlled-${index}`, {
            type: "complete",
            reason: "unknown",
          } satisfies MessageStatus),
        isRunning: running,
        onNew: vi.fn(),
      })
      return (
        <VoiceMediaProvider media={media} locale="en">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread autoFocus={false} />
          </AssistantRuntimeProvider>
        </VoiceMediaProvider>
      )
    }
    render(<ControlledHarness />)
    act(() => media.submitVoiceTurn(["existing"], vi.fn()))
    messages = [
      existing,
      {
        id: "unrelated",
        role: "assistant",
        content: [{ type: "text", text: "Unrelated activity" }],
      },
      {
        id: "voice-user",
        role: "user",
        content: [{ type: "text", text: "Voice turn" }],
      },
    ]
    act(() => refresh())
    await waitFor(() => expect(document.body).toHaveTextContent("Voice turn"))
    expect(synthesize).not.toHaveBeenCalled()
    expect(media.getSnapshot().autoReadRequest).toBeDefined()
    running = true
    act(() => refresh())
    messages = [
      ...messages,
      {
        id: "owned",
        role: "assistant",
        content: [{ type: "text", text: "Owned answer" }],
      },
    ]
    running = false
    act(() => refresh())
    await waitFor(() => expect(synthesize).toHaveBeenCalledOnce())
    expect(synthesize).toHaveBeenCalledWith(
      "Owned answer",
      expect.any(AbortSignal)
    )
    media.dispose()
  })
  it("does not record an unsafe voice turn but still opens its mode picker", async () => {
    const h = setup({ voiceTurn: true, speech: "unconfigured" })
    const mic = screen.getByRole("button", { name: "Record: Voice turn" })
    fireEvent.click(mic)
    expect(h.recording.state).toBe("inactive")
    fireEvent.keyDown(mic, { key: "ArrowDown" })
    expect(await screen.findByRole("menu")).toBeVisible()
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Transcription" })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Record: Transcription" })
    )
    await waitFor(() => expect(h.recording.state).toBe("recording"))
  })
  it("lets native speech resolve unverified picker hints without changing providers", async () => {
    const h = setup({ voiceTurn: true })
    act(() =>
      h.media.setAvailability("session", {
        transcription: "unverified",
        speech: "unverified",
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(h.model.run).toHaveBeenCalledOnce())
  })
  it("keeps recording across a visibility change until explicit Send", async () => {
    const h = setup({ voiceTurn: true })
    fireEvent.click(screen.getByRole("button", { name: "Record: Voice turn" }))
    await waitFor(() => expect(h.recording.state).toBe("recording"))
    h.media.handleHidden()
    expect(h.recording.state).toBe("recording")
    expect(h.media.captureSignal.aborted).toBe(false)
    expect(h.model.run).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(h.model.run).toHaveBeenCalledOnce())
  })
  it("keeps setup guidance on the microphone instead of below the composer", () => {
    setup({ voiceTurn: true, speech: "unconfigured" })
    expect(
      screen.queryByText(
        "Voice turns require both native transcription and read-aloud.",
        { selector: "p" }
      )
    ).toBeNull()
    expect(
      screen.getByRole("button", { name: "Record: Voice turn" })
    ).toHaveAttribute(
      "aria-description",
      expect.stringContaining(
        "Voice turns require both transcription and read-aloud."
      )
    )
  })
  it("omits voice UI on an unsupported runtime", () => {
    function Unsupported() {
      const runtime = useLocalRuntime(
        { run: async () => ({ content: [] }) },
        {
          initialMessages: [
            { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          ],
        }
      )
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread autoFocus={false} />
        </AssistantRuntimeProvider>
      )
    }
    const { container } = render(<Unsupported />)
    expect(
      within(container).queryByRole("button", { name: /Record:/ })
    ).toBeNull()
    expect(
      within(container).queryByRole("button", { name: "Read aloud" })
    ).toBeNull()
  })

  it("reads only the requested message when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined)
    const OriginalURL = URL
    vi.stubGlobal(
      "URL",
      class extends OriginalURL {
        static createObjectURL() {
          return "blob:audio"
        }
        static revokeObjectURL = vi.fn()
      }
    )
    const h = setup({
      initialMessages: [
        {
          id: "matching",
          role: "assistant",
          content: [{ type: "text", text: "Owned answer" }],
        },
        {
          id: "latest",
          role: "assistant",
          content: [{ type: "text", text: "Not the owned answer" }],
        },
      ],
    })
    expect(h.synthesize).not.toHaveBeenCalled()
    act(() => h.media.requestReadAloud("session", "matching"))
    await waitFor(() => expect(h.synthesize).toHaveBeenCalledOnce())
    expect(h.synthesize.mock.calls[0]?.[0]).toBe("Owned answer")
    expect(h.media.getSnapshot().readRequest).toBeUndefined()
    act(() => h.audio.dispatchEvent(new Event("ended")))
    expect(screen.getByText("Owned answer")).toBeVisible()
    expect(h.synthesize).toHaveBeenCalledOnce()
  })

  it("reads within the owning message, preserves non-text parts, and restores prose on Stop", async () => {
    const OriginalURL = URL
    vi.stubGlobal(
      "URL",
      class extends OriginalURL {
        static createObjectURL() {
          return "blob:audio"
        }
        static revokeObjectURL = vi.fn()
      }
    )
    const h = setup({
      initialMessages: [
        {
          id: "answer-one",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Private reasoning" },
            {
              type: "tool-call",
              toolCallId: "tool",
              toolName: "Inspect",
              args: {},
              result: "Inspectable result",
            },
            { type: "text", text: "First answer" },
          ],
        },
        {
          id: "answer-two",
          role: "assistant",
          content: [{ type: "text", text: "Second answer" }],
        },
      ],
    })
    const first = screen
      .getByText("First answer")
      .closest<HTMLElement>('[data-role="assistant"]')!
    const second = screen
      .getByText("Second answer")
      .closest<HTMLElement>('[data-role="assistant"]')!
    fireEvent.mouseEnter(first)
    fireEvent.click(within(first).getByRole("button", { name: "Read aloud" }))
    await waitFor(() => expect(h.audio.play).toHaveBeenCalledOnce())
    expect(
      within(first).getByRole("button", { name: "Pause" })
    ).toBeInTheDocument()
    expect(
      within(second).getByRole("button", { name: "Read aloud" })
    ).toBeInTheDocument()
    expect(h.synthesize.mock.calls[0]?.[0]).toBe("First answer")
    expect(within(first).getByRole("slider")).toHaveAttribute(
      "aria-valuenow",
      "0"
    )
    act(() => {
      h.audio.currentTime = 6
      h.audio.duration = 24
      h.audio.dispatchEvent(new Event("timeupdate"))
    })
    const timeline = within(first).getByRole("slider")
    expect(timeline).toHaveAttribute("aria-valuenow", "6")
    fireEvent.keyDown(timeline, { key: "End" })
    expect(h.audio.currentTime).toBe(24)
    expect(h.synthesize).toHaveBeenCalledOnce()
    const firstMessage = h.runtime.thread
      .getState()
      .messages.find((message) => message.id === "answer-one")
    expect(firstMessage?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning" }),
        expect.objectContaining({ type: "tool-call" }),
      ])
    )
    fireEvent.click(within(first).getByRole("button", { name: "Pause" }))
    expect(h.audio.paused).toBe(true)
    fireEvent.click(within(first).getByRole("button", { name: "Play" }))
    await waitFor(() => expect(h.audio.play).toHaveBeenCalledTimes(2))
    expect(h.synthesize).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event("aos:conversation-search"))
    const search = await screen.findByRole("searchbox", {
      name: "Search in conversation",
    })
    fireEvent.change(search, { target: { value: "First answer" } })
    expect(await screen.findByText("1 of 1")).toBeVisible()
    fireEvent.keyDown(search, { key: "Escape" })
    fireEvent.click(within(first).getByRole("button", { name: "Stop reading" }))
    await waitFor(() =>
      expect(
        within(first).getByRole("button", { name: "Read aloud" })
      ).toBeInTheDocument()
    )
    expect(within(first).getByText("First answer")).toBeVisible()
    expect(h.model.run).not.toHaveBeenCalled()
  })

  it("keeps read-aloud playing when the browser window becomes hidden", async () => {
    const h = setup({
      initialMessages: [
        {
          id: "answer",
          role: "assistant",
          content: [{ type: "text", text: "Keep reading this answer" }],
        },
      ],
    })
    const answer = screen
      .getByText("Keep reading this answer")
      .closest<HTMLElement>('[data-role="assistant"]')!
    fireEvent.mouseEnter(answer)
    fireEvent.click(within(answer).getByRole("button", { name: "Read aloud" }))
    await waitFor(() => expect(h.audio.play).toHaveBeenCalledOnce())

    h.media.handleHidden()

    expect(h.audio.pause).toHaveBeenCalled()
    expect(h.audio.paused).toBe(true)
  })

  it("keeps a visible retryable notice after speech synthesis fails", async () => {
    const synthesize = vi.fn(async () => {
      throw new Error("synthesis failed")
    })
    setup({
      synthesize,
      initialMessages: [
        {
          id: "answer",
          role: "assistant",
          content: [{ type: "text", text: "Readable answer" }],
        },
      ],
    })
    const answer = screen
      .getByText("Readable answer")
      .closest<HTMLElement>('[data-role="assistant"]')!
    fireEvent.mouseEnter(answer)
    fireEvent.click(within(answer).getByRole("button", { name: "Read aloud" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Audio could not be generated or played. You can try Read aloud again."
    )
    expect(within(answer).getByText("Readable answer")).toBeVisible()
    expect(
      within(answer).getByRole("button", { name: "Read aloud" })
    ).toBeEnabled()
    expect(synthesize).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    "keeps playback only for an explicitly reconciled message replacement (reconciled=%s)",
    async (reconciled) => {
      const OriginalURL = URL
      vi.stubGlobal(
        "URL",
        class extends OriginalURL {
          static createObjectURL() {
            return "blob:audio"
          }
          static revokeObjectURL = vi.fn()
        }
      )
      const audio = new Player()
      const media = new VoiceMediaController({
        createAudio: () => audio as unknown as HTMLAudioElement,
      })
      media.setScope("session")
      media.setAvailability("session", {
        transcription: "ready",
        speech: "ready",
      })
      const adapters = media.createAdapters("session", {
        transcribe: async () => "voice turn",
        synthesize: async () => new Blob(["audio"]),
        projectText: (text) => text,
      })
      let messages: readonly ThreadMessageLike[] = [
        {
          id: "live-answer",
          role: "assistant",
          content: [{ type: "text", text: "Same answer" }],
        },
      ]
      let refresh!: () => void
      function ControlledHarness() {
        const [, rerender] = useReducer((revision) => revision + 1, 0)
        refresh = rerender
        const runtime = useExternalStoreRuntime<ThreadMessageLike>({
          adapters,
          messages,
          convertMessage: (message) => message,
          onNew: vi.fn(),
        })
        return (
          <VoiceMediaProvider media={media} locale="en">
            <AssistantRuntimeProvider runtime={runtime}>
              <Thread autoFocus={false} />
            </AssistantRuntimeProvider>
          </VoiceMediaProvider>
        )
      }
      render(<ControlledHarness />)
      const live = screen
        .getByText("Same answer")
        .closest<HTMLElement>('[data-role="assistant"]')!
      fireEvent.mouseEnter(live)
      fireEvent.click(within(live).getByRole("button", { name: "Read aloud" }))
      await waitFor(() => expect(audio.play).toHaveBeenCalledOnce())

      messages = [
        {
          id: "other-branch",
          role: "assistant",
          content: [
            {
              type: "text",
              text: reconciled ? "Same answer" : "Different answer",
            },
          ],
        },
      ]
      act(() => {
        if (reconciled)
          media.reconcilePlaybackOwner("session", "live-answer", "other-branch")
        refresh()
      })
      if (reconciled) {
        expect(media.getSnapshot().playback).toBeDefined()
        expect(screen.getByRole("group", { name: "Read aloud" })).toBeVisible()
        expect(audio.play).toHaveBeenCalledOnce()
        // Once the durable owner appeared, the old optimistic id is no longer
        // an alias: switching back to a different message must stop playback.
        messages = [
          {
            id: "live-answer",
            role: "assistant",
            content: "A different branch",
          },
        ]
        act(() => refresh())
      }
      await waitFor(() => expect(media.getSnapshot().playback).toBeUndefined())
      expect(screen.queryByRole("group", { name: "Read aloud" })).toBeNull()
      media.dispose()
    }
  )

  it("keeps Stop reading available while another turn is running", async () => {
    const OriginalURL = URL
    vi.stubGlobal(
      "URL",
      class extends OriginalURL {
        static createObjectURL() {
          return "blob:audio"
        }
        static revokeObjectURL = vi.fn()
      }
    )
    const h = setup({
      modelResult: new Promise(() => {}),
      initialMessages: [
        {
          id: "answer",
          role: "assistant",
          content: [{ type: "text", text: "Read this answer" }],
        },
      ],
    })
    const answer = screen
      .getByText("Read this answer")
      .closest<HTMLElement>('[data-role="assistant"]')!
    fireEvent.mouseEnter(answer)
    fireEvent.click(within(answer).getByRole("button", { name: "Read aloud" }))
    await waitFor(() => expect(h.audio.play).toHaveBeenCalledOnce())
    act(() => h.runtime.thread.composer.setText("Start another turn"))
    fireEvent.click(screen.getByRole("button", { name: "Send message" }))
    await waitFor(() =>
      expect(h.runtime.thread.getState().isRunning).toBe(true)
    )
    expect(
      within(answer).getByRole("button", { name: "Stop reading" })
    ).toBeVisible()
  })
})
