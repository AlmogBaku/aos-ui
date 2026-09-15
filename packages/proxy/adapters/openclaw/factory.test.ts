import type { AGUIEvent } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import type { ServerRunEngine, ServerRunHandle } from "../../core/runtime"
import { OpenClawServerAdapter } from "./adapter"
import { createOpenClawRuntime } from "./factory"

function handle(): ServerRunHandle {
  return {
    events: (async function* (): AsyncIterable<AGUIEvent> {})(),
    settled: Promise.resolve(),
    stop: async () => "idle",
    recoveryPosition: () => ({ epoch: "test", lastSeen: 0 }),
  }
}

const runs: ServerRunEngine = {
  start: async () => handle(),
  recover: async () => handle(),
}

describe("OpenClaw runtime factory", () => {
  it("owns one coordinator and disposes the provider adapter idempotently", async () => {
    const client = {
      start: vi.fn(),
      stopAndWait: vi.fn(async () => undefined),
      request: vi.fn(),
    }
    const adapter = new OpenClawServerAdapter({
      client,
      runs,
      subscribeSession: async () => () => undefined,
    })

    const instance = await createOpenClawRuntime({
      id: "openclaw-local",
      adapter,
      limits: {
        activeExecutions: 4,
        guestActiveExecutions: 2,
        operatorEventPeers: 4,
        subscriberEvents: 20,
        subscriberBytes: 4096,
      },
    })

    expect(instance.id).toBe("openclaw-local")
    expect(instance.runtime).toBe(adapter)
    await Promise.all([instance.close(), instance.close()])
    expect(client.stopAndWait).toHaveBeenCalledTimes(1)
  })
})
