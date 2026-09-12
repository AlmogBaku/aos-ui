import { describe, expect, it } from "vitest"

import {
  AgentCatalogResponseSchema,
  HermesAuthStateSchema,
  OperatorAuthStateSchema,
  RuntimeInfoSchema,
  VisibilityUpdateRequestSchema,
} from "./index"

describe("AOS v1 normalized protocol", () => {
  it("accepts only the public operator authentication states", () => {
    expect(
      OperatorAuthStateSchema.parse({
        status: "authenticated",
        operator: { id: "operator@example.test", displayName: "Operator" },
      })
    ).toEqual({
      status: "authenticated",
      operator: { id: "operator@example.test", displayName: "Operator" },
    })
    expect(() =>
      OperatorAuthStateSchema.parse({
        status: "authenticated",
        operator: { id: "operator@example.test", accessToken: "secret" },
      })
    ).toThrow()
  })

  it("keeps native Hermes authentication material outside browser state", () => {
    expect(
      HermesAuthStateSchema.parse({
        status: "authenticated",
        method: "static-token",
      })
    ).toEqual({ status: "authenticated", method: "static-token" })
    expect(() =>
      HermesAuthStateSchema.parse({
        status: "authenticated",
        method: "static-token",
        token: "secret",
      })
    ).toThrow()
  })

  it("describes operation-specific runtime capabilities without booleans", () => {
    expect(
      RuntimeInfoSchema.parse({
        runtime: { id: "hermes", name: "Hermes" },
        status: "ready",
        capabilities: {
          agentCatalog: { status: "available" },
          agentVisibility: {
            status: "available",
            concurrency: "revision",
          },
          sessionCreation: {
            status: "unavailable",
            reason: "not-implemented",
          },
        },
      }).status
    ).toBe("ready")
    expect(() =>
      RuntimeInfoSchema.parse({
        runtime: { id: "hermes", name: "Hermes" },
        status: "ready",
        capabilities: { agentCatalog: true },
      })
    ).toThrow()
  })

  it("validates normalized Agent entries and rejects native profile metadata", () => {
    const payload = {
      revision: "profiles:12",
      agents: [
        {
          summary: {
            kind: "ready",
            id: "researcher",
            name: "Researcher",
            description: "Investigates primary sources",
            activity: "idle",
            visibility: "visible",
          },
          visibility: "visible",
          selectable: true,
          editable: true,
          revision: "hermes-bots:7",
        },
      ],
    }
    expect(AgentCatalogResponseSchema.parse(payload)).toEqual(payload)
    expect(() =>
      AgentCatalogResponseSchema.parse({
        ...payload,
        agents: [
          {
            ...payload.agents[0],
            ui_meta_revisions: { "hermes-bots": 7 },
          },
        ],
      })
    ).toThrow()
  })

  it("requires the observed revision on every visibility update", () => {
    expect(
      VisibilityUpdateRequestSchema.parse({
        visibility: "hidden",
        revision: "hermes-bots:7",
      })
    ).toEqual({ visibility: "hidden", revision: "hermes-bots:7" })
    expect(() =>
      VisibilityUpdateRequestSchema.parse({ visibility: "hidden" })
    ).toThrow()
  })
})
