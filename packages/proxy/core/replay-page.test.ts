import { describe, expect, it } from "vitest"

import type { SessionHistoryResponse } from "../../protocol"
import { lastPromptIndex } from "./replay-page"

const BASE_HISTORY: Omit<SessionHistoryResponse, "messages"> = {
  sessionId: "s-test",
  total: 0,
  limit: 200,
  offset: 0,
  nextOffset: 0,
}

function history(
  messages: SessionHistoryResponse["messages"]
): SessionHistoryResponse {
  return { ...BASE_HISTORY, messages, total: messages.length }
}

const user = (id: string): SessionHistoryResponse["messages"][number] => ({
  id,
  role: "user",
  content: [{ type: "text", text: "Hello" }],
  createdAt: "2026-09-26T00:00:00.000Z",
})

const correction = (
  id: string
): SessionHistoryResponse["messages"][number] => ({
  id,
  role: "user",
  content: [{ type: "text", text: "Fix this" }],
  createdAt: "2026-09-26T00:00:01.000Z",
  correction: true,
})

describe("lastPromptIndex", () => {
  it("skips a typed correction message and lands on the last plain user turn", () => {
    // A correction is not a prompt — lastPromptIndex returns the prompt's index
    expect(lastPromptIndex(history([user("u1"), correction("c1")]))).toBe(0)
  })

  it("returns -1 when every user turn is a correction", () => {
    expect(lastPromptIndex(history([correction("c1"), correction("c2")]))).toBe(
      -1
    )
  })

  it("returns the index of the last plain user turn ignoring trailing corrections", () => {
    expect(
      lastPromptIndex(history([user("u1"), correction("c1"), correction("c2")]))
    ).toBe(0)
  })
})
