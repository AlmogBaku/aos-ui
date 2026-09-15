import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

async function resolvedPackageVersion(specifier: string, name: string) {
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)))
  for (;;) {
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8")
      ) as { name?: string; version?: string }
      if (manifest.name === name) return manifest.version
    } catch {
      // Keep walking to the package root.
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Could not resolve ${name}`)
    directory = parent
  }
}

describe("official runtime clients", () => {
  it("constructs the pinned OpenCode v2 client under Bun", async () => {
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2/client")

    const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })

    expect(client).toBeTypeOf("object")
    expect(client.session).toBeTypeOf("object")
    await expect(
      resolvedPackageVersion("@opencode-ai/sdk/v2/client", "@opencode-ai/sdk")
    ).resolves.toBe("1.18.29")
  })

  it("constructs and closes the pinned OpenClaw gateway client under Bun", async () => {
    const [{ GatewayClient }, { PROTOCOL_VERSION }] = await Promise.all([
      import("@openclaw/gateway-client"),
      import("@openclaw/gateway-protocol/version"),
    ])
    const client = new GatewayClient({ url: "ws://127.0.0.1:18789" })

    expect(PROTOCOL_VERSION).toBe(4)
    await expect(client.stopAndWait()).resolves.toBeUndefined()
    await expect(
      resolvedPackageVersion(
        "@openclaw/gateway-client",
        "@openclaw/gateway-client"
      )
    ).resolves.toBe("2026.9.4")
    await expect(
      resolvedPackageVersion(
        "@openclaw/gateway-protocol/version",
        "@openclaw/gateway-protocol"
      )
    ).resolves.toBe("2026.9.4")
  })
})
