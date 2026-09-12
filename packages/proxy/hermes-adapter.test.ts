import { describe, expect, it, vi } from "vitest"

import {
  HermesAgentNotFoundError,
  HermesRevisionConflictError,
  HermesServerAdapter,
  type HermesRpcTransport,
} from "./hermes-adapter"
import { HermesAuthenticationError } from "./hermes-transport"

function profile(hidden = false, revision: number | null = 7) {
  return {
    name: "researcher",
    display_name: "Researcher",
    description: "Investigates primary sources",
    ui_meta: {
      aos: { role: "agent", privatePath: "/srv/hermes/researcher" },
      "hermes-bots": { hidden, nativeOnly: "keep-server-side" },
    },
    ui_meta_revisions: revision === null ? {} : { "hermes-bots": revision },
  }
}

describe("Hermes server adapter", () => {
  it("projects profile names as Agent IDs without leaking native metadata", async () => {
    const request = vi.fn(async () => ({ profiles: [profile()] }))
    const adapter = new HermesServerAdapter({ request } as HermesRpcTransport)

    const catalog = await adapter.listAgents()

    expect(request).toHaveBeenCalledWith("profiles.list", {
      include_sessions: false,
    })
    expect(catalog).toEqual({
      revision: "profiles:researcher@hermes-bots:7",
      agents: [
        {
          summary: {
            kind: "ready",
            id: "researcher",
            name: "Researcher",
            description: "Investigates primary sources",
            activity: "unknown",
            visibility: "visible",
          },
          visibility: "visible",
          selectable: true,
          editable: true,
          revision: "hermes-bots:7",
        },
      ],
    })
    expect(JSON.stringify(catalog)).not.toContain("privatePath")
    expect(JSON.stringify(catalog)).not.toContain("nativeOnly")
  })

  it("marks visibility unavailable when Hermes omits the CAS revision", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile(false, null)] })),
    })
    const catalog = await adapter.listAgents()
    expect(catalog.agents[0]).toMatchObject({
      editable: false,
      revision: "unavailable",
    })
    expect((await adapter.runtimeInfo()).capabilities.agentVisibility).toEqual({
      status: "unavailable",
      reason: "native-revision-unavailable",
    })
  })

  it("updates visibility with the observed revision and confirms an authoritative reread", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [profile()] })
      .mockResolvedValueOnce(profile())
      .mockResolvedValueOnce({ applied: { ui_meta: true } })
      .mockResolvedValueOnce({ profiles: [profile(true, 8)] })
    const adapter = new HermesServerAdapter({ request })

    const updated = await adapter.updateAgentVisibility(
      "researcher",
      "hidden",
      "hermes-bots:7"
    )

    expect(request.mock.calls).toEqual([
      ["profiles.list", { include_sessions: false }],
      ["profiles.describe", { name: "researcher" }],
      [
        "profiles.configure",
        {
          name: "researcher",
          ui_meta: {
            "hermes-bots": {
              hidden: true,
              nativeOnly: "keep-server-side",
            },
          },
          ui_meta_expected_revisions: { "hermes-bots": 7 },
        },
      ],
      ["profiles.list", { include_sessions: false }],
    ])
    expect(updated.agent).toMatchObject({
      visibility: "hidden",
      selectable: false,
      revision: "hermes-bots:8",
    })
  })

  it("rejects a stale revision before mutating Hermes", async () => {
    const request = vi.fn(async () => ({ profiles: [profile()] }))
    const adapter = new HermesServerAdapter({ request })
    await expect(
      adapter.updateAgentVisibility("researcher", "hidden", "hermes-bots:6")
    ).rejects.toBeInstanceOf(HermesRevisionConflictError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("distinguishes rejected Hermes credentials from a temporary outage", async () => {
    const unauthenticated = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new HermesAuthenticationError()
      }),
    })
    const unavailable = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new Error("connection refused")
      }),
    })
    await expect(unauthenticated.authState()).resolves.toEqual({
      status: "unauthenticated",
    })
    await expect(unavailable.authState()).resolves.toEqual({
      status: "unavailable",
      reason: "temporarily-unavailable",
    })
  })

  it("reports a missing Agent separately from a Hermes outage", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile()] })),
    })
    await expect(
      adapter.updateAgentVisibility("missing-agent", "hidden", "hermes-bots:7")
    ).rejects.toBeInstanceOf(HermesAgentNotFoundError)
  })
})
