import { readFile } from "node:fs/promises"

import { describe, expect, it, vi } from "vitest"

import plugin from "./index.js"

describe("OpenClaw external plugin contract", () => {
  it("registers only tools supported without operator Gateway authority", () => {
    const names: string[] = []
    plugin.register({
      pluginConfig: {},
      registerTool: vi.fn((_tool, options) => names.push(options.name)),
    } as never)

    expect(names.sort()).toEqual([
      "present_artifact",
      "present_plan",
      "render_chart",
      "render_map",
      "render_stats",
    ])
  })

  it("advertises only available tools in the shipped manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("./openclaw.plugin.json", import.meta.url), "utf8")
    )

    expect(manifest.contracts.tools.sort()).toEqual([
      "present_artifact",
      "present_plan",
      "render_chart",
      "render_map",
      "render_stats",
    ])
  })
})
