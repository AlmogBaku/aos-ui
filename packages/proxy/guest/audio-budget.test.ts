// @vitest-environment node

import { describe, expect, it } from "vitest"

import { createGuestAudioBudget } from "./audio-budget"

const NOW = 1_700_000_000_000
const WINDOW_MS = 600_000
const REF = "guest_ref"
const OTHER_REF = "other_guest_ref"

function harness(limits: { maxInFlight?: number; maxOps?: number } = {}) {
  let current = NOW
  return {
    advance(ms: number) {
      current += ms
    },
    audio: createGuestAudioBudget({
      now: () => current,
      windowMs: WINDOW_MS,
      maxInFlight: limits.maxInFlight ?? 2,
      maxOps: limits.maxOps ?? 60,
    }),
  }
}

function spend(audio: ReturnType<typeof harness>["audio"], ref: string) {
  const release = audio.acquire(ref)
  release?.()
  return release !== undefined
}

describe("guest audio budget", () => {
  it("refuses a third concurrent operation and frees the slot on release", () => {
    const { audio } = harness()

    const first = audio.acquire(REF)
    const second = audio.acquire(REF)

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(audio.acquire(REF)).toBeUndefined()

    first?.()

    expect(audio.acquire(REF)).toBeDefined()
    expect(audio.acquire(REF)).toBeUndefined()
  })

  it("refuses an operation past the windowed allowance and forgets it once the window passes", () => {
    const { advance, audio } = harness()

    for (let index = 0; index < 60; index += 1)
      expect(spend(audio, REF), `operation ${index + 1}`).toBe(true)

    // Nothing is in flight: the refusal is the spend ceiling, not concurrency.
    expect(audio.acquire(REF)).toBeUndefined()

    advance(WINDOW_MS + 1)

    expect(spend(audio, REF)).toBe(true)
  })

  it("keeps a completed operation counted for the rest of its window", () => {
    const { advance, audio } = harness({ maxOps: 2 })

    expect(spend(audio, REF)).toBe(true)
    advance(WINDOW_MS / 2)
    expect(spend(audio, REF)).toBe(true)
    expect(audio.acquire(REF)).toBeUndefined()

    // Only the first operation has aged out of the window.
    advance(WINDOW_MS / 2 + 1)

    expect(spend(audio, REF)).toBe(true)
    expect(audio.acquire(REF)).toBeUndefined()
  })

  it("budgets each conversation separately", () => {
    const { audio } = harness({ maxOps: 1 })

    expect(audio.acquire(REF)).toBeDefined()
    expect(audio.acquire(REF)).toBeUndefined()

    expect(audio.acquire(OTHER_REF)).toBeDefined()
    expect(audio.acquire(OTHER_REF)).toBeUndefined()
  })

  it("ignores a repeated release", () => {
    const { audio } = harness()

    const first = audio.acquire(REF)
    expect(audio.acquire(REF)).toBeDefined()
    first?.()
    first?.()

    expect(audio.acquire(REF)).toBeDefined()
    expect(audio.acquire(REF)).toBeUndefined()
  })

  it("gives a conversation its full allowance again after it drains", () => {
    const { advance, audio } = harness({ maxOps: 1 })

    expect(spend(audio, REF)).toBe(true)
    expect(audio.acquire(REF)).toBeUndefined()

    advance(WINDOW_MS + 1)

    expect(spend(audio, REF)).toBe(true)
    expect(audio.acquire(REF)).toBeUndefined()
  })
})
