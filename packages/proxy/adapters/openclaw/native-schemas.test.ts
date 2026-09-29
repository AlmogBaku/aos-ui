import { describe, expect, it } from "vitest"

import {
  aosToolsPatch,
  OpenClawNativePayloadError,
  openClawHistoryParams,
  openClawModelsParams,
  openClawPatchSessionParams,
  openClawSessionsParams,
  parseOpenClawHistory,
  parseOpenClawSessions,
} from "./native-schemas"

describe("OpenClaw native workspace schemas", () => {
  it("[CL1-SCHEMA-001] emits only official, scope-bound RPC parameters", () => {
    expect(openClawModelsParams("researcher", "agent:researcher:main")).toEqual(
      { agentId: "researcher", sessionKey: "agent:researcher:main" }
    )
  })

  it("[CL1-SCHEMA-002] rejects invalid scoped values before native dispatch", () => {
    expect(() => openClawSessionsParams("", 50, 0)).toThrow(
      OpenClawNativePayloadError
    )
    expect(() => openClawHistoryParams("researcher", "", 200, 0)).toThrow(
      OpenClawNativePayloadError
    )
  })

  it("[CL1-SCHEMA-003] rejects a native page that exceeds its requested bound", () => {
    expect(() =>
      parseOpenClawSessions(
        { sessions: [{ key: "agent:a:one" }, { key: "agent:a:two" }] },
        1
      )
    ).toThrow(OpenClawNativePayloadError)
    expect(() =>
      parseOpenClawHistory({ messages: [{ id: "one" }, { id: "two" }] }, 1)
    ).toThrow(OpenClawNativePayloadError)
  })

  it("[CL1-SCHEMA-004] rejects oversized and deeply nested native history before projection", () => {
    expect(() =>
      parseOpenClawHistory(
        { messages: [{ id: "one", content: "x".repeat(4_000_001) }] },
        1
      )
    ).toThrow(OpenClawNativePayloadError)
    let deep: unknown = "leaf"
    for (let index = 0; index < 40; index++) deep = { deep }
    expect(() =>
      parseOpenClawHistory({ messages: [{ id: "one", content: deep }] }, 1)
    ).toThrow(OpenClawNativePayloadError)
  })

  it("[CL1-SCHEMA-005] rejects an unscoped Session mutation and an unofficial pin state", () => {
    expect(() =>
      openClawPatchSessionParams("researcher", "", { archived: true })
    ).toThrow(OpenClawNativePayloadError)
    expect(
      parseOpenClawSessions(
        { sessions: [{ key: "agent:a:one", pinned: true }] },
        1
      )
    ).toEqual([{ key: "agent:a:one", pinned: true }])
    expect(() =>
      parseOpenClawSessions(
        { sessions: [{ key: "agent:a:one", pinned: "yes" }] },
        1
      )
    ).toThrow(OpenClawNativePayloadError)
  })

  it("enables the aos-ui MCP server through official patch parameters", () => {
    expect(
      openClawPatchSessionParams(
        "researcher",
        "agent:researcher:main",
        aosToolsPatch({
          mcpServers: { other: false },
          skills: { review: true },
        })
      )
    ).toEqual({
      agentId: "researcher",
      key: "agent:researcher:main",
      toolOverrides: {
        mcpServers: { other: false, "aos-ui": true },
        skills: { review: true },
      },
      expectedToolOverrides: {
        mcpServers: { other: false },
        skills: { review: true },
      },
    })
    expect(
      openClawPatchSessionParams(
        "researcher",
        "agent:researcher:main",
        aosToolsPatch(undefined)
      )
    ).toMatchObject({ expectedToolOverrides: null })
  })

  it("rejects a listed Session whose tool overrides are not official", () => {
    expect(() =>
      parseOpenClawSessions(
        {
          sessions: [{ key: "agent:researcher:main", toolOverrides: { x: 1 } }],
        },
        10
      )
    ).toThrow(OpenClawNativePayloadError)
  })
})
