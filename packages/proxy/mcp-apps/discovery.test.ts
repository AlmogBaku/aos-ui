import { describe, expect, it } from "vitest"

import { mcpServersFromNative } from "./discovery"

describe("mcpServersFromNative", () => {
  it("gives a server a URL only where the proxy may dial it", () => {
    const server = {
      dialable: true,
      url: "https://apps.example.test/mcp",
      credentials: false,
    }
    const servers = mcpServersFromNative(
      [
        { ...server, name: "open" },
        { ...server, name: "off", dialable: false },
        { ...server, name: "stdio", url: "file:///tmp/mcp.sock" },
        { ...server, name: "private", credentials: true },
        { ...server, name: "configured", credentials: true },
      ],
      (name) => name === "configured"
    )

    expect(servers).toEqual([
      { name: "open", url: "https://apps.example.test/mcp" },
      { name: "off" },
      { name: "stdio" },
      { name: "private" },
      { name: "configured", url: "https://apps.example.test/mcp" },
    ])
  })
})
