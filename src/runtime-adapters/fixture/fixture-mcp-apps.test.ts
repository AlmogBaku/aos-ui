import { afterEach, describe, expect, it, vi } from "vitest"

import { artifactFileId, mcpAppStableOriginKey } from "@harness-gw/sdk/node"
import {
  FIXTURE_ARTIFACT_VIEW_DOMAIN,
  FIXTURE_MCP_APP_FILE_IDS,
  FIXTURE_MCP_APP_FILE_PATHS,
} from "@shared/presentation/views"
import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"

import { createFixtureMcpAppAdapter } from "./fixture-mcp-apps"

const AGENT_ID = "agent-aster"
const SESSION_ID = "thread-aster-market"

/** The viewer's declared policy and stable origin, as the server records them. */
const UI = {
  csp: { resourceDomains: ["https://fonts.googleapis.com"] },
  domain: FIXTURE_ARTIFACT_VIEW_DOMAIN,
}

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
            _meta: { ui: UI },
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
  it("opens a published attachment in the recorded viewer, with its policy and stable origin, at its served file, calling no tool", async () => {
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
      ...UI,
      toolInput: {},
      toolResult: {
        structuredContent: {
          value: {
            filename: "quarterly-spend.csv",
            mimeType: "text/csv",
            fileId: artifactFileId(
              "/fixture/mcp-app-files/quarterly-spend.csv"
            ),
          },
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

  // The browser computes neither, so the fixture carries them as literals.
  it("carries the SDK's own stable origin key and file ids", () => {
    expect(FIXTURE_ARTIFACT_VIEW_DOMAIN).toBe(
      `${mcpAppStableOriginKey("http://127.0.0.1:4110/mcp")}.mcp-apps.localhost`
    )
    for (const path of FIXTURE_MCP_APP_FILE_PATHS)
      expect(FIXTURE_MCP_APP_FILE_IDS.get(path), path).toBe(
        artifactFileId(path)
      )
  })
})
