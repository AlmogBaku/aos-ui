import { describe, expect, it, vi } from "vitest"

import type { RuntimeConfig, RuntimeLimits } from "../config"

const factories = vi.hoisted(() => ({
  hermes: vi.fn(),
  opencode: vi.fn(),
}))

vi.mock("./hermes/factory", () => ({ createHermesRuntime: factories.hermes }))
vi.mock("./opencode/factory", () => ({
  createOpenCodeRuntime: factories.opencode,
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

    await expect(createRuntimeInstance(config, limits)).resolves.toBe(selected)
    expect(factories.opencode).toHaveBeenCalledExactlyOnceWith(config, limits)
    expect(factories.hermes).not.toHaveBeenCalled()
  })
})
