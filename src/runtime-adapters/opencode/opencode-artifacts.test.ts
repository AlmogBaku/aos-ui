import type {
  OpenCodeProjectedThreadMessage,
  OpenCodeThreadState,
  Part,
} from "@assistant-ui/react-opencode"
import { describe, expect, it } from "vitest"

import {
  projectOpenCodeArtifactPart,
  projectOpenCodeArtifacts,
} from "./opencode-artifacts"

function completedState() {
  return {
    status: "completed",
    input: { path: "reports/result.csv" },
    output: "Published result.csv (15 bytes).",
    title: "Published result.csv",
    metadata: {
      aos_ui: {
        kind: "artifact",
        id: "artifact-1",
        filename: "result.csv",
        mimeType: "text/csv",
        sizeBytes: 15,
      },
    },
    time: { start: 1, end: 2 },
    attachments: [
      {
        id: "attachment-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "file",
        mime: "text/csv",
        filename: "result.csv",
        url: "data:text/csv;base64,bmFtZSx2YWx1ZQpBLDcK",
      },
    ],
  }
}

function toolPart(overrides: Record<string, unknown> = {}) {
  return {
    id: "part-artifact",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "present_artifact",
    state: completedState(),
    ...overrides,
  } as unknown as Part
}

describe("projectOpenCodeArtifactPart", () => {
  it("projects explicit artifact metadata and its native attachment", () => {
    expect(projectOpenCodeArtifactPart(toolPart())).toEqual({
      type: "data",
      name: "aos.artifact",
      data: {
        id: "artifact-1",
        filename: "result.csv",
        mimeType: "text/csv",
        sizeBytes: 15,
        source: {
          type: "inline",
          encoding: "base64",
          data: "bmFtZSx2YWx1ZQpBLDcK",
        },
      },
    })
  })

  it.each([
    ["another tool", { tool: "write" }],
    [
      "unclassified attachment",
      { state: { ...completedState(), metadata: {} } },
    ],
    ["failed publication", { state: { ...completedState(), status: "error" } }],
    [
      "a non-data attachment URL",
      {
        state: {
          ...completedState(),
          attachments: [
            {
              type: "file",
              mime: "text/csv",
              filename: "result.csv",
              url: "https://opencode.test/files/result.csv",
            },
          ],
        },
      },
    ],
    [
      "a non-base64 data URL",
      {
        state: {
          ...completedState(),
          attachments: [
            {
              type: "file",
              mime: "text/csv",
              filename: "result.csv",
              url: "data:text/csv,name%2Cvalue",
            },
          ],
        },
      },
    ],
    [
      "malformed base64",
      {
        state: {
          ...completedState(),
          attachments: [
            {
              type: "file",
              mime: "text/csv",
              filename: "result.csv",
              url: "data:text/csv;base64,%%%",
            },
          ],
        },
      },
    ],
  ])("does not classify %s", (_label, override) => {
    expect(projectOpenCodeArtifactPart(toolPart(override))).toBeNull()
  })
})

describe("projectOpenCodeArtifacts", () => {
  it("adds the artifact data part to the matching projected assistant message", () => {
    const state = {
      messagesById: {
        "message-1": { parts: [toolPart()] },
      },
    } as unknown as OpenCodeThreadState
    const messages = [
      {
        id: "message-1",
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ] as OpenCodeProjectedThreadMessage[]

    expect(projectOpenCodeArtifacts(state, messages)[0]?.content).toEqual([
      { type: "text", text: "Done" },
      expect.objectContaining({ type: "data", name: "aos.artifact" }),
    ])
  })
})
