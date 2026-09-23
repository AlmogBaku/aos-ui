import { describe, expect, it } from "vitest"

import {
  aosToolsPatch,
  OpenClawNativePayloadError,
  openClawCreateSessionParams,
  openClawDeleteSessionParams,
  openClawHistoryParams,
  openClawModelsParams,
  openClawPatchSessionParams,
  openClawSessionsParams,
  parseOpenClawHistory,
  parseOpenClawSessions,
} from "./native-schemas"

describe("OpenClaw native workspace schemas", () => {
  it("[CL1-SCHEMA-001] emits only official, scope-bound RPC parameters", () => {
    expect(openClawSessionsParams("researcher", 50, 0)).toEqual({
      agentId: "researcher",
      limit: 50,
      offset: 0,
      sortBy: "updatedAt",
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
    })
    expect(
      openClawHistoryParams("researcher", "agent:researcher:main", 200, 0)
    ).toEqual({
      agentId: "researcher",
      sessionKey: "agent:researcher:main",
      limit: 200,
      offset: 0,
    })
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

  it("[CL1-SCHEMA-005] emits one official Session mutation flag and rejects an unofficial pin state", () => {
    expect(
      openClawPatchSessionParams("researcher", "agent:researcher:main", {
        label: "Renamed",
      })
    ).toEqual({
      agentId: "researcher",
      key: "agent:researcher:main",
      label: "Renamed",
    })
    expect(
      openClawPatchSessionParams("researcher", "agent:researcher:main", {
        pinned: true,
      })
    ).toEqual({
      agentId: "researcher",
      key: "agent:researcher:main",
      pinned: true,
    })
    expect(
      openClawDeleteSessionParams("researcher", "agent:researcher:main")
    ).toEqual({ agentId: "researcher", key: "agent:researcher:main" })
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

  it("enables the aos-ui MCP server through official create and patch parameters", () => {
    expect(openClawCreateSessionParams("researcher")).toEqual({
      agentId: "researcher",
      toolOverrides: { mcpServers: { "aos-ui": true } },
    })
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
