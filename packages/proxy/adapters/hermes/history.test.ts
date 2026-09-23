import { StopReason, ToolKind } from "../../core/events"
import { describe, expect, it } from "vitest"

import { projectHermesHistory } from "./history"
import {
  assistantText,
  assistantToolCall,
  toolRow,
  userRow,
} from "./test-utils/history-rows"

describe("server-side Hermes history projection", () => {
  it("preserves a semantic tool failure when Hermes omits is_error", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-failed-tool",
        role: "assistant",
        tool_calls: [
          {
            id: "failed-tool",
            function: {
              name: "use_skill",
              arguments: '{"name":"missing"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "failed-tool",
        tool_name: "use_skill",
        content: JSON.stringify({
          success: false,
          error: "Skill 'missing' not found.",
        }),
      },
    ])

    expect(messages[0]?.content).toMatchObject([
      {
        type: "tool-call",
        toolCallId: "failed-tool",
        result: { success: false, error: "Skill 'missing' not found." },
        isError: true,
      },
    ])
  })

  it("replays a failed command with its exit code and hint", () => {
    const result = {
      output: "Error: in prepare, no such table: users",
      exit_code: 1,
      error: null,
      hint: "Exit 1: the command failed. Read the output before retrying.",
    }
    const messages = projectHermesHistory([
      {
        id: "assistant-command",
        role: "assistant",
        tool_calls: [
          {
            id: "failed-command",
            function: {
              name: "terminal",
              arguments: '{"command":"sqlite3 app.db \'select * from users\'"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "failed-command",
        tool_name: "terminal",
        is_error: true,
        content: JSON.stringify(result),
      },
    ])

    expect(messages[0]?.content).toMatchObject([
      {
        type: "tool-call",
        toolCallId: "failed-command",
        args: { command: "sqlite3 app.db 'select * from users'" },
        result,
        isError: true,
      },
    ])
  })

  it("restores trusted TTS media and suppresses a redundant copied marker", () => {
    const audioPath = "/home/alice/voice-memos/out/quick-brief.mp3"
    const copiedPath = "/home/alice/voice-memos/out/copied-brief.mp3"
    const messages = projectHermesHistory([
      {
        id: "assistant-tts",
        role: "assistant",
        tool_calls: [
          {
            id: "tts-call",
            function: {
              name: "text_to_speech",
              arguments: '{"text":"Quarterly update"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tts-call",
        tool_name: "text_to_speech",
        content: JSON.stringify({
          success: true,
          file_path: audioPath,
          file_paths: [audioPath],
          media_tag: `MEDIA:${audioPath}`,
          provider: "edge",
        }),
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: `Your brief is ready.\nMEDIA:${copiedPath}`,
      },
    ])

    expect(messages).toHaveLength(1)
    const artifact = messages[0]?.content.find(
      (part) => part.type === "data" && part.name === "aos.artifact"
    )
    expect(artifact).toMatchObject({
      type: "data",
      name: "aos.artifact",
      data: {
        filename: "quick-brief.mp3",
        mimeType: "audio/mpeg",
      },
    })
    expect(
      artifact?.type === "data" ? artifact.data.source : undefined
    ).toEqual({
      type: "provider",
      reference:
        artifact?.type === "data" && typeof artifact.data.id === "string"
          ? artifact.data.id
          : undefined,
    })
    expect(messages[0]?.content).toContainEqual({
      type: "text",
      text: "Your brief is ready.",
    })
    expect(JSON.stringify(messages)).not.toContain("MEDIA:")
    expect(JSON.stringify(messages)).not.toContain(audioPath)
    expect(JSON.stringify(messages)).not.toContain(copiedPath)
    expect(JSON.stringify(messages)).not.toContain("Media unavailable")
  })

  it("redacts an assistant MEDIA path that names a sensitive file", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-forged-media",
        role: "assistant",
        content: "MEDIA:/home/alice/.hermes/auth.json",
      },
    ])

    expect(messages).toMatchObject([
      {
        content: [{ type: "text", text: "[Media unavailable]" }],
      },
    ])
    expect(JSON.stringify(messages)).not.toContain("/home/")
    expect(JSON.stringify(messages)).not.toContain("aos.artifact")
  })

  it("restores one artifact per MEDIA reference however many rows repeat it", () => {
    const line = "MEDIA:/home/alice/reports/q3.pdf"
    const messages = projectHermesHistory([
      { id: "assistant-1", role: "assistant", content: `Draft:\n${line}` },
      { id: "assistant-2", role: "assistant", content: `Final:\n${line}` },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toMatchObject([
      { type: "text", text: "Draft:" },
      { type: "data", name: "aos.artifact", data: { filename: "q3.pdf" } },
      { type: "text", text: "Final:" },
    ])
    expect(JSON.stringify(messages)).not.toContain("/home/alice")
  })

  it("restores file attachments without exposing Hermes context or paths", () => {
    const messages = projectHermesHistory([
      {
        id: "warning-row",
        role: "user",
        content:
          "what do you see?\n@file:/home/alice/.hermes/attachments/click-2.mov\n\n--- Context Warnings ---\n- @file:/home/alice/.hermes/attachments/click-2.mov: path is outside the allowed workspace",
      },
      {
        id: "context-row",
        role: "user",
        content:
          "what do u c?\n@file:.hermes/attachments/click.mov\n\n--- Attached Context ---\n\n📎 @file:.hermes/attachments/click.mov (video/quicktime, 38.5 KB) — binary file, not inlined as text. It is available on disk at `/home/alice/.hermes/attachments/click.mov`.",
      },
    ])

    expect(messages).toMatchObject([
      {
        content: [{ type: "text", text: "what do you see?" }],
        attachments: [
          {
            id: "warning-row:attachment:0",
            type: "file",
            name: "click-2.mov",
            status: { type: "complete" },
            content: [],
          },
        ],
      },
      {
        content: [{ type: "text", text: "what do u c?" }],
        attachments: [
          {
            id: "context-row:attachment:0",
            type: "file",
            name: "click.mov",
            contentType: "video/quicktime",
            status: { type: "complete" },
            content: [],
          },
        ],
      },
    ])
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain("Attached Context")
    expect(serialized).not.toContain("Context Warnings")
    expect(serialized).not.toContain("@file:")
    expect(serialized).not.toContain("/home/")
    expect(serialized).not.toContain(".hermes/attachments")
  })

  it("restores an attached image as an artifact part, never as a marker", () => {
    const messages = projectHermesHistory([
      {
        id: "attached-image-row",
        role: "user",
        content:
          "do u see it?\n@image:/home/alice/.hermes/images/upload_20260920_024035_1.png",
      },
    ])

    expect(messages).toMatchObject([
      {
        content: [
          { type: "text", text: "do u see it?" },
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: expect.stringMatching(/^hermes-media-[a-f0-9]{32}$/u),
              filename: "upload_20260920_024035_1.png",
              mimeType: "image/png",
              source: { type: "provider" },
            },
          },
        ],
      },
    ])
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain("@image:")
    expect(serialized).not.toContain("/home/")
  })

  it("shows an inlined image once rather than beside its own directive", () => {
    const messages = projectHermesHistory([
      {
        id: "inline-image-row",
        role: "user",
        content: JSON.stringify([
          {
            type: "text",
            text: "do u see it?\n@image:/home/alice/.hermes/images/upload_1.png",
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YQ==" },
          },
        ]),
      },
    ])

    expect(messages).toMatchObject([
      {
        content: [
          { type: "text", text: "do u see it?" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
      },
    ])
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain("@image:")
    expect(serialized).not.toContain("aos.artifact")
  })

  it("omits native bookkeeping rows with a display kind", () => {
    const messages = projectHermesHistory([
      {
        id: "bookkeeping-row",
        role: "user",
        content: "internal-content",
        display_kind: "internal_notification",
      },
      {
        id: "conversation-row",
        role: "user",
        content: "conversation-content",
      },
    ])

    expect(messages).toMatchObject([
      {
        id: "conversation-row",
        content: [{ type: "text", text: "conversation-content" }],
      },
    ])
  })

  it("uses display content only for a compacted native row", () => {
    const messages = projectHermesHistory([
      {
        id: "ordinary-row",
        role: "user",
        content: "own-content",
        display_content: "foreign-content",
      },
      {
        id: "compacted-row",
        role: "user",
        content: "compaction-carrier",
        display_content: "recovered-content",
        _compressed_summary: true,
      },
    ])

    expect(messages).toMatchObject([
      { content: [{ type: "text", text: "own-content" }] },
      { content: [{ type: "text", text: "recovered-content" }] },
    ])
  })

  it("preserves message IDs, reasoning, tools, images, and safe rich descriptors without native disclosure", () => {
    const messages = projectHermesHistory([
      {
        id: "user-native-1",
        role: "user",
        timestamp: 1,
        content: [
          { type: "text", text: "Show the report" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YQ==" },
          },
        ],
        native_position: 17,
      },
      {
        id: "assistant-native-1",
        role: "assistant",
        timestamp: 2,
        reasoning_content: "Inspecting the measurements",
        tool_calls: [
          {
            id: "chart-1",
            function: {
              name: "tool_call",
              arguments: JSON.stringify({
                name: "render_chart",
                arguments: { type: "bar", data: [{ label: "A", value: 2 }] },
              }),
            },
          },
          {
            id: "artifact-1",
            function: {
              name: "present_artifact",
              arguments: '{"path":"private/report.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "chart-1",
        tool_name: "render_chart",
        content: '{"ok":true}',
      },
      {
        role: "tool",
        tool_call_id: "artifact-1",
        tool_name: "present_artifact",
        content: JSON.stringify({
          ok: true,
          type: "aos.artifact",
          artifact: {
            id: "report-1",
            filename: "report.md",
            path: "/srv/hermes/private/report.md",
            mimeType: "text/markdown",
            sizeBytes: 42,
          },
        }),
      },
      {
        id: "assistant-native-2",
        role: "assistant",
        timestamp: 3,
        content: "Here it is.",
      },
    ])

    expect(messages).toEqual([
      {
        id: "user-native-1",
        role: "user",
        createdAt: "1970-01-01T00:00:01.000Z",
        content: [
          { type: "text", text: "Show the report" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
      },
      {
        id: "assistant-native-1",
        role: "assistant",
        createdAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:03.000Z",
        content: [
          { type: "reasoning", text: "Inspecting the measurements" },
          {
            type: "tool-call",
            toolCallId: "chart-1",
            toolName: "render_chart",
            kind: ToolKind.Other,
            args: { type: "bar", data: [{ label: "A", value: 2 }] },
            argsText: JSON.stringify({
              type: "bar",
              data: [{ label: "A", value: 2 }],
            }),
            result: { ok: true },
          },
          {
            type: "tool-call",
            toolCallId: "artifact-1",
            toolName: "present_artifact",
            kind: ToolKind.Other,
            args: {},
            argsText: "{}",
            result: {
              ok: true,
              type: "aos.artifact",
              artifact: {
                id: "report-1",
                filename: "report.md",
                mimeType: "text/markdown",
                sizeBytes: 42,
              },
            },
          },
          {
            type: "data",
            name: "aos.artifact",
            data: {
              id: "report-1",
              filename: "report.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
              source: { type: "provider", reference: "report-1" },
            },
          },
          { type: "text", text: "Here it is." },
        ],
      },
    ])
    expect(JSON.stringify(messages)).not.toContain("/srv/hermes")
    expect(JSON.stringify(messages)).not.toContain("native_position")
  })

  it("preserves settled batched clarification questions and their recorded answers", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-question",
        role: "assistant",
        tool_calls: [
          {
            id: "clarify-1",
            function: {
              name: "clarify",
              arguments: JSON.stringify({
                questions: [
                  {
                    question: "Where do you live?",
                    choices: ["Tel Aviv", "Jerusalem"],
                  },
                  {
                    question: "Which amenities do you use?",
                    choices: ["Parks", "Transit"],
                    multi_select: true,
                  },
                ],
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "clarify-1",
        tool_name: "clarify",
        content: JSON.stringify({
          responses: [
            {
              question: "Where do you live?",
              choices_offered: ["Tel Aviv", "Jerusalem"],
              user_response: "Jerusalem",
            },
            {
              question: "Which amenities do you use?",
              choices_offered: ["Parks", "Transit"],
              user_response: '["Parks","Transit"]',
            },
          ],
        }),
      },
    ])

    expect(messages[0]?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "clarify-1",
        toolName: "question",
        kind: ToolKind.Other,
        args: {
          question: "2 questions",
          questions: [
            {
              question: "Where do you live?",
              options: ["Tel Aviv", "Jerusalem"],
              allowFreeform: false,
              multiple: false,
            },
            {
              question: "Which amenities do you use?",
              options: ["Parks", "Transit"],
              allowFreeform: false,
              multiple: true,
            },
          ],
          allowFreeform: true,
        },
        argsText: expect.any(String),
        result: {
          status: "answered",
          responses: [
            { question: "Where do you live?", answers: ["Jerusalem"] },
            {
              question: "Which amenities do you use?",
              answers: ["Parks", "Transit"],
            },
          ],
        },
      },
    ])
  })

  it("records an explicitly discarded Hermes clarification without inventing answers", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-question",
        role: "assistant",
        tool_calls: [
          {
            id: "clarify-cancelled",
            function: {
              name: "clarify",
              arguments: JSON.stringify({
                questions: [
                  {
                    question: "Answer whichever apply.",
                    choices: ["One", "Two"],
                    multi_select: true,
                  },
                ],
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "clarify-cancelled",
        tool_name: "clarify",
        content: JSON.stringify({
          responses: [
            {
              question: "Answer whichever apply.",
              choices_offered: ["One", "Two"],
              user_response: "",
            },
          ],
        }),
      },
    ])

    expect(messages[0]?.content).toMatchObject([
      {
        toolName: "question",
        args: {
          questions: [{ question: "Answer whichever apply." }],
        },
        result: {
          status: "cancelled",
          responses: [{ question: "Answer whichever apply.", answers: [] }],
        },
      },
    ])
  })

  it.each([
    "/opt/service/private.txt",
    "/usr/local/bin/private-tool",
    "relative/private.txt",
    String.raw`\\server\share\private.txt`,
    "home/operator/private.txt",
    "https://public.example.test/private",
    "wss://public.example.test/private",
  ])(
    "keeps operator-visible receipt text inspectable for %s",
    (privateText) => {
      const messages = projectHermesHistory([
        {
          id: "assistant-1",
          role: "assistant",
          tool_calls: [
            {
              id: "command-1",
              function: {
                name: "execute_command",
                arguments: JSON.stringify({
                  command: privateText,
                  description: "Run a command",
                }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "command-1",
          tool_name: "execute_command",
          content: JSON.stringify({
            ok: true,
            command: privateText,
            summary: privateText,
            message: privateText,
          }),
        },
      ])

      expect(messages[0]?.content).toMatchObject([
        {
          type: "tool-call",
          toolName: "execute_command",
          args: { command: privateText, description: "Run a command" },
          result: {
            ok: true,
            command: privateText,
            summary: privateText,
            message: privateText,
          },
        },
      ])

      const plain = projectHermesHistory([
        {
          id: "assistant-2",
          role: "assistant",
          tool_calls: [
            {
              id: "command-2",
              function: { name: "execute_command", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "command-2",
          tool_name: "execute_command",
          content: privateText,
        },
      ])
      expect(plain[0]?.content).toMatchObject([
        { type: "tool-call", result: privateText },
      ])
    }
  )

  it("preserves inspectable tool data while redacting credentials and provider metadata", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-1",
        role: "assistant",
        tool_calls: [
          {
            id: "search-1",
            function: {
              name: "web_search",
              arguments: JSON.stringify({
                query: "useful query",
                filters: {
                  language: "en",
                  path: "/srv/hermes/private",
                  privatePath: "workspace-relative/private.txt",
                  provider_url: "http://127.0.0.1:9000/native",
                  details: {
                    language: "en",
                    authorization: "Bearer nested-private-token",
                    stored_session_id: "stored-session-secret",
                  },
                },
                session_id: "live-session-secret",
                credentials: { token: "secret-token" },
              }),
            },
          },
          {
            id: "unknown-1",
            function: {
              name: "provider_private_tool",
              arguments: JSON.stringify({
                description: "native-only",
                path: "/srv/private/input",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "search-1",
        tool_name: "web_search",
        content: JSON.stringify({
          ok: true,
          matches: [
            {
              title: "Public title",
              snippet: "Useful summary",
              provider_url: "http://hermes.internal/result/1",
              native_position: 17,
              metadata: { authorization: "Bearer private-token" },
            },
          ],
          credential: "private-password",
        }),
      },
      {
        role: "tool",
        tool_call_id: "unknown-1",
        tool_name: "provider_private_tool",
        content: JSON.stringify({
          answer: "native payload",
          path: "/srv/private/output",
          nested: { sessionId: "live-session-secret", token: "secret-token" },
        }),
      },
    ])

    expect(messages[0]?.content).toMatchObject([
      {
        type: "tool-call",
        toolCallId: "search-1",
        toolName: "web_search",
        args: {
          query: "useful query",
          filters: {
            language: "en",
            path: "/srv/hermes/private",
            privatePath: "workspace-relative/private.txt",
            provider_url: "http://127.0.0.1:9000/native",
            details: {
              language: "en",
              authorization: "[REDACTED]",
            },
          },
          credentials: "[REDACTED]",
        },
        result: {
          ok: true,
          matches: [
            {
              title: "Public title",
              snippet: "Useful summary",
              provider_url: "http://hermes.internal/result/1",
            },
          ],
          credential: "[REDACTED]",
        },
      },
      {
        type: "tool-call",
        toolCallId: "unknown-1",
        toolName: "provider_private_tool",
        args: {
          description: "native-only",
          path: "/srv/private/input",
        },
        result: {
          answer: "native payload",
          path: "/srv/private/output",
          nested: { token: "[REDACTED]" },
        },
      },
    ])
    const serialized = JSON.stringify(messages)
    for (const leak of [
      "live-session-secret",
      "private-token",
      "stored-session-secret",
      "private-password",
      "native_position",
      "metadata",
    ])
      expect(serialized).not.toContain(leak)
    expect(serialized).toContain("[REDACTED]")
  })

  it("does not turn path-shaped artifact identity into a public descriptor", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-1",
        role: "assistant",
        tool_calls: [
          {
            id: "artifact-unsafe",
            function: {
              name: "present_artifact",
              arguments: '{"path":"/srv/private/report.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "artifact-unsafe",
        tool_name: "present_artifact",
        content: JSON.stringify({
          ok: true,
          type: "aos.artifact",
          artifact: {
            id: "/srv/private/report.md",
            filename: "../report.md",
            path: "/srv/private/report.md",
          },
        }),
      },
    ])

    expect(messages[0]?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "artifact-unsafe",
        toolName: "present_artifact",
        kind: ToolKind.Other,
        args: {},
        argsText: "{}",
        result: { ok: true },
      },
    ])
    expect(JSON.stringify(messages)).not.toContain("/srv/private")
  })

  it("history-rows builders produce shapes accepted by projectHermesHistory", () => {
    // Round-trip: build rows with the test utilities and verify that
    // projectHermesHistory projects them into the expected message structure.
    // This keeps the builder shapes pinned to what history.ts actually reads.
    // Note: adjacent assistant rows are merged by projectHermesHistory, so a
    // user row separates the two assistant turns.
    const rows = [
      userRow("u1", "Hello", { rowId: 1 }),
      assistantToolCall(
        "a1",
        [{ toolCallId: "tc1", name: "bash", args: { cmd: "ls" } }],
        { rowId: 2 }
      ),
      toolRow("tc1", "bash", { output: "file.txt" }, false, { rowId: 3 }),
      userRow("u2", "Show result", { rowId: 4 }),
      assistantText("a2", "Done.", { rowId: 5 }),
    ]

    const messages = projectHermesHistory(rows)

    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: "user", id: "hermes-row-1" })
    expect(messages[1]).toMatchObject({
      role: "assistant",
      id: "hermes-row-2",
    })
    expect(messages[1]?.content[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "bash",
      args: { cmd: "ls" },
      result: { output: "file.txt" },
    })
    // isError is absent (not false) when the tool result is not an error
    expect(
      (messages[1]?.content[0] as Record<string, unknown>)?.isError
    ).toBeUndefined()
    expect(messages[2]).toMatchObject({ role: "user", id: "hermes-row-4" })
    expect(messages[3]).toMatchObject({
      role: "assistant",
      id: "hermes-row-5",
    })
    expect(messages[3]?.content[0]).toMatchObject({
      type: "text",
      text: "Done.",
    })
  })

  it("rows with a non-empty display_kind are skipped by projectHermesHistory", () => {
    // history.ts:484 filters rows where stringValue(display_kind) is truthy.
    const rows = [
      userRow("u1", "Hello"),
      assistantText("a1", "Hidden", { displayKind: "system" }),
      assistantText("a2", "Visible"),
    ]

    const messages = projectHermesHistory(rows)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: "user" })
    expect(messages[1]?.content[0]).toMatchObject({
      type: "text",
      text: "Visible",
    })
  })

  it("flags the user row an accepted redirect persisted mid-turn", () => {
    const scaffold =
      "[Context from the interrupted assistant response]\nThe agent was drafting the summary."

    const messages = projectHermesHistory([
      userRow("u1", "Summarize the notes", { rowId: 1 }),
      userRow("u2", "Use the second draft", { rowId: 2, apiContent: scaffold }),
    ])

    expect(messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Summarize the notes" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Use the second draft" }],
        metadata: { custom: { correction: true } },
      },
    ])
    expect(messages[0]?.metadata).toBeUndefined()
  })

  it("leaves an ordinary prompt unflagged whatever its api_content carries", () => {
    const messages = projectHermesHistory([
      userRow("u1", "Summarize the notes", { rowId: 1 }),
      userRow("u2", "And the appendix", {
        rowId: 2,
        apiContent: "And the appendix",
      }),
    ])

    expect(messages).toHaveLength(2)
    for (const message of messages) expect(message.metadata).toBeUndefined()
  })

  it("ends a merged assistant turn at the newest row that built it", () => {
    const messages = projectHermesHistory([
      assistantToolCall(
        "a1",
        [{ toolCallId: "c1", name: "read_file", args: { path: "a.txt" } }],
        { timestamp: 100 }
      ),
      { ...toolRow("c1", "read_file", { ok: true }), timestamp: 140 },
      assistantText("a2", "Read it.", { timestamp: 160 }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      createdAt: "1970-01-01T00:01:40.000Z",
      completedAt: "1970-01-01T00:02:40.000Z",
    })
  })

  it("ends a single-row turn where it started", () => {
    const [message] = projectHermesHistory([
      assistantText("a1", "Done.", { timestamp: 100 }),
    ])

    expect(message?.completedAt).toBe(message?.createdAt)
  })

  it("records no completion for rows the provider kept no time for", () => {
    const [message] = projectHermesHistory([assistantText("a1", "Done.")])

    expect(message).toMatchObject({
      content: [{ type: "text", text: "Done." }],
    })
    expect(message?.completedAt).toBeUndefined()
  })

  it("stores a published artifact right after the call that published it", () => {
    const messages = projectHermesHistory([
      assistantToolCall("a1", [
        { toolCallId: "c1", name: "present_artifact", args: { path: "r.md" } },
        { toolCallId: "c2", name: "read_file", args: { path: "a.txt" } },
      ]),
      toolRow("c1", "present_artifact", {
        ok: true,
        type: "aos.artifact",
        artifact: {
          id: "report-1",
          filename: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
        },
      }),
      toolRow("c2", "read_file", { ok: true }),
    ])

    // The later call's result still patches the part it belongs to, which the
    // inserted artifact moved along.
    expect(messages[0]?.content).toMatchObject([
      { type: "tool-call", toolCallId: "c1" },
      { type: "data", name: "aos.artifact", data: { id: "report-1" } },
      { type: "tool-call", toolCallId: "c2", result: { ok: true } },
    ])
  })

  it("keeps a stored edit's kind, location, and diff", () => {
    const path = "/home/operator/project/notes.md"
    const diff = `--- a${path}\n+++ b${path}\n@@ -1 +1 @@\n-old\n+new\n`
    const secret = "/workspace/token=ghp_leaked.md"
    const messages = projectHermesHistory([
      assistantToolCall("a1", [
        { toolCallId: "c1", name: "patch", args: { path, old_string: "old" } },
        { toolCallId: "c2", name: "write_file", args: { path: secret } },
      ]),
      toolRow("c1", "patch", { success: true, diff, files_modified: [path] }),
      toolRow("c2", "write_file", { files_modified: [secret] }),
    ])

    const [edit, write] = messages[0]?.content ?? []
    expect(edit).toMatchObject({
      kind: ToolKind.Edit,
      locations: [{ path }],
      diffs: [{ changes: [{ operation: "modify", path }], patch: diff }],
    })
    expect(write).toMatchObject({ kind: ToolKind.Edit })
    expect(write).not.toHaveProperty("locations")
    expect(write).not.toHaveProperty("diffs")
  })

  it("stops a stored turn the way its newest row finished", () => {
    const messages = projectHermesHistory([
      userRow("u1", "Write it"),
      { ...assistantText("a1", "Partial"), finish_reason: "length" },
      userRow("u2", "Look it up"),
      {
        ...assistantToolCall("a2", [
          { toolCallId: "c1", name: "read_file", args: {} },
        ]),
        finish_reason: "tool_calls",
      },
      toolRow("c1", "read_file", "contents"),
      { ...assistantText("a3", "Done"), finish_reason: "stop" },
      userRow("u3", "Again"),
      { ...assistantText("a4", "Declined"), finish_reason: "content_filter" },
      userRow("u4", "Then"),
      {
        ...assistantToolCall("a5", [
          { toolCallId: "c2", name: "read_file", args: {} },
        ]),
        finish_reason: "tool_calls",
      },
    ])

    expect(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.stopReason)
    ).toEqual([
      StopReason.MaxTokens,
      StopReason.EndTurn,
      StopReason.Refusal,
      undefined,
    ])
  })

  it("replays a turn Hermes closed after a Stop as cancelled, without its marker", () => {
    const messages = projectHermesHistory([
      userRow("u1", "Count slowly"),
      {
        ...assistantToolCall("a1", [
          { toolCallId: "c1", name: "terminal", args: {} },
        ]),
        finish_reason: "tool_calls",
      },
      toolRow("c1", "terminal", { output: "1\n2\n\n[Command interrupted]" }),
      { ...assistantText("a2", "Operation interrupted."), finish_reason: null },
    ])

    const turn = messages[1]
    expect(turn?.stopReason).toBe(StopReason.Cancelled)
    expect(turn?.content.map((part) => part.type)).toEqual(["tool-call"])
  })
})
