import { describe, expect, it, vi } from "vitest"

import AosUiHarnessPlugin, * as AosUiHarnessPluginModule from "../../.opencode/plugins/aos-ui-harness"

async function createHarnessHook(
  getSession: () => Promise<{ data?: { agent?: unknown } }>
) {
  const get = vi.fn(getSession)
  const log = vi.fn(async () => ({ data: true }))
  const hooks = await AosUiHarnessPlugin({
    client: { session: { get }, app: { log } },
  } as never)
  const hook = hooks["experimental.chat.system.transform"]
  if (!hook) throw new Error("Expected the AOS system-transform hook")
  return { get, hook, log }
}

describe("OpenCode harness plugin", () => {
  it("exposes only one callable plugin entrypoint to the OpenCode auto-loader", async () => {
    const client = {
      session: { get: vi.fn(async () => ({ data: { agent: "build" } })) },
      app: { log: vi.fn(async () => ({ data: true })) },
    }
    const functionExports = Object.entries(AosUiHarnessPluginModule).filter(
      ([, plugin]) => typeof plugin === "function"
    )

    const loadedPlugins = await Promise.all(
      functionExports.map(([, plugin]) => plugin({ client } as never))
    )

    expect(functionExports.map(([name]) => name)).toEqual(["default"])
    expect(loadedPlugins).toHaveLength(1)
    expect(loadedPlugins[0]).toHaveProperty(
      "experimental.chat.system.transform"
    )
  })

  it("injects the OpenCode manifest and records healthy provider guidance", async () => {
    const { get, hook, log } = await createHarnessHook(async () => ({
      data: { agent: "build" },
    }))
    const system = ["Provider-owned Agent instructions"]

    await hook({ sessionID: "session-build", model: {} as never }, { system })

    expect(system).toHaveLength(2)
    expect(system[0]).toBe("Provider-owned Agent instructions")
    expect(system[1]).toContain("AOS presentation harness:")
    expect(system[1]).toContain("`monty_execute`")
    expect(get).toHaveBeenCalledWith({
      path: { id: "session-build" },
      throwOnError: true,
    })
    expect(log).toHaveBeenCalledWith({
      body: {
        service: "aos-ui-harness",
        level: "info",
        message: "AOS presentation harness is active",
        extra: {
          manifest: "opencode",
          sessionID: "session-build",
        },
      },
      throwOnError: true,
    })
  })

  it("injects the restricted Agent Builder manifest", async () => {
    const { hook, log } = await createHarnessHook(async () => ({
      data: { agent: "agent-builder" },
    }))
    const system: string[] = []

    await hook({ sessionID: "session-builder", model: {} as never }, { system })

    expect(system).toHaveLength(1)
    expect(system[0]).toContain("`question`")
    expect(system[0]).not.toContain("`render_chart`")
    expect(system[0]).not.toMatch(/monty_/)
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "info",
          extra: {
            manifest: "agent-builder",
            sessionID: "session-builder",
          },
        }),
      })
    )
  })

  it("logs degraded guidance when Session ownership resolution fails", async () => {
    const { hook, log } = await createHarnessHook(async () => {
      throw new Error("provider unavailable")
    })
    const system: string[] = []

    await hook({ sessionID: "session-unknown", model: {} as never }, { system })

    expect(system).toHaveLength(1)
    expect(system[0]).toMatch(/Interactive questions are unavailable/)
    expect(system[0]).not.toContain("`render_chart`")
    expect(log).toHaveBeenCalledWith({
      body: {
        service: "aos-ui-harness",
        level: "warn",
        message:
          "AOS harness could not resolve Session ownership; conservative guidance was injected",
        extra: {
          error: "provider unavailable",
          manifest: "ag-ui-fallback",
          sessionID: "session-unknown",
        },
      },
      throwOnError: true,
    })
  })

  it("does not duplicate an existing injection or repeat its health log", async () => {
    const { hook, log } = await createHarnessHook(async () => ({
      data: { agent: "build" },
    }))
    const system = ["Provider-owned Agent instructions"]

    await hook({ sessionID: "session-build", model: {} as never }, { system })
    await hook({ sessionID: "session-build", model: {} as never }, { system })

    expect(system).toHaveLength(2)
    expect(
      system.filter((entry) => entry.includes("AOS presentation harness:"))
    ).toHaveLength(1)
    expect(log).toHaveBeenCalledTimes(1)
  })
})
