// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { INTERACTION_PROTOCOL } from "../../protocol"
import type { AgentCatalogResponse } from "../../protocol"
import type { ServerTurnEngine, ServerRuntime } from "../core/runtime"
import type {
  SpeechCapability,
  TranscriptionCapability,
  VoiceSynthesizer,
  VoiceTranscriber,
} from "./openai-compatible"
import { VoiceProviderError } from "./openai-compatible"
import { withVoiceProviders } from "./runtime"

const CAPABILITIES = {
  workspace: {
    slashCommands: {
      status: "available",
      scope: "attached-session",
      commands: [{ name: "plan", description: "Draft a plan" }],
    },
    models: {
      status: "available",
      scope: "attached-session",
      selection: "native-session",
      choices: "provider-reported",
    },
    context: { status: "unavailable", reason: "context-unavailable" },
    todos: { status: "unavailable", reason: "todos-unavailable" },
    activity: { status: "unavailable", reason: "activity-unavailable" },
  },
  interactions: {
    steering: {
      status: "available",
      scope: "active-turn",
      semantics: "visible-user-message",
      input: "text",
      fallback: "provider-queue",
    },
    approvals: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
      choices: [
        { value: "once", scope: "request" },
        { value: "deny", scope: "request" },
      ],
      maxPending: 1,
    },
    questions: {
      status: "available",
      protocol: INTERACTION_PROTOCOL,
      scope: "turn",
      answerModes: ["single", "multiple", "free-text"],
      cancellation: "native-cancel",
      maxQuestions: 1,
      maxChoicesPerQuestion: 4,
      maxAnswerValuesPerQuestion: "complete-request",
      maxStringBytes: 4096,
    },
    reactions: { status: "unavailable", reason: "reactions-unavailable" },
  },
  content: {
    attachments: { status: "unavailable", reason: "attachments-unavailable" },
    artifacts: { status: "unavailable", reason: "artifacts-unavailable" },
    mcpApps: { status: "unavailable", reason: "mcp-apps-unavailable" },
    transcription: {
      status: "unavailable",
      reason: "native-transcription-unavailable",
    },
    speech: { status: "unavailable", reason: "native-speech-unavailable" },
  },
}

const NATIVE_TRANSCRIPTION: TranscriptionCapability = {
  status: "available",
  scope: "agent",
  acceptedMimeTypes: ["audio/wav"],
  mimeParameter: "codecs",
  codecValues: ["pcm"],
  maxRecordingBytes: 16,
  maxTranscriptBytes: 32,
}
const NATIVE_SPEECH: SpeechCapability = {
  status: "available",
  scope: "agent",
  acceptedMimeTypes: ["audio/wav"],
  maxTextBytes: 16,
  maxAudioBytes: 32,
}
const PROVIDER_TRANSCRIPTION: TranscriptionCapability = {
  status: "available",
  scope: "agent",
  acceptedMimeTypes: ["audio/webm"],
  mimeParameter: "codecs",
  codecValues: ["opus"],
  maxRecordingBytes: 1_024,
  maxTranscriptBytes: 2_048,
}
const PROVIDER_SPEECH: SpeechCapability = {
  status: "available",
  scope: "agent",
  acceptedMimeTypes: ["audio/mpeg"],
  maxTextBytes: 64,
  maxAudioBytes: 512,
}

class NativeFailure extends Error {}

/** A native runtime whose state is private, so a lost `this` cannot read it. */
class FakeNative {
  readonly turns = { engine: "native" } as unknown as ServerTurnEngine
  readonly transcribeCalls: string[] = []
  readonly speakCalls: string[] = []
  #agents = [{ id: "agent-one" }]
  #capabilities: unknown = CAPABILITIES
  readonly #failure?: (signal?: AbortSignal) => unknown

  constructor(failure?: (signal?: AbortSignal) => unknown) {
    this.#failure = failure
  }

  setCapabilities(value: unknown) {
    this.#capabilities = value
  }

