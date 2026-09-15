import { describe, expect, it } from "vitest"

import {
  OpenClawNativePayloadError,
  openClawHistoryParams,
  openClawModelsParams,
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
})
