import { describe, expect, it } from "vitest"

import {
  readAgentCreatedEvent,
  readAgentCreatedFromMessages,
} from "./agent-activation"

type CompletedStateFixture = {
  status: string
  input: Record<string, never>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number }
}

type CompletedPartFixture = {
  id: string
  sessionID: string
  messageID: string
  type: string
  callID: string
  tool: string
  state: CompletedStateFixture
}

function completedPart(
  overrides: Partial<CompletedPartFixture> = {}
): CompletedPartFixture {
  return {
    id: "part-1",
    sessionID: "draft-session",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "create_agent",
    state: {
      status: "completed",
      input: {},
      output: "Created",
      title: "Created research-agent",
      metadata: {
        aos_ui: {
          version: 1,
          kind: "agent-created",
          draftThreadId: "draft-session",
          agentId: "research-agent",
          name: "Research Agent",
          description: "Finds and synthesizes primary sources",
        },
      },
      time: { start: 1, end: 2 },
    },
    ...overrides,
  }
}

function completedEvent(part: unknown = completedPart()) {
  return {
    type: "message.part.updated",
    properties: { sessionID: "draft-session", part },
  }
}

describe("OpenCode typed Agent activation receipts", () => {
  it("accepts only the nested metadata of a completed create_agent tool part", () => {
    expect(readAgentCreatedEvent(completedEvent())).toEqual({
      threadId: "draft-session",
      candidate: {
        agentId: "research-agent",
        name: "Research Agent",
        description: "Finds and synthesizes primary sources",
        callId: "call-1",
      },
    })
  })

  it("accepts the normalized event-source Session identity", () => {
    expect(
      readAgentCreatedEvent({
        type: "message.part.updated",
        sessionId: "draft-session",
        properties: { part: completedPart() },
      })
    ).toMatchObject({ threadId: "draft-session" })
  })

  it.each([
    ["assistant prose", { type: "text", text: "I created research-agent" }],
    ["the wrong tool", completedPart({ tool: "write" })],
    [
      "a non-completed tool",
      completedPart({
        state: { ...completedPart().state, status: "running", metadata: {} },
      }),
    ],
    ["a cross-Session part", completedPart({ sessionID: "other-session" })],
  ])("rejects %s", (_label, part) => {
    expect(readAgentCreatedEvent(completedEvent(part))).toBeUndefined()
  })

  it("rejects top-level metadata spoofing and a mismatched receipt thread", () => {
    expect(
      readAgentCreatedEvent({
        type: "message.part.updated",
        properties: {
          sessionID: "draft-session",
          metadata: completedPart().state,
          part: completedPart({
            state: { ...completedPart().state, metadata: {} },
          }),
        },
      })
    ).toBeUndefined()

    const part = completedPart()
    expect(
      readAgentCreatedEvent(
        completedEvent({
          ...part,
          state: {
            ...part.state,
            metadata: {
              aos_ui: {
                version: 1,
                kind: "agent-created",
                draftThreadId: "other-session",
                agentId: "research-agent",
                name: "Research Agent",
                description: "Description",
              },
            },
          },
        })
      )
    ).toBeUndefined()
  })

  it.each(["../escape", "Agent Name", "agent-builder", "build", "en", "he"])(
    "rejects unsafe or reserved Agent ID %s",
    (agentId) => {
      const part = completedPart()
      expect(
        readAgentCreatedEvent(
          completedEvent({
            ...part,
            state: {
              ...part.state,
              metadata: {
                aos_ui: {
                  version: 1,
                  kind: "agent-created",
                  draftThreadId: "draft-session",
                  agentId,
                  name: "Agent",
                  description: "Description",
                },
              },
            },
          })
        )
      ).toBeUndefined()
    }
  )

  it("recovers from history using the identical guard, never prose", () => {
    expect(
      readAgentCreatedFromMessages(
        [
          {
            parts: [
              { type: "text", text: "Created a research-agent" },
              completedPart(),
            ],
          },
        ],
        "draft-session"
      )
    ).toMatchObject({ agentId: "research-agent", callId: "call-1" })

    expect(
      readAgentCreatedFromMessages(
        [{ parts: [{ type: "text", text: "Created a research-agent" }] }],
        "draft-session"
      )
    ).toBeUndefined()
  })
})
