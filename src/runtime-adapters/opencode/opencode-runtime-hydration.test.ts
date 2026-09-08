import type { OpencodeClient } from "@assistant-ui/react-opencode"
import { describe, expect, it, vi } from "vitest"

import { hydrateOpenCodeSession } from "./use-aos-opencode-runtime"

describe("OpenCode initial native state hydration", () => {
  it("restores status, permissions, and questions before relying on live events", async () => {
    const client = {
      session: {
        status: vi.fn(async () => ({
          data: { "session-1": { type: "busy" } },
        })),
      },
      permission: {
        list: vi.fn(async () => ({
          data: [{ id: "permission-1", sessionID: "session-1" }],
        })),
      },
      question: {
        list: vi.fn(async () => ({
          data: [{ id: "question-1", sessionID: "session-1", questions: [] }],
        })),
      },
    } as unknown as OpencodeClient
    const emit = vi.fn()

    await hydrateOpenCodeSession(client, "session-1", emit)

    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      "session.status",
      "permission.asked",
      "question.asked",
    ])
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.status",
        sessionId: "session-1",
        properties: expect.objectContaining({ status: { type: "busy" } }),
      })
    )
  })
})
