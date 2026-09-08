import { expect, test, type Page } from "@playwright/test"

import { presentationExamples } from "../shared/presentation/tools"

// Mocked browser orchestration only: no live microphone, provider, or profile.
test.setTimeout(45_000)

const conversationUrl = "/research/hermes%3Aresearch%3Ahistory"
const plan = presentationExamples.present_plan
const originalProse =
  "A **formatted answer** with a [reference](https://example.test/source)."
const originalHistory = [
  { id: 1, role: "user", content: "An earlier question" },
  {
    id: 2,
    role: "assistant",
    content: originalProse,
    tool_calls: [
      {
        id: "original-plan",
        function: { name: "present_plan", arguments: JSON.stringify(plan) },
      },
    ],
  },
  {
    id: 3,
    role: "tool",
    tool_call_id: "original-plan",
    content: JSON.stringify({ ok: true, value: plan }),
  },
  { id: 4, role: "assistant", content: "The same reply." },
]

type NativeRequest = { method: string; params?: Record<string, unknown> }
type AudioRequest = { profile: string | null; body: Record<string, unknown> }
type NativeEvent = {
  type: string
  payload?: Record<string, unknown>
  sessionId?: string
}
type BrowserMediaSnapshot = {
  microphoneRequests: number
  stoppedTracks: number
  createdUrls: string[]
  revokedUrls: string[]
  audio: Array<{ paused: boolean; rate: number; src: string; plays: number }>
}
type VoiceBrowser = Window & {
  __voiceNativeRpc: (request: NativeRequest) => Promise<unknown>
  __voiceBrowser: {
    snapshot: () => BrowserMediaSnapshot
    finalizeRecorder: () => void
    events: (events: NativeEvent[]) => void
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function mediaSnapshot(page: Page) {
  return page.evaluate(() =>
    (window as unknown as VoiceBrowser).__voiceBrowser.snapshot()
  )
}

async function installHermesVoiceMock(
  page: Page,
  options: {
    holdRecorder?: boolean
    holdTranscription?: boolean
    blockPlayback?: boolean
    liveMeter?: boolean
  } = {}
) {
  const transcription = deferred<string>()
  const rpc: NativeRequest[] = []
  const uploads: AudioRequest[] = []
  const speech: AudioRequest[] = []
  const unexpected: string[] = []
  let history: unknown[] = [...originalHistory]
  let running = false
  if (!options.holdTranscription) transcription.resolve("A voice ask")

  await page.route("**/hermes/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.slice("/hermes".length)
    const profile = url.searchParams.get("profile")
    if (path === "/api/auth/ws-ticket")
      return route.fulfill({
        json: { ticket: "voice-e2e-ticket", ttl_seconds: 30 },
      })
    if (path === "/api/config") return route.fulfill({ status: 403 })
    if (path === "/api/sessions")
      return route.fulfill({
        json: {
          sessions: [
            {
              id: "history",
              profile: "research",
              title: "Native voice history",
              last_active: 1_788_000_000,
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        },
      })
    if (path === "/api/sessions/history/messages") {
      return route.fulfill({
        json: {
          session_id: "history",
          messages: history,
          pagination: { returned: history.length },
        },
      })
    }
    const toolset = path.match(
      /^\/api\/tools\/toolsets\/(stt|tts)\/config$/u
    )?.[1]
    if (toolset) {
      const name = toolset === "stt" ? "Local Whisper" : "Microsoft Edge TTS"
      return route.fulfill({
        json: {
          name: toolset,
          has_category: true,
          active_provider: name,
          providers: [
            {
              name,
              is_active: true,
              status: "ready",
              ...(toolset === "tts" ? { tts_provider: "edge" } : {}),
            },
          ],
        },
      })
    }
    if (path === "/api/audio/transcribe") {
      uploads.push({ profile, body: request.postDataJSON() })
      return route.fulfill({
        json: {
          ok: true,
          transcript: await transcription.promise,
          provider: "mock-local",
        },
      })
    }
    if (path === "/api/audio/speak") {
      speech.push({ profile, body: request.postDataJSON() })
      return route.fulfill({
        json: {
          ok: true,
          data_url: "data:audio/mpeg;base64,SUQzBAAA",
          mime_type: "audio/mpeg",
          provider: "edge",
        },
      })
    }
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 404 })
  })

  await page.exposeFunction("__voiceNativeRpc", (request: NativeRequest) => {
    rpc.push(request)
    if (request.method === "profiles.list")
      return {
        profiles: [
          {
            name: "research",
            display_name: "Research",
            description: "Mock native voice profile",
            canonical_session: { id: "history", last_active: 0 },
            ui_meta: { "hermes-bots": { hidden: false } },
          },
        ],
      }
    if (request.method === "session.resume")
      return {
        session_id: "live-history",
        resumed: "history",
        running,
        status: running ? "running" : "idle",
        messages: [],
      }
    if (request.method === "session.active_list")
      return {
        sessions: [
          {
            id: "live-history",
            session_key: "history",
            running,
            status: running ? "running" : "idle",
          },
        ],
      }
    if (request.method === "session.events.since")
      return { events: [], truncated: false, epoch: "voice-e2e" }
    if (request.method === "prompt.submit") {
      running = true
      return { status: "streaming" }
    }
    if (request.method === "session.interrupt") {
      running = false
      return { status: "interrupted" }
    }
    unexpected.push(`RPC ${request.method}`)
    throw new Error(`Unexpected mocked Hermes RPC ${request.method}`)
  })

  await page.addInitScript((settings) => {
    const host = window as unknown as VoiceBrowser
    const recorders: Recorder[] = []
    const audio: FakeAudio[] = []
    const sockets: NativeSocket[] = []
    const createdUrls: string[] = []
    const revokedUrls: string[] = []
    let microphoneRequests = 0
    let stoppedTracks = 0
    let blockedPlaybacks = settings.blockPlayback ? 1 : 0
    let sequence = 10
    class Track extends EventTarget {
      readyState = "live"
      stop() {
        if (this.readyState === "live") {
          this.readyState = "ended"
          stoppedTracks++
        }
      }
    }
    class Recorder extends EventTarget {
      static isTypeSupported(type: string) {
        return type === "audio/webm;codecs=opus"
      }
      state = "inactive"
      readonly mimeType: string
      finalized = false
      constructor(_stream: unknown, options?: { mimeType?: string }) {
        super()
        this.mimeType = options?.mimeType ?? "audio/webm;codecs=opus"
        recorders.push(this)
      }
      start() {
        this.state = "recording"
      }
      stop() {
        if (this.state === "inactive") return
        this.state = "inactive"
        if (!settings.holdRecorder) queueMicrotask(() => this.finalize())
      }
      finalize() {
        if (this.finalized) return
        this.finalized = true
        this.dispatchEvent(
          new BlobEvent("dataavailable", {
            data: new Blob([Uint8Array.of(1, 2, 3)], { type: this.mimeType }),
          })
        )
        this.dispatchEvent(new Event("stop"))
      }
    }
    class FakeAudio extends EventTarget {
      src = ""
      paused = true
      playbackRate = 1
      currentTime = 0
      duration = 24
      plays = 0
      constructor() {
        super()
        audio.push(this)
      }
      play() {
        this.plays++
        if (blockedPlaybacks > 0) {
          blockedPlaybacks--
          return Promise.reject(
            new DOMException("Mock autoplay policy", "NotAllowedError")
          )
        }
        this.paused = false
        this.dispatchEvent(new Event("play"))
        return Promise.resolve()
      }
      pause() {
        this.paused = true
        this.dispatchEvent(new Event("pause"))
      }
      removeAttribute(name: string) {
        if (name === "src") this.src = ""
      }
      load() {}
    }
    class NativeSocket extends EventTarget {
      static readonly OPEN = 1
      readyState = 0
      constructor(readonly url: string) {
        super()
        sockets.push(this)
        setTimeout(() => {
          this.readyState = 1
          this.dispatchEvent(new Event("open"))
          // Browser WebSocket messages arrive in a later task than `open`.
          // Hermes installs its message listener after awaiting the handshake.
          setTimeout(() =>
            this.notify("gateway.ready", { replay_epoch: "voice-e2e" }, "")
          )
        })
      }
      send(raw: string) {
        const request = JSON.parse(raw) as NativeRequest & { id: string }
        void host.__voiceNativeRpc(request).then((result) => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
            })
          )
          if (request.method === "session.resume")
            setTimeout(() =>
              this.notify("session.info", {
                running: false,
                stored_session_id: "history",
                profile_name: "research",
              })
            )
        })
      }
      notify(
        type: string,
        payload: Record<string, unknown> = {},
        sessionId = "live-history"
      ) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              jsonrpc: "2.0",
              method: "event",
              params: {
                type,
                session_id: sessionId,
                payload,
                ...(sessionId
                  ? { seq: sessionId === "live-history" ? ++sequence : 900 }
                  : {}),
              },
            }),
          })
        )
      }
      close() {
        this.readyState = 3
      }
    }

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          microphoneRequests++
          if (settings.liveMeter) {
            const context = new AudioContext()
            await context.resume()
            const oscillator = context.createOscillator()
            const gain = context.createGain()
            const destination = context.createMediaStreamDestination()
            oscillator.frequency.value = 220
            gain.gain.value = 0.35
            oscillator.connect(gain).connect(destination)
            oscillator.start()
            const track = destination.stream.getAudioTracks()[0]!
            const stop = track.stop.bind(track)
            Object.defineProperty(track, "stop", {
              configurable: true,
              value: () => {
                if (track.readyState === "ended") return
                stoppedTracks++
                oscillator.stop()
                stop()
                void context.close()
              },
            })
            return destination.stream
          }
          const track = new Track()
          return { getTracks: () => [track] }
        },
      },
    })
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: Recorder,
    })
    Object.defineProperty(window, "Audio", {
      configurable: true,
      value: FakeAudio,
    })
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      // Preserve Vite's own socket while mocking only the native harness wire.
      value: new Proxy(WebSocket, {
        construct(Target, args) {
          const [url, protocols] = args as [
            string | URL,
            string | string[] | undefined,
          ]
          return new URL(String(url), location.href).pathname ===
            "/hermes/api/ws"
            ? new NativeSocket(String(url))
            : new Target(url, protocols)
        },
      }),
    })
    const createUrl = URL.createObjectURL.bind(URL)
    const revokeUrl = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (blob) => {
      const url = createUrl(blob)
      createdUrls.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      revokedUrls.push(url)
      revokeUrl(url)
    }
    host.__voiceBrowser = {
      snapshot: () => ({
        microphoneRequests,
        stoppedTracks,
        createdUrls,
        revokedUrls,
        audio: audio.map((value) => ({
          paused: value.paused,
          rate: value.playbackRate,
          src: value.src,
          plays: value.plays,
        })),
      }),
      finalizeRecorder: () => recorders.at(-1)?.finalize(),
      events: (events) => {
        const socket = sockets.findLast((value) => value.readyState === 1)
        for (const event of events)
          socket?.notify(event.type, event.payload, event.sessionId)
      },
    }
  }, options)

  return {
    uploads,
    speech,
    unexpected,
    submissions: () =>
      rpc.filter((request) => request.method === "prompt.submit"),
    releaseTranscription: transcription.resolve,
    async completeReply() {
      running = false
      history = [
        ...originalHistory,
        { id: 5, role: "user", content: "A voice ask" },
        { id: 6, role: "assistant", content: "The same reply." },
      ]
      await page.evaluate(() =>
        (window as unknown as VoiceBrowser).__voiceBrowser.events([
          { type: "message.start" },
          { type: "message.start", sessionId: "unrelated-live-session" },
          {
            type: "status.update",
            payload: { kind: "provider", text: "Working" },
          },
          {
            type: "notification.show",
            payload: { kind: "notice", text: "Notice" },
          },
          { type: "reaction", payload: { kind: "heart" } },
          { type: "message.delta", payload: { text: "The same reply." } },
          {
            type: "message.complete",
            payload: { status: "complete", text: "The same reply." },
          },
          {
            type: "session.control.update",
            payload: { control: { goal: { active: true } } },
          },
          {
            type: "status.update",
            payload: { kind: "goal", text: "Goal updated" },
          },
          {
            type: "session.info",
            payload: {
              running: false,
              stored_session_id: "history",
              profile_name: "research",
            },
          },
        ])
      )
    },
  }
}

