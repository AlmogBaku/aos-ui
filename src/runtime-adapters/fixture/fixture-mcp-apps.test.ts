import { afterEach, describe, expect, it, vi } from "vitest"

import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"

import { createFixtureMcpAppAdapter } from "./fixture-mcp-apps"

const AGENT_ID = "agent-aster"
const SESSION_ID = "thread-aster-market"

/** The recorded `aos-ui` server, holding only the artifact viewer. */
function recordedServer() {
  return Response.json({
    tools: [],
    resources: {
      "ui://aos-ui/artifact": {
        contents: [
          {
            uri: "ui://aos-ui/artifact",
            mimeType: "text/html;profile=mcp-app",
            text: "<p>viewer</p>",
          },
        ],
      },
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fixture MCP App adapter", () => {
  it("opens a published attachment in the recorded viewer at its served file, calling no tool", async () => {
    vi.stubGlobal("location", new URL("http://localhost:3000/agents/aster"))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => recordedServer())
    )
    const adapter = createFixtureMcpAppAdapter()
    const target = {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      artifactId: "fixture-market-data",
    }
    const addresses = {
      path: "http://localhost:3000/fixture/mcp-app-files/quarterly-spend.csv",
    }

    const view = await adapter.open(target)

    expect(view).toMatchObject({
      html: "<p>viewer</p>",
      toolInput: {},
      toolResult: {
        structuredContent: {
          value: { filename: "quarterly-spend.csv", mimeType: "text/csv" },
        },
      },
      files: { addresses },
    })
    await expect(adapter.renewFiles(target)).resolves.toEqual({ addresses })
    await expect(
      adapter.callTool({ ...target, name: "refresh", arguments: {} })
    ).rejects.toThrow("calls no tool")
    // An id the preview never published is gone; an inline one is only unservable.
    await expect(
      adapter.open({ ...target, artifactId: "fixture-pruned" })
    ).rejects.toBeInstanceOf(ArtifactMissingError)
    const inline = adapter.open({ ...target, artifactId: "fixture-image" })
    await expect(inline).rejects.toThrow()
    await expect(inline).rejects.not.toBeInstanceOf(ArtifactMissingError)
  })
})
