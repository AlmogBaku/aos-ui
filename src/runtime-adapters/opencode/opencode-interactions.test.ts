import { describe, expect, it, vi } from "vitest"
import {
  createOpenCodeThreadState,
  type OpenCodeQuestionRequest,
  type OpenCodeServerEvent,
  type OpencodeClient,
} from "@assistant-ui/react-opencode"
import { createOpenCodeRuntimeInteractions } from "./opencode-interactions"

describe("OpenCode interaction adapter", () => {
  it("preserves expiry when the runtime removes the question before the shared SSE listener runs", async () => {
    let questions: OpenCodeQuestionRequest[] = [
      {
        id: "one",
        sessionID: "session-one",
        askedAt: 1,
        questions: [{ header: "Region", question: "Where?", options: [] }],
      },
    ]
    const runtimeListeners = new Set<() => void>()
    const eventListeners = new Set<(event: OpenCodeServerEvent) => void>()
    const client = {
      question: { list: vi.fn(async () => ({ data: [] })) },
    } as unknown as OpencodeClient
    const interactions = createOpenCodeRuntimeInteractions(
      client,
      {
        read: () => ({
          state: createOpenCodeThreadState("session-one"),
          questions,
        }),
        subscribe: (listener) => {
          runtimeListeners.add(listener)
          return () => {
            runtimeListeners.delete(listener)
          }
        },
      },
      {
        subscribe: (listener) => {
          eventListeners.add(listener)
          return () => {
            eventListeners.delete(listener)
          }
        },
      }
    )
    expect(interactions.getPending("session-one")?.requestId).toBe("one")
    const release = interactions.subscribe("session-one", () => {})
    await vi.waitFor(() => expect(client.question.list).toHaveBeenCalledOnce())
    questions = []
    for (const listener of runtimeListeners) listener()
    for (const listener of eventListeners)
      listener({
        type: "question.replied",
        sessionId: "session-one",
        properties: { sessionID: "session-one", requestID: "one", answers: [] },
        raw: {
          type: "question.replied",
          properties: {
            sessionID: "session-one",
            requestID: "one",
            answers: [],
          },
        },
      })
    expect(interactions.getPending("session-one")).toMatchObject({
      requestId: "one",
      status: "expired",
    })
    release()
  })

  it("loads preexisting requests for only the subscribed Session with stable snapshots", async () => {
    const client = {
      question: {
        list: vi.fn(async () => ({
          data: [
            {
              id: "one",
              sessionID: "session-one",
              questions: [
                {
                  header: "Region",
                  question: "Where?",
                  options: [{ label: "IL", description: "Israel" }],
                },
              ],
            },
            { id: "foreign", sessionID: "session-two", questions: [] },
          ],
        })),
      },
    } as unknown as OpencodeClient
    const interactions = createOpenCodeRuntimeInteractions(
      client,
      { subscribe: () => () => {}, read: () => undefined },
      { subscribe: () => () => {} }
    )
    const listener = vi.fn()
    const unsubscribe = interactions.subscribe("session-one", listener)
    await vi.waitFor(() =>
      expect(interactions.getPending("session-one")?.requestId).toBe("one")
    )
    const snapshot = interactions.getPending("session-one")
    expect(interactions.getPending("session-one")).toBe(snapshot)
    expect(interactions.getPending("session-two")).toBeUndefined()
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })
})