test("Chromium receives live microphone levels and keeps recording while hidden", async ({
  page,
}) => {
  const native = await installHermesVoiceMock(page, { liveMeter: true })
  await page.goto(conversationUrl)
  await page
    .getByRole("button", { name: "Record: Transcription", exact: true })
    .click()

  const recording = page.getByRole("status", { name: "Recording", exact: true })
  await expect(recording).toBeVisible()
  const levels = recording.locator('[data-slot="composer-voice-level"]')
  await expect(levels).toHaveCount(14)
  await expect
    .poll(async () =>
      levels.evaluateAll((bars) =>
        Math.max(...bars.map((bar) => Number.parseFloat(bar.style.height)))
      )
    )
    .toBeGreaterThan(3)

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(recording).toBeVisible()
  expect((await mediaSnapshot(page)).stoppedTracks).toBe(0)

  await page.getByRole("button", { name: "Finish", exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Message input" })
  ).toHaveValue("A voice ask")
  await expect
    .poll(async () => (await mediaSnapshot(page)).stoppedTracks)
    .toBe(1)
  expect(native.uploads).toHaveLength(1)
  expect(native.submissions()).toHaveLength(0)
  expect(native.unexpected).toEqual([])
})

test("tap transcription waits for final recorder data and native text before restoring an editable draft", async ({
  page,
}) => {
  const native = await installHermesVoiceMock(page, {
    holdRecorder: true,
    holdTranscription: true,
  })
  await page.goto(conversationUrl)
  const input = page.getByRole("textbox", { name: "Message input" })
  await expect(input).toBeEditable()
  await input.fill("Existing draft")
  const microphone = page.getByRole("button", {
    name: "Record: Transcription",
    exact: true,
  })
  await expect(microphone).toHaveAttribute("aria-disabled", "false")
  await microphone.click()
  await expect(
    page.getByRole("status", { name: "Recording", exact: true })
  ).toBeVisible()
  await expect(input).toBeHidden()
  await page.getByRole("button", { name: "Finish", exact: true }).click()
  await expect(page.getByText("Transcribing", { exact: true })).toBeVisible()
  expect(native.uploads).toHaveLength(0)
  expect(native.submissions()).toHaveLength(0)
  await page.evaluate(() =>
    (window as unknown as VoiceBrowser).__voiceBrowser.finalizeRecorder()
  )
  await expect.poll(() => native.uploads.length).toBe(1)
  expect(native.uploads[0]).toEqual({
    profile: "research",
    body: {
      data_url: "data:audio/webm;codecs=opus;base64,AQID",
      mime_type: "audio/webm;codecs=opus",
    },
  })
  expect(native.submissions()).toHaveLength(0)
  native.releaseTranscription("Final spoken words")
  await expect(input).toHaveValue("Existing draft Final spoken words")
  await expect(input).toBeFocused()
  await expect
    .poll(async () => (await mediaSnapshot(page)).stoppedTracks)
    .toBe(1)
  expect(native.submissions()).toHaveLength(0)
  expect(native.speech).toHaveLength(0)
  expect(native.unexpected).toEqual([])
})

test("keyboard-selected voice turn sends once and reads the new Assistant UI reply", async ({
  page,
}) => {
  const native = await installHermesVoiceMock(page, {
    holdRecorder: true,
    holdTranscription: true,
  })
  await page.goto(conversationUrl)
  const microphone = page.getByRole("button", {
    name: "Record: Transcription",
    exact: true,
  })
  await expect(microphone).toHaveAttribute("aria-disabled", "false")
  await microphone.focus()
  await page.keyboard.press("ArrowDown")
  const menu = page.getByRole("menu", { name: "Microphone mode" })
  await expect(menu).toBeVisible()
  await page.keyboard.press("End")
  await expect(
    menu.getByRole("menuitemradio", { name: "Voice turn", exact: true })
  ).toBeFocused()
  await page.keyboard.press("Enter")
  const voiceMic = page.getByRole("button", {
    name: "Record: Voice turn",
    exact: true,
  })
  await expect(voiceMic).toBeFocused()
  await expect(voiceMic).toHaveAttribute("aria-disabled", "false")
  await voiceMic.click()
  const send = page.getByRole("button", { name: "Send", exact: true })
  await expect(send).toBeFocused()
  await send.click()
  await expect(send).toBeDisabled()
  expect(native.submissions()).toHaveLength(0)
  await page.evaluate(() =>
    (window as unknown as VoiceBrowser).__voiceBrowser.finalizeRecorder()
  )
  await expect.poll(() => native.uploads.length).toBe(1)
  expect(native.submissions()).toHaveLength(0)
  native.releaseTranscription("A voice ask")
  await expect.poll(() => native.submissions().length).toBe(1)
  await expect(
    page.locator('[data-slot="aui_user-message-root"]').last()
  ).toContainText("A voice ask")
  await expect(
    page.getByRole("textbox", { name: "Message input" })
  ).toHaveValue("")
  expect(native.speech).toHaveLength(0)

  await native.completeReply()
  await expect.poll(() => native.speech.length).toBe(1)
  expect(native.speech[0]).toEqual({
    profile: "research",
    body: { text: "The same reply." },
  })
  const messages = page.locator('[data-slot="aui_assistant-message-root"]')
  await expect(
    messages.last().getByRole("group", { name: "Read aloud", exact: true })
  ).toBeVisible()
  await expect(
    messages.nth(1).getByRole("group", { name: "Read aloud", exact: true })
  ).toHaveCount(0)
  await expect(
    messages.nth(1).getByText("The same reply.", { exact: true })
  ).toBeVisible()
  await messages
    .last()
    .getByRole("button", { name: "Stop reading", exact: true })
    .click()
  await expect(
    messages.last().getByText("The same reply.", { exact: true })
  ).toBeVisible()
  expect(native.submissions()).toHaveLength(1)
  expect(native.uploads).toHaveLength(1)
  expect(native.speech).toHaveLength(1)
  expect(native.unexpected).toEqual([])
})

test("a 450 ms microphone hold opens the picker without recording and restores keyboard focus", async ({
  page,
}) => {
  const native = await installHermesVoiceMock(page)
  await page.goto(conversationUrl)
  const microphone = page.getByRole("button", {
    name: "Record: Transcription",
    exact: true,
  })
  await expect(microphone).toHaveAttribute("aria-disabled", "false")
  await page.clock.install({ time: new Date("2026-09-08T12:00:00Z") })
  await page.clock.pauseAt(new Date("2026-09-08T12:00:01Z"))
  const box = (await microphone.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.clock.runFor(449)
  await expect(page.getByRole("menu", { name: "Microphone mode" })).toHaveCount(
    0
  )
  await page.clock.runFor(1)
  const menu = page.getByRole("menu", { name: "Microphone mode" })
  await expect(menu).toBeVisible()
  await page.mouse.up()
  await expect(menu).toBeVisible()
  expect((await mediaSnapshot(page)).microphoneRequests).toBe(0)
  await page.keyboard.press("Escape")
  await expect(microphone).toBeFocused()
  await page.keyboard.press("Shift+F10")
  await expect(menu).toBeVisible()
  await menu
    .getByRole("menuitemradio", { name: "Voice turn", exact: true })
    .click()
  await page.clock.resume()
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Record: Voice turn", exact: true })
  ).toBeVisible()
  await expect(
    page
      .getByRole("button", { name: "Record: Voice turn", exact: true })
      .locator(".lucide-radio")
  ).toBeVisible()
  expect(native.uploads).toHaveLength(0)
  expect(native.submissions()).toHaveLength(0)
  expect(native.unexpected).toEqual([])
})

test("manual inline read-aloud preserves tools and restores rich prose after pause, speed, and stop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const native = await installHermesVoiceMock(page)
  await page.goto(conversationUrl)
  const first = page.locator('[data-slot="aui_assistant-message-root"]').first()
  const second = page.locator('[data-slot="aui_assistant-message-root"]').nth(1)
  await expect(first.getByRole("link", { name: "reference" })).toBeVisible()
  await expect(
    first.getByRole("heading", { name: "Illustrative plan" })
  ).toBeVisible()
  await first.hover()
  await first.getByRole("button", { name: "Read aloud", exact: true }).click()
  const playback = first.getByRole("group", { name: "Read aloud", exact: true })
  await expect(
    playback.getByRole("button", { name: "Pause", exact: true })
  ).toBeVisible()
  expect(native.speech).toEqual([
    {
      profile: "research",
      body: { text: "A formatted answer with a reference." },
    },
  ])
  await expect(
    first.getByRole("heading", { name: "Illustrative plan" })
  ).toBeVisible()
  await expect(
    second.getByRole("group", { name: "Read aloud", exact: true })
  ).toHaveCount(0)
  await expect(
    second.getByText("The same reply.", { exact: true })
  ).toBeVisible()
  await expect(playback.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "0"
  )
  await expect(playback.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    "0:00 of 0:24"
  )
  await page.screenshot({
    path: "test-results/voice-evidence/read-aloud-desktop.png",
  })
  await playback.getByRole("button", { name: "Pause", exact: true }).click()
  expect((await mediaSnapshot(page)).audio[0]?.paused).toBe(true)
  await playback
    .getByRole("button", {
      name: "Playback speed, currently 1 times",
      exact: true,
    })
    .click()
  await expect(
    playback.getByRole("button", {
      name: "Playback speed, currently 1.25 times",
      exact: true,
    })
  ).toBeVisible()
  expect((await mediaSnapshot(page)).audio[0]?.rate).toBe(1.25)
  await playback.getByRole("button", { name: "Play", exact: true }).click()
  await expect(
    playback.getByRole("button", { name: "Pause", exact: true })
  ).toBeVisible()
  expect(native.speech).toHaveLength(1)
  await first.getByRole("button", { name: "Stop reading", exact: true }).click()
  await expect(playback).toHaveCount(0)
  await expect(first.getByRole("link", { name: "reference" })).toHaveAttribute(
    "href",
    "https://example.test/source"
  )
  await expect(first.locator("strong")).toHaveText("formatted answer")
  await expect(
    first.getByRole("heading", { name: "Illustrative plan" })
  ).toBeVisible()
  const media = await mediaSnapshot(page)
  expect(media.audio).toEqual([{ paused: true, rate: 1.25, src: "", plays: 2 }])
  expect(media.revokedUrls).toEqual(media.createdUrls)
  expect(media.createdUrls).toHaveLength(1)
  expect(native.submissions()).toHaveLength(0)
  expect(native.unexpected).toEqual([])
})

