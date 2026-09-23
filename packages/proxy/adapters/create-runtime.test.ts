import { describe, expect, it, vi } from "vitest"

import type { RuntimeConfig, RuntimeLimits } from "../config"

const factories = vi.hoisted(() => ({
  hermes: vi.fn(),
  openclaw: vi.fn(),
  opencode: vi.fn(),
}))

vi.mock("./hermes/factory", () => ({ createHermesRuntime: factories.hermes }))
vi.mock("./opencode/factory", () => ({
  createOpenCodeRuntime: factories.opencode,
}))
vi.mock("./openclaw/factory", () => ({
  createOpenClawRuntime: factories.openclaw,
}))

import { createRuntimeInstance } from "./create-runtime"

const limits: RuntimeLimits = {
  activeExecutions: 8,
  guestActiveExecutions: 2,
  operatorEventPeers: 8,
  subscriberEvents: 64,
  subscriberBytes: 64 * 1024,
}

describe("runtime selection", () => {
  it("constructs OpenCode only through its server-side runtime factory", async () => {
    const selected = { provider: "opencode" }
    factories.opencode.mockResolvedValueOnce(selected)
    const config = {
      kind: "opencode",
      id: "opencode-main",
      baseUrl: "http://127.0.0.1:4096",
      directory: "/workspace",
      username: "aos-ui",
      passwordFile: "/run/secrets/opencode-password",
    } satisfies Extract<RuntimeConfig, { kind: "opencode" }>

    const mcpServerOverrides = new Map([
      ["desktop", { headers: { Authorization: "Bearer test" } }],
    ])

    await expect(
      createRuntimeInstance(config, limits, mcpServerOverrides)
    ).resolves.toBe(selected)
    expect(factories.opencode).toHaveBeenCalledExactlyOnceWith(config, limits, {
      mcpServerOverrides,
    })
    expect(factories.hermes).not.toHaveBeenCalled()
  })

  it("constructs OpenClaw only through its server-side runtime factory", async () => {
    const selected = { provider: "openclaw" }
    factories.openclaw.mockResolvedValueOnce(selected)
    const config = {
      kind: "openclaw",
      id: "openclaw-main",
      baseUrl: "ws://127.0.0.1:18789",
      deviceIdentityFile: "/run/secrets/openclaw-device-identity",
      deviceTokenFile: "/run/secrets/openclaw-device-token",
    } satisfies Extract<RuntimeConfig, { kind: "openclaw" }>

    await expect(createRuntimeInstance(config, limits)).resolves.toBe(selected)
    expect(factories.openclaw).toHaveBeenCalledExactlyOnceWith(config, limits)
    expect(factories.hermes).not.toHaveBeenCalled()
    expect(factories.opencode).not.toHaveBeenCalled()
  })
})
