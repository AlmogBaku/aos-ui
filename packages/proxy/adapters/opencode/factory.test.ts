import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { captureLogs } from "../../../../test/support/log-capture"
import type { RuntimeLimits } from "../../config"
import type { ServerTurnEngine } from "../../core/runtime"
import type { OpenCodeAdapterClient } from "./adapter"
import type { OpenCodeClientOptions } from "./client"
import { createOpenCodeRuntime } from "./factory"
import { CredentialValues } from "../../redaction"
import { OpenCodeTurnEngine } from "./run"

/** The services the proxy hands a runtime, logging to a capture. */
const services = () => ({
  logger: captureLogs().logger,
  credentials: new CredentialValues(),
})

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
    await writeFile(passwordFile, "pw-test-1\n", { mode: 0o600 })
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
        { ...services(), clientFactory: () => client() }
      )

      const { turns } = runtime.runtime
      expect(turns).toBeInstanceOf(OpenCodeTurnEngine)
      // The runtime is up exactly when its engine's watches are.
      expect(runtime.runtime.link).toBe((turns as OpenCodeTurnEngine).link)
      await runtime.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("hands the client a password reader that picks up a rotated file and redacts its Basic form, and closes one runtime idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aos-opencode-factory-"))
    const passwordFile = join(directory, "password")
    await writeFile(passwordFile, "pw-test-1\n", { mode: 0o600 })
    await chmod(passwordFile, 0o600)
    const close = vi.fn(async () => {})
    const clientFactory = vi.fn<
      (options: OpenCodeClientOptions) => OpenCodeAdapterClient
    >(() => client(close))
    const deps = services()

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
        { ...deps, clientFactory, turns }
      )

      expect(runtime.id).toBe("opencode-local")
      expect(runtime.runtime.turns).toBe(turns)
      expect(clientFactory).toHaveBeenCalledWith({
        baseUrl: "http://127.0.0.1:4096",
        directory: "/workspace/runtime",
        username: "operator",
        password: expect.any(Function),
      })
      const [options] = clientFactory.mock.calls[0]!
      await writeFile(passwordFile, "pw-test-2\n", { mode: 0o600 })
      await expect(options.password()).resolves.toBe("pw-test-2")
      const basic = Buffer.from("operator:pw-test-2").toString("base64")
      expect(deps.credentials.scrub(`Basic ${basic}`)).not.toContain(basic)
      await Promise.all([runtime.close(), runtime.close()])
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