test("autoplay rejection offers a gesture retry for the same audio and hiding pauses playback", async ({
  page,
}) => {
  const native = await installHermesVoiceMock(page, { blockPlayback: true })
  await page.goto(conversationUrl)
  const message = page
    .locator('[data-slot="aui_assistant-message-root"]')
    .last()
  await message.hover()
  await message.getByRole("button", { name: "Read aloud", exact: true }).click()
  await expect(
    message.getByText("Press Play to listen.", { exact: true })
  ).toBeVisible()
  const playback = message.getByRole("group", {
    name: "Read aloud",
    exact: true,
  })
  await playback.getByRole("button", { name: "Play", exact: true }).click()
  await expect(
    playback.getByRole("button", { name: "Pause", exact: true })
  ).toBeVisible()
  await expect(
    message.getByText("Press Play to listen.", { exact: true })
  ).toHaveCount(0)
  expect(native.speech).toHaveLength(1)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(
    playback.getByRole("button", { name: "Play", exact: true })
  ).toBeVisible()
  expect((await mediaSnapshot(page)).audio[0]?.paused).toBe(true)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(
    playback.getByRole("button", { name: "Play", exact: true })
  ).toBeVisible()
  await message
    .getByRole("button", { name: "Stop reading", exact: true })
    .click()
  await expect(playback).toHaveCount(0)
  const media = await mediaSnapshot(page)
  expect(media.audio[0]).toMatchObject({ paused: true, src: "", plays: 2 })
  expect(media.revokedUrls).toEqual(media.createdUrls)
  expect(media.createdUrls).toHaveLength(1)
  expect(native.submissions()).toHaveLength(0)
  expect(native.unexpected).toEqual([])
})

