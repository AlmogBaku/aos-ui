import { describe, expect, it } from "vitest"

import { CANONICAL_TOOL_NAMES } from "../../../packages/proxy/adapters/hermes/tool-data"
import { OPENCODE_CANONICAL_TOOL_NAMES } from "../../../packages/proxy/adapters/opencode/tool-names"

import { richToolRegistry } from "./registry"

describe("richToolRegistry", () => {
  it("registers no tool name a runtime adapter renames", () => {
    const native = new Set([
      ...CANONICAL_TOOL_NAMES.keys(),
      ...OPENCODE_CANONICAL_TOOL_NAMES.keys(),
    ])
    expect(
      Object.keys(richToolRegistry).filter((name) => native.has(name))
    ).toEqual([])
  })
})
