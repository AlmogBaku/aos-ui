import { describe, expect, it } from "vitest"

import {
  OpenClawNativePayloadError,
  openClawHistoryParams,
  openClawModelsParams,
  openClawSessionsParams,
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
})