test.describe("mobile Hebrew voice", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })

  test("touch holds open the localized RTL picker and a tap records without submitting", async ({
    page,
  }) => {
    const native = await installHermesVoiceMock(page)
    await page.goto(`/he${conversationUrl}`)
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
    const microphone = page.getByRole("button", {
      name: "הקלטה: תמלול",
      exact: true,
    })
    await expect(microphone).toHaveAttribute("aria-disabled", "false")
    const box = (await microphone.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    const fieldBox = (await page
      .locator('[data-slot="aui_composer-field"]')
      .boundingBox())!
    const composerBox = (await page
      .locator(".aui-composer-root")
      .boundingBox())!
    expect(composerBox.x).toBeCloseTo(4, 0)
    expect(390 - composerBox.x - composerBox.width).toBeCloseTo(4, 0)
    expect(box.x).toBeGreaterThanOrEqual(fieldBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width)
    expect(
      Math.abs(box.y + box.height / 2 - (fieldBox.y + fieldBox.height / 2))
    ).toBeLessThanOrEqual(1)
    const addBox = (await page
      .locator(".aui-composer-add-attachment")
      .boundingBox())!
    const sendBox = (await page.locator(".aui-composer-send").boundingBox())!
    const gapFromField = (control: typeof box) =>
      Math.min(
        Math.abs(control.x + control.width - fieldBox.x),
        Math.abs(fieldBox.x + fieldBox.width - control.x)
      )
    expect(gapFromField(addBox)).toBeLessThanOrEqual(4)
    expect(gapFromField(sendBox)).toBeLessThanOrEqual(4)
    await page.screenshot({
      path: "test-results/voice-evidence/composer-mobile-hebrew.png",
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    })
    const menu = page.getByRole("menu", { name: "מצב המיקרופון" })
    await expect(menu).toBeVisible()
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })
    await expect(menu).toBeVisible()
    expect((await mediaSnapshot(page)).microphoneRequests).toBe(0)
    const item = menu.getByRole("menuitemradio", { name: "תמלול", exact: true })
    await expect(item).toHaveAttribute("aria-checked", "true")
    await expect(
      menu.getByRole("menuitemradio", { name: "תור קולי", exact: true })
    ).toBeVisible()
    const menuBox = (await menu.boundingBox())!
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390)
    await item.tap()
    await microphone.tap()
    await expect(
      page.getByRole("status", { name: "מקליט", exact: true })
    ).toBeVisible()
    await page.screenshot({
      path: "test-results/voice-evidence/recording-mobile-hebrew.png",
    })
    await page.getByRole("button", { name: "סיום", exact: true }).tap()
    const input = page.getByRole("textbox", { name: "שדה הודעה" })
    await expect(input).toHaveValue("A voice ask")
    await expect(input).toBeEditable()
    await expect
      .poll(async () => (await mediaSnapshot(page)).stoppedTracks)
      .toBe(1)
    expect(native.uploads).toHaveLength(1)
    expect(native.submissions()).toHaveLength(0)
    expect(native.unexpected).toEqual([])
  })
})
