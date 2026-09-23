import { describe, expect, it } from "vitest"

import {
  bufferNativeEvent,
  drainBufferedEvents,
  firstBufferedSeq,
  nativeEvent,
  nativeEventBuffer,
  terminalText,
  tokenUsage,
  usageCost,
} from "./run-frames"

describe("reading a native Hermes frame", () => {
  it("keeps the type, Session, sequence and payload Hermes sent", () => {
    expect(
      nativeEvent({
        type: "message.delta",
        session_id: "live-1",
        seq: 4,
        payload: { text: "Hello" },
      })
    ).toEqual({
      type: "message.delta",
      session_id: "live-1",
      seq: 4,
      payload: { text: "Hello" },
    })
  })

  it("refuses a frame without a type or a live Session", () => {
    expect(nativeEvent({ session_id: "live-1", seq: 1 })).toBeUndefined()
    expect(nativeEvent({ type: "message.delta", seq: 1 })).toBeUndefined()
    expect(nativeEvent("message.delta")).toBeUndefined()
  })

  it("refuses a sequence that cannot address Hermes' ring", () => {
    expect(
      nativeEvent({ type: "message.delta", session_id: "live-1", seq: 1.5 })
    ).toBeUndefined()
    expect(
      nativeEvent({ type: "message.delta", session_id: "live-1", seq: -1 })
    ).toBeUndefined()
    expect(
      nativeEvent({ type: "message.delta", session_id: "live-1", seq: "4" })
    ).toBeUndefined()
  })
})

describe("the bounded native frame buffer", () => {
  it("drains the frames it held in Hermes' own order", () => {
    const buffer = nativeEventBuffer()
    bufferNativeEvent(buffer, { type: "message.start", session_id: "live-1" })
    bufferNativeEvent(buffer, {
      type: "message.delta",
      session_id: "live-1",
      seq: 2,
    })

    expect(drainBufferedEvents(buffer)).toEqual([
      { type: "message.start", session_id: "live-1" },
      { type: "message.delta", session_id: "live-1", seq: 2 },
    ])
    expect(buffer.overflow).toBe(false)
    expect(drainBufferedEvents(buffer)).toEqual([])
  })

  it("holds nothing once a frame passes its bound", () => {
    const buffer = nativeEventBuffer()
    bufferNativeEvent(buffer, { type: "message.start", session_id: "live-1" })

    bufferNativeEvent(buffer, {
      type: "message.delta",
      session_id: "live-1",
      payload: { text: "x".repeat(4_194_305) },
    })

    expect(buffer.overflow).toBe(true)
    expect(drainBufferedEvents(buffer)).toEqual([])
  })

  it("reports the first held sequence, and none when nothing carries one", () => {
    expect(
      firstBufferedSeq([
        { type: "message.start", session_id: "live-1" },
        { type: "message.delta", session_id: "live-1", seq: 7 },
      ])
    ).toBe(7)
    expect(firstBufferedSeq([])).toBe(0)
  })
})

describe("reading native token usage", () => {
  it("projects Hermes' counters into AOS token usage", () => {
    expect(
      tokenUsage({ model: "claude", input: 3, output: 5, total: 8 })
    ).toEqual([
      { model: "claude", inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    ])
  })

  it("accepts a usage payload whole or not at all", () => {
    expect(tokenUsage({ input: 3, output: -1 })).toBeUndefined()
    expect(tokenUsage({ input: 1.5 })).toBeUndefined()
    expect(tokenUsage({})).toBeUndefined()
  })

  it("reads a counter Hermes sends as null as absent", () => {
    expect(tokenUsage({ input: 3, cache_read: null, cache_write: 2 })).toEqual([
      { inputTokens: 3, cachedWriteTokens: 2 },
    ])
  })

  it("prices usage in US dollars only when Hermes reports a cost", () => {
    expect(usageCost({ cost_usd: 0.5 })).toEqual({
      amount: 0.5,
      currency: "USD",
    })
    expect(usageCost({ cost_usd: null })).toBeUndefined()
    expect(usageCost({ cost_usd: -1 })).toBeUndefined()
  })
})

describe("reading terminal output", () => {
  it("keeps the text a terminal prints and drops its control sequences", () => {
    expect(
      terminalText("\u001b[1;32mok\u001b[0m \u001b]0;title\u0007done\n")
    ).toBe("ok done\n")
  })
})
