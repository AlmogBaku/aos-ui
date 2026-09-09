// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import {
  encodeHermesThreadId,
  projectHermesHistory,
} from "./hermes-native-client"
import {
  HermesArtifactAdapter,
  projectHermesArtifactReceipt,
} from "./hermes-artifacts"

const receipt = {
  ok: true,
  type: "aos.artifact",
  artifact: {
    id: "hermes-artifact-123",
    path: "reports/summary.csv",
    filename: "Quarterly summary.csv",
    mimeType: "text/csv",
    sizeBytes: 21,
  },
}

const descriptor = {
  id: "hermes-artifact-123",
  filename: "Quarterly summary.csv",
  mimeType: "text/csv",
  sizeBytes: 21,
  source: { type: "provider" as const, reference: "reports/summary.csv" },
}

describe("Hermes artifact receipts", () => {
  it("projects the explicit receipt into the canonical data part", () => {
    expect(projectHermesArtifactReceipt(JSON.stringify(receipt))).toEqual({
      type: "data",
      name: "aos.artifact",
      data: descriptor,
    })
  })

  it.each([
    undefined,
    "not json",
    { ...receipt, ok: false },
    { ...receipt, type: "other" },
    { ...receipt, artifact: { ...receipt.artifact, path: "../secret" } },
    { ...receipt, artifact: { ...receipt.artifact, id: "" } },
    { ...receipt, artifact: { ...receipt.artifact, sizeBytes: -1 } },
  ])("rejects malformed or unsafe receipts: %j", (value) => {
    expect(projectHermesArtifactReceipt(value)).toBeUndefined()
  })

  it("adds an artifact data part beside its historical tool result", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-1",
        role: "assistant",
        content: "Published",
        tool_calls: [
          {
            id: "tool-1",
            function: {
              name: "present_artifact",
              arguments: '{"path":"reports/summary.csv"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool-1",
        content: JSON.stringify(receipt),
      },
    ])

    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Published" },
      expect.objectContaining({ type: "tool-call", result: receipt }),
      { type: "data", name: "aos.artifact", data: descriptor },
    ])
  })

  it("projects artifacts selected through Hermes tool search", () => {
    const messages = projectHermesHistory([
      {
        id: "assistant-1",
        role: "assistant",
        tool_calls: [
          {
            id: "tool-1",
            function: {
              name: "tool_call",
              arguments: JSON.stringify({
                name: "present_artifact",
                arguments: { path: "reports/summary.csv" },
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool-1",
        tool_name: "present_artifact",
        content: JSON.stringify(receipt),
      },
    ])

    expect(messages[0]?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolName: "present_artifact",
        args: { path: "reports/summary.csv" },
      }),
      { type: "data", name: "aos.artifact", data: descriptor },
    ])
  })

  it("does not project receipt-shaped output from another or failed tool", () => {
    for (const row of [
      {
        role: "tool",
        tool_call_id: "tool-1",
        content: JSON.stringify(receipt),
      },
      {
        role: "tool",
        tool_call_id: "tool-2",
        content: JSON.stringify(receipt),
        is_error: true,
      },
    ]) {
      const name =
        row.tool_call_id === "tool-1" ? "write_file" : "present_artifact"
      const messages = projectHermesHistory([
        {
          id: "assistant-1",
          role: "assistant",
          tool_calls: [
            {
              id: row.tool_call_id,
              function: { name, arguments: "{}" },
            },
          ],
        },
        row,
      ])
      expect(messages[0]?.content).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "data" })])
      )
    }
  })
})

describe("Hermes artifact transport", () => {
  const threadId = encodeHermesThreadId("research + עברית", "stored/session")
  const sessionClient = {
    session: vi.fn(() => ({
      threadId,
      agentId: "research + עברית",
      profile: "research + עברית",
      storedSessionId: "stored/session",
    })),
  }

  it("resolves through native data URLs with the selected profile and Session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ dataUrl: "data:text/csv;base64,cmVnaW9uLHRvdGFsCg==" })
      )
    const adapter = new HermesArtifactAdapter({
      baseUrl: "https://aos.test/native/hermes/",
      client: sessionClient,
      fetcher,
    })
    const signal = new AbortController().signal

    const blob = await adapter.resolve({
      artifact: descriptor,
      agentId: "research + עברית",
      threadId,
      signal,
    })

    expect(blob.type).toBe("text/csv")
    await expect(blob.text()).resolves.toBe("region,total\n")
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://aos.test/native/hermes/api/fs/read-data-url?path=reports%2Fsummary.csv&profile=research+%2B+%D7%A2%D7%91%D7%A8%D7%99%D7%AA&session_id=stored%2Fsession",
      {
        credentials: "include",
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      }
    )
  })

  it("falls back to native streaming download when the data URL is too large", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 413 }))
      .mockResolvedValueOnce(
        new Response(Uint8Array.of(1, 2, 3), {
          headers: { "content-type": "application/pdf" },
        })
      )
    const adapter = new HermesArtifactAdapter({
      baseUrl: "/hermes",
      client: sessionClient,
      fetcher,
    })

    const blob = await adapter.resolve({
      artifact: descriptor,
      agentId: "research + עברית",
      threadId,
      signal: new AbortController().signal,
    })

    expect(blob.type).toBe("application/pdf")
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/hermes/api/fs/download?path=reports%2Fsummary.csv&profile=research+%2B+%D7%A2%D7%91%D7%A8%D7%99%D7%AA&session_id=stored%2Fsession"
    )
  })

  it("rejects stale ownership and non-provider sources before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const adapter = new HermesArtifactAdapter({
      baseUrl: "/hermes",
      client: sessionClient,
      fetcher,
    })
    const options = {
      artifact: descriptor,
      agentId: "other-profile",
      threadId,
      signal: new AbortController().signal,
    }

    await expect(adapter.resolve(options)).rejects.toThrow("ownership")
    await expect(
      adapter.resolve({
        ...options,
        agentId: "research + עברית",
        artifact: {
          ...descriptor,
          source: { type: "url", url: "https://example.test" },
        },
      })
    ).rejects.toThrow("provider artifact")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects invalid native data instead of interpreting it as bytes", async () => {
    const adapter = new HermesArtifactAdapter({
      baseUrl: "/hermes",
      client: sessionClient,
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ dataUrl: "data:text/plain,not-base64" })
        ),
    })

    await expect(
      adapter.resolve({
        artifact: descriptor,
        agentId: "research + עברית",
        threadId,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("invalid artifact response")
  })
})