  async listAgents() {
    return { agents: this.#agents } as unknown as AgentCatalogResponse
  }

  async workspaceCapabilities() {
    return this.#capabilities
  }

  async transcribe(
    agentId: string,
    _bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal
  ) {
    this.transcribeCalls.push(`${agentId}:${mimeType}`)
    if (this.#failure) throw this.#failure(signal)
    return "native transcript"
  }

  async speak(agentId: string, text: string, signal?: AbortSignal) {
    this.speakCalls.push(`${agentId}:${text}`)
    if (this.#failure) throw this.#failure(signal)
    return { bytes: new Uint8Array([1]), mimeType: "audio/wav" }
  }

  publicError(cause: unknown) {
    return cause instanceof NativeFailure
      ? { code: "temporarily_unavailable" as const, status: 503 as const }
      : undefined
  }
}

function native(failure?: (signal?: AbortSignal) => unknown) {
  const instance = new FakeNative(failure)
  return { instance, runtime: instance as unknown as ServerRuntime }
}

function transcriber() {
  const transcribe = vi.fn(async () => "provider transcript")
  const provider: VoiceTranscriber = {
    capability: () => PROVIDER_TRANSCRIPTION,
    transcribe,
  }
  return { provider, transcribe }
}

function synthesizer() {
  const speak = vi.fn(async () => ({
    bytes: new Uint8Array([2]),
    mimeType: "audio/mpeg",
  }))
  const provider: VoiceSynthesizer = {
    capability: () => PROVIDER_SPEECH,
    speak,
  }
  return { provider, speak }
}

function logger() {
  return { info: vi.fn(), error: vi.fn() }
}

async function content(runtime: ServerRuntime) {
  const value = (await runtime.workspaceCapabilities(
    "agent-one",
    "session"
  )) as { content: { transcription: unknown; speech: unknown } } | undefined
  return value?.content
}

describe("withVoiceProviders", () => {
  it("delegates every other member to the native runtime it wraps", async () => {
    const { instance, runtime } = native()
    const wrapped = withVoiceProviders(runtime, {}, logger())

    await expect(wrapped.listAgents()).resolves.toEqual({
      agents: [{ id: "agent-one" }],
    })
    expect(wrapped.turns).toBe(instance.turns)
    expect(wrapped.subscribeCatalogChanges).toBeUndefined()
  })

  it("leaves an unconfigured direction with the native runtime", async () => {
    const { instance, runtime } = native()
    const speech = synthesizer()
    const wrapped = withVoiceProviders(
      runtime,
      { speech: { mode: "override", provider: speech.provider } },
      logger()
    )

    await expect(
      wrapped.transcribe("agent-one", new Uint8Array([1]), "audio/wav")
    ).resolves.toBe("native transcript")
    expect(instance.transcribeCalls).toEqual(["agent-one:audio/wav"])
    expect((await content(wrapped))?.transcription).toEqual(
      CAPABILITIES.content.transcription
    )
  })

  it("serves an overridden direction from the provider alone", async () => {
    const { instance, runtime } = native()
    instance.setCapabilities({
      ...CAPABILITIES,
      content: {
        ...CAPABILITIES.content,
        transcription: NATIVE_TRANSCRIPTION,
        speech: NATIVE_SPEECH,
      },
    })
    const transcription = transcriber()
    const speech = synthesizer()
    const log = logger()
    const wrapped = withVoiceProviders(
      runtime,
      {
        transcription: { mode: "override", provider: transcription.provider },
        speech: { mode: "override", provider: speech.provider },
      },
      log
    )

    await expect(
      wrapped.transcribe("agent-one", new Uint8Array([1]), "audio/webm")
    ).resolves.toBe("provider transcript")
    await expect(wrapped.speak("agent-one", "read this")).resolves.toEqual({
      bytes: new Uint8Array([2]),
      mimeType: "audio/mpeg",
    })
    expect(transcription.transcribe).toHaveBeenCalledWith(
      new Uint8Array([1]),
      "audio/webm",
      undefined
    )
    expect(speech.speak).toHaveBeenCalledWith("read this", undefined)
    expect(instance.transcribeCalls).toEqual([])
    expect(instance.speakCalls).toEqual([])
    expect(await content(wrapped)).toEqual({
      attachments: CAPABILITIES.content.attachments,
      artifacts: CAPABILITIES.content.artifacts,
      mcpApps: CAPABILITIES.content.mcpApps,
      transcription: PROVIDER_TRANSCRIPTION,
      speech: PROVIDER_SPEECH,
    })
    expect(log.info).not.toHaveBeenCalled()
  })

  it("prefers the native runtime in fallback mode", async () => {
    const { instance, runtime } = native()
    instance.setCapabilities({
      ...CAPABILITIES,
      content: {
        ...CAPABILITIES.content,
        transcription: NATIVE_TRANSCRIPTION,
        speech: NATIVE_SPEECH,
      },
    })
    const transcription = transcriber()
    const speech = synthesizer()
    const log = logger()
    const wrapped = withVoiceProviders(
      runtime,
      {
        transcription: { mode: "fallback", provider: transcription.provider },
        speech: { mode: "fallback", provider: speech.provider },
      },
      log
    )

    await expect(
      wrapped.transcribe("agent-one", new Uint8Array([1]), "audio/wav")
    ).resolves.toBe("native transcript")
    await expect(wrapped.speak("agent-one", "read this")).resolves.toEqual({
      bytes: new Uint8Array([1]),
      mimeType: "audio/wav",
    })
    expect(transcription.transcribe).not.toHaveBeenCalled()
    expect(speech.speak).not.toHaveBeenCalled()
    expect(await content(wrapped)).toEqual({
      attachments: CAPABILITIES.content.attachments,
      artifacts: CAPABILITIES.content.artifacts,
      mcpApps: CAPABILITIES.content.mcpApps,
      transcription: NATIVE_TRANSCRIPTION,
      speech: NATIVE_SPEECH,
    })
    expect(log.info).not.toHaveBeenCalled()
  })

  it("advertises the provider in fallback mode while the native side is unavailable", async () => {
    const { runtime } = native()
    const transcription = transcriber()
    const speech = synthesizer()
    const wrapped = withVoiceProviders(
      runtime,
      {
        transcription: { mode: "fallback", provider: transcription.provider },
        speech: { mode: "fallback", provider: speech.provider },
      },
      logger()
    )

    expect(await content(wrapped)).toEqual({
      attachments: CAPABILITIES.content.attachments,
      artifacts: CAPABILITIES.content.artifacts,
      mcpApps: CAPABILITIES.content.mcpApps,
      transcription: PROVIDER_TRANSCRIPTION,
      speech: PROVIDER_SPEECH,
    })
  })

  it("falls back to the provider after a native failure and logs only the classification", async () => {
    const { instance, runtime } = native(() => new NativeFailure("boom"))
    const transcription = transcriber()
    const speech = synthesizer()
    const log = logger()
    const wrapped = withVoiceProviders(
      runtime,
      {
        transcription: { mode: "fallback", provider: transcription.provider },
        speech: { mode: "fallback", provider: speech.provider },
      },
      log
    )

    await expect(
      wrapped.transcribe("agent-one", new Uint8Array([1]), "audio/webm")
    ).resolves.toBe("provider transcript")
    expect(instance.transcribeCalls).toEqual(["agent-one:audio/webm"])
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith({
      event: "voice.fallback",
      direction: "transcription",
      nativeCode: "temporarily_unavailable",
    })

    await expect(wrapped.speak("agent-one", "read this")).resolves.toEqual({
      bytes: new Uint8Array([2]),
      mimeType: "audio/mpeg",
    })
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenLastCalledWith({
      event: "voice.fallback",
      direction: "speech",
      nativeCode: "temporarily_unavailable",
    })
  })

  it("logs an unclassified native failure without its message", async () => {
    const { runtime } = native(() => new Error("private upstream detail"))
    const transcription = transcriber()
    const log = logger()
    const wrapped = withVoiceProviders(
      runtime,
      { transcription: { mode: "fallback", provider: transcription.provider } },
      log
    )

    await expect(
      wrapped.transcribe("agent-one", new Uint8Array([1]), "audio/webm")
    ).resolves.toBe("provider transcript")
    expect(log.info).toHaveBeenCalledWith({
      event: "voice.fallback",
      direction: "transcription",
      nativeCode: "unclassified",
    })
  })

  it("never falls back once the caller has aborted", async () => {
    const { runtime } = native((signal) => signal?.reason)
    const transcription = transcriber()
    const speech = synthesizer()
    const log = logger()
    const wrapped = withVoiceProviders(
      runtime,
      {
        transcription: { mode: "fallback", provider: transcription.provider },
        speech: { mode: "fallback", provider: speech.provider },
      },
      log
    )
    const reason = new Error("caller stopped")
    const controller = new AbortController()
    controller.abort(reason)

    await expect(
      wrapped.transcribe(
        "agent-one",
        new Uint8Array([1]),
        "audio/webm",
        controller.signal
      )
    ).rejects.toBe(reason)
    await expect(
      wrapped.speak("agent-one", "read this", controller.signal)
    ).rejects.toBe(reason)
    expect(transcription.transcribe).not.toHaveBeenCalled()
    expect(speech.speak).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })

  it("returns capabilities it cannot parse untouched", async () => {
    const { instance, runtime } = native()
    const unparsable = { content: { transcription: "yes" } }
    instance.setCapabilities(unparsable)
    const transcription = transcriber()
    const wrapped = withVoiceProviders(
      runtime,
      { transcription: { mode: "override", provider: transcription.provider } },
      logger()
    )

    await expect(
      wrapped.workspaceCapabilities("agent-one", "session")
    ).resolves.toBe(unparsable)
  })

  it("classifies a provider failure and delegates every other cause", () => {
    const { instance, runtime } = native()
    const wrapped = withVoiceProviders(runtime, {}, logger())
    const nativeCause = new NativeFailure("boom")

    expect(
      wrapped.publicError(new VoiceProviderError("invalid_request"))
    ).toEqual({ code: "invalid_request", status: 400 })
    expect(
      wrapped.publicError(new VoiceProviderError("temporarily_unavailable"))
    ).toEqual({ code: "temporarily_unavailable", status: 503 })
    expect(wrapped.publicError(nativeCause)).toEqual(
      instance.publicError(nativeCause)
    )
    expect(wrapped.publicError(new Error("anything"))).toBeUndefined()
  })
})
