import { describe, expect, it } from "vitest"

import { hermesInflightTurn, restoredHermesFailedTurn } from "./inflight"

const turn = {
  id: "aos-inflight:stored",
  userText: "Summarize the filing",
  createdAt: "2026-09-15T19:41:41.000Z",
}

function restore(snapshot: Record<string, unknown>) {
  const inflight = hermesInflightTurn({
    user: "Summarize the filing",
    ...snapshot,
  })
  if (!inflight) throw new Error("Expected a validated inflight snapshot")
  return restoredHermesFailedTurn(inflight, turn)
}

describe("Hermes retained turn", () => {
  it("restores nothing for a turn Hermes is still streaming", () => {
    expect(
      restore({
        assistant: "Reading the filing",
        status: "error",
        streaming: true,
        error: "Provider rejected the request",
      })
    ).toBeUndefined()
  })

  it("restores nothing for a retained error text without a failed turn state", () => {
    expect(
      restore({
        assistant: "Reading the filing",
        status: "streaming",
        error: "Provider rejected the request",
      })
    ).toBeUndefined()
  })

  it("restores a failed turn Hermes is no longer streaming", () => {
    expect(
      restore({
        assistant: "I could not reach the model.",
        status: "error",
        streaming: false,
        error: "Provider rejected the request",
      })
    ).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I could not reach the model." }],
      status: {
        type: "incomplete",
        reason: "error",
        error:
          "Hermes could not complete this turn.\nProvider rejected the request",
      },
    })
  })

  it("restores no text for a failed turn that streamed nothing", () => {
    expect(
      restore({
        // Hermes retains an empty assistant text when the model streamed no
        // prose before failing: the failure is the whole of that turn.
        assistant: "",
        status: "error",
        streaming: false,
        error: "An error occurred (ValidationException)",
        error_surface: {
          layer: "provider",
          code: "validation_exception",
          retryable: true,
        },
      })
    ).toMatchObject({
      role: "assistant",
      content: [],
      status: {
        type: "incomplete",
        reason: "error",
        error:
          "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.\nAn error occurred (ValidationException)",
      },
      metadata: {
        custom: { aos: { turnErrorCode: "AOS_PROVIDER_RETRYABLE_FAILURE" } },
      },
    })
  })

  it("drops a retained cause that carries a credential-shaped value", () => {
    const restored = restore({
      assistant: "",
      status: "error",
      streaming: false,
      error: "provider rejected authorization=Bearer sk-live-native-secret",
    })

    expect(JSON.stringify(restored)).not.toContain("sk-live-native-secret")
    expect(restored?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "Hermes could not complete this turn.",
    })
  })

  it("truncates retained text to the protocol's character bound", () => {
    // Inside the native byte bound, past the protocol's 1,000,000 characters.
    const assistant = "a".repeat(1_048_000)

    const restored = restore({
      assistant,
      status: "error",
      streaming: false,
      error: "Provider rejected the request",
    })

    expect(restored?.content).toEqual([
      { type: "text", text: "a".repeat(1_000_000) },
    ])
  })
})
