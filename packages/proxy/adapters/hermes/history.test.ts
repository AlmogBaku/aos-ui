import { describe, expect, it } from "vitest"

import { projectHermesHistory } from "./history"

describe("server-side Hermes history projection", () => {
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
        content: [
          { type: "reasoning", text: "Inspecting the measurements" },
          {
            type: "tool-call",
            toolCallId: "chart-1",
            toolName: "render_chart",
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
          responses: [
            { question: "Answer whichever apply.", answers: [] },
          ],
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
    "makes receipt text opaque instead of guessing whether %s is private",
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
          args: { description: "Run a command" },
          result: { ok: true },
        },
      ])
      expect(JSON.stringify(messages)).not.toContain(privateText)

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
        { type: "tool-call", result: { status: "completed" } },
      ])
      expect(JSON.stringify(plain)).not.toContain(privateText)
    }
  )

  it("allowlists useful supported tool data and makes unsupported results opaque", () => {
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

    expect(messages[0]?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "search-1",
        toolName: "web_search",
        args: {
          query: "useful query",
          filters: { language: "en", details: { language: "en" } },
        },
        argsText: JSON.stringify({
          query: "useful query",
          filters: { language: "en", details: { language: "en" } },
        }),
        result: {
          ok: true,
          matches: [{ title: "Public title", snippet: "Useful summary" }],
        },
      },
      {
        type: "tool-call",
        toolCallId: "unknown-1",
        toolName: "provider_private_tool",
        args: {},
        argsText: "{}",
        result: { status: "completed" },
      },
    ])
    const serialized = JSON.stringify(messages)
    for (const leak of [
      "/srv/",
      "hermes.internal",
      "127.0.0.1",
      "live-session-secret",
      "private-token",
      "stored-session-secret",
      "private-password",
      "workspace-relative",
      "native_position",
      "metadata",
      "credentials",
    ])
      expect(serialized).not.toContain(leak)
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
        args: {},
        argsText: "{}",
        result: { ok: true },
      },
    ])
    expect(JSON.stringify(messages)).not.toContain("/srv/private")
  })
})
