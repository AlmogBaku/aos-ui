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
  it("lands on the last plain user turn past any trailing corrections", () => {
    // A correction is not a prompt, however many of them follow the prompt.
    expect(lastPromptIndex(history([user("u1"), correction("c1")]))).toBe(0)
    expect(
      lastPromptIndex(history([user("u1"), correction("c1"), correction("c2")]))
    ).toBe(0)
  })

  it("returns -1 when every user turn is a correction", () => {
    expect(lastPromptIndex(history([correction("c1"), correction("c2")]))).toBe(
      -1
    )
  })
})
