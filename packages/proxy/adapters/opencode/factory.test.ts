import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import type { RuntimeLimits } from "../../config"
import type { ServerTurnEngine } from "../../core/runtime"
import type { OpenCodeAdapterClient } from "./adapter"
import { createOpenCodeRuntime } from "./factory"
import { OpenCodeTurnEngine } from "./run"

const limits: RuntimeLimits = {
  activeExecutions: 4,
  guestActiveExecutions: 1,
  operatorEventPeers: 4,
  subscriberEvents: 100,
  subscriberBytes: 65_536,
}

const turns: ServerTurnEngine = {
  async start() {
    throw new Error("factory test does not start turns")
  },
  async recover() {
    throw new Error("factory test does not recover turns")
  },
}

function client(close = vi.fn(async () => {})): OpenCodeAdapterClient {
  return {
    catalog: { agents: async () => ({ data: [] }) },
    sessions: {
      list: async () => ({ data: [], cursor: {} }),
      get: async () => {
        throw new Error("not used")
      },
      create: async () => {
        throw new Error("not used")
      },
      messages: async () => ({ data: [], cursor: {} }),
      questions: { reply: async () => {}, reject: async () => {} },
      permissions: { reply: async () => {} },
    },
    close,
  }
}

describe("OpenCode runtime factory", () => {
  it("builds one native OpenCode run engine without a production test override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-opencode-factory-"))
    const passwordFile = join(directory, "password")
    await writeFile(passwordFile, "native-password\n", { mode: 0o600 })
    await chmod(passwordFile, 0o600)

    try {
      const runtime = await createOpenCodeRuntime(
        {
          kind: "opencode",
          id: "opencode-local",
          baseUrl: "http://127.0.0.1:4096",
          directory: "/workspace/runtime",
          username: "operator",
          passwordFile,
        },
        limits,
        { clientFactory: () => client() }
      )

      expect(runtime.runtime.turns).toBeInstanceOf(OpenCodeTurnEngine)
      await runtime.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("reads the server-only password once and closes one coordinator/client runtime idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-opencode-factory-"))
    const passwordFile = join(directory, "password")
    await writeFile(passwordFile, "native-password\n", { mode: 0o600 })
    await chmod(passwordFile, 0o600)
    const close = vi.fn(async () => {})
    const clientFactory = vi.fn(() => client(close))

    try {
      const runtime = await createOpenCodeRuntime(
        {
          kind: "opencode",
          id: "opencode-local",
          baseUrl: "http://127.0.0.1:4096",
          directory: "/workspace/runtime",
          username: "operator",
          passwordFile,
        },
        limits,
        { clientFactory, turns }
      )

      expect(runtime.id).toBe("opencode-local")
      expect(runtime.runtime.turns).toBe(turns)
      expect(clientFactory).toHaveBeenCalledWith({
        baseUrl: "http://127.0.0.1:4096",
        directory: "/workspace/runtime",
        username: "operator",
        password: "native-password",
      })
      await Promise.all([runtime.close(), runtime.close()])
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
