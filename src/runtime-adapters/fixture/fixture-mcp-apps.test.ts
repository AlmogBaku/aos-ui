import { afterEach, describe, expect, it, vi } from "vitest"

import { artifactFileId, mcpAppStableOriginKey } from "@harness-gw/sdk/node"
import {
  FIXTURE_ARTIFACT_VIEW_DOMAIN,
  FIXTURE_MCP_APP_FILE_IDS,
  FIXTURE_MCP_APP_FILE_PATHS,
} from "@shared/presentation/views"
import { ArtifactMissingError } from "@/artifacts/browser-artifact-adapter"

import { McpAppResourceReadError } from "../contracts"
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

  it("answers a view's read of a served file's address with the file, as the aos-ui server does, and names why one cannot be read", async () => {
    vi.stubGlobal("location", new URL("http://localhost:3000/agents/aster"))
    const address =
      "http://localhost:3000/fixture/mcp-app-files/quarterly-spend.csv"
    const fetch = vi.fn(async (url: string) =>
      url === address
        ? new Response("quarter,total\n", {
            headers: { "content-type": "text/csv" },
          })
        : recordedServer()
    )
    vi.stubGlobal("fetch", fetch)
    const adapter = createFixtureMcpAppAdapter()
    const target = {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      artifactId: "fixture-market-data",
    }

    await expect(
      adapter.readResource({ ...target, uri: address })
    ).resolves.toEqual({
      contents: [
        { uri: address, mimeType: "text/csv", blob: btoa("quarter,total\n") },
      ],
    })
    // A file the preview does not serve, and the view itself, read as before.
    const other = "http://localhost:3000/fixture/mcp-app-files/other.csv"
    expect(
      (await adapter.readResource({ ...target, uri: other })).contents
    ).toEqual([{ uri: other, mimeType: "text/plain", text: "" }])
    expect(
      (await adapter.readResource({ ...target, uri: "ui://aos-ui/artifact" }))
        .contents[0]
    ).toMatchObject({ text: "<p>viewer</p>" })
    expect(fetch.mock.calls.map(([url]) => url)).not.toContain(other)

    fetch.mockImplementationOnce(async () => {
      throw new TypeError("offline")
    })
    const failed = await adapter
      .readResource({ ...target, uri: address })
      .catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(McpAppResourceReadError)
    expect(failed).toMatchObject({ reason: "unreachable" })
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
