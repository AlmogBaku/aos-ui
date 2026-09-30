// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import { useFakeClock } from "../../../../test/support/fake-clock"
import { canonicalToolName } from "../../core/aos-tool-names"
import { createMcpServerCache } from "../../core/mcp-server-cache"
import {
  createMcpAppClient,
  MCP_CATALOG_TIMEOUT_MS,
} from "../../mcp-apps/client"
import { createMcpToolNames, mcpToolCatalog } from "../../mcp-apps/tool-names"
import { HERMES_MCP_TOOL_NAMES, hermesMcpToolName } from "./mcp-tool-names"

describe("Hermes MCP tool names", () => {
  it.each([
    ["github", "create_issue", "mcp__github__create_issue"],
    ["my-server", "get.weather", "mcp__my_server__get_weather"],
    // Values computed by Hermes' own `mcp_prefixed_tool_name`.
    [
      "plugin-acme-weather-plugin-acme-weather",
      "fetch_hourly_forecast_for_station",
      "mcp__plugin_acme_weather_plugin_acme_weather__fetch_hou_6495c86c",
    ],
  ])("names %s / %s as Hermes does", (server, tool, raw) => {
    expect(hermesMcpToolName(server, tool)).toBe(raw)
  })

  it.each([
    ["mcp__my_server__get_weather", "mcp__my-server__get.weather"],
    [
      "mcp__plugin_acme_weather_plugin_acme_weather__fetch_hou_6495c86c",
      "mcp__plugin-acme-weather-plugin-acme-weather__fetch_hourly_forecast_for_station",
    ],
    ["mcp__my_server_admin__purge", "mcp__my_server_admin__purge"],
    ["mcp__local__run", "mcp__local__run"],
    ["mcp__aos_ui__render_chart", "render_chart"],
    ["mcp__unknown__tool", "mcp__unknown__tool"],
    ["read_file", "read_file"],
  ])("reads %s as %s", async (raw, canonical) => {
    const names = createMcpToolNames(HERMES_MCP_TOOL_NAMES, async () => [
      {
        name: "my-server",
        tools: ["get.weather"],
      },
      { name: "my_server_admin", tools: ["purge"] },
      {
        name: "plugin-acme-weather-plugin-acme-weather",
        tools: ["fetch_hourly_forecast_for_station"],
      },
      // A server the proxy cannot list resolves by its prefix.
      { name: "local" },
    ])

    expect(canonicalToolName(raw, await names.load("profile"))).toBe(canonical)
  })

  it("resolves a tool added since the last load after one refetch", async () => {
    const catalog = vi.fn(async (_key: string, fresh: boolean) => [
      {
        name: "my-server",
        tools: fresh ? ["get.weather", "get.tide"] : ["get.weather"],
      },
    ])
    const names = createMcpToolNames(HERMES_MCP_TOOL_NAMES, catalog)

    const resolve = await names.load("profile", ["mcp__my_server__get_tide"])

    expect(canonicalToolName("mcp__my_server__get_tide", resolve)).toBe(
      "mcp__my-server__get.tide"
    )
    expect(catalog.mock.calls.map(([, fresh]) => fresh)).toEqual([false, true])
  })

  it("resolves an unreachable server's tools by prefix within one bounded wait", async () => {
    const clock = useFakeClock()
    // Accepts the connection and never answers, as a wedged server does.
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise<Response>(() => {})
    )
    const dials = () =>
      fetch.mock.calls.filter(([, init]) =>
        String(init?.body).includes('"initialize"')
      ).length
    const client = createMcpAppClient({ fetch })
    const servers = createMcpServerCache(async () => [
      { name: "local", url: "http://127.0.0.1:4110/mcp" },
    ])
    const names = createMcpToolNames(
      HERMES_MCP_TOOL_NAMES,
      mcpToolCatalog(servers, client)
    )

    const load = names.load("profile", ["mcp__local__run"])
    await clock.advance(MCP_CATALOG_TIMEOUT_MS)
    const resolve = await load
    // A read within the refetch window waits on no second dial.
    await names.load("profile", ["mcp__local__run"])

    expect(resolve("mcp__local__run")).toEqual({ server: "local", tool: "run" })
    expect(dials()).toBe(1)
    await client.close()
  })
})
