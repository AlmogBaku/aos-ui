import { describe, expect, it, vi } from "vitest"

import type { ArtifactDescriptor } from "@/runtime-adapters/contracts"
import { createBrowserArtifactAdapter } from "./browser-artifact-adapter"

const options = (artifact: ArtifactDescriptor) => ({
  artifact,
  agentId: "agent-1",
  threadId: "thread-1",
  signal: new AbortController().signal,
})

describe("createBrowserArtifactAdapter", () => {
  it("decodes inline UTF-8 and base64 sources", async () => {
    const adapter = createBrowserArtifactAdapter()
    const utf8 = await adapter.resolve(
      options({
        id: "utf8",
        filename: "hello.txt",
        mimeType: "text/plain",
        source: { type: "inline", encoding: "utf8", data: "שלום" },
      })
    )
    const base64 = await adapter.resolve(
      options({
        id: "base64",
        filename: "hello.bin",
        source: { type: "inline", encoding: "base64", data: "AQID" },
      })
    )

    expect(utf8.type).toBe("text/plain")
    expect(await utf8.text()).toBe("שלום")
    expect([...new Uint8Array(await base64.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it("fetches public URL sources without credentials and forwards cancellation", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(
      async () =>
        new Response("report", {
          status: 200,
          headers: { "content-type": "text/plain" },
        })
    )
    const adapter = createBrowserArtifactAdapter({ fetcher })

    expect(
      await (
        await adapter.resolve({
          ...options({
            id: "url",
            filename: "report.txt",
            source: { type: "url", url: "https://files.example/report.txt" },
          }),
          signal: controller.signal,
        })
      ).text()
    ).toBe("report")
    expect(fetcher).toHaveBeenCalledWith("https://files.example/report.txt", {
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    })
  })

  it("rejects malformed base64, provider references, and failed URL responses", async () => {
    const adapter = createBrowserArtifactAdapter({
      fetcher: vi.fn(async () => new Response("missing", { status: 404 })),
    })
    await expect(
      adapter.resolve(
        options({
          id: "bad",
          filename: "bad.bin",
          source: { type: "inline", encoding: "base64", data: "not base64" },
        })
      )
    ).rejects.toThrow("base64")
    await expect(
      adapter.resolve(
        options({
          id: "provider",
          filename: "provider.bin",
          source: { type: "provider", reference: "opaque" },
        })
      )
    ).rejects.toThrow("provider")
    await expect(
      adapter.resolve(
        options({
          id: "url",
          filename: "missing.txt",
          source: { type: "url", url: "https://files.example/missing" },
        })
      )
    ).rejects.toThrow("404")
  })
})
