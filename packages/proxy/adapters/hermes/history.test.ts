import { StopReason, ToolKind } from "../../core/events"
import { describe, expect, it } from "vitest"

import { hermesTurnStart, projectHermesHistory } from "./history"
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

    // The call's response and the one after it, which still trusts its media.
    expect(messages).toHaveLength(2)
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
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "Your brief is ready." },
    ])
    expect(JSON.stringify(messages)).not.toContain("MEDIA:")
    expect(JSON.stringify(messages)).not.toContain(audioPath)
    expect(JSON.stringify(messages)).not.toContain(copiedPath)
    expect(JSON.stringify(messages)).not.toContain("Media unavailable")
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

  const tagged = (displayKind: string, content = "Synthetic payload") =>
    userRow("x", content, { displayKind })
  const untagged = (content: string) => userRow("x", content)

  it.each([
    // Shown, and the reply after it is its own turn's.
    ["a prompt", untagged("And the appendix"), ["u1", "u1-1", "x", "x-1"]],
    [
      "a skill invocation",
      tagged("skill_invocation", "/work fix the leak"),
      ["u1", "u1-1", "x", "x-1"],
    ],
    // Shown as a correction of the running turn, which keeps the reply.
    [
      "a redirect",
      userRow("x", "Use the second draft", {
        apiContent: "[Context from the interrupted assistant response]\nDraft",
      }),
      ["u1", "u1-1", "x!", "u1-2"],
    ],
    [
      "a steer",
      tagged(
        "steer",
        "[OUT-OF-BAND USER MESSAGE — a direct message]\nUse the second draft\n[/OUT-OF-BAND USER MESSAGE]"
      ),
      ["u1", "u1-1", "x!", "u1-2"],
    ],
    // Hidden, but its reply is its own message.
    ...[
      "auto_continue",
      "process_complete",
      "async_delegation_complete",
      "internal_notification",
      "hidden",
    ].map((kind) => [`${kind} row`, tagged(kind), ["u1", "u1-1", "x-1"]]),
    ...[
      "[Continuing toward your standing goal]\nGoal: tidy the notes",
      "[/loop wakeup #2, every 10m]\nRecurring task: check the build",
      "[Heartbeat — recurring instruction, fires every 1h]\nCheck the inbox",
      '[IMPORTANT: Background process proc_1 matched watch pattern "ERR".\nCommand: make]',
      "[System note: Your previous turn was interrupted mid-run. Resume it.]",
    ].map((text) => [
      text.split("\n")[0],
      untagged(text),
      ["u1", "u1-1", "x-1"],
    ]),
    // Model-only: hidden, and the reply stays with the original request.
    ...[
      "[System: The active model for this chat has changed]",
      "  [STILL IN PROGRESS — this is the active request.]\nSummarize the notes",
      "[Your active task list was preserved across context compression]\n- [>] Draft",
      "[Skills pruned during compression — reload before acting on these tasks]",
      "Continue from the compressed conversation context above. No human turn.",
      "[Background process proc_1 heartbeat #3 — still running after 5m]",
    ].map((text) => [
      text.split("\n")[0],
      untagged(text),
      ["u1", "u1-1", "u1-2"],
    ]),
    ...["model_switch", "personality_switch", "unknown_kind"].map((kind) => [
      `${kind} row`,
      tagged(kind),
      ["u1", "u1-1", "u1-2"],
    ]),
    [
      "a hidden compaction handoff",
      { ...tagged("hidden"), _compressed_summary: true },
      ["u1", "u1-1", "u1-2"],
    ],
  ])("projects %s by its row class", (_name, row, ids) => {
    const messages = projectHermesHistory([
      userRow("u1", "Summarize the notes"),
      assistantToolCall("a1", [
        { toolCallId: "c1", name: "read_file", args: { path: "notes.md" } },
      ]),
      toolRow("c1", "read_file", "contents"),
      row,
      assistantText("a2", "Done."),
    ])

    expect(
      messages.map(({ id, correction }) => (correction ? `${id}!` : id))
    ).toEqual(ids)
  })

  it.each([
    [
      '[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\nSkill body that quotes The user has provided the following instruction alongside the skill invocation: nothing\n\nThe user has provided the following instruction alongside the skill invocation: fix   the leak\n\n[Runtime note: synthetic]',
      "/work fix the leak",
    ],
    [
      '[IMPORTANT: The user has invoked the "/clean /work" stacked skill bundle, loading 2 skills together. Treat every skill below as active guidance for this turn.]\n\nSkills loaded: clean, work\n\nUser instruction: tidy up\n\n[Loaded as part of the stacked skill invocation "clean".]\nUser instruction: body text',
      "/clean /work tidy up",
    ],
    [
      '[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\nSkill body',
      "/work",
    ],
  ])(
    "shows a skill scaffold as the invocation typed: %#",
    (scaffold, typed) => {
      const [message] = projectHermesHistory([userRow("u1", scaffold)])

      expect(message?.content).toEqual([{ type: "text", text: typed }])
    }
  )

  it.each([
    "[Your active task list was preserved across context compression]\n- [>] Draft\n\n[Skills pruned during compression — reload before acting on these tasks]",
    "[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]\nSummarize the notes",
  ])(
    "shows a prompt without the scaffold Hermes merged onto it: %#",
    (tail) => {
      const [message] = projectHermesHistory([
        userRow("u1", `Summarize the notes\n\n${tail}`),
      ])

      expect(message?.content).toEqual([
        { type: "text", text: "Summarize the notes" },
      ])
    }
  )

  it("hides a compaction carrier whose only live content is the replayed request", () => {
    const replay =
      "[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]\nSummarize the notes"
    const messages = projectHermesHistory([
      {
        id: "carrier",
        role: "user",
        content: `Synthetic summary\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---\n\n${replay}`,
        display_content: replay,
        _compressed_summary: true,
      },
    ])

    expect(messages).toEqual([])
  })

  it("keeps one reply whole across a tagged assistant row", () => {
    const messages = projectHermesHistory([
      userRow("u1", "Summarize the notes"),
      assistantText("a1", "Working."),
      assistantText("a-hidden", "Understood.", { displayKind: "hidden" }),
      assistantText("a2", "Done."),
    ])

    expect(messages).toMatchObject([
      { id: "u1" },
      {
        id: "u1-1",
        content: [
          { type: "text", text: "Working." },
          { type: "text", text: "Done." },
        ],
      },
    ])
    expect(messages).toHaveLength(2)
  })

  it("starts a page at its first prompt or automation row, never a hidden one", () => {
    expect(
      hermesTurnStart([
        assistantText("a0", "Earlier reply."),
        untagged("[System: The active model for this chat has changed]"),
        tagged("model_switch"),
        untagged("[/loop wakeup #2, every 10m]\nRecurring task: check"),
        userRow("u1", "Summarize the notes"),
      ])
    ).toBe(3)
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
      // Each model response numbers from the prompt's row, and its thought is
      // a message of its own ahead of it.
      {
        id: "user-native-1-1-thought",
        role: "assistant",
        createdAt: "1970-01-01T00:00:02.000Z",
        content: [{ type: "reasoning", text: "Inspecting the measurements" }],
      },
      {
        id: "user-native-1-1",
        role: "assistant",
        createdAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:02.000Z",
        content: [
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
        ],
      },
      {
        id: "user-native-1-2",
        role: "assistant",
        createdAt: "1970-01-01T00:00:03.000Z",
        completedAt: "1970-01-01T00:00:03.000Z",
        content: [{ type: "text", text: "Here it is." }],
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

  it.each([
    [
      "an accepted redirect",
      userRow("u2", "Use the second draft", {
        rowId: 2,
        apiContent:
          "[Context from the interrupted assistant response]\nThe agent was drafting the summary.",
      }),
    ],
    [
      "a steer",
      userRow(
        "u2",
        "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\nUse the second draft\n[/OUT-OF-BAND USER MESSAGE]",
        { rowId: 2, displayKind: "steer" }
      ),
    ],
  ])("flags the user row %s persisted mid-turn", (_name, correction) => {
    const messages = projectHermesHistory([
      userRow("u1", "Summarize the notes", { rowId: 1 }),
      correction,
    ])

    expect(messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Summarize the notes" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Use the second draft" }],
        correction: true,
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

  it("ends a model response at the newest row that built it", () => {
    const messages = projectHermesHistory([
      assistantToolCall(
        "a1",
        [{ toolCallId: "c1", name: "read_file", args: { path: "a.txt" } }],
        { timestamp: 100 }
      ),
      { ...toolRow("c1", "read_file", { ok: true }), timestamp: 140 },
      assistantText("a2", "Read it.", { timestamp: 160 }),
    ])

    expect(messages).toMatchObject([
      {
        createdAt: "1970-01-01T00:01:40.000Z",
        completedAt: "1970-01-01T00:02:20.000Z",
      },
      {
        createdAt: "1970-01-01T00:02:40.000Z",
        completedAt: "1970-01-01T00:02:40.000Z",
      },
    ])
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
      undefined,
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

  it.each([
    "Your request was not processed. Send it again if you still want me to carry it out.",
    "This turn did not complete. Some actions may already have run; verify their effects before resending.",
  ])(
    "replays a turn Hermes closed with a failed-turn notice as cancelled: %s",
    (notice) => {
      const messages = projectHermesHistory([
        userRow("u1", "Describe these"),
        { ...assistantText("a1", notice), finish_reason: null },
      ])

      const turn = messages[1]
      expect(turn?.stopReason).toBe(StopReason.Cancelled)
      expect(turn?.content).toEqual([])
    }
  )

  it("keeps a model reply that quotes a failed-turn notice", () => {
    const notice =
      "Your request was not processed. Send it again if you still want me to carry it out."
    const messages = projectHermesHistory([
      userRow("u1", "What does the notice say?"),
      { ...assistantText("a1", notice), finish_reason: "stop" },
    ])

    expect(messages[1]?.stopReason).toBe(StopReason.EndTurn)
    expect(messages[1]?.content).toEqual([{ type: "text", text: notice }])
  })

  it("keeps a user message that is a JSON object as the text that was sent", () => {
    const sent = JSON.stringify({ v: 1, type: "note", body: "Synthetic" })

    const [message] = projectHermesHistory([userRow("u1", sent)])

    expect(message?.content).toEqual([{ type: "text", text: sent }])
  })
})
