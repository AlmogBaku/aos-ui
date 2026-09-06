import type { OpenCodeThreadState } from "@assistant-ui/react-opencode"
import { describe, expect, it } from "vitest"

import { findOrphanedOpenCodeQuestion } from "./orphaned-question"

function stateWithQuestion(
  overrides: Partial<OpenCodeThreadState> = {}
): OpenCodeThreadState {
  return {
    sessionId: "session-build",
    session: null,
    sessionStatus: { type: "idle" },
    loadState: { type: "ready" },
    runState: { type: "idle" },
    messageOrder: ["assistant-1"],
    messagesById: {
      "assistant-1": {
        id: "assistant-1",
        info: { id: "assistant-1", role: "assistant" } as never,
        shadowParts: undefined,
        parts: [
          {
            id: "part-1",
            sessionID: "session-build",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "question",
            state: {
              status: "running",
              input: {
                questions: [
                  {
                    header: "Approach",
                    question: "How should I proceed?",
                    options: [
                      {
                        label: "Fast",
                        description: "Make the smallest safe change",
                      },
                    ],
                    custom: true,
                  },
                ],
              },
              time: { start: 100 },
            },
          },
        ],
      },
    },
    childSessionsById: {},
    pendingUserMessages: {},
    interactions: {
      permissions: { pending: {}, resolved: {} },
      questions: { pending: {}, answered: {}, rejected: {} },
    },
    unhandledEvents: [],
    sync: {},
    ...overrides,
  }
}

describe("findOrphanedOpenCodeQuestion", () => {
  it("recovers a persisted running question after the session becomes idle", () => {
    expect(findOrphanedOpenCodeQuestion(stateWithQuestion())).toEqual({
      messageId: "assistant-1",
      callId: "call-1",
      askedAt: 100,
      questions: [
        {
          header: "Approach",
          question: "How should I proceed?",
          options: [
            {
              label: "Fast",
              description: "Make the smallest safe change",
            },
          ],
          custom: true,
        },
      ],
    })
  })

  it.each([
    ["history is not ready", { loadState: { type: "loading" } }],
    ["the run is active", { runState: { type: "streaming" } }],
    ["the session is active", { sessionStatus: { type: "busy" } }],
    [
      "a user reply is pending",
      {
        pendingUserMessages: {
          local: { status: "pending" },
        },
      },
    ],
  ])("does not recover while %s", (_label, overrides) => {
    expect(
      findOrphanedOpenCodeQuestion(
        stateWithQuestion(overrides as Partial<OpenCodeThreadState>)
      )
    ).toBeNull()
  })

  it("does not recover a question when a later user message exists", () => {
    const state = stateWithQuestion()
    expect(
      findOrphanedOpenCodeQuestion({
        ...state,
        messageOrder: ["assistant-1", "user-2"],
        messagesById: {
          ...state.messagesById,
          "user-2": {
            id: "user-2",
            info: { id: "user-2", role: "user" } as never,
            parts: [],
            shadowParts: undefined,
          },
        },
      })
    ).toBeNull()
  })

  it.each(["completed", "error"])(
    "does not recover a %s question tool",
    (status) => {
      const state = stateWithQuestion()
      const message = state.messagesById["assistant-1"]!
      const part = message.parts[0]!
      expect(
        findOrphanedOpenCodeQuestion({
          ...state,
          messagesById: {
            "assistant-1": {
              ...message,
              parts: [
                {
                  ...part,
                  state: {
                    status,
                    input: {},
                    ...(status === "completed"
                      ? {
                          output: "",
                          title: "",
                          metadata: {},
                          time: { start: 100, end: 101 },
                        }
                      : { error: "expired", time: { start: 100, end: 101 } }),
                  },
                } as never,
              ],
            },
          },
        })
      ).toBeNull()
    }
  )

  it("ignores malformed persisted question input", () => {
    const state = stateWithQuestion()
    const message = state.messagesById["assistant-1"]!
    const part = message.parts[0]!
    expect(
      findOrphanedOpenCodeQuestion({
        ...state,
        messagesById: {
          "assistant-1": {
            ...message,
            parts: [
              {
                ...part,
                state: {
                  status: "running",
                  input: { questions: [{ header: "Missing fields" }] },
                  time: { start: 100 },
                },
              } as never,
            ],
          },
        },
      })
    ).toBeNull()
  })
})
